import { mock } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SOFT_TIMEOUT_MS } from "../../extensions/constants.js";
import { interceptNativeEffects, fixtureNow, fixturePid } from "./spawn-native.js";

interface Input { mode: "spawn" | "stop" | "duplicate" | "wait-any" | "rerun" | "deferred" | "deferred-unobserved" | "deferred-group" | "deferred-wait" | "deferred-settle-hold" | "staggered-exits" | "soft-expiry" | "soft-extend" | "soft-terminal" | "soft-restore" | "soft-restore-notified" | "soft-review-reset" | "soft-one-reminder"; platform?: string; resource?: boolean; caller?: "tool" | "shutdown" | "slash"; command?: string; command2?: string; stopFails?: boolean; killFails?: boolean; signalGone?: boolean; softTimeoutMs?: number | null; extendSoftTimeoutMs?: number; timeoutSeconds?: number }
const input: Input = JSON.parse(await Bun.stdin.text());
const native = await interceptNativeEffects(input);
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const unused = () => { throw new Error("spawn_fixture.sdk_operation=unexpected_render"); };
mock.module("@earendil-works/pi-ai", () => ({ StringEnum: (values: readonly string[]) => ({ enum: values }) }));
mock.module("typebox", () => ({ Type: { Object: (value: unknown) => value, Optional: (value: unknown) => value, Number: () => ({}), String: () => ({}), Boolean: () => ({}) } }));
mock.module("@earendil-works/pi-tui", () => ({ matchesKey: unused, truncateToWidth: unused, visibleWidth: unused, wrapTextWithAnsi: unused }));
mock.module("@earendil-works/pi-coding-agent", () => ({ getShellConfig: () => ({ shell: "fixture-shell", args: ["-c"] }) }));

interface ToolResult { content: { type: string; text: string }[]; details: { action: string; task?: Record<string, unknown>; tasks?: Record<string, unknown>[] } }
interface Tool { name: string; execute(id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: unknown): Promise<ToolResult> }
const tools = new Map<string, Tool>();
const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): unknown }>();
const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
const messages: unknown[] = [];
const notifications: unknown[] = [];
const entries: unknown[] = [];
// Restore replays from the session branch; getBranch returns the entries this
// process appended so a second session_start acts as a live restore.
const ctx = {
	cwd: process.cwd(), hasUI: false, isProjectTrusted: () => true,
	sessionManager: { getSessionId: () => "spawn-hardening-private-session", getSessionFile: () => join(process.cwd(), "session.jsonl"), getBranch: () => [...entries] },
	ui: { notify: (...args: unknown[]) => notifications.push(args), setWidget() {} },
} as unknown as ExtensionContext;
const pi = {
	registerTool(tool: Tool) { tools.set(tool.name, tool); },
	registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): unknown }) { commands.set(name, command); }, registerShortcut() {}, registerMessageRenderer() {},
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { events.set(event, handler); },
	// Custom entries persist as { type: "custom", customType, data } on the
	// session branch; restore replays from getBranch.
	appendEntry: (customType: unknown, data: unknown) => entries.push({ type: "custom", customType, data }),
	sendMessage: (...args: unknown[]) => messages.push(args),
} as unknown as ExtensionAPI;
let started = false;
let shutDown = false;
async function dispatch(event: string, payload?: unknown) {
	const handler = events.get(event);
	// Pi emits every lifecycle event; an extension that does not listen simply
	// ignores it. Skipping unregistered events keeps the fixture honest about
	// which handlers the extension actually registers.
	if (!handler) return;
	await handler(payload ?? {}, ctx);
}
async function execute(params: Record<string, unknown>) {
	const tool = tools.get("bg_task");
	if (!tool) throw new Error("spawn_fixture.tool_missing=bg_task");
	return await tool.execute("private-tool-call", params, undefined, undefined, ctx);
}
// session_shutdown releases the task list, so after it the task is read from
// the snapshot it persisted for the next session to restore. `appendEntry`
// records { type, customType, data }, and the snapshot set is `data.tasks`.
function persistedTask(): Record<string, unknown> | undefined {
	for (const entry of [...entries].reverse() as Array<{ data?: { tasks?: Record<string, unknown>[] } }>) {
		const task = entry?.data?.tasks?.find((candidate) => candidate.id === "bg-1");
		if (task) return task;
	}
	return undefined;
}
async function state() {
	// After `session_shutdown` the live map is empty (upstream's handler clears it,
	// where HEAD's deliberately did not), and a finalized task may be pruned from
	// it by the finished-task bound (#3224). The persisted snapshot is then the
	// record — and reading it is what a later turn does too, so a pruned task and
	// a retained one report the same state.
	const task = (shutDown ? undefined : (await execute({ action: "log", id: "bg-1" })).details.task) ?? persistedTask();
	if (!task) throw new Error("spawn_fixture.task_missing=bg-1");
	return { id: task.id, pid: task.pid, status: task.status, reason: task.terminationReason ?? null, exitCode: task.exitCode, exitNotified: task.exitNotified };
}
/** Soft-reminder steers, which carry their own event type and must never be exit wakes. */
const softWakeTexts = () => messages
	.map((args) => args[0] as { content?: unknown; details?: { eventType?: string } })
	.filter((message) => message?.details?.eventType === "soft-timeout")
	.map((message) => String(message.content ?? ""));
const exitWakeCount = () => messages
	.map((args) => args[0] as { details?: { eventType?: string; task?: { id?: string } } })
	.filter((message) => message?.details?.eventType === "exit" && message?.details?.task?.id === "bg-1").length;
const softTimers = (ms: number) => native.activeTimers().filter((timer) => timer.kind === "timeout" && timer.ms === ms);
async function softState() {
	const inspected = await execute({ action: "log", id: "bg-1" });
	const task = inspected.details.task;
	if (!task) throw new Error("spawn_fixture.task_missing=bg-1");
	return {
		status: task.status,
		exitNotified: task.exitNotified,
		expiresAt: task.expiresAt ?? null,
		softExpiresAt: task.softExpiresAt ?? null,
		softTimeoutMs: task.softTimeoutMs ?? null,
		softTimeoutNotified: task.softTimeoutNotified ?? null,
	};
}

// A task with pending log text finalizes after its log flush, which the real
// file system finishes in real time.
async function finalized() {
	for (let waited = 0; waited < 5_000 && (await state()).status === "running"; waited += 1) await Bun.sleep(1);
	// The status turns terminal synchronously in `closeTaskLifecycle`, but upstream
	// defers `finalizeTask`'s exit-wake decision to the task log's flush: that
	// callback is what records delivery as `exitNotified`. Landing pending writes
	// and letting one macrotask run means the read below sees the snapshot a later
	// turn would, instead of one caught mid-decision.
	const { taskLogs } = await import("../../extensions/log-writer.js");
	await taskLogs.drain();
	await Bun.sleep(1);
}
try {
	const { default: backgroundTasks } = await import("../../extensions/background-tasks.js");
	backgroundTasks(pi);
	await dispatch("session_start");
	started = true;
	// Only the platform-sensitive spawn call runs under this row's platform.
	if (input.platform) Object.defineProperty(process, "platform", { ...originalPlatform, value: input.platform });
	const wantsExitWake = input.mode === "deferred" || input.mode === "deferred-unobserved" || input.mode === "deferred-wait" || input.mode === "deferred-settle-hold" || input.mode === "operator-stop" || input.mode === "soft-expiry" || input.mode === "soft-extend" || input.mode === "soft-restore" || input.mode === "soft-terminal";
	// Legacy scenarios pin the soft reminder off (`softTimeoutMs: 0`) so their
	// exact timer sets stay about the behavior under test; `softTimeoutMs: null`
	// exercises the extension default, and a number is passed through.
	const softTimeoutParam = input.softTimeoutMs === null ? undefined : input.softTimeoutMs ?? 0;
	const softMs = input.softTimeoutMs === null ? DEFAULT_SOFT_TIMEOUT_MS : input.softTimeoutMs ?? 0;
	const spawned = await execute({
		action: "spawn",
		command: input.command ?? "fixture command",
		notifyOnExit: wantsExitWake,
		...(softTimeoutParam !== undefined ? { softTimeoutMs: softTimeoutParam } : {}),
		...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
	});
	Object.defineProperty(process, "platform", originalPlatform);
	let duplicate: { first: string; second: string } | undefined;
	let waitAny: { first: string; waited: string; details: { task?: { id?: string } } } | undefined;
	let supersede: { wakes: unknown[]; listText: string } | undefined;
	let operatorStop: { messages: unknown[]; activeStopKey: boolean } | undefined;
	let deferred: { afterExit: unknown[]; afterLog: unknown[]; afterTurnEnd: unknown[] } | undefined;
	if (input.mode === "deferred" || input.mode === "deferred-unobserved" || input.mode === "deferred-wait" || input.mode === "deferred-settle-hold" ) {
		// Run in flight: the exit arrives mid-run. The run boundary is
		// before_agent_start → agent_end → agent_settled (Pi emits turn_end per tool round, so
		// flushing there would split one run's completions across wakes).
		await dispatch("before_agent_start");
		native.children[0]?.emit("close", 0);
		await Promise.resolve();
		const afterExit = messages.slice();
		let afterLog: unknown[] = [];
		if (input.mode === "deferred") {
			await execute({ action: "log", id: "bg-1" });
			afterLog = messages.slice(afterExit.length);
		}
		if (input.mode === "deferred-wait") {
			// The exit is already deferred; a bounded wait returns the terminal
			// result immediately and must consume the pending wake.
			await execute({ action: "wait", id: "bg-1", waitSeconds: 5 });
			afterLog = messages.slice(afterExit.length);
		}
		if (input.mode === "deferred-settle-hold") {
			// agent_end closes one low-level run; retries, recovery, compaction
			// retry and follow-up work all continue after it. The wake must stay
			// held until agent_settled (no remaining automatic work), otherwise a
			// later read in the same run finds nothing left to consume.
			await dispatch("agent_end");
			afterLog = messages.slice(afterExit.length);
		}
		await dispatch("agent_end");
		await dispatch("agent_settled");
		const afterTurnEnd = messages.slice(afterExit.length + afterLog.length);
		deferred = { afterLog, afterTurnEnd, afterExit };
	}
	let deferredGroup: { count: number; grouped: boolean } | undefined;
	if (input.mode === "deferred-group") {
		await dispatch("before_agent_start");
		// children[0] is the fixture's own pre-spawn; the two grouped tasks are
		// children[1] and children[2].
		await execute({ action: "spawn", command: "echo one", notifyOnExit: true });
		await execute({ action: "spawn", command: "echo two", notifyOnExit: true });
		native.children[1]?.emit("close", 0);
		native.children[2]?.emit("close", 0);
		await Promise.resolve();
		await Promise.resolve();
		const during = messages.length;
		await dispatch("agent_end");
		await dispatch("agent_settled");
		const wakes = messages.slice(during).filter(([m]: any[]) => m?.customType === "kendex-background-tasks:event" && (m?.details?.grouped === true || m?.details?.eventType === "exit"));
		deferredGroup = { count: wakes.length, grouped: wakes.some(([m]: any[]) => String(m?.content ?? "").includes("background tasks finished")) };
	}
	// Regression for the three-wake report: three tasks finishing at different
	// points inside ONE run must produce a single grouped wake at the run
	// boundary.
	let staggered: { listAfterRun: string; wakeTexts: string[]; wakes: number; grouped: boolean } | undefined;
	if (input.mode === "staggered-exits") {
		await dispatch("before_agent_start");
		// children[0] is the fixture's own pre-spawn; the three staggered tasks
		// are children[1..3] and each exits at a different point in this run.
		await execute({ action: "spawn", command: "echo first", notifyOnExit: true });
		native.children[1]?.emit("close", 0);
		await Promise.resolve();
		await execute({ action: "spawn", command: "echo second", notifyOnExit: true });
		native.children[2]?.emit("close", 0);
		await Promise.resolve();
		await execute({ action: "spawn", command: "echo third", notifyOnExit: true });
		native.children[3]?.emit("close", 0);
		await Promise.resolve();
		await Promise.resolve();
		const during = messages.length;
		await dispatch("agent_end");
		await dispatch("agent_settled");
		const wakes = messages.slice(during).filter(([m]: any[]) => m?.customType === "kendex-background-tasks:event" && (m?.details?.grouped === true || m?.details?.eventType === "exit"));
		const wakeTexts = wakes.map(([m]: any[]) => String(m?.content ?? "").slice(0, 200));
		const listed = await execute({ action: "list" });
		staggered = {
			grouped: wakes.some(([m]: any[]) => String(m?.content ?? "").includes("background tasks finished")),
			listAfterRun: String(listed.content[0]?.text ?? ""),
			wakeTexts,
			wakes: wakes.length,
		};
	}
	let soft: Record<string, unknown> | undefined;
	if (input.mode === "soft-expiry") {
		// One soft reminder, no stop: the process keeps running, the reminder is
		// one-shot, and the later real exit still wakes the agent.
		const atSpawn = { timers: softTimers(softMs).length, state: await softState() };
		native.fireTimeout(softMs);
		await Promise.resolve();
		const afterWake = {
			state: await softState(),
			wakes: softWakeTexts().length,
			text: softWakeTexts()[0] ?? "",
			signals: [...native.signals],
			softTimers: softTimers(softMs).length,
			exitWakes: exitWakeCount(),
		};
		await dispatch("before_agent_start");
		native.children[0]?.emit("close", 0);
		await Promise.resolve();
		await dispatch("agent_end");
		await dispatch("agent_settled");
		soft = { atSpawn, afterWake, afterExit: { state: await softState(), exitWakes: exitWakeCount(), softWakes: softWakeTexts().length } };
	} else if (input.mode === "soft-one-reminder") {
		// One held reminder per task: output bursts during the interval add no
		// timer, each delivered reminder re-arms exactly one in its place, and the
		// second interval is measured from the first delivery.
		const atSpawn = { timers: softTimers(softMs).length, state: await softState() };
		const timerCounts: number[] = [];
		for (let burst = 0; burst < 3; burst++) {
			native.children[0]?.stdout?.emit("data", Buffer.from(`noise ${burst}\n`));
			native.children[0]?.stderr?.emit("data", Buffer.from(`noise-e ${burst}\n`));
			await Promise.resolve();
			timerCounts.push(softTimers(softMs).length);
		}
		const afterNoise = { timers: softTimers(softMs).length, wakes: softWakeTexts().length, timerCounts };
		native.fireTimeout(softMs);
		await Promise.resolve();
		const afterFirst = { timers: softTimers(softMs).length, wakes: softWakeTexts().length, state: await softState(), softExpiresAt: (await softState()).softExpiresAt };
		// A second interval: the rearmed reminder is the only one, and it fires once.
		native.fireTimeout(softMs);
		await Promise.resolve();
		const afterSecond = { timers: softTimers(softMs).length, wakes: softWakeTexts().length, texts: softWakeTexts(), state: await softState() };
		soft = { atSpawn, afterFirst, afterNoise, afterSecond };
	} else if (input.mode === "soft-extend") {
		// extend clears the fired deadline, re-arms a fresh window, and leaves the
		// hard timeout budget untouched.
		native.fireTimeout(softMs);
		await Promise.resolve();
		const firstWake = { state: await softState(), wakes: softWakeTexts().length, softTimers: softTimers(softMs).length, wakeText: softWakeTexts()[0] ?? "", signals: [...native.signals] };
		const extended = await execute({ action: "extend", id: "bg-1", softTimeoutMs: input.extendSoftTimeoutMs });
		const extendedMs = input.extendSoftTimeoutMs ?? softMs;
		const afterExtend = {
			action: extended.details.action,
			state: await softState(),
			softTimers: softTimers(extendedMs).length,
			hardTimers: softTimers((input.timeoutSeconds ?? 0) * 1_000).length,
			text: extended.content[0]?.text ?? "",
		};
		// `extendSoftTimeoutMs: 0` disables the reminder, so there is no window to fire.
		if (extendedMs > 0) {
			native.fireTimeout(extendedMs);
			await Promise.resolve();
		}
		const secondWake = { fired: extendedMs > 0, state: await softState(), wakes: softWakeTexts().length, text: softWakeTexts()[1] ?? "", signals: [...native.signals], hardTimers: softTimers((input.timeoutSeconds ?? 0) * 1_000).length };
		await dispatch("before_agent_start");
		native.children[0]?.emit("close", 0);
		await Promise.resolve();
		await dispatch("agent_end");
		await dispatch("agent_settled");
		soft = { firstWake, afterExtend, secondWake, afterExit: { state: await softState(), exitWakes: exitWakeCount(), softWakes: softWakeTexts().length } };
	} else if (input.mode === "soft-restore-notified") {
		// The one-shot latch is persisted: a restart after the reminder fired must
		// not arm a second one.
		native.fireTimeout(softMs);
		await Promise.resolve();
		const afterWake = { state: await softState(), wakes: softWakeTexts().length, softTimers: softTimers(softMs).length };
		await dispatch("session_start");
		soft = { afterWake, afterRestore: { state: await softState(), softTimers: softTimers(softMs).length, wakes: softWakeTexts().length, exitWakes: exitWakeCount() } };
	} else if (input.mode === "soft-terminal") {
		// A task that finished before its soft deadline never gets a reminder.
		// The exit fires mid-turn, so the wake defers to the agent_settled flush; the
		// count is taken after the flush but before any log read (which would
		// consume the wake by design).
		await dispatch("before_agent_start");
		native.children[0]?.emit("close", 0);
		await Promise.resolve();
		await dispatch("agent_end");
		await dispatch("agent_settled");
		const exitWakes = exitWakeCount();
		soft = {
			softTimers: softTimers(softMs).length,
			softWakes: softWakeTexts().length,
			exitWakes,
			timers: native.activeTimers(),
		};
	} else if (input.mode === "soft-review-reset") {
		// A review (the legacy soft reset) while a reminder is still armed must
		// discard that armed reminder rather than leaving it to fire: one timer
		// remains, and it belongs to the new interval.
		const atSpawn = { timers: softTimers(softMs).length, state: await softState() };
		const resetMs = input.extendSoftTimeoutMs ?? softMs;
		const reset = await execute({ action: "extend", id: "bg-1", softTimeoutMs: resetMs });
		const afterReset = {
			state: await softState(),
			staleTimers: softTimers(softMs).length,
			timers: softTimers(resetMs).length,
			text: reset.content[0]?.text ?? "",
		};
		native.fireTimeout(resetMs);
		await Promise.resolve();
		const afterWake = { state: await softState(), wakes: softWakeTexts().length, timers: softTimers(resetMs).length };
		soft = { atSpawn, afterReset, afterWake };
	} else if (input.mode === "soft-restore") {
		// A live task restored from a snapshot re-arms its soft reminder exactly
		// once, and the restore must not double-arm it.
		const beforeRestore = { state: await softState(), softTimers: softTimers(softMs).length };
		await dispatch("session_start");
		const afterRestore = { state: await softState(), softTimers: softTimers(softMs).length, timers: native.activeTimers() };
		native.fireTimeout(softMs);
		await Promise.resolve();
		soft = {
			beforeRestore,
			afterRestore,
			afterWake: {
				state: await softState(),
				wakes: softWakeTexts().length,
				text: softWakeTexts()[0] ?? "",
				signals: [...native.signals],
				shiftedTimers: softTimers(softMs).length,
				exitWakes: exitWakeCount(),
			},
		};
	}
	let rerun: { first: string; second: string } | undefined;
	if (input.mode === "rerun") {
		native.children[0]?.emit("close", 0);
		await Promise.resolve();
		const again = await execute({ action: "spawn", command: input.command ?? "fixture command", notifyOnExit: false });
		rerun = { first: spawned.content[0]?.text ?? "", second: again.content[0]?.text ?? "" };
	} else if (input.mode === "duplicate") {
		const second = await execute({ action: "spawn", command: input.command2 ?? input.command ?? "fixture command", notifyOnExit: false });
		native.children[1]?.emit("close", 0);
		duplicate = { first: spawned.content[0]?.text ?? "", second: second.content[0]?.text ?? "" };
	} else if (input.mode === "supersede") {
		// The identical respawn supersedes bg-1; only the newer task may wake.
		const second = await execute({ action: "spawn", command: input.command2 ?? input.command ?? "fixture command", notifyOnExit: true });
		await dispatch("before_agent_start");
		native.children[0]?.emit("close", 0);
		native.children[1]?.emit("close", 0);
		await Promise.resolve();
		await dispatch("agent_end");
		await dispatch("agent_settled");
		const listed = await execute({ action: "list" });
		supersede = { wakes: messages.slice(), listText: listed.content[0]?.text ?? "" };
		void second;
	} else if (input.mode === "operator-stop") {
		// The user cancels through /bg:stop — an operator action, not the agent's
		// own tool call. The agent must learn the task it may be waiting on is gone.
		await dispatch("before_agent_start");
		const command = commands.get("bg:stop");
		if (!command) throw new Error("spawn_fixture.command_missing=bg:stop");
		await command.handler("bg-1", ctx);
		await Promise.resolve();
		native.children[0]?.emit("close", null);
		await Promise.resolve();
		await dispatch("agent_end");
		await dispatch("agent_settled");
		const wakeText = messages
			.map((m: any) => (typeof m === "string" ? m : JSON.stringify(m)))
			.filter((text: string) => text.includes("bg-1"));
		operatorStop = { messages: wakeText, activeStopKey: true };
	} else if (input.mode === "wait-any") {
		// No id: the wait should attach to the oldest running task. Native timers
		// are intercepted, so fire the wait's expiry, then close the child. The
		// window is 3s so it cannot be confused with the state writer's 1s
		// persist window or the 2s log stall deadline; fireTimeout is exact.
		const waitedPromise = execute({ action: "wait", waitSeconds: 3 });
		native.fireTimeout(3_000);
		const waited = await waitedPromise;
		native.children[0]?.emit("close", 0);
		waitAny = { first: spawned.content[0]?.text ?? "", waited: waited.content[0]?.text ?? "", details: waited.details as { task?: { id?: string } } };
	}
	if (input.mode === "spawn" || input.mode === "stop" || input.mode === "rerun") {
		const expectedSpawns = input.mode === "rerun" ? 2 : 1;
		if (native.children.length !== expectedSpawns || native.spawns.length !== expectedSpawns) throw new Error(`spawn_fixture.spawn_count=${native.spawns.length},children=${native.children.length}`);
	}
	const child = native.children[0]!;
	const spawn = native.spawns[0]!;
	const before = await state();
	// Full soft state of the spawned task, read before any shutdown can mutate it.
	const spawnSoftState = input.softTimeoutMs !== undefined || input.defaultSoftTimeoutMs !== undefined ? await softState() : undefined;
	const stopStart = native.syncCalls.length;
	const signalsBefore = native.signals.length;
	let outcome: unknown;
	let stopResult: ToolResult | undefined;
	let after: unknown;
	let escalated: unknown;
	if (input.mode === "stop") {
		// The tool's stop awaits the bounded termination it initiated, so its child
		// end has to be produced while the call is pending — which is what a real
		// child does when its process actually ends. Shutdown and the slash command
		// are not awaited by a caller here, so they keep the direct sequence.
		let pendingStop: Promise<ToolResult> | undefined;
		if (input.caller === "shutdown") {
			await dispatch("session_shutdown");
			shutDown = true;
			outcome = { kind: "shutdown" };
		} else if (input.caller === "slash") {
			const command = commands.get("bg:stop");
			if (!command) throw new Error("spawn_fixture.command_missing=bg:stop");
			await command.handler("bg-1", ctx);
			outcome = { kind: "slash" };
		} else {
			pendingStop = execute({ action: "stop", id: "bg-1" });
			// Wait until the stop has tried to signal: the intermediate state below
			// is the state a stop leaves behind once its signal is out.
			for (let spin = 0; spin < 400 && native.signals.length === signalsBefore && native.syncCalls.length === stopStart; spin++) await Bun.sleep(5);
		}
		after = { state: await state(), timers: native.activeTimers(), signals: [...native.signals], childSignals: [...native.childSignals], unitCalls: native.syncCalls.slice(stopStart) };
		if (input.caller !== "shutdown" && !input.stopFails && !input.signalGone) {
			native.fireTimeout(5000);
			escalated = { state: await state(), signals: [...native.signals], unitCalls: native.syncCalls.slice(stopStart) };
			child.emit("close", null);
			await finalized();
		}
		if (pendingStop) {
			try { const result = await pendingStop; stopResult = result; outcome = { kind: "tool", action: result.details.action, text: result.content[0]?.text }; if (process.env.FIXTURE_DEBUG_TEXT) process.stderr.write(`LEN=${(result.content[0]?.text ?? "").length}\n${result.content[0]?.text}\n---\n`); }
			catch (error) { outcome = { kind: "error", message: error instanceof Error ? error.message : String(error) }; }
		}
	}
	if (input.mode === "spawn") child.emit("close", 0);
	const final = await state();
	// Log lines are written asynchronously; the drain lands them before the read.
	const { taskLogs } = await import("../../extensions/log-writer.js");
	await taskLogs.drain();
	const log = readFileSync(spawned.details.task!.logFile as string, "utf8");
	const stoppedTimers = native.activeTimers();
	const stopCalls = native.syncCalls.slice(stopStart);
	const signals = [...native.signals];
	const childSignals = [...native.childSignals];
	// Soft scenarios already finalized bg-1 (or deliberately did not): the
	// generic shutdown/finalize tail below would mutate wake counts, so those
	// scenarios report their own `final` and skip the trailing kill.
	if (input.mode === "soft-expiry" || input.mode === "soft-extend" || input.mode === "soft-terminal" || input.mode === "soft-restore" || input.mode === "soft-restore-notified" || input.mode === "soft-review-reset" || input.mode === "soft-one-reminder") {
		const softChild = native.children[0]!;
		const softSpawn = native.spawns[0]!;
		process.stdout.write(JSON.stringify({
			spawn: { file: softSpawn.file, args: softSpawn.args, resultAction: spawned.details.action, resultId: spawned.details.task!.id, resultPid: spawned.details.task!.pid },
			soft, spawnSoftState,
			final: await softState(),
			remainingTimers: native.activeTimers(),
			unexpected: native.unexpected,
			messages,
			fixtureNow, fixturePid,
		}));
		void softChild;
	} else {
	if (!shutDown) { await dispatch("session_shutdown"); shutDown = true; }
	process.stdout.write(JSON.stringify({
		spawn: { file: spawn.file, args: spawn.args, detached: spawn.options.detached, stdio: spawn.options.stdio, cwdIsPrivate: spawn.options.cwd === process.cwd(), piRootIsPrivate: (spawn.options.env as NodeJS.ProcessEnv).PI_CODING_AGENT_DIR === process.env.PI_CODING_AGENT_DIR, resultAction: spawned.details.action, resultId: spawned.details.task!.id, resultPid: spawned.details.task!.pid },
		duplicate, waitAny, supersede, operatorStop, rerun, deferred, deferredGroup, staggered, soft, spawnSoftState,
		before, outcome, stopResult, after, escalated, final, log, stoppedTimers, stopCalls, signals, childSignals,
		timerEvents: native.timerEvents, remainingTimers: native.activeTimers(), unexpected: native.unexpected, notifications, messages,
		fixtureNow, fixturePid,
	}));
	}
} finally {
	Object.defineProperty(process, "platform", originalPlatform);
	try { if (started && !shutDown) await dispatch("session_shutdown"); }
	finally { native.restore(); }
}
