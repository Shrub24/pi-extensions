import { beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { newStackItem, renderStackItemText, setStackItemResultText } from "../tool-renderer/stack.js";
import { commandExit } from "../tool-renderer/text.js";
import { clearPackageConfigCache } from "../tool-renderer/package-config.js";
import { registerBash } from "../tool-renderer/tools.js";
import { useWorld } from "./helpers/world.js";

const world = useWorld();
const theme = { fg: (color: string, text: string) => `[${color}]${text}[/]`, bold: (text: string) => text } as Theme;
let definition: ToolDefinition;
beforeEach(() => {
	registerBash({ registerTool: (tool: ToolDefinition) => { definition = tool; } } as ExtensionAPI, {
		createBashTool: () => ({ description: "fixture", parameters: {}, execute: async () => ({ content: [] }) }),
	}, world().cwd);
});

const cases = [
	{ name: "success", text: "hello", isError: false, status: "exit 0" },
	{ name: "success mentioning an exit code", text: "the manual says exit 99", isError: false, status: "exit 0" },
	{ name: "success printing Pi's footer", text: "Command exited with code 99", isError: false, status: "exit 0" },
	{ name: "nonzero exit", text: "failure\n\nCommand exited with code 23", isError: true, status: "exit 23" },
	{ name: "timeout", text: "Command timed out after 1 seconds", isError: true, status: "failed" },
	{ name: "cancellation", text: "Command aborted", isError: true, status: "failed" },
];
for (const row of cases) {
	test(`standalone status: ${row.name}`, () => {
		const output = definition.renderResult!(
			{ content: [{ type: "text", text: row.text }], details: undefined },
			{ expanded: false, isPartial: false }, theme,
			{ args: { command: "probe" }, cwd: world().cwd, state: {}, isError: row.isError, toolCallId: row.name,
				executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false, invalidate() {} },
		).render(200).join("\n");
		expect(output).toContain(`[${row.isError ? "error" : "success"}]${row.status}[/]`);
	});
	test(`grouped status: ${row.name}`, () => {
		const item = newStackItem("bash", row.name, { command: "probe" }, "batch");
		setStackItemResultText(item, row.text, row.isError, false);
		const output = renderStackItemText(item, theme, false, world().cwd);
		expect(output).toContain(row.isError ? "[error]failed[/]" : "[success]exit 0[/]");
	});
}

for (const [text, expected] of [
	["output\n\nCommand exited with code 23", 23],
	["output\r\n\r\nCommand exited with code 23\r\n", 23],
	["the manual says exit 99", null],
	["Command exited with code 23\nmore output", null],
] as const) {
	test(`exit footer: ${JSON.stringify(text)}`, () => expect(commandExit(text)).toBe(expected));
}

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const stripStyles = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("a finished bash row puts the command on its own line below the head", () => {
	const drawn = definition.renderResult!(
		{ content: [{ type: "text", text: "hello" }], details: undefined } as any,
		{ expanded: false, isPartial: false } as any,
		plainTheme,
		{ args: { command: "echo hello", intent: "say hello" }, isError: false, isPartial: false, cwd: world().cwd } as any,
	);
	const lines = stripStyles(drawn.render(80).join("\n")).split("\n");
	expect(lines[0]).toContain("Bash — say hello");
	expect(lines[1]).toContain("$ echo hello");
	expect(lines[0]).not.toContain("echo hello");
});

test("a finished one-line bash result stays visible in the collapsed row", () => {
	const drawn = definition.renderResult!(
		{ content: [{ type: "text", text: "hi" }], details: undefined } as any,
		{ expanded: false, isPartial: false } as any,
		plainTheme,
		{ args: { command: "echo hi" }, isError: false, isPartial: false, cwd: world().cwd } as any,
	);
	expect(stripStyles(drawn.render(80).join("\n"))).toContain("hi");
});

function setRendererSettings(settings: Record<string, unknown>): void {
	writeFileSync(join(world().cwd, ".pi", "settings.json"), JSON.stringify({ "pi-tool-renderer": settings }));
	clearPackageConfigCache();
}

function renderFinished(command: string, output: string, expanded = false): string {
	const drawn = definition.renderResult!(
		{ content: [{ type: "text", text: output }], details: undefined } as any,
		{ expanded, isPartial: false } as any,
		plainTheme,
		{ args: { command }, isError: false, isPartial: false, cwd: world().cwd } as any,
	);
	return stripStyles(drawn.render(80).join("\n"));
}

test("opencode is the former name of preview and collapses to five output lines", () => {
	setRendererSettings({ bashOutputMode: "opencode" });
	const output = Array.from({ length: 12 }, (_value, index) => `row ${index + 1}`).join("\n");
	const collapsed = renderFinished("seq 12", output);
	expect(collapsed).toContain("row 12");
	expect(collapsed).toContain("row 8");
	expect(collapsed, "rows before the last five are hidden").not.toContain("row 7");
});

test("a multi-line command shows its first line and an ellipsis when collapsed", () => {
	setRendererSettings({});
	const command = "set -e\nfor i in 1 2 3; do\n  echo $i\ndone";
	const collapsed = renderFinished(command, "1\n2\n3");
	expect(collapsed).toContain("$ set -e…");
	expect(collapsed).not.toContain("for i in");
	expect(renderFinished(command, "1\n2\n3", true)).toContain("done");
});
