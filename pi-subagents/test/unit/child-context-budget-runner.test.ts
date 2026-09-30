// The orchestrator learns about a mid-run compaction only through the control
// event the runner emits, and that emission lives in runSubagent's per-step
// closure (it needs the run's status payload). So this drives the real
// runSubagent with a scripted child whose session events include the
// compaction_end the child hook produces, and asserts the wake lands in the
// run's own event log with the numbers an operator needs.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { runSubagent, type SubagentRunConfig } from "../../src/runs/background/subagent-runner.ts";
import { CHILD_COMPACTION_COMPACTOR } from "../../src/runs/shared/child-compaction.ts";
import { createFakeChildSessions } from "../support/fake-child-session.ts";

function makeConfig(asyncDir: string, overrides: Partial<SubagentRunConfig> = {}): SubagentRunConfig {
	return {
		id: `budget-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		steps: [{ agent: "budget-child", task: "read the file and report" }],
		resultPath: path.join(asyncDir, "result.json"),
		cwd: asyncDir,
		placeholder: "{previous}",
		asyncDir,
		sessionId: "budget-runner-session",
		artifactConfig: { enabled: false },
		share: false,
		...overrides,
	};
}

interface ControlRecord { event?: { type?: string; reason?: string; message?: string; agent?: string; runId?: string } }

function controlEvents(asyncDir: string): ControlRecord[] {
	const eventsPath = path.join(asyncDir, "events.jsonl");
	if (!fs.existsSync(eventsPath)) return [];
	return fs.readFileSync(eventsPath, "utf-8").split("\n").filter(Boolean).map((line) => {
		try { return JSON.parse(line) as ControlRecord; } catch { return {} as ControlRecord; }
	});
}

function contextBudgetNotices(asyncDir: string): ControlRecord[] {
	return controlEvents(asyncDir).filter((record) => record.event?.reason === "context_budget");
}

const compactionEnd = (tokensBefore: number) => ({
	type: "compaction_end",
	ts: Date.now(),
	reason: "threshold",
	willRetry: false,
	aborted: false,
	result: { summary: "deterministic summary", firstKeptEntryId: "entry-1", tokensBefore, details: { compactor: CHILD_COMPACTION_COMPACTOR } },
});

describe("child context budget wake", () => {
	it("reports a mid-run compaction to the orchestrator", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-budget-wake-"));
		try {
			const queue = path.join(root, "queue");
			fs.mkdirSync(queue, { recursive: true });
			fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({
				output: "read big.txt and reported",
				jsonl: [compactionEnd(251_004)],
			}));
			const config = makeConfig(root);
			await runSubagent(config, createFakeChildSessions(() => queue).factory);
			const notices = contextBudgetNotices(config.asyncDir);
			assert.equal(notices.length, 1, `expected one context_budget wake; events=${JSON.stringify(controlEvents(config.asyncDir).map((r) => r.event?.type))}`);
			const wake = notices[0]!.event!;
			assert.equal(wake.type, "needs_attention");
			assert.equal(wake.runId, config.id);
			assert.equal(wake.agent, "budget-child");
			assert.match(String(wake.message), /compacted its context mid-run/);
			assert.match(String(wake.message), /251,004/, "the wake names what was compacted");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a second compaction too, instead of deduping it away", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-budget-twice-"));
		try {
			const queue = path.join(root, "queue");
			fs.mkdirSync(queue, { recursive: true });
			fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({
				output: "long run",
				jsonl: [compactionEnd(251_004), compactionEnd(252_900)],
			}));
			const config = makeConfig(root);
			await runSubagent(config, createFakeChildSessions(() => queue).factory);
			assert.equal(contextBudgetNotices(config.asyncDir).length, 2, "a re-compaction is a fresh fact, not a repeat nudge");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("stays silent when the compaction came from pi's own summarizer", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-budget-fallback-"));
		try {
			const queue = path.join(root, "queue");
			fs.mkdirSync(queue, { recursive: true });
			// No compactor marker: pi's LLM summarizer ran, and that cost already
			// shows up in usage, so reporting it would double-count.
			fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({
				output: "fallback compaction",
				jsonl: [{ ...compactionEnd(251_004), result: { summary: "model summary", firstKeptEntryId: "entry-1", tokensBefore: 251_004 } }],
			}));
			const config = makeConfig(root);
			await runSubagent(config, createFakeChildSessions(() => queue).factory);
			assert.equal(contextBudgetNotices(config.asyncDir).length, 0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
