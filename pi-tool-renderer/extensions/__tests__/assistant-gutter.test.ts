import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Container, Markdown, MouseRegion, visibleWidth } from "@earendil-works/pi-tui";

import { clearPackageConfigCache } from "../tool-renderer/package-config.js";
import { __test, installAssistantMessageRenderer } from "../tool-renderer/messages.js";
import { useWorld } from "./helpers/world.js";

const theme = {
	bg: (_token: string, text: string) => `\x1b[48;5;236m${text}\x1b[49m`,
	bold: (text: string) => text,
	fg: (_token: string, text: string) => text,
	italic: (text: string) => text,
} as never;

const ROBOT = "\u{f06a9}";
const world = useWorld();

const markdownTheme = {
	bold: (text: string) => text,
	code: (text: string) => text,
	codeBlock: (text: string) => text,
	codeBlockBorder: (text: string) => text,
	heading: (text: string) => text,
	italic: (text: string) => text,
	link: (text: string) => text,
	linkUrl: (text: string) => text,
	quote: (text: string) => text,
	quoteBorder: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
	listBullet: (text: string) => text,
	hr: (text: string) => text,
};

test("agent gutter labels the first line and indents the rest", () => {
	const lines = __test.assistantTextGutterLines(["first line", "second line", "", "fourth"], theme, undefined, "agent");
	expect(lines[0]).toContain(ROBOT);
	expect(lines[0]).toContain("first line");
	expect(lines[1]).toContain("second line");
	expect(lines[1]).not.toContain(ROBOT);
	expect(lines[2], "blank rows stay clean").toBe("");
	expect(lines[3]).not.toContain(ROBOT);
});

test("bar gutter marks every non-blank line", () => {
	const lines = __test.assistantTextGutterLines(["a", "b"], theme, undefined, "bar");
	expect(lines.every((line) => line.includes("\u258f"))).toBe(true);
});

test("assistant prose is laid out once at the width left by the agent gutter", () => {
	const { cwd } = world();
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-tool-renderer": { assistantMessageStyle: "agent" } }));
	clearPackageConfigCache();
	const handlers = new Map<string, (...args: any[]) => void>();
	class AssistantMessageComponent {
		contentContainer = new Container();
		hasToolCalls = false;
		lastMessage: any = { content: [] };
		constructor() {
			this.contentContainer.addChild(new Markdown("One schema note: upstream's ConfigProfileSchema is .strict() with historian/dreamer only, where pi: there means ProfilePiModelBlockSchema. Our top-level profile pi block (subagent_prompt) still fits as a new key, but the edit lands in a file region upstream has changed, so it must be re-applied rather than blind-merged.", 0, 0, markdownTheme as any));
		}
		render(width: number) { return this.contentContainer.render(width); }
		updateContent(message: any) { this.lastMessage = message; }
	}
	const pi = { on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) };
	installAssistantMessageRenderer(pi as any, AssistantMessageComponent);
	handlers.get("session_start")!({}, { cwd, hasUI: true, ui: { theme } });
	const component = new AssistantMessageComponent();
	try {
		component.updateContent({ content: [] });
		for (const width of [57, 220]) {
			const lines = component.render(width);
			expect(lines.some((line) => line.trim() === "the"), `width ${width} must not strand 'the' on its own`).toBe(false);
			expect(Math.max(...lines.map(visibleWidth)), `width ${width} output fits`).toBeLessThanOrEqual(width);
		}
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-tool-renderer": { assistantMessageStyle: "plain" } }));
		clearPackageConfigCache();
		const plainLines = component.render(57);
		expect(plainLines.some((line) => line.includes("\x1b]1337;kx-assistant-row\x07"))).toBe(false);
		expect(plainLines.some((line) => line.includes(ROBOT))).toBe(false);
	} finally {
		handlers.get("session_shutdown")!();
	}
});

test("full-width thinking panels and assistant blank lines survive gutter layout", () => {
	const { cwd } = world();
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-tool-renderer": { assistantMessageStyle: "agent", thinkingPanel: true } }));
	clearPackageConfigCache();
	const handlers = new Map<string, (...args: any[]) => void>();
	class AssistantMessageComponent {
		contentContainer = new Container();
		hasToolCalls = false;
		lastMessage: any = { content: [] };
		constructor() {
			this.contentContainer.addChild(new Markdown("First paragraph.\n\nSecond paragraph after a blank line.", 0, 0, markdownTheme as any));
			this.contentContainer.addChild(new MouseRegion(new Markdown("reasoning block", 0, 0, markdownTheme as any), () => undefined));
		}
		render(width: number) { return this.contentContainer.render(width); }
		updateContent(message: any) { this.lastMessage = message; }
	}
	const pi = { on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) };
	installAssistantMessageRenderer(pi as any, AssistantMessageComponent);
	handlers.get("session_start")!({}, { cwd, hasUI: true, ui: { theme } });
	try {
		const component = new AssistantMessageComponent();
		component.updateContent({ content: [{ type: "text", text: "answer" }, { type: "thinking", thinking: "reasoning" }] });
		for (const width of [40, 60]) {
			const lines = component.render(width);
			const panelRows = lines.filter((line) => line.includes("\x1b[48;5;236m"));
			expect(panelRows.length).toBeGreaterThan(0);
			expect(panelRows.every((line) => visibleWidth(line) === width)).toBe(true);
			expect(panelRows.some((line) => line.includes("reasoning block"))).toBe(true);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	} finally {
		handlers.get("session_shutdown")!();
	}
});

test("the gutter does not rewrap already-rendered lines", () => {
	const long = "x".repeat(60);
	const lines = __test.assistantTextGutterLines([long], theme, undefined, "bar");
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain(long);
});
