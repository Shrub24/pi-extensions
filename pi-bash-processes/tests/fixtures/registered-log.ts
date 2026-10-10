import { mock } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RegistrationDeps } from "../../extensions/registrations.js";
import type { BackgroundTaskSnapshot } from "../../extensions/types.js";
import { fakeTask } from "./lifecycle.js";

// Peer mocks stay in this child. Production result, snapshot, and log functions run unchanged.
const unused = () => { throw new Error("registered log fixture reached an unrelated operation"); };
mock.module("@earendil-works/pi-ai", () => ({ StringEnum: (values: readonly string[]) => ({ enum: values }) }));
mock.module("typebox", () => ({ Type: { Object: (value: unknown) => value, Optional: (value: unknown) => value, Number: () => ({}), String: () => ({}), Array: () => ({}), Boolean: () => ({}) } }));
mock.module("@earendil-works/pi-tui", () => ({ matchesKey: unused, truncateToWidth: unused, visibleWidth: unused, wrapTextWithAnsi: unused }));
const { applyTaskToolSurface } = await import("../../extensions/registrations.js");
const { buildTaskResultObservation } = await import("../../extensions/task-result.js");
const { taskSnapshot } = await import("../../extensions/snapshot.js");

interface InputRow { tool: string; output: string; task: Partial<BackgroundTaskSnapshot> }
interface Tool {
	name: string;
	execute(id: string, params: { action: "log"; id?: string; pid?: number }): Promise<unknown>;
}
const rows: InputRow[] = JSON.parse(await Bun.stdin.text());
const results = [];
for (const row of rows) {
	const task = fakeTask(row.task);
	const calls: unknown[] = [];
	const tools = new Map<string, Tool>();
	const pi = {
		registerTool(tool: Tool) { tools.set(tool.name, tool); },
		registerCommand() {}, registerShortcut() {},
	} as unknown as ExtensionAPI;
	const observation = buildTaskResultObservation({
		task: { ...task, resultReady: true },
		now: Date.now(),
		outputPreviewChars: 2_000,
		output: { kind: "ok", text: row.output },
		logSettled: true,
	});
	const deps: RegistrationDeps = {
		getActiveCtx: () => ({ cwd: process.cwd() }) as ExtensionContext,
		setActiveCtx: unused,
		rememberSnapshot(value) { calls.push({ rememberSameTask: value === task }); return taskSnapshot(value); },
		sortedTasks: unused, formatTaskListText: unused,
		getTaskOutput(value) { calls.push({ outputSameTask: value === task }); return row.output; },
		readTaskResult(value) { calls.push({ readSameTask: value === task }); return Promise.resolve({ handoff: { observation } }); },
		stopTaskConfirmed: unused,
		consumeObservedExitWake(id: string) { calls.push({ consumedExitWake: id }); return true; },
		resolveTask(id, pid) { calls.push({ id: id ?? null, pid: pid ?? null }); return task; },
		requestStop: unused, spawnTask: unused, clearFinishedTasks: unused,
		armForcedBackground: unused, toggleWidget: unused,
		dashboardDeps: { sortedTasks: unused, getTask: unused, getTaskOutput: unused, requestStop: unused, clearFinishedTasks: unused, formatTaskListText: unused },
		dashboardShortcut: "none", backgroundBashShortcut: "none", widgetToggleShortcut: "none",
	};
	// The compatibility surface, which is the one that declares bg_status at all.
	applyTaskToolSurface(pi, deps, "print");
	const tool = tools.get(row.tool);
	if (!tool) throw new Error(`Missing registered tool: ${row.tool}`);
	const result = await tool.execute("log-call", row.tool === "bg_task" ? { action: "log", id: task.id } : { action: "log", pid: task.pid });
	results.push({ result, calls });
}
process.stdout.write(JSON.stringify(results));
