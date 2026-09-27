import { expect, test } from "bun:test";

import { renderManagedBashResult } from "../tool-renderer/managed-bash.js";

// Minimal theme/context stand-ins: the row renderer only styles text and reads
// the tool context for the command, cwd and expansion state.
const theme = {
	bold: (text: string) => text,
	fg: (_token: string, text: string) => text,
	inverse: (text: string) => text,
} as never;

function render(task: Record<string, unknown>, options: { expanded?: boolean; isPartial?: boolean; command?: string } = {}): string {
	const component = renderManagedBashResult({
		args: { command: options.command ?? "bun test" },
		context: { args: { command: options.command ?? "bun test" }, cwd: process.cwd() },
		cwd: process.cwd(),
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
	expect(collapsed, "collapsed rows keep the command preview bounded").not.toContain("# ENDMARK");
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
