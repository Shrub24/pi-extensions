import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { __test } from "../tool-renderer/chrome.js";
import { stripAnsi } from "../tool-renderer/ansi.js";

const BG = "\u001b[48;5;236m";
const theme = {
	bg: (_token: string, text: string) => `${BG}${text}\u001b[49m`,
	bold: (text: string) => text,
	fg: (_token: string, text: string) => text,
} as never;

function component(state: Record<string, unknown> = {}) {
	return { cwd: process.cwd(), isPartial: false, result: { isError: false }, toolCallId: "t", toolName: "Bash", ...state };
}

test("panel chrome fills each row edge to edge with the state background and adds no rules", () => {
	const lines = __test.renderPanelChrome(component(), ["● Bash $ echo hi", "hi", ""], theme, 40);
	expect(lines.length).toBe(3);
	for (const line of lines) {
		expect(line).toContain(BG);
		expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		expect(visibleWidth(line)).toBe(39);
	}
	expect(lines.join("\n")).not.toContain("─");
});

test("panel chrome without a theme degrades to the core rows", () => {
	const lines = __test.renderPanelChrome(component(), ["hi"], undefined, 20);
	expect(lines).toEqual(["hi"]);
});
