import { expect, test } from "bun:test";

import { renderFffResult } from "../tool-renderer/fff.js";

const theme = {
	bold: (text: string) => text,
	fg: (token: string, text: string) => text,
	inverse: (text: string) => text,
} as never;

function render(args: Record<string, unknown>, output: string, options: { expanded?: boolean } = {}): string {
	const component = renderFffResult("ffgrep", { content: [{ type: "text", text: output }] }, options, theme, { args, cwd: process.cwd() }, process.cwd()) as { render(width: number): string[] };
	return component.render(120).join("\n");
}

test("fff grep rows match the native grep row shape", () => {
	const line = render({ pattern: "intent", path: "src" }, "src/a.ts:1: intent\nsrc/b.ts:9: intent\n");
	expect(line).toContain("grep");
	expect(line).toContain("grep intent");
	expect(line).toContain("2 matches");
	expect(line).not.toContain("src/a.ts");
});

test("fff grep rows expand to the bounded preview", () => {
	const expanded = render({ pattern: "intent" }, "src/a.ts:1: intent\nsrc/b.ts:9: intent\n", { expanded: true });
	expect(expanded).toContain("src/a.ts");
});

test("empty fff results say so", () => {
	const line = render({ pattern: "nothing" }, "");
	expect(line).toContain("no matches");
});
