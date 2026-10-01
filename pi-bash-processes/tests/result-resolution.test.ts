// Result resolution end to end (openspec `herdsman-background-handoffs`
// tasks 2.2-2.3) against the real lifecycle and the real bridge: a durable
// `resultResolution` record appears only on an actual delivery of the
// terminal result or an actually-delivered unrecoverable capture error —
// never from a host wake, an inspection, or a failed handoff. The provider's
// `outstanding` list is the settlement-visible observable; the task record's
// own field pins which kind was recorded.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { startExtensionHost, type ExtensionHost, type HostTool } from "./fixtures/extension-host.js";
import { bindBackgroundWorkAssignment, queryBackgroundWorkSnapshot } from "../extensions/background-work.js";
import { sidecarStatePath } from "../extensions/persistence.js";
import { requestBridge } from "../extensions/bridge.js";

const host: ExtensionHost = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const SESSION = `extension-host-${process.pid}`;
const scope = (requestId: string) => ({ sessionId: SESSION, requestId });
const bgTask = (): HostTool => host.tools.get("bg_task")!;
const bash = (): HostTool => host.tools.get("bash")!;
const listed = async (id: string) => (await host.listTasks()).find((task) => task.id === id);

/** A managed command, reporting its exit code and combined text (pi-bg-output harness). */
const bashRun = async (command: string) => {
	try {
		const result = await bash().execute("managed", { command }, undefined, undefined, host.ctx);
		return { exitCode: (result.structuredContent as { exit_code?: number } | undefined)?.exit_code ?? 0, output: result.content[0]?.text ?? "" };
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		return { exitCode: Number(/Command exited with code (\d+)/.exec(text)?.[1] ?? 1), output: text };
	}
};

/** The endpoint the declared CLI talks to, read from a managed command's own environment. */
async function endpoint(): Promise<{ session: string; socketPath: string }> {
	const result = await bash().execute("endpoint", { command: 'printf "%s\\n%s\\n" "$PI_BG_SESSION" "$PI_BG_SOCKET"' }, undefined, undefined, host.ctx);
	const [session, socketPath] = (result.content[0]?.text ?? "").trim().split("\n");
	expect(socketPath, "managed bash is told which endpoint to ask").toBeTruthy();
	return { session: session!, socketPath: socketPath! };
}

async function awaitLogBytes(id: string, minBytes: number, budgetMs = 30_000): Promise<number> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const record = await listed(id);
		const size = record?.logFile ? statSync(record.logFile as string).size : 0;
		if (size >= minBytes) return size;
		if (Date.now() >= deadline) return size;
		await Bun.sleep(10);
	}
}

const outstandingOf = (requestId: string) => {
	const result = queryBackgroundWorkSnapshot(host.events, scope(requestId));
	if (result.state === "ready" || result.state === "reconciling") return result.snapshot.outstanding;
	return null;
};

/** A restored terminal task whose capture was never certified: its retained
 *  log does not exist, so any retrieval can only deliver the failure. */
const craftedIncomplete = (id: string) => ({
	id,
	command: `printf 'crafted ${id}'`,
	title: id,
	cwd: tmpdir(),
	status: "stopped",
	exitCode: 137,
	pid: 4194303,
	startedAt: Date.now() - 60_000,
	updatedAt: Date.now() - 30_000,
	logFile: join(tmpdir(), `herdsman-phase03-${id}-${process.pid}.log`),
	// Wake-suppressed, so the session-start replay of missed exits never
	// notifies it: the assertions below can pin that the delivered error
	// itself is not what sets exitNotified.
	notifyOnExit: false,
	notifyOnOutput: false,
	exitNotified: false,
	resultReady: false,
	outputComplete: false,
	outputBytes: 0,
	resultResolution: undefined,
	sessionId: SESSION,
});

test("an unrecoverable capture error delivered through the tool and the CLI resolves as error, and unblocks the bind", async () => {
	const sidecar = sidecarStatePath(host.ctx);
	mkdirSync(dirname(sidecar), { recursive: true });
	writeFileSync(sidecar, `${JSON.stringify({ tasks: [craftedIncomplete("bg-900"), craftedIncomplete("bg-901"), craftedIncomplete("bg-902"), { ...craftedIncomplete("bg-903"), resultReady: true, outputComplete: false }] })}\n`);
	await host.dispatch("session_start");

	// Unassociated, unresolved, will-never-certify work blocks every bind.
	const refused = queryBackgroundWorkSnapshot(host.events, scope("req-err")).state;
	expect(refused).toBe("error");
	const bindBefore = bindBackgroundWorkAssignment(host.events, scope("req-err"));
	if (bindBefore.state !== "refused") throw new Error(`expected refused before the error deliveries, received ${JSON.stringify(bindBefore)}`);
	expect(bindBefore.reason).toContain("bg-900");

	// Tool path: the retrieval hands over the failure and records `error`.
	const got = await bgTask().execute("resolution-err-get", { action: "get", id: "bg-900" });
	expect(got.content[0]?.text ?? "").toContain("bg-900");
	const toolRecord = await listed("bg-900");
	expect(toolRecord?.resultResolution, "the delivered failure is recorded as an error resolution").toBe("error");
	expect(toolRecord?.exitNotified, "an error delivery is not a host notification").toBe(false);
	expect(toolRecord?.outputComplete, "a delivered error never upgrades the capture to complete").toBe(false);

	// CLI path: the preview carries the capture error and its receipt; the
	// client confirms the error delivery, which records `error`.
	const { session, socketPath } = await endpoint();
	const preview = await requestBridge({ session, socketPath }, { op: "get", id: "bg-901", output: "preview" });
	if (!preview.ok || !preview.response.ok) throw new Error(`expected a prepared preview, received ${JSON.stringify(preview)}`);
	expect(preview.response.result.captureError, "the incomplete capture is reported").toBeTruthy();
	expect(preview.response.result.receipt, "every handoff carries the token that would settle it").toBeTruthy();
	const confirmed = await requestBridge({ session, socketPath }, { op: "receipt", token: preview.response.result.receipt!, delivered: "error" });
	if (!confirmed.ok || !confirmed.response.ok || !confirmed.response.result.ack) throw new Error(`expected the error delivery to confirm, received ${JSON.stringify(confirmed)}`);
	expect(confirmed.response.result.ack.committed).toBe("error");
	expect(confirmed.response.result.ack.reviewed, "an error delivery commits no review").toBe(false);
	const cliRecord = await listed("bg-901");
	expect(cliRecord?.resultResolution).toBe("error");
	expect(cliRecord?.exitNotified, "confirmation is not a notification either").toBe(false);

	// Bounded-wait path: the centralized rule can only deliver an incomplete
	// capture as an error, never as a successful terminal result.
	const waited = await bgTask().execute("resolution-err-wait", { action: "wait", id: "bg-902", waitSeconds: 5 }, undefined, undefined, host.ctx);
	expect(waited.content[0]?.text ?? "").toContain("bg-902");
	expect((await listed("bg-902"))?.resultResolution, "the wait delivered an unrecoverable capture as an error").toBe("error");
	expect((await listed("bg-902"))?.exitNotified, "the wait is a result handoff, not a host notification").toBe(false);

	// A latched capture whose writer never certified the file (the restored
	// record says resultReady but outputComplete false): the wait's early
	// branch still routes through the centralized rule and can only deliver
	// it as an error — terminal by latch, uncertified by integrity.
	const latched = await bgTask().execute("resolution-err-wait-latched", { action: "wait", id: "bg-903", waitSeconds: 5 }, undefined, undefined, host.ctx);
	expect(latched.content[0]?.text ?? "").toContain("bg-903");
	expect((await listed("bg-903"))?.resultResolution, "an uncertified terminal capture is delivered as an error").toBe("error");
	expect((await listed("bg-903"))?.exitNotified).toBe(false);

	// The trap is gone: the bind proceeds and the snapshot is authoritative
	// with nothing outstanding — while both tasks keep their notification
	// obligations exactly where they were.
	expect(bindBackgroundWorkAssignment(host.events, scope("req-err"))).toStrictEqual({ state: "bound" });
	const snapshot = queryBackgroundWorkSnapshot(host.events, scope("req-err"));
	if (snapshot.state !== "ready") throw new Error(`expected ready after the error deliveries, received ${JSON.stringify(snapshot)}`);
	expect(snapshot.snapshot.outstanding).toStrictEqual([]);
	expect((await listed("bg-900"))?.exitNotified).toBe(false);
	expect((await listed("bg-901"))?.exitNotified).toBe(false);
	expect((await listed("bg-902"))?.exitNotified).toBe(false);
	expect((await listed("bg-903"))?.exitNotified).toBe(false);
});

test("a delivered host wake never resolves the result; the retrieval does", async () => {
	expect(bindBackgroundWorkAssignment(host.events, scope("req-n"))).toStrictEqual({ state: "bound" });
	await host.dispatch("before_agent_start");
	const spawned = await bgTask().execute("resolution-notify", { action: "spawn", command: "printf 'notified-run\\n'" });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);

	// The turn is in flight, so the completion is held, not delivered.
	const heldExit = host.messages.filter(([message]) => (message as { details?: { eventType?: string } }).details?.eventType === "exit");
	expect(heldExit, "the mid-turn completion is held").toHaveLength(0);

	await host.dispatch("agent_end");
	await host.dispatch("agent_settled");
	const exits = host.messages.filter(([message]) => (message as { details?: { eventType?: string } }).details?.eventType === "exit");
	expect(exits.length, "the settled turn delivers the completion wake exactly once").toBe(1);
	expect(JSON.stringify(exits[0]), "the wake names its task").toContain(id);
	expect((await listed(id))?.exitNotified, "the wake is acknowledged as delivered").toBe(true);
	expect((await listed(id))?.resultResolution, "a host wake is notification, not settlement").toBeUndefined();
	expect(outstandingOf("req-n"), "the notified terminal result is still outstanding").toStrictEqual([
		{ taskId: id, state: "awaiting-result-review", reason: expect.stringContaining("awaiting an actual result handoff") },
	]);

	await bgTask().execute("resolution-notify-get", { action: "get", id });
	expect((await listed(id))?.resultResolution, "the certified retrieval resolves it").toBe("delivered");
	expect(outstandingOf("req-n")).toStrictEqual([]);
});

test("a running inspection resolves nothing; the bounded wait's terminal result resolves", async () => {
	const spawned = await bgTask().execute("resolution-wait", { action: "spawn", command: "printf 'waited-run\\n'; sleep 0.4" });
	const id = (spawned.details.task as { id: string }).id;

	await bgTask().execute("resolution-wait-get", { action: "get", id });
	expect((await listed(id))?.resultResolution, "reading a running task is inspection, not resolution").toBeUndefined();
	expect(outstandingOf("req-n")).toStrictEqual([
		{ taskId: id, state: "running", reason: expect.stringContaining("spawned under this assignment") },
	]);

	const waited = await bgTask().execute("resolution-wait-wait", { action: "wait", id, waitSeconds: 20 }, undefined, undefined, host.ctx);
	expect(waited.content[0]?.text ?? "").toContain(id);
	expect((await listed(id))?.resultResolution, "the wait's terminal result was an actual delivery").toBe("delivered");
	expect(outstandingOf("req-n")).toStrictEqual([]);
});

test("a confirmed stop delivers its result and resolves it", async () => {
	const spawned = await bgTask().execute("resolution-stop", { action: "spawn", command: "printf 'stopped-result\\n'; sleep 30" });
	const id = (spawned.details.task as { id: string }).id;
	const stopped = await bgTask().execute("resolution-stop-stop", { action: "stop", id });
	const text = stopped.content[0]?.text ?? "";
	expect(text, "the stop hands over the retained result").toContain("stopped-result");
	expect((await listed(id))?.resultResolution, "the confirmed stop's result delivery resolves it").toBe("delivered");
	expect(outstandingOf("req-n")).toStrictEqual([]);
});

test("a failed CLI handoff stays unresolved; a completed read resolves", async () => {
	const spawned = await bgTask().execute("resolution-epipe", {
		action: "spawn",
		command: "head -c 3000000 /dev/zero | tr '\\0' 'z'",
	});
	const id = (spawned.details.task as { id: string }).id;
	await awaitLogBytes(id, 1_000_000);
	await host.settledTask(id);

	// The pipe closes early: the bytes the caller kept are not the result,
	// so the CLI reports the failure and confirms nothing.
	const piped = await bashRun(`set -o pipefail; pi-bg get ${id} --output | head -c 64 > /dev/null`);
	expect(piped.exitCode, `expected a failed handoff, got: ${piped.output}`).not.toBe(0);
	expect(piped.output, "the failure is reported as a pipe failure").toContain("epipe");
	expect((await listed(id))?.resultResolution, "a failed handoff resolves nothing").toBeUndefined();
	expect(outstandingOf("req-n"), "the assignment still waits for the real result").toStrictEqual([
		{ taskId: id, state: "awaiting-result-review", reason: expect.stringContaining("awaiting an actual result handoff") },
	]);

	// The same read, completed, is the actual delivery.
	const complete = await bashRun(`pi-bg get ${id} --output > ${join(tmpdir(), `herdsman-phase03-epipe-${process.pid}.txt`)}`);
	expect(complete.exitCode, complete.output).toBe(0);
	expect(complete.output).toContain("kendex: ack=terminal");
	expect((await listed(id))?.resultResolution, "the completed CLI read resolves it").toBe("delivered");
	expect(outstandingOf("req-n")).toStrictEqual([]);
});

/** The session lane directory, anchored on a real task's log path (crafted
 *  restore fixtures point at tmpdir, which is never the lane). */
const laneDirOf = async (): Promise<string> => {
	const real = (await host.listTasks()).find((task) => String(task.logFile ?? "").includes("lanes"));
	expect(real, "a real task log anchors the lane directory").toBeTruthy();
	return dirname(String(real!.logFile));
};

/** Make every task log the spawn pre-creates read-only, so the writer's chain
 *  ends with a failed append and the flush barrier can never certify the
 *  capture. Returns the restore function. */
const blockNewLogs = (laneDir: string): (() => void) => {
	const known = new Set(readdirSync(laneDir));
	const touched: string[] = [];
	const watcher = setInterval(() => {
		for (const name of readdirSync(laneDir)) {
			if (known.has(name) || !name.endsWith(".log")) continue;
			known.add(name);
			try {
				chmodSync(join(laneDir, name), 0o444);
				touched.push(join(laneDir, name));
			} catch { /* the file may already be gone */ }
		}
	}, 2);
	watcher.unref?.();
	return () => {
		clearInterval(watcher);
		for (const file of touched) {
			try { chmodSync(file, 0o644); } catch { /* best effort */ }
		}
	};
};

test("a bounded wait delivers the terminal result only after the log's flush barrier settles", async () => {
	expect(bindBackgroundWorkAssignment(host.events, scope("req-flush"))).toStrictEqual({ state: "bound" });
	const spawned = await bgTask().execute("resolution-flush", { action: "spawn", command: "printf 'flush-barrier\\n'" });
	const id = (spawned.details.task as { id: string }).id;
	const waited = await bgTask().execute("resolution-flush-wait", { action: "wait", id, waitSeconds: 20 }, undefined, undefined, host.ctx);
	expect(waited.content[0]?.text ?? "").toContain(id);
	// The wait attaches while the process runs, so it owns this exit and is
	// released only inside finalizeTask's settle() — after
	// completeResultFinalization and the centralized observation. A record
	// here therefore proves the WAIT caller routed through the rule
	// post-barrier: had it observed the finalizing window, nothing would
	// have been recorded at all.
	expect((await listed(id))?.resultResolution, "the wait's terminal result is a certified delivery").toBe("delivered");
	expect((await listed(id))?.outputComplete, "and certifies because the writer settled").toBe(true);
	expect(outstandingOf("req-flush"), "the delivery retires the assignment's waiting").toStrictEqual([]);
});

test("a bounded wait whose log can never settle delivers the capture as an error, never a result", async () => {
	expect(bindBackgroundWorkAssignment(host.events, scope("req-flushfail"))).toStrictEqual({ state: "bound" });
	// spawnTask pre-creates the log file; making it read-only the moment it
	// appears means every append the writer attempts fails, so the chain ends
	// with a failed write and `taskLogs.settled` stays false at the barrier.
	const unblock = blockNewLogs(await laneDirOf());
	try {
		const spawned = await bgTask().execute("resolution-flushfail", { action: "spawn", command: "sleep 0.15; printf 'one\\n'; sleep 0.15; printf 'tail\\n'" });
		const id = (spawned.details.task as { id: string }).id;
		const waited = await bgTask().execute("resolution-flushfail-wait", { action: "wait", id, waitSeconds: 20 }, undefined, undefined, host.ctx);
		expect(waited.content[0]?.text ?? "").toContain(id);
		// The barrier settled the process's fate but not the capture's
		// integrity: readiness is terminal, outputComplete false, so the
		// centralized rule the wait caller runs can only deliver `error`.
		expect((await listed(id))?.resultResolution, "an uncertified flush is delivered as an error").toBe("error");
		expect((await listed(id))?.outputComplete, "the writer never certified the file").toBe(false);
		expect(outstandingOf("req-flushfail"), "the delivered error retires the waiting").toStrictEqual([]);
	} finally {
		unblock();
	}
});

test("a foreground result is delivered through the same post-barrier rule", async () => {
	const result = await bash().execute("resolution-fg", { command: "printf 'fg-barrier\\n'" }, undefined, undefined, host.ctx);
	expect(result.content[0]?.text ?? "").toContain("fg-barrier");
	const tasks = await host.listTasks();
	const fg = [...tasks].reverse().find((task) => String(task.command ?? "").includes("fg-barrier"));
	expect(fg, "the foreground command produced its managed task").toBeTruthy();
	// settleForeground runs after completeResultFinalization and the exit-
	// ownership branch's centralized observation, so by the time the tool
	// returns the delivery is recorded — a finalizing observation would have
	// recorded nothing.
	expect(fg!.resultResolution, "the foreground handoff is a certified delivery").toBe("delivered");
	expect(fg!.outputComplete, "the writer settled before the barrier released the caller").toBe(true);
});

test("a foreground result whose log can never settle is delivered as an error", async () => {
	const unblock = blockNewLogs(await laneDirOf());
	try {
		const result = await bash().execute("resolution-fg-fail", { command: "sleep 0.15; printf 'one\\n'; sleep 0.15; printf 'tail\\n'" }, undefined, undefined, host.ctx);
		expect(result.content[0]?.text ?? "", "the tool still returns its result").toBeDefined();
		const tasks = await host.listTasks();
		const fg = [...tasks].reverse().find((task) => String(task.command ?? "").includes("sleep 0.15"));
		expect(fg, "the foreground command produced its managed task").toBeTruthy();
		// The ownership branch observed the capture after the barrier with
		// outputComplete false: the foreground caller's result carries an
		// error resolution — never silence, and never a successful result.
		expect(fg!.resultResolution, "the unsettled flush is delivered as an error").toBe("error");
		expect(fg!.outputComplete, "the writer never certified the file").toBe(false);
	} finally {
		unblock();
	}
});
