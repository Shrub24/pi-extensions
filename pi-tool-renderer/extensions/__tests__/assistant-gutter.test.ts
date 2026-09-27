import { expect, test } from "bun:test";

import { __test } from "../tool-renderer/messages.js";

const theme = {
	bold: (text: string) => text,
	fg: (token: string, text: string) => `<${token}>${text}</>`,
	italic: (text: string) => text,
} as never;

const ROBOT = "\u{f06a9}";

test("agent gutter labels the first line and indents the rest", () => {
	const lines = __test.assistantTextGutterLines(["first line", "second line", "", "fourth"], 40, theme, undefined, "agent");
	expect(lines[0]).toContain(ROBOT);
	expect(lines[0]).toContain("first line");
	expect(lines[1]).toContain("second line");
	expect(lines[1]).not.toContain(ROBOT);
	expect(lines[2], "blank rows stay clean").toBe("");
	expect(lines[3]).not.toContain(ROBOT);
});

test("bar gutter marks every non-blank line", () => {
	const lines = __test.assistantTextGutterLines(["a", "b"], 40, theme, undefined, "bar");
	expect(lines.every((line) => line.includes("\u258f"))).toBe(true);
});

test("a long line is re-wrapped to the gutter width", () => {
	const long = "x".repeat(60);
	const lines = __test.assistantTextGutterLines([long], 20, theme, undefined, "bar");
	expect(lines.length).toBeGreaterThan(1);
	for (const line of lines) {
		expect(line.replace(/<[^>]+>/g, "").length).toBeLessThanOrEqual(20);
	}
});
