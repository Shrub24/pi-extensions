import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyTaskToolSurface, type RegistrationDeps } from "../extensions/registrations.js";
import { settingNumber } from "../extensions/settings.js";
import { taskSnapshot } from "../extensions/snapshot.js";
import { buildTaskResultObservation } from "../extensions/task-result.js";
import type { ManagedTask } from "../extensions/types.js";
import { fakeTask } from "./fixtures/lifecycle.js";

// The TUI presentation of `bg_task action:"get"`. `content` is the model's copy
// of the result — a multiline transcript of id, metadata, preview and
// acknowledgment. The renderer owns the operator's copy, so the two must not be
// the same text: a get that prints `content` verbatim is the missing-renderer
// fallback, not a rendering.
//
// Factual theme: this suite asserts information, not styling.
const theme = {
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	fg: (_token: string, text: string) => text,
	inverse: (text: string) => text,
} as never;

const CWD = "/private/nix";
const unused = () => { throw new Error("bg get render test reached an unrelated operation"); };

interface ToolResult {
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
}

interface RegisteredTool {
	name: string;
	execute(callId: string, params: Record<string, unknown>): Promise<ToolResult>;
	renderResult(result: ToolResult, options: Record<string, unknown>, theme: unknown, context: Record<string, unknown>): { render(width: number): string[] };
}

const BODY = Array.from({ length: 120 }, (_, index) => `/nix/store/out-${index}`).join("\n");

/** A registered `bg_task` whose `get` reads one prepared result, shelled in as the shared operation does. */
function registeredBgTask(options: { artifact?: boolean; captureError?: string; output?: string } = {}): RegisteredTool {
	const output = options.output ?? BODY;
	const task: ManagedTask = fakeTask({
		command: "nix build .#pi-bolt --no-link --print-out-paths",
		cwd: CWD,
		exitCode: 0,
		id: "bg-24",
		outputBytes: output.length,
		pid: 4242,
		resultReady: true,
		softTimeoutMs: 600_000,
		startedAt: 1_000_000,
		status: "completed",
		title: "nix build",
		updatedAt: 1_055_000,
	});
	const observation = buildTaskResultObservation({
		task,
		now: 1_055_000,
		outputPreviewChars: 200_000,
		output: { ok: true, output },
		logSettled: true,
	});
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerCommand() {},
		registerShortcut() {},
		registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
	} as unknown as ExtensionAPI;
	const deps: RegistrationDeps = {
		dashboardDeps: { clearFinishedTasks: unused, formatTaskListText: unused, getTask: unused, getTaskOutput: unused, requestStop: unused, sortedTasks: unused },
		dashboardShortcut: "none",
		backgroundBashShortcut: "none",
		widgetToggleShortcut: "none",
		armForcedBackground: unused,
		clearFinishedTasks: unused,
		consumeObservedExitWake: () => true,
		extendSoftTimeout: unused,
		formatTaskListText: unused,
		getActiveCtx: () => null,
		getTaskOutput: () => output,
		oldestRunningTask: () => null,
		readTaskResult: () => Promise.resolve({
			ack: { acknowledged: true, committed: "terminal", reviewed: false },
			handoff: {
				...(options.artifact === false ? {} : { artifact: { bytes: observation.outputBytes, complete: true, partial: false, path: "/private/lane/bg-24.log" } }),
				captureError: options.captureError,
				observation,
			},
		}),
		rememberSnapshot: taskSnapshot,
		requestStop: unused,
		resolveTask: () => task,
		setActiveCtx: unused,
		similarRunningTasks: unused,
		sortedTasks: () => [task],
		spawnTask: unused,
		stopTaskConfirmed: unused,
		toggleWidget: unused,
		waitForTask: unused,
	};
	applyTaskToolSurface(pi, deps, "tui");
	const tool = tools.get("bg_task");
	if (!tool) throw new Error("bg_task was not registered for the tui surface");
	return tool;
}

async function renderedGet(expanded: boolean, options: Parameters<typeof registeredBgTask>[0] = {}): Promise<string[]> {
	const tool = registeredBgTask(options);
	const result = await tool.execute("get-call", { action: "get", id: "bg-24", output: options.artifact === false ? "preview" : "full" });
	return tool.renderResult(result, { expanded }, theme, { args: { action: "get", id: "bg-24" }, cwd: CWD }).render(120);
}

/** The lines only the model-facing result text carries. */
const RAW_RESULT_LINES = [
	"elapsed (terminal)",
	"command: nix build",
	"cwd: /private/nix",
	"next review:",
	"output: full immutable snapshot",
	"acknowledged:",
];

test("a collapsed get renders a task row, not the model-facing result text", async () => {
	const lines = await renderedGet(false);
	const text = lines.join("\n");
	expect(text, "the row identifies the task and its outcome").toContain("bg-24");
	expect(text).toContain("completed (exit 0)");
	for (const raw of RAW_RESULT_LINES) {
		expect(text, `a collapsed get must not print the raw result line "${raw}"`).not.toContain(raw);
	}
	expect(lines.length, "a collapsed row is a row, not a dump").toBeLessThanOrEqual(3);
	expect(text, "a collapsed row shows a bounded window, not the capture").not.toContain("/nix/store/out-50");
});

test("an expanded get shows the task, the output, and where the rest is", async () => {
	const lines = await renderedGet(true);
	const text = lines.join("\n");
	expect(text, "the command is readable, not only in the transcript text").toContain("nix build .#pi-bolt");
	expect(text, "so is the working directory").toContain(CWD);
	expect(text, "the newest output is in the expanded view").toContain("/nix/store/out-119");
	expect(text, "the complete capture is named").toContain("/private/lane/bg-24.log");
	for (const raw of RAW_RESULT_LINES) {
		expect(text, `an expanded get must not print the raw result line "${raw}"`).not.toContain(raw);
	}
	const limit = Math.max(1, Math.floor(settingNumber("toolExpandedLogLines", 80, CWD)));
	expect(lines.length, "an expanded get is bounded by the configured log-line limit").toBeLessThanOrEqual(limit + 8);
});

test("a preview read points at the full read, and a missing capture is never a clean success", async () => {
	const preview = (await renderedGet(true, { artifact: false })).join("\n");
	expect(preview, "a preview without a snapshot still names the full read").toContain('bg_task get output:"full"');
	expect(preview).toContain("/nix/store/out-119");

	const uncertified = (await renderedGet(true, { captureError: "the retained capture is not certified complete" })).join("\n");
	expect(uncertified, "an uncertified capture is reported as one").toContain("not certified complete");
});
