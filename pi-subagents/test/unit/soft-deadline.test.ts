import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { consumeExtendRequest, extendRequestPath, requestAsyncExtend, requestAsyncStop, watchAsyncControlInbox } from "../../src/runs/background/control-channel.ts";
import { runSubagent, type SubagentRunConfig } from "../../src/runs/background/subagent-runner.ts";
import { formatControlNoticeMessage } from "../../src/runs/shared/subagent-control.ts";
import { resolveSoftTimeoutMs } from "../../src/runs/foreground/subagent-executor.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { createFakeChildSessions } from "../support/fake-child-session.ts";

function makeConfig(asyncDir: string, overrides: Partial<SubagentRunConfig> = {}): SubagentRunConfig {
	return {
		id: `soft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		steps: [{ agent: "soft-child", task: "hold" }],
		resultPath: path.join(asyncDir, "result.json"),
		cwd: asyncDir,
		placeholder: "{previous}",
		asyncDir,
		sessionId: "soft-deadline-session",
		artifactConfig: { enabled: false },
		share: false,
		...overrides,
	};
}

function controlEvents(asyncDir: string): Array<{ event?: { type?: string; reason?: string; message?: string } }> {
	const eventsPath = path.join(asyncDir, "events.jsonl");
	if (!fs.existsSync(eventsPath)) return [];
	return fs.readFileSync(eventsPath, "utf-8").split("\n").filter(Boolean).map((line) => {
		try { return JSON.parse(line) as { event?: { type?: string; reason?: string; message?: string } }; } catch { return {}; }
	});
}

function softNotices(asyncDir: string): Array<{ event?: { reason?: string; message?: string } }> {
	return controlEvents(asyncDir).filter((record) => record.event?.reason === "soft_deadline");
}

describe("soft deadline", () => {
	it("fires exactly one advisory notice per armed window, does not stop the run, and extend re-arms", { skip: process.platform === "win32" ? "timer race flaky on Windows CI" : undefined }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-soft-deadline-"));
		try {
			const queue = path.join(root, "queue");
			fs.mkdirSync(queue, { recursive: true });
			// A long pre-emission delay keeps the child live without hanging the harness.
			fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({ delay: 30_000, output: "held" }));
			const config = makeConfig(root, { softTimeoutMs: 150 });
			const run = runSubagent(config, createFakeChildSessions(() => queue).factory);
			try {
				await new Promise((resolve) => setTimeout(resolve, 500));
				assert.equal(softNotices(config.asyncDir).length, 1, "exactly one wake per armed window");
				assert.equal(readStatus(config.asyncDir)?.state, "running", "soft expiry must not stop or abort the run");
				requestAsyncExtend(config.asyncDir, 150, { source: "test" });
				await new Promise((resolve) => setTimeout(resolve, 600));
				assert.equal(readStatus(config.asyncDir)?.state, "running", "extend must not stop or abort the run");
				const notices = softNotices(config.asyncDir);
				assert.equal(notices.length, 2, "extend re-arms a fresh one-shot window");
				const status = readStatus(config.asyncDir);
				assert.equal(status?.timedOut, undefined, "hard timeout flag must stay unset");
				assert.equal(status?.deadlineAt, undefined, "no hard deadline existed; extend must not invent one");
				assert.ok((status?.softTimeoutMs ?? 0) > 0, "re-armed window persisted");
				assert.match(notices[1]?.event?.message ?? "", /Soft deadline reached/);
			} finally {
				requestAsyncStop(config.asyncDir, { source: "test" });
				await run;
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("a run that already finished emits no soft notice", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-soft-finished-"));
		try {
			const queue = path.join(root, "queue");
			fs.mkdirSync(queue, { recursive: true });
			fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({ output: "done fast" }));
			const config = makeConfig(root, { softTimeoutMs: 50 });
			await runSubagent(config, createFakeChildSessions(() => queue).factory);
			await new Promise((resolve) => setTimeout(resolve, 250));
			assert.equal(softNotices(config.asyncDir).length, 0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("hard timeout semantics are unchanged and softTimeoutMs: 0 disables", { skip: process.platform === "win32" ? "timer race flaky on Windows CI" : undefined }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-soft-hard-"));
		try {
			const queue = path.join(root, "queue");
			fs.mkdirSync(queue, { recursive: true });
			fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({ delay: 30_000, output: "held" }));
			// The launcher derives deadlineAt from timeoutMs; mirror that contract here.
			// Hard timeout still aborts a held child within its window.
			const hardConfig = makeConfig(path.join(root, "hard"), { timeoutMs: 120, deadlineAt: Date.now() + 120, softTimeoutMs: 0 });
			await runSubagent(hardConfig, createFakeChildSessions(() => queue).factory);
			const hardStatus = readStatus(hardConfig.asyncDir);
			assert.equal(hardStatus?.timedOut, true, "hard timeout must still abort");
			assert.equal(hardStatus?.softTimeoutMs, undefined, "0 disables: no soft fields persisted");
			assert.equal(softNotices(hardConfig.asyncDir).length, 0, "0 disables: no soft notice");
			// 0 disables while the run is live: no timer, no notice, no abort.
			const disabledConfig = makeConfig(path.join(root, "disabled"), { softTimeoutMs: 0 });
			const disabled = runSubagent(disabledConfig, createFakeChildSessions(() => queue).factory);
			try {
				await new Promise((resolve) => setTimeout(resolve, 400));
				assert.equal(readStatus(disabledConfig.asyncDir)?.state, "running", "0 must not abort");
				assert.equal(softNotices(disabledConfig.asyncDir).length, 0, "0 must not notify");
			} finally {
				requestAsyncStop(disabledConfig.asyncDir, { source: "test" });
				await disabled;
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("extend request files are validated and consumed exactly once", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-soft-extend-"));
		try {
			assert.throws(() => requestAsyncExtend(root, 0), /positive integer/);
			assert.throws(() => requestAsyncExtend(root, 1.5), /positive integer/);
			requestAsyncExtend(root, 60_000, { source: "unit" });
			const first = consumeExtendRequest(root);
			assert.equal(first?.softTimeoutMs, 60_000);
			assert.equal(first?.source, "unit");
			assert.equal(fs.existsSync(extendRequestPath(root)), false, "consumed exactly once");
			assert.equal(consumeExtendRequest(root), undefined);
			fs.writeFileSync(extendRequestPath(root), "{ not json");
			assert.equal(consumeExtendRequest(root), undefined, "malformed requests are discarded");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("the soft-deadline notice names the four choices, says the child was not aborted, and reports remaining hard time", () => {
		const message = formatControlNoticeMessage({
			type: "needs_attention", to: "needs_attention", ts: Date.now(), runId: "run-1", agent: "worker",
			message: "Soft deadline reached for run run-1; the child is actively in a model/tool round, so this is progress rather than a stuck signal. Choose: continue, steer/give context, extend, or stop. The child was not aborted. Hard deadline backstop in about 300s; this wake is the decision point.",
			reason: "soft_deadline", elapsedMs: 600_000,
		});
		assert.match(message, /continue/);
		assert.match(message, /steer\/give context/);
		assert.match(message, /extend/);
		assert.match(message, /stop/);
		assert.match(message, /not aborted/);
		assert.match(message, /action: "extend"/);
		assert.match(message, /hard timeout\/deadline is unchanged/);
		assert.match(message, /primary decision point/);
		assert.match(message, /backstop/);
		// Round-aware framing travels in the event message.
		assert.match(message, /progress rather than a stuck signal/);
		assert.match(message, /decision point/);
	});

	it("onExtend routes through the inbox watcher", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-soft-watch-"));
		try {
			const received: Array<number | undefined> = [];
			const dispose = watchAsyncControlInbox(root, { onExtend: (request) => received.push(request.softTimeoutMs), platform: "linux" });
			requestAsyncExtend(root, 45_000, { source: "watch" });
			await new Promise((resolve) => setTimeout(resolve, 300));
			dispose();
			assert.deepEqual(received, [45_000]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolveSoftTimeoutMs precedence: param > config > 600000; invalid param disables; 0 disables", () => {
		assert.equal(resolveSoftTimeoutMs(5_000, 9_000), 5_000);
		assert.equal(resolveSoftTimeoutMs(undefined, 9_000), 9_000);
		assert.equal(resolveSoftTimeoutMs(undefined, undefined), 600_000);
		assert.equal(resolveSoftTimeoutMs(0, 9_000), 0, "explicit 0 disables");
		assert.equal(resolveSoftTimeoutMs(undefined, 0), 0, "configured 0 disables");
		assert.equal(resolveSoftTimeoutMs(-5, 9_000), 0, "invalid param falls closed to disabled");
		assert.equal(resolveSoftTimeoutMs(1.5, 9_000), 0, "non-integer param falls closed to disabled");
		assert.equal(resolveSoftTimeoutMs(Number.MAX_SAFE_INTEGER, undefined), 0, "overflow falls closed");
	});
});
