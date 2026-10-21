import { useWorld } from "./helpers/world.js";
import { describe, expect, test } from "bun:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { __test } from "../tool-renderer/messages.js";

const ANSI_RE = /\x1b(?:\[[0-9;:]*m|\]133;[ABC]\x07)/g;

const theme = {
	bg(_token: string, text: string) {
		return `\x1b[48;5;236m${text}\x1b[49m`;
	},
	codeBlock(text: string) {
		return text;
	},
	highlightCode(code: string) {
		return code.split("\n");
	},
};

function stripControl(text: string): string {
	return text.replace(ANSI_RE, "");
}

useWorld();

describe("styled markdown code blocks", () => {
	test("render code flush-left with background but no copy gutter", () => {
		const rendered = __test.renderStyledCodeBlock({ type: "code", lang: "bash", text: "echo hi\nprintf ok" }, 20, theme);

		expect(rendered).toHaveLength(2);
		expect(stripControl(rendered[0]!)).toBe("echo hi" + " ".repeat(12));
		expect(stripControl(rendered[1]!)).toBe("printf ok" + " ".repeat(10));
		expect(stripControl(rendered[0]!).startsWith(" ")).toBe(false);
		expect(stripControl(rendered[0]!)).not.toContain("┃");
		expect(stripControl(rendered[0]!)).not.toContain("│");
		expect(rendered[0]!).toContain("\x1b[48;5;236m");
		expect(visibleWidth(rendered[0]!)).toBe(19);
	});

	test("a second theme gets its own highlight of the same code, and a repeat under one theme is served from cache", () => {
		const code = { type: "code", lang: "text", text: "same_code_under_two_themes" };
		let calls = 0;
		const themed = (tag: string) => ({ highlightCode: (text: string) => { calls++; return [`${text}:${tag}`]; } });
		const first = themed("first");
		const second = themed("second");

		expect(stripControl(__test.renderStyledCodeBlock(code, 60, first)[0]!)).toContain(":first");
		expect(stripControl(__test.renderStyledCodeBlock(code, 60, second)[0]!)).toContain(":second");
		const afterTwoThemes = calls;
		__test.renderStyledCodeBlock(code, 60, second);
		expect(calls, "the repeat under the same theme is a cache hit").toBe(afterTwoThemes);
	});
});
