import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { clearPackageConfigCache } from "../tool-renderer/package-config.js";
import { renderManagedBashCall, renderManagedBashResult } from "../tool-renderer/managed-bash.js";
import { useWorld } from "./helpers/world.js";

const world = useWorld();

// Minimal theme/context stand-ins: the row renderer only styles text and reads
// the tool context for the command, cwd and expansion state.
const theme = {
	bold: (text: string) => text,
	fg: (_token: string, text: string) => text,
	inverse: (text: string) => text,
} as never;

function render(task: Record<string, unknown>, options: { expanded?: boolean; isPartial?: boolean; command?: string } = {}): string {
	const cwd = world().cwd;
	const component = renderManagedBashResult({
		args: { command: options.command ?? "bun test" },
		context: { args: { command: options.command ?? "bun test" }, cwd },
		cwd,
		expanded: options.expanded ?? false,
		isPartial: options.isPartial ?? false,
		// The runner row is driven by task state, never by the result text.
		result: { content: [{ type: "text", text: "ignored when a task is present" }], details: {} },
		task: {
			elapsedMs: 12_000,
			exitCode: 0,
			id: "bg-7",
			lineCount: 40,
			logFile: "/tmp/kendex-pi-bg/bg-7.log",
			status: "running",
			tail: Array.from({ length: 40 }, (_value, index) => `line ${index + 1}`).join("\n"),
			...task,
		},
		theme,
	}) as { render(width: number): string[] };
	return component.render(120).join("\n");
}

test("a running task row reports live state, its id, and only the recent tail", () => {
	const line = render({});
	expect(line).toContain("running");
	expect(line).toContain("bg-7");
	expect(line).toContain("line 40");
	expect(line, "collapsed rows keep the bounded tail").not.toContain("line 1\n");
});

test("expanding a task row shows the whole tail, the log path and the untruncated command", () => {
	const longCommand = `echo ${"x".repeat(200)} # ENDMARK`;
	const collapsed = render({}, { command: longCommand });
	const expanded = render({}, { command: longCommand, expanded: true });
	expect(expanded).toContain("line 1\n");
	expect(expanded).toContain("bg-7.log");
	expect(expanded).toContain("# ENDMARK");
	expect(collapsed, "a single-line command is not cut when no character cap is set").toContain("# ENDMARK");
});

test("a character cap bounds the collapsed command only when commandPreviewChars is set", () => {
	const longCommand = `echo ${"x".repeat(200)} # ENDMARK`;
	writeFileSync(join(world().cwd, ".pi", "settings.json"), JSON.stringify({ "pi-tool-renderer": { commandPreviewChars: 60 } }));
	clearPackageConfigCache();
	const collapsed = render({}, { command: longCommand });
	const expanded = render({}, { command: longCommand, expanded: true });
	expect(collapsed).not.toContain("# ENDMARK");
	expect(collapsed).toContain("…");
	expect(expanded, "expanded rows show the full command").toContain("# ENDMARK");
});

test("a multi-line command stays on one header line unless expanded", () => {
	const command = `set -e\nfor i in 1 2 3; do\n  echo "$i"\ndone`;
	const collapsed = render({}, { command });
	const expanded = render({}, { command, expanded: true });
	expect(collapsed).toContain("set -e…");
	expect(collapsed).not.toContain("for i in 1 2 3");
	expect(expanded).toContain("done");
});

test("a finished task row shows its exit code, not the running state", () => {
	const line = render({ elapsedMs: 1_500, exitCode: 2, status: "failed" });
	expect(line).toContain("exit 2");
	expect(line).not.toContain("running");
});

/**
 * Pi renders the call component and the partial result component of one tool
 * call side by side, so anything both of them draw appears twice in the
 * transcript. A command inside its foreground window must be drawn once: by the
 * call row, which is the only one that knows the row is still live.
 */
test("a running call draws the head and command, and its streamed output is only the tail", () => {
	const cwd = world().cwd;
	const args = { command: "bun test", intent: "Run the suite" };
	const state: Record<string, unknown> = {};
	const context = { args, cwd, executionStarted: true, argsComplete: true, isPartial: true, expanded: false, state, invalidate() {} };
	const live = { elapsedMs: 12_000, exitCode: null, id: "bg-7", lineCount: 40, logFile: "/tmp/kendex-pi-bg/bg-7.log", status: "running", tail: "streamed output" };

	const callRow = renderManagedBashCall({ args, context, cwd, theme, task: live }).render(120).join("\n");
	expect(callRow).toContain("running");
	expect(callRow).toContain("12s");
	expect(callRow).toContain("40 lines");
	expect(callRow).toContain("bun test");
	expect(callRow, "a foreground command is not claimed as a background task").not.toContain("bg-7");

	// Past the live-tail delay, so the streamed tail is what the row would show.
	state.kendexBashLiveTail = { startedAt: Date.now() - 2_000 };
	const streamed = renderManagedBashResult({
		args,
		context,
		cwd,
		expanded: false,
		isPartial: true,
		result: { content: [{ type: "text", text: "streamed output\n" }], details: { action: "bash" } },
		theme,
	}).render(120).join("\n");
	expect(streamed.trim()).toBe("streamed output");
	expect(streamed, "the streamed row repeats neither the head nor the command").not.toContain("bun test");
	expect(`${callRow}\n${streamed}`.match(/bun test/g)?.length, "the command appears once in the row").toBe(1);
});

test("expanding a running call shows the whole live tail", () => {
	const cwd = world().cwd;
	const args = { command: "bun test" };
	const tail = Array.from({ length: 30 }, (_value, index) => `out ${index + 1}`).join("\n");
	const streamed = (expanded: boolean): string => renderManagedBashResult({
		args,
		context: { args, cwd, expanded, state: { kendexBashLiveTail: { startedAt: Date.now() - 2_000 } }, invalidate() {} },
		cwd,
		expanded,
		isPartial: true,
		result: { content: [{ type: "text", text: `${tail}\n` }], details: {} },
		theme,
	}).render(120).join("\n");
	expect(streamed(false), "collapsed rows keep the live-tail budget").not.toContain("out 1\n");
	expect(streamed(false)).toContain("out 30");
	expect(streamed(true), "expanded rows show the full tail").toContain("out 1\n");
});

import { renderManagedBashResult as renderPlain } from "../tool-renderer/managed-bash.js";

test("a foreground row shows exit, lines and duration with a single bullet", () => {
	const component = renderPlain({
		args: { command: "echo hi" },
		context: { args: { command: "echo hi" }, cwd: process.cwd() },
		cwd: process.cwd(),
		expanded: false,
		isPartial: false,
		result: {
			content: [{ type: "text", text: "hi\n" }],
			details: { task: { startedAt: 1_000_000, updatedAt: 1_002_000, status: "completed" } },
		},
		task: undefined,
		theme,
	}) as { render(width: number): string[] };
	const line = component.render(120).join("\n");
	expect(line).toContain("exit 0");
	expect(line).toContain("2s");
	expect(line.match(/●|•/g)?.length, "exactly one chrome bullet").toBe(1);
});
