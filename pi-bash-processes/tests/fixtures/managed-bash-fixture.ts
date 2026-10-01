import { mock } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { DEFAULT_FOREGROUND_YIELD_MS, MANAGED_BASH_PARTIAL_UPDATE_MS } from "../../extensions/constants.js";
import { interceptNativeEffects } from "./spawn-native.js";

// Extension-level fixture for the bounded managed-Bash v1 tool. Reuses the
// spawn-native interception (fake child, manually-fired timers) so every
// timing path is deterministic: no real subprocess, no real waiting.
interface Input { scenario: "abort" | "fast" | "slow" | "timeout"; command?: string; timeout?: number; showWidget?: boolean }
const input: Input = JSON.parse(await Bun.stdin.text());
const native = await interceptNativeEffects({});
const unused = () => { throw new Error("managed_bash_fixture.sdk_operation=unexpected_render"); };
mock.module("@earendil-works/pi-ai", () => ({ StringEnum: (values: readonly string[]) => ({ enum: values }) }));
mock.module("typebox", () => ({ Type: { Object: (value: unknown) => value, Optional: (value: unknown) => value, Number: () => ({}), String: () => ({}), Boolean: () => ({}) } }));
// Widget rendering is asserted, so the width helpers must work; every other
// host render entry point stays guarded against unexpected use.
mock.module("@earendil-works/pi-tui", () => ({
	matchesKey: unused,
	truncateToWidth: (text: string, width: number) => text.slice(0, width),
	visibleWidth: (text: string) => text.length,
	wrapTextWithAnsi: (text: string) => [text],
}));
mock.module("@earendil-works/pi-coding-agent", () => ({ getShellConfig: () => ({ shell: "fixture-shell", args: ["-c"] }) }));

interface ToolResult { content: { type: string; text: string }[]; details: { action: string; task?: Record<string, unknown> } }
interface Tool { name: string; execute(id: string, params: Record<string, unknown>, ...rest: unknown[]): Promise<ToolResult> }
const tools = new Map<string, Tool>();
const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
const messages: unknown[][] = [];
// The widget is the surface under test for foreground-vs-background claims:
// capture whatever the extension installs so the fixture can render it.
const widgets = new Map<string, unknown>();
const widgetTheme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };
const widgetTui = { terminal: { rows: 40 }, requestRender() {} };
const widgetLines = (): string => {
	const factory = widgets.get("kendex-mini-dashboard-stack-above");
	if (typeof factory !== "function") return "";
	try {
		const component = (factory as (tui: unknown, theme: unknown) => { render(width: number): string[] })(widgetTui, widgetTheme);
		return component.render(120).join("\n");
	} catch (error) {
		return `widget-render-error: ${error instanceof Error ? error.message : String(error)}`;
	}
};
const ctx = {
	cwd: process.cwd(), hasUI: true, isProjectTrusted: () => true,
	sessionManager: { getSessionId: () => "managed-bash-session", getSessionFile: () => join(process.cwd(), "session.jsonl"), getBranch: () => [] },
	ui: {
		notify() {},
		setWidget(key: string, factory: unknown) {
			if (factory) widgets.set(key, factory);
			else widgets.delete(key);
		},
	},
} as unknown as ExtensionContext;
const pi = {
	registerTool(tool: Tool) { tools.set(tool.name, tool); },
	registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { events.set(event, handler); },
	appendEntry() {},
	sendMessage: (...args: unknown[]) => messages.push(args),
} as unknown as ExtensionAPI;

// Stale inherited values must never shadow the live session in the spawn env.
process.env.PI_SESSION_ID = "stale-session";
process.env.PI_MODEL = "stale-model";

let started = false;
let shutDown = false;
try {
	const { default: backgroundTasks } = await import("../../extensions/background-tasks.js");
	backgroundTasks(pi);
	const managedBashPublished = Boolean((globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("kendex.background-tasks.managed-bash")]);
	await events.get("session_start")!( {}, ctx);
	started = true;
	const bash = tools.get("bash");
	if (!bash) throw new Error("managed_bash_fixture.tool_missing=bash");
	const bgTask = tools.get("bg_task");
	if (!bgTask) throw new Error("managed_bash_fixture.tool_missing=bg_task");

	const controller = new AbortController();
	// A real onUpdate callback, like the TUI passes: the streaming path must be
	// exercised, not skipped because the fixture sent undefined.
	const partialUpdates: unknown[] = [];
	const command = input.command ?? "fixture command";
	const pending = bash.execute("bash-call-1", { command, ...(input.timeout !== undefined ? { timeout: input.timeout } : {}) }, controller.signal, (partial: unknown) => partialUpdates.push(partial), ctx);
	let settled = false;
	void pending.then(() => { settled = true; }, () => {});
	const widgetDuringForeground = widgetLines();
	const spawnsAfterExecute = native.spawns.length;
	const signalsBeforeSettle = [...native.signals];
	const child = native.children[0];
	if (!child) throw new Error("managed_bash_fixture.spawn_missing");

	let result: ToolResult | undefined;
	let resultError: string | undefined;
	if (input.scenario === "abort") {
		controller.abort();
		try { result = await pending; }
		catch (error) { resultError = error instanceof Error ? error.message : String(error); }
		child.emit("close", null);
		await Promise.resolve();
	} else if (input.scenario === "fast") {
		child.stdout.emit("data", Buffer.from(input.scenario === "fast" && input.command?.includes("| tail") ? "one\ntwo\n" : "fast-output\n"));
		child.emit("close", 0);
		try { result = await pending; }
		catch (error) { resultError = error instanceof Error ? error.message : String(error); }
	} else if (input.scenario === "slow") {
		// The soft reminder is a separate budget from the foreground yield; match
		// the yield timer exactly so the assertion stays about this scenario.
		const yieldMs = native.activeTimers().filter((timer) => timer.kind === "timeout" && timer.ms === DEFAULT_FOREGROUND_YIELD_MS).map((timer) => timer.ms);
		if (yieldMs.length !== 1) throw new Error(`managed_bash_fixture.yield_timer_count=${yieldMs.length}`);
		// Streaming: output produced inside the foreground window must reach the
		// TUI through onUpdate before the yield, not only in the final result.
		child.stdout.emit("data", Buffer.from("streamed-line\n"));
		native.fireInterval(MANAGED_BASH_PARTIAL_UPDATE_MS);
		if (partialUpdates.length === 0) throw new Error("managed_bash_fixture.partial_update_missing");
		native.fireTimeout(yieldMs[0]!);
		result = await pending;
		const listed = await bgTask.execute("list-1", { action: "list" });
		const runningState = (listed.details as { tasks: Record<string, unknown>[] }).tasks[0];
		if (settled !== true) throw new Error("managed_bash_fixture.yield_not_settled");		// Same process continues: no second spawn, still running, same pid.
		if (native.spawns.length !== 1) throw new Error(`managed_bash_fixture.respawned=${native.spawns.length}`);
		if (runningState?.status !== "running") throw new Error(`managed_bash_fixture.status=${String(runningState?.status)}`);
		child.emit("close", 0);
		// The exit wake waits for the task's log to hold its output, so let the
		// captured writes settle before the next turn boundary is dispatched.
		const { taskLogs } = await import("../../extensions/log-writer.js");
		await taskLogs.drain();
		await Promise.resolve();
	} else {
		if (native.signals.length !== 0) throw new Error("managed_bash_fixture.early_kill");
		const timeoutTimers = native.activeTimers().filter((timer) => timer.kind === "timeout" && timer.ms === 50);
		if (timeoutTimers.length !== 1) throw new Error(`managed_bash_fixture.timeout_timer_count=${timeoutTimers.length}`);
		native.fireTimeout(50);
		child.emit("close", null);
		try { result = await pending; }
		catch (error) { resultError = error instanceof Error ? error.message : String(error); }
	}

	// Renderer-degradation contract: with no renderer module present, the bash
	// tool must still return renderable components, never undefined.
	const callComponent = (bash as unknown as { renderCall?: (...a: unknown[]) => unknown }).renderCall?.({ command: "x" }, {}, ctx);
	const resultComponent = (bash as unknown as { renderResult?: (...a: unknown[]) => unknown }).renderResult?.({ content: [{ type: "text", text: "out" }] }, { expanded: false, isPartial: false }, {}, ctx);
	const renderable = (component: unknown) => Boolean(component) && typeof (component as { render?: unknown }).render === "function";

	await events.get("before_agent_start")!({}, ctx);
	const widgetAfterSettle = widgetLines();

	const listed = await bgTask.execute("list-2", { action: "list" });
	const tasks = (listed.details as { tasks: Record<string, unknown>[] }).tasks;
	const exitWakes = messages.filter((args) => {
		const message = args[0] as { details?: { eventType?: string; task?: { id?: string } } };
		return message?.details?.eventType === "exit" && message?.details?.task?.id === "bg-1";
	});
	const spawnEnv = native.spawns[0]?.options.env as NodeJS.ProcessEnv;
	if (!shutDown) { await events.get("session_shutdown")!({}, ctx); shutDown = true; }
	const managedBashCleared = !Boolean((globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("kendex.background-tasks.managed-bash")]);
	process.stdout.write(JSON.stringify({
		scenario: input.scenario,
		managedBashPublished,
		callRenderable: renderable(callComponent),
		partialTexts: partialUpdates.map((partial) => {
			const content = (partial as { content?: { text?: string }[] }).content;
			return content?.[0]?.text ?? "";
		}),
		widgetDuringForeground,
		widgetAfterSettle,
		widgetKeys: [...widgets.keys()],
		resultRenderable: renderable(resultComponent),
		managedBashCleared,
		spawns: native.spawns.length,
		spawnsAfterExecute,
		signalsBeforeSettle,
		signals: native.signals,
		resultText: result?.content[0]?.text,
		resultAction: result?.details.action,
		resultTask: result?.details.task,
		resultError,
		composedCommand: command,
		finalTasks: tasks,
		exitWakeCount: exitWakes.length,
		env: { PI_SESSION_ID: spawnEnv?.PI_SESSION_ID, PI_SESSION_FILE: spawnEnv?.PI_SESSION_FILE, PI_PROVIDER: spawnEnv?.PI_PROVIDER, PI_MODEL: spawnEnv?.PI_MODEL, PI_REASONING_LEVEL: spawnEnv?.PI_REASONING_LEVEL, PATH: typeof spawnEnv?.PATH === "string" },
		unexpected: native.unexpected,
		remainingTimers: native.activeTimers(),
	}));
} finally {
	try { if (started && !shutDown) await events.get("session_shutdown")!({}, ctx); }
	finally { native.restore(); }
}
