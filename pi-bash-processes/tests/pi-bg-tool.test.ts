import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";

import { startExtensionHost, type HostTool } from "./fixtures/extension-host.js";
import { registerAll, type RegistrationDeps } from "../extensions/registrations.js";

// The declared tool surface for `get` and `stop`: the same prepared result, the
// same commit rule, and the same confirmed-termination procedure the `pi-bg` CLI
// uses, reached through the real registered `bg_task` tool.
//
// The short grace makes the SIGKILL-escalation arm fast; a process that exits on
// SIGTERM is unaffected by it.
// The short grace makes the SIGKILL-escalation arm fast. The long exit-wake
// debounce keeps a finished task's completion genuinely owed for the length of a
// test, which is what makes "listing settles nothing" observable.
const host = await startExtensionHost({ settings: { exitWakeBatchMs: 5_000, forceKillGraceMs: 400 } });
afterAll(() => host.dispose());

const bgTask = (): HostTool => host.tools.get("bg_task")!;

const spawned = (result: { details: Record<string, unknown> }) => result.details.task as { id: string };

const spawn = async (command: string, callId: string): Promise<string> => spawned(await bgTask().execute(callId, { action: "spawn", command }, undefined, undefined, host.ctx)).id;

const get = async (callId: string, params: Record<string, unknown>) => bgTask().execute(callId, params, undefined, undefined, host.ctx);

const text = (result: { content: { text?: string }[] }) => result.content[0]?.text ?? "";

const listed = async (id: string) => (await host.listTasks()).find((task) => task.id === id);

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("get on a running task resets only the review clock and acknowledges nothing", async () => {
	const id = await spawn("sleep 30", "get-running");
	const result = await get("get-running-read", { action: "get", id });

	expect(result.details.ack, "a running read settles neither the completion nor a review").toEqual({
		acknowledged: false,
		committed: "review",
		reviewed: true,
	});
	expect(result.details.observation.readiness).toBe("running");
	expect(result.details.observation.completionOwed, "a running task owes no completion yet").toBe(false);
	expect(result.details.captureError, "a running preview is a partial capture, not a short result").toBeUndefined();
	expect(text(result)).toContain("running");
	expect(text(result)).toContain("acknowledged: nothing");

	// The read recorded the bytes it handed over, so a repeat with no new output
	// identifies the output as unchanged instead of re-announcing it.
	const repeat = await get("get-running-repeat", { action: "get", id });
	expect(repeat.details.observation.outputChanged).toBe(false);
	expect(repeat.details.observation.outputRevision).toBe(result.details.observation.outputRevision);
	expect(repeat.details.ack.committed).toBe("review");

	// A full read of a running task hands over a partial artifact and still only
	// reviews: the bytes cannot certify a completion that has not happened.
	const full = await get("get-running-full", { action: "get", id, output: "full" });
	expect(full.details.artifact.partial).toBe(true);
	expect(full.details.artifact.complete).toBe(false);
	expect((await listed(id))!.logFile).not.toBe(full.details.artifact.path);
	expect(full.details.ack.committed).toBe("review");

	await bgTask().execute("get-running-stop", { action: "stop", id }, undefined, undefined, host.ctx);
});

test("get on a finished task acknowledges the completion after a successful handoff, and a repeat reports unchanged output", async () => {
	const id = await spawn("printf 'one\\ntwo\\n'", "get-terminal");
	await host.settledTask(id);

	const result = await get("get-terminal-read", { action: "get", id });
	expect(result.details.ack).toEqual({ acknowledged: true, committed: "terminal", reviewed: false });
	expect(result.details.observation.outputComplete).toBe(true);
	expect(result.details.captureError).toBeUndefined();
	expect(result.details.observation.completionOwed).toBe(false);
	expect(text(result)).toContain("completed (exit 0)");
	expect(text(result)).toContain("one");

	// A terminal read resets no review, so the repeat is idempotent rather than
	// re-acknowledging: the obligation is reported settled both times.
	const repeat = await get("get-terminal-repeat", { action: "get", id });
	expect(repeat.details.observation.outputRevision).toBe(result.details.observation.outputRevision);
	expect(repeat.details.ack).toEqual({ acknowledged: true, committed: "terminal", reviewed: false });
});

test("list has no lifecycle side effects", async () => {
	const id = await spawn("printf 'unobserved\\n'", "get-list");
	await host.settledTask(id);
	const owed = async () => ((await host.listTasks()).find((task) => task.id === id) ?? {}).exitNotified === false;
	expect(await owed(), "the completion is owed before anything reads the task").toBe(true);

	for (const call of ["get-list-1", "get-list-2", "get-list-3"]) {
		const listed = await bgTask().execute(call, { action: "list" }, undefined, undefined, host.ctx);
		expect(listed.details.action).toBe("list");
		expect(listed.details.ack, "listing acknowledges nothing").toBeUndefined();
		expect(listed.details.observation, "listing reviews nothing and settles nothing").toBeUndefined();
	}
	expect(await owed(), "three listings left the completion obligation exactly where it was").toBe(true);

	// Only a read that actually hands the result over settles it.
	const after = await get("get-list-read", { action: "get", id });
	expect(after.details.ack.committed).toBe("terminal");
	expect(after.details.observation.completionOwed, "the settled handoff says so").toBe(false);
	expect(await owed()).toBe(false);
});

// The boundary every terminal read in this file depends on. `status` leaves
// "running" inside `finalizeTask`, *before* the flush that certifies the capture
// settles: the writer's `appendFile` is asynchronous, so with a batch still
// pending at close there is a real window in which the process is closed and the
// capture is not certified. A wait that keyed on `status` alone could read the
// log inside that window and see bytes the writer had not landed yet, which shows
// up as an intermittent missing final line rather than as an honest failure.
test("a closed process is not yet a certified capture, so a status-only wait is not terminal readiness", async () => {
	// The large write is the *last* thing the task does, so a batch is guaranteed
	// to be in flight when the process ends.
	const id = await spawn("sleep 0.2; yes x | head -c 8000000", "readiness-boundary");

	// The first record that is no longer running is the earliest terminal
	// observation any caller could make.
	let closed: Record<string, any> | undefined;
	for (let spin = 0; spin < 4_000 && !closed; spin++) {
		const task = (await listed(id))!;
		if (task.status !== "running") closed = task;
		else await Bun.sleep(1);
	}
	expect(closed, "the task reached a terminal status").toBeDefined();
	expect(closed!.resultReady, "the process closed before its capture was certified").toBe(false);

	// The readiness the contract names: the wait ends only once the capture says
	// it is certified, and only then does the log hold what the task wrote.
	const settled = await host.settledTask(id);
	expect(settled.resultReady).toBe(true);
	expect(settled.status).not.toBe("running");
});

test("a full get hands over the settled capture itself, and never a live log", async () => {
	const id = await spawn("printf 'first\\n'; sleep 1; printf 'second\\n'", "get-artifact");

	// While the task runs, the artifact is a snapshot at a fixed boundary: the
	// live log is not it, and output produced afterwards cannot change it.
	const running = await get("get-artifact-running", { action: "get", id, output: "full" });
	const live = (await listed(id))!.logFile as string;
	expect(running.details.artifact.path).not.toBe(live);
	expect(running.details.artifact.partial).toBe(true);
	const atBoundary = readFileSync(running.details.artifact.path as string, "utf8");

	await host.settledTask(id);
	expect(readFileSync(running.details.artifact.path as string, "utf8"), "output produced later did not change the handoff").toBe(atBoundary);

	// A settled, certified capture is its own artifact: nothing appends to a
	// flushed log, so no copy is made and the bytes are the capture's.
	const settled = await get("get-artifact-settled", { action: "get", id, output: "full" });
	expect(settled.details.artifact.complete).toBe(true);
	expect(settled.details.artifact.path).toBe(live);
	expect(readFileSync(settled.details.artifact.path as string, "utf8")).toBe(readFileSync(live, "utf8"));
	expect(text(settled)).toContain("first");
	expect(text(settled)).toContain("second");
	expect(settled.details.fullOutputPath).toBe(live);
});

test("an uncertified capture is handed over as a short result and commits nothing", async () => {
	const id = await spawn("printf 'surviving bytes\\n'", "get-short");
	await host.settledTask(id);
	const logFile = (await listed(id))!.logFile as string;
	rmSync(logFile, { force: true });

	// The preview hands over what survives and the loss metadata, and says the
	// result is not complete. Nothing is committed, so the obligation is untouched.
	const preview = await get("get-short-read", { action: "get", id });
	expect(preview.details.captureError, "the read says the capture is not complete").toBeTruthy();
	expect(preview.details.ack, "a short capture commits no acknowledgment").toBeUndefined();
	expect(text(preview)).toContain("not a complete result");

	// A full read cannot hand anything over at all: that is an explicit failure,
	// never an empty success.
	await expect(get("get-short-full", { action: "get", id, output: "full" })).rejects.toThrow();
});

test("stop returns the final result under the same id, and a get of it still succeeds", async () => {
	const id = await spawn("sleep 30", "get-stop");
	const result = await get("get-stop-call", { action: "stop", id });

	expect(result.details.action).toBe("stop");
	expect(result.details.stopMessage).toContain(`Stopping ${id}`);
	expect(text(result)).toContain(`${id} — stopped`);
	expect(result.details.observation.status).toBe("stopped");
	expect(result.details.observation.readiness).toBe("terminal");
	expect(result.details.ack.committed).toBe("terminal");
	expect(text(result)).toContain("acknowledged: completion settled");

	const after = await get("get-stop-read", { action: "get", id });
	expect(after.details.observation.status).toBe("stopped");
	expect(after.details.observation.exitCode).toBe(result.details.observation.exitCode);
	expect(text(after)).toContain("stopped");
});

test("stop escalates to SIGKILL for a task that ignores SIGTERM", async () => {
	const id = await spawn("trap '' TERM; while :; do :; done", "get-kill");
	await Bun.sleep(200);
	const pid = (await listed(id))!.pid as number;
	expect(alive(pid), "the task is running before the stop").toBe(true);

	const result = await get("get-kill-call", { action: "stop", id });
	expect(result.details.observation.status).toBe("stopped");
	expect(result.details.ack.committed).toBe("terminal");
	expect(alive(pid), "the group was escalated past its TERM trap").toBe(false);
});

test("stop on an already-finished task reports its real outcome rather than a fabricated stop", async () => {
	const id = await spawn("printf 'done\\n'", "get-finished-stop");
	await host.settledTask(id);
	const before = await listed(id);

	const result = await get("get-finished-stop-call", { action: "stop", id });
	expect(result.details.stopMessage).toContain(`is already completed (exit 0)`);
	expect(result.details.observation.status, "a completed task is not rewritten as stopped").toBe("completed");
	expect(result.details.observation.exitCode).toBe(before!.exitCode);
	expect(result.details.ack.committed).toBe("terminal");
});

// The unconfirmed arm cannot be produced by a real signal in-process: every
// reachable failure is either confirmed or finalized optimistically. It is
// injected here because the tool's obligation is about what it does with the
// answer, and the answer is what the shared operation returns.
function toolWithStop(deps: Partial<RegistrationDeps>): HostTool {
	const tools = new Map<string, HostTool>();
	const stub = {
		appendEntry() {},
		on: () => () => {},
		registerCommand() {},
		registerMessageRenderer() {},
		registerShortcut() {},
		registerTool(tool: HostTool) {
			tools.set(tool.name, tool);
		},
		sendMessage() {},
	} as never;
	const base: RegistrationDeps = {
		backgroundBashShortcut: "none",
		clearFinishedTasks: () => 0,
		consumeObservedExitWake: () => false,
		dashboardDeps: {
			getActiveTaskId: () => null,
			spawnBackgroundTask: () => null,
			stopTask: () => false,
			toggleStop: () => false,
		},
		dashboardShortcut: "none",
		extendSoftTimeout: () => ({ message: "", ok: true }),
		formatTaskListText: () => "",
		getActiveCtx: () => null,
		getTaskOutput: () => "",
		oldestRunningTask: () => null,
		readTaskResult: async () => {
			throw new Error("an unconfirmed stop must not reach the result operation");
		},
		rememberSnapshot: (task) => task as never,
		requestStop: () => ({ message: "", ok: true }),
		resolveTask: () => null,
		setActiveCtx: () => {},
		similarRunningTasks: () => ({ identical: [], similar: [] }),
		sortedTasks: () => [],
		stopTaskConfirmed: async () => ({ confirmed: false, message: "bg-9 did not confirm termination within 5000ms" }),
		waitForTask: async () => ({ content: [], details: {} }),
		widgetToggleShortcut: "none",
		...deps,
	};
	registerAll(stub, base);
	return tools.get("bg_task")!;
}

test("an unconfirmed stop is never reported as a stopped task, and hands over no result", async () => {
	const task = { id: "bg-9", status: "running" } as never;
	const tool = toolWithStop({ resolveTask: () => task });
	await expect(tool.execute("unconfirmed", { action: "stop", id: "bg-9" }, undefined, undefined, host.ctx)).rejects.toThrow(
		"did not confirm termination",
	);
});
