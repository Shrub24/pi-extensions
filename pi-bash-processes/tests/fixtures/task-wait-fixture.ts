import { mock } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { interceptNativeEffects } from "./spawn-native.js";

// Extension-level fixture for bounded `bg_task action:"wait"`. Reuses the
// spawn-native interception (fake child, manually-fired timers) so wait
// attachment, settlement, expiry, queued-message release, abort, the
// second-wait rejection, and clamping all run against the production
// extension with deterministic timing: no real subprocess, no real waiting.
interface Input { scenario: string; waitSeconds?: number; taskWaitDefaultSeconds?: number; taskWaitMaxSeconds?: number }

const input: Input = JSON.parse(await Bun.stdin.text());
const native = await interceptNativeEffects({});
const unused = () => { throw new Error("task_wait_fixture.sdk_operation=unexpected_render"); };
mock.module("@earendil-works/pi-ai", () => ({ StringEnum: (values: readonly string[]) => ({ enum: values }) }));
mock.module("typebox", () => ({ Type: { Object: (value: unknown) => value, Optional: (value: unknown) => value, Number: () => ({}), String: () => ({}), Boolean: () => ({}) } }));
mock.module("@earendil-works/pi-tui", () => ({ matchesKey: unused, truncateToWidth: unused, visibleWidth: unused, wrapTextWithAnsi: unused }));
mock.module("@earendil-works/pi-coding-agent", () => ({ getShellConfig: () => ({ shell: "fixture-shell", args: ["-c"] }) }));

interface ToolResult { content: { type: string; text: string }[]; details: { action: string; task?: Record<string, unknown>; removed?: number } }
interface Tool { name: string; execute(id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: ExtensionContext): Promise<ToolResult> }
const tools = new Map<string, Tool>();
const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
const messages: unknown[][] = [];
let pendingMessages = false;
const ctx = {
	cwd: process.cwd(), hasUI: false, isProjectTrusted: () => true,
	hasPendingMessages: () => pendingMessages,
	sessionManager: { getSessionId: () => "task-wait-session", getSessionFile: () => join(process.cwd(), "session.jsonl"), getBranch: () => [] },
	ui: { notify() {}, setWidget() {} },
} as unknown as ExtensionContext;
const pi = {
	registerTool(tool: Tool) { tools.set(tool.name, tool); },
	registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { events.set(event, handler); },
	appendEntry() {},
	sendMessage: (...args: unknown[]) => messages.push(args),
} as unknown as ExtensionAPI;

let started = false;
let shutDown = false;
try {
	const { default: backgroundTasks } = await import("../../extensions/background-tasks.js");
	backgroundTasks(pi);
	await events.get("session_start")!({}, ctx);
	started = true;
	const bgTask = tools.get("bg_task");
	if (!bgTask) throw new Error("task_wait_fixture.tool_missing=bg_task");

	// The soft reminder is pinned off so this scenario's timer set stays exact;
	// soft-reminder behavior has its own focused test file.
	const spawn = () => bgTask.execute("spawn-1", { action: "spawn", command: "fixture wait task", softTimeoutMs: 0 });
	const wait = (waitSeconds?: number, signal?: AbortSignal) => bgTask.execute(
		"wait-1",
		{ action: "wait", id: "bg-1", ...(waitSeconds !== undefined ? { waitSeconds } : {}) },
		signal,
		undefined,
		ctx,
	);
	const taskList = async () => {
		const listed = await bgTask.execute("list-1", { action: "list" });
		return (listed.details as { tasks: Record<string, unknown>[] }).tasks;
	};
	const exitWakeCount = () => messages.filter((args) => {
		const message = args[0] as { details?: { eventType?: string; task?: { id?: string } } };
		return message?.details?.eventType === "exit" && message?.details?.task?.id === "bg-1";
	}).length;

	await spawn();
	const child = native.children[0];
	if (!child) throw new Error("task_wait_fixture.spawn_missing");

	let result: ToolResult | undefined;
	let resultError: string | undefined;
	let secondWaitError: string | undefined;
	let firstWaitText: string | undefined;
	let exitNotifiedAfterWait: boolean | undefined;
	let timersDuringWait: { kind: string; ms: number }[] = [];
	let timersAfterWait: { kind: string; ms: number }[] = [];
	const signalsBeforeSettle: unknown[] = [];

	if (input.scenario === "terminal") {
		child.emit("close", 0);
		timersDuringWait = native.activeTimers();
		result = await wait(30);
		timersAfterWait = native.activeTimers();
	} else if (input.scenario === "terminal-elapsed") {
		// The task is 7s old when the wait attaches. A terminal fast path
		// reports the task's total age, not the zero-length wait.
		native.advanceNow(7_000);
		child.emit("close", 0);
		result = await wait(30);
		timersAfterWait = native.activeTimers();
	} else if (input.scenario === "wait-elapsed") {
		// The task is 5s old when the wait attaches and the wait window is
		// fired 7s later: Running text must say 7s, never the 12s task age.
		native.advanceNow(5_000);
		const pending = wait(30);
		native.advanceNow(7_000);
		native.fireTimeout(30_000);
		result = await pending;
		timersAfterWait = native.activeTimers();
		child.emit("close", 0);
	} else if (input.scenario === "shutdown-wait") {
		const pending = wait(30);
		await events.get("session_shutdown")!({}, ctx);
		shutDown = true;
		try { result = await pending; }
		catch (error) { resultError = error instanceof Error ? error.message : String(error); }
		timersAfterWait = native.activeTimers();
	} else if (input.scenario === "settles") {
		const pending = wait(30);
		timersDuringWait = native.activeTimers();
		child.emit("close", 0);
		result = await pending;
		timersAfterWait = native.activeTimers();
	} else if (input.scenario === "expiry") {
		const pending = wait();
		native.fireTimeout(30_000);
		result = await pending;
		timersAfterWait = native.activeTimers();
		child.emit("close", 0);
	} else if (input.scenario === "pending") {
		const pending = wait(30);
		pendingMessages = true;
		native.fireInterval(100);
		result = await pending;
		pendingMessages = false;
		timersAfterWait = native.activeTimers();
		child.emit("close", 0);
	} else if (input.scenario === "abort") {
		const controller = new AbortController();
		const pending = wait(30, controller.signal);
		controller.abort();
		try { result = await pending; }
		catch (error) { resultError = error instanceof Error ? error.message : String(error); }
		signalsBeforeSettle.push(...native.signals);
		timersAfterWait = native.activeTimers();
		child.emit("close", 0);
	} else if (input.scenario === "second-wait") {
		const first = wait(30);
		try { await wait(10); }
		catch (error) { secondWaitError = error instanceof Error ? error.message : String(error); }
		native.fireTimeout(30_000);
		firstWaitText = (await first).content[0]?.text;
		timersAfterWait = native.activeTimers();
		child.emit("close", 0);
	} else if (input.scenario === "clamp-high") {
		const pending = wait(999);
		timersDuringWait = native.activeTimers();
		native.fireTimeout(120_000);
		result = await pending;
		timersAfterWait = native.activeTimers();
		child.emit("close", 0);
	} else if (input.scenario === "clamp-low") {
		const pending = wait(-5);
		timersDuringWait = native.activeTimers();
		native.fireTimeout(0);
		result = await pending;
		timersAfterWait = native.activeTimers();
		child.emit("close", 0);
	} else if (input.scenario === "settles-suppresses-wake") {
		// Regression (bg-2088 / bg-3047): a wait ATTACHED to a running task is
		// the delivery channel when the child finalizes during the wait — the
		// waiter-owns-exit claim must record the exit so neither a wake now nor
		// one at the run boundary duplicates the result the wait already handed
		// over. Dispatch the run boundary around the wait like the real flow.
		await events.get("before_agent_start")!({}, ctx);
		const pending = wait(30);
		timersDuringWait = native.activeTimers();
		child.emit("close", 0);
		result = await pending;
		const stateAfterWait = (await taskList())[0] as { exitNotified?: boolean };
		await events.get("agent_end")?.({}, ctx);
		await events.get("agent_settled")?.({}, ctx);
		timersAfterWait = native.activeTimers();
		exitNotifiedAfterWait = stateAfterWait.exitNotified === true;
	} else if (input.scenario === "configured-bounds") {
		const pending = wait();
		timersDuringWait = native.activeTimers();
		native.fireTimeout(12_000);
		result = await pending;
		timersAfterWait = native.activeTimers();
		child.emit("close", 0);
	} else {
		throw new Error(`task_wait_fixture.scenario=${input.scenario}`);
	}

	const finalTasks = await taskList();
	const exitWakes = exitWakeCount();
	if (!shutDown) { await events.get("session_shutdown")!({}, ctx); shutDown = true; }
	process.stdout.write(JSON.stringify({
		scenario: input.scenario,
		spawns: native.spawns.length,
		signalsBeforeSettle,
		signals: native.signals,
		resultText: result?.content[0]?.text,
		resultAction: result?.details.action,
		resultTask: result?.details.task,
		resultError,
		secondWaitError,
		firstWaitText,
		timersDuringWait,
		timersAfterWait,
		finalTasks,
		exitWakeCount: exitWakes,
		exitNotifiedAfterWait,
		unexpected: native.unexpected,
	}));
} finally {
	try { if (started && !shutDown) await events.get("session_shutdown")!({}, ctx); }
	finally { native.restore(); }
}
