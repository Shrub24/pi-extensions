import { useWorld } from "./helpers/world.js";
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Container, Markdown, visibleWidth } from "@earendil-works/pi-tui";

import { clearPackageConfigCache } from "../tool-renderer/package-config.js";
import { __test, installAssistantMessageRenderer, installMarkdownCodeBlockRenderer } from "../tool-renderer/messages.js";

const ANSI_RE = /\x1b(?:\[[0-9;:]*m|\]133;[ABC]\x07)/g;

const theme = {
	bg(_token: string, text: string) {
		return `\x1b[48;5;236m${text}\x1b[49m`;
	},
	code(text: string) {
		return text;
	},
	codeBlock(text: string) {
		return text;
	},
	highlightCode(code: string) {
		return code.split("\n").map((line) => `\x1b[38;5;250m${line}\x1b[0m`);
	},
};

function stripControl(text: string): string {
	return text.replace(ANSI_RE, "");
}

const world = useWorld();

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

	test("assistant gutter preserves full-width backgrounds on wrapped code rows", () => {
		const { cwd } = world();
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-tool-renderer": { assistantMessageStyle: "agent", styledCodeBlocks: true, thinkingPanel: true } }));
		clearPackageConfigCache();
		const handlers = new Map<string, Array<(...args: any[]) => void>>();
		const pi = {
			on(event: string, handler: (...args: any[]) => void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			emit(event: string, ...args: any[]) { for (const handler of handlers.get(event) ?? []) handler(...args); },
		};
		const uiTheme = { ...theme, fg: (_token: string, text: string) => text, bold: (text: string) => text };
		class AssistantMessageComponent {
			contentContainer = new Container();
			hasToolCalls = false;
			lastMessage: any = { content: [] };
			constructor() {
				this.contentContainer.addChild(new Markdown("```ts\nconst id = 1;\nconst label = \"a deliberately long code string that wraps across the available viewport\";\n```", 0, 0, theme as any));
			}
			render(width: number) { return this.contentContainer.render(width); }
			updateContent(message: any) { this.lastMessage = message; }
		}
		installMarkdownCodeBlockRenderer(pi as any);
		installAssistantMessageRenderer(pi as any, AssistantMessageComponent);
		pi.emit("session_start", {}, { cwd, hasUI: true, ui: { theme: uiTheme } });
		try {
			const component = new AssistantMessageComponent();
			component.updateContent({ content: [{ type: "text", text: "code" }] });
			const lines = component.render(40);
			const codeRows = lines.filter((line) => line.includes("\x1b[48;5;236m"));
			expect(codeRows.length).toBeGreaterThan(1);
			expect(codeRows.every((line) => visibleWidth(line) === 39)).toBe(true);
			expect(codeRows.every((line) => line.startsWith("\x1b[48;5;236m"))).toBe(true);
			expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
			expect(codeRows.every((line) => line.includes("\x1b[49m"))).toBe(true);
			expect(codeRows.some((line) => line.includes("\x1b[0m\x1b[48;5;236m"))).toBe(true);
			expect(codeRows.some((line) => line.includes("const id = 1;"))).toBe(true);
		} finally {
			pi.emit("session_shutdown");
		}
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
