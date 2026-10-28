import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Box, Container, Markdown, MouseRegion, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";

import { stripAnsi } from "../tool-renderer/ansi.js";
import { clearPackageConfigCache } from "../tool-renderer/package-config.js";
import { installAssistantMessageRenderer, THINKING_ROW_SENTINEL, __test } from "../tool-renderer/messages.js";
import { useWorld } from "./helpers/world.js";

const world = useWorld();

const TINT = "\x1b[48;5;236m";

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
	highlightCode: (code: string) => code.split("\n"),
} as never;

const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m`,
	bold: (text: string) => text,
} as never;

/** Mirrors Pi: every updateContent clears the container and rebuilds all children. */
class StreamingAssistantMessage extends Container {
	contentContainer = new Container();
	hasToolCalls = false;
	lastMessage: any = { content: [] };
	constructor() {
		super();
		this.addChild(this.contentContainer);
	}
	render(width: number) { return this.contentContainer.render(width); }
	updateContent(message: any): void {
		this.lastMessage = message;
		this.contentContainer.clear();
		const visible = message.content.some((block: any) => block.type === "thinking" && block.thinking.trim());
		if (visible) this.contentContainer.addChild(new Spacer(1));
		for (const block of message.content) {
			if (block.type === "text" && block.text.trim()) this.contentContainer.addChild(new Markdown(block.text.trim(), 0, 0, markdownTheme));
			if (block.type !== "thinking" || !block.thinking.trim()) continue;
			const markdown = new Markdown(block.thinking.trim(), 0, 0, markdownTheme);
			this.contentContainer.addChild(new MouseRegion(markdown, () => undefined));
		}
	}
}

test("each thinking panel frames its block with the box's own padding, sharing no child", () => {
	const { cwd } = world();
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-tool-renderer": { thinkingPanel: true, assistantMessageStyle: "plain" } }));
	clearPackageConfigCache();
	const handlers = new Map<string, (...args: any[]) => void>();
	const pi = { on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) };
	installAssistantMessageRenderer(pi as any, StreamingAssistantMessage);
	handlers.get("session_start")!({}, { cwd, hasUI: true, ui: { theme } });
	try {
		const panels = ["First block", "Second block"].map((thinking) => {
			const component = new StreamingAssistantMessage();
			component.updateContent({ content: [{ type: "thinking", thinking }] });
			return component.contentContainer.children.filter((child) => child instanceof Box) as Box[];
		});
		for (const panel of panels) {
			expect(panel).toHaveLength(1);
			// Pi-Bolt's render bookkeeping holds each rendered child's owners strongly, so a
			// component shared between panels keeps every panel that ever rendered it alive.
			expect(panel[0]!.children).toHaveLength(1);
		}
		for (const left of panels[0]![0]!.children) {
			for (const right of panels[1]![0]!.children) expect(right).not.toBe(left);
		}
		const rows = (panels[0]![0] as any).render(40) as string[];
		// The box paints every row, padding included: the marker the assistant pass later
		// swaps for a zero-width keeper is what keeps a tinted blank row from being trimmed.
		expect(rows[0]).toContain(TINT);
		expect(rows.at(-1)).toContain(TINT);
		expect(rows[0]).toContain(THINKING_ROW_SENTINEL);
		expect(rows.at(-1)).toContain(THINKING_ROW_SENTINEL);
	} finally {
		handlers.get("session_shutdown")!();
	}
});

test("a thinking panel keeps a tinted row below its last line of thinking text", () => {
	const { cwd } = world();
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-tool-renderer": { thinkingPanel: true, assistantMessageStyle: "plain" } }));
	clearPackageConfigCache();
	const handlers = new Map<string, (...args: any[]) => void>();
	const pi = { on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) };
	installAssistantMessageRenderer(pi as any, StreamingAssistantMessage);
	handlers.get("session_start")!({}, { cwd, hasUI: true, ui: { theme } });
	try {
		const component = new StreamingAssistantMessage();
		component.updateContent({ content: [{ type: "thinking", thinking: "Editing group boundary fields" }] });
		const thinkingOnly = component.render(50);
		const lastOnly = thinkingOnly[thinkingOnly.length - 1] ?? "";
		expect(lastOnly).toContain(TINT);
		expect(lastOnly).toContain("\u200B");
		expect(stripAnsi(lastOnly).replace("]1337;kx-thinking", "")).not.toMatch(/[A-Za-z0-9]/);
		expect(visibleWidth(lastOnly)).toBe(50);

		component.updateContent({ content: [{ type: "thinking", thinking: "Editing group boundary fields" }, { type: "text", text: "Here is the answer." }] });
		const withText = component.render(50);
		const panelRows = withText.filter((line) => line.includes(TINT));
		const lastPanelRow = panelRows[panelRows.length - 1] ?? "";
		expect(lastPanelRow).toContain("\u200B");
		expect(withText.indexOf(lastPanelRow)).toBeLessThan(withText.findIndex((line) => line.includes("Here is the answer.")));
	} finally {
		handlers.get("session_shutdown")!();
	}
});

test("growing thinking content keeps its panel tint across streaming updates", () => {
	const { cwd } = world();
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-tool-renderer": { thinkingPanel: true, assistantMessageStyle: "plain" } }));
	clearPackageConfigCache();
	const handlers = new Map<string, (...args: any[]) => void>();
	const pi = { on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) };
	installAssistantMessageRenderer(pi as any, StreamingAssistantMessage);
	handlers.get("session_start")!({}, { cwd, hasUI: true, ui: { theme } });
	try {
		const component = new StreamingAssistantMessage();
		component.updateContent({ content: [{ type: "thinking", thinking: "Editing group boundary fields" }] });
		const first = component.render(60).join("\n");
		expect(first).toContain(TINT);
		expect(first).toContain("Editing group boundary fields");

		component.updateContent({ content: [{ type: "thinking", thinking: "Editing group boundary fields\n\nUpdating tool boundaries\n\nAdding boundary cache fields" }] });
		const streamed = component.render(60).join("\n");
		expect(streamed).toContain("Adding boundary cache fields");
		expect(streamed).toContain(TINT);
	} finally {
		handlers.get("session_shutdown")!();
	}
});

test("thinking panel rows keep their fill and the marker lands on the message", () => {
	const panelRow = `${THINKING_ROW_SENTINEL}\u001b[48;5;236m thinking text \u001b[49m`;
	const lines = [panelRow, "", "# Heading", "body"];
	const out = __test.assistantTextGutterLines(lines, theme, "/tmp", "agent");
	// Panel row: sentinel stripped, no gutter lead, background intact at column 0.
	expect(out[0]).toBe("\u001b[48;5;236m thinking text \u001b[49m");
	expect(out[0]!.startsWith(THINKING_ROW_SENTINEL)).toBe(false);
	// Marker sits on the first real message line, with a space after it.
	expect(out[2]!.endsWith("# Heading")).toBe(true);
	expect(out[2]!.startsWith("   ")).toBe(false);
	// Continuation lines hang on the same indent.
	expect(out[3]).toBe("   body");
});

test("plain assistant style never writes the thinking-panel marker to the terminal", () => {
	const { cwd } = world();
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-tool-renderer": { thinkingPanel: true, assistantMessageStyle: "plain" } }));
	clearPackageConfigCache();
	const handlers = new Map<string, (...args: any[]) => void>();
	const pi = { on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) };
	installAssistantMessageRenderer(pi as any, StreamingAssistantMessage);
	handlers.get("session_start")!({}, { cwd, hasUI: true, ui: { theme } });
	try {
		const component = new StreamingAssistantMessage();
		component.updateContent({ content: [{ type: "thinking", thinking: "Editing group boundary fields" }] });
		const thinkingOnly = component.render(50);
		// No heading: the block is framed by tinted padding rows only.
		expect(thinkingOnly.some((line) => stripAnsi(line).includes("thinking"))).toBe(false);
		const textRow = thinkingOnly.findIndex((line) => stripAnsi(line).includes("Editing group boundary fields"));
		expect(textRow).toBeGreaterThan(0);
		expect(thinkingOnly[textRow - 1]).toContain(TINT);
		// Padding rows stay non-blank for trimmers that strip ANSI, and never carry
		// the raw marker to the terminal.
		expect(thinkingOnly.slice(0, textRow).every((line) => line.trim().length > 0)).toBe(true);
		const lastPanelRow = thinkingOnly.map((line) => line.includes(TINT)).lastIndexOf(true);
		expect(lastPanelRow).toBeGreaterThan(thinkingOnly.findIndex((line) => stripAnsi(line).includes("Editing group boundary fields")));
		expect(thinkingOnly.filter((line) => line.includes(THINKING_ROW_SENTINEL))).toEqual([]);
		component.updateContent({ content: [{ type: "thinking", thinking: "Editing group boundary fields" }, { type: "text", text: "Done." }] });
		const withText = component.render(50);
		expect(withText.some((line) => line.includes(TINT))).toBe(true);
		expect(withText.filter((line) => line.includes(THINKING_ROW_SENTINEL))).toEqual([]);
	} finally {
		handlers.get("session_shutdown")!();
	}
});
