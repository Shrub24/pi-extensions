import { mock } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

// Runtime-degradation fixture: the optional managed-bash presentation module is
// unavailable, exactly as it is in a deployment whose bundle did not carry it, so
// the extension's own lazy import fails. The regression is about what that costs:
// the rich row, never the row itself.
const PRESENTATION = "@vanillagreen/pi-tool-renderer/managed-bash";
const input: { command?: string; output?: string } = JSON.parse(await Bun.stdin.text());
mock.module(PRESENTATION, () => { throw new Error(`Cannot find package '${PRESENTATION}'`); });

const unused = () => { throw new Error("bash fallback fixture reached an unexpected host operation"); };
mock.module("@earendil-works/pi-ai", () => ({ StringEnum: (values: readonly string[]) => ({ enum: values }) }));
mock.module("typebox", () => ({ Type: { Object: (value: unknown) => value, Optional: (value: unknown) => value, Number: () => ({}), String: () => ({}), Boolean: () => ({}) } }));
mock.module("@earendil-works/pi-tui", () => ({
	matchesKey: unused,
	truncateToWidth: (text: string, width: number) => text.slice(0, width),
	visibleWidth: (text: string) => text.length,
	wrapTextWithAnsi: (text: string) => [text],
}));
mock.module("@earendil-works/pi-coding-agent", () => ({ getShellConfig: () => ({ shell: "fixture-shell", args: ["-c"] }) }));

interface Component { render(width: number): string[] }
interface BashTool {
	renderCall(args: unknown, theme: unknown, context: unknown): Component | undefined;
	renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): Component | undefined;
}

const tools = new Map<string, unknown>();
const pi = {
	appendEntry() {}, registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
	registerTool(tool: unknown) { tools.set((tool as { name: string }).name, tool); },
	on() {}, sendMessage() {},
} as unknown as ExtensionAPI;
const ctx = {
	cwd: process.cwd(), hasUI: true, isProjectTrusted: () => true,
	sessionManager: { getBranch: () => [], getSessionFile: () => join(process.cwd(), "session.jsonl"), getSessionId: () => "bash-fallback-session" },
	ui: { notify() {}, setWidget() {} },
} as unknown as ExtensionContext;
const theme = { bold: (text: string) => text, fg: (_token: string, text: string) => text };

// Recorded before the extension loads, so the premise is evidence rather than
// an assumption: this run really is the missing-module path.
let presentationImportError: string | undefined;
try {
	await import(PRESENTATION);
} catch (error) {
	presentationImportError = error instanceof Error ? error.message : String(error);
}

const { default: backgroundTasks } = await import("../../extensions/background-tasks.js");
backgroundTasks(pi);
const bash = tools.get("bash") as BashTool | undefined;
if (!bash) throw new Error("bash_fallback_fixture.tool_missing=bash");

const command = input.command ?? "nix build .#pi-bolt --no-link --print-out-paths";
const lines = (component: Component | undefined, width = 200): string[] => {
	if (!component || typeof component.render !== "function") throw new Error("bash_fallback_fixture.unrenderable_component");
	return component.render(width);
};
const textResult = (text: string, isError = false) => ({ content: [{ type: "text", text }], details: { action: "bash" }, isError });
const denials = [
	"Permission denied: bash requires approval for this command",
	...Array.from({ length: 200 }, (_, index) => `denial-detail-${index}`),
].join("\n");
const successes = Array.from({ length: 200 }, (_, index) => `out-line-${index}`).join("\n");

process.stdout.write(JSON.stringify({
	bashRegistered: true,
	presentationImportError,
	call: lines(bash.renderCall({ command }, theme, ctx)),
	blockedBeforeExecution: lines(bash.renderResult(textResult("", true), { expanded: false }, theme, { args: { command }, cwd: ctx.cwd, isError: true })),
	denied: lines(bash.renderResult(textResult(denials, true), { expanded: false, isPartial: false }, theme, { args: { command }, cwd: ctx.cwd, isError: true })),
	successCollapsed: lines(bash.renderResult(textResult(input.output ?? successes), { expanded: false, isPartial: false }, theme, { args: { command }, cwd: ctx.cwd })),
	successExpanded: lines(bash.renderResult(textResult(input.output ?? successes), { expanded: true, isPartial: false }, theme, { args: { command }, cwd: ctx.cwd })),
}));
