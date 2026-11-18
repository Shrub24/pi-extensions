import { expect, test } from "bun:test";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { __stampTest, __test, installUserMessageRenderer } from "../tool-renderer/messages.js";
import { useWorld } from "./helpers/world.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearPackageConfigCache } from "../tool-renderer/package-config.js";

const world = useWorld();

test("user Markdown reuses one layout and invalidates for width, content, themes and host invalidation", () => { let highlights = 0;
	let highlightSuffix = "";
	const markdownTheme = { ...getMarkdownTheme(), codeBlockBorder: (text: string) => text, codeBlock: (text: string) => text, highlightCode(code: string) { highlights++; return code.split("\n").map((line) => line + highlightSuffix); } };
	const theme = { fg: (_token: string, text: string) => text };
	const ui = { theme };
	class Message { text = "```typescript\nconst first = true;\n```";
		markdownTheme = markdownTheme;
		invalidations = 0;
		invalidate() { this.invalidations++; }
		render(_width = 60) { return ["upstream"]; } }
	const handlers = new Map<string, (...args: unknown[]) => void>();
	installUserMessageRenderer({ on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler) } as never, Message);
	const component = new Message();
	const draw = (width = 60) => component.render(width);
	try { handlers.get("session_start")!({}, { cwd: world().cwd, hasUI: true, ui, sessionManager: { getBranch: () => [] } });
		const first = draw();
		const count = highlights;
		expect(first.join("\n")).toContain("first");
		expect(count).toBeGreaterThan(0);
		expect(draw()).toEqual(first);
		expect(highlights).toBe(count);
		// A new width is a new layout; whether the highlight is recomputed is the
		// cache's business, so the contract is the rendered rows.
		expect(draw(40)).not.toEqual(first);
		expect(draw(60)).toEqual(first);
		component.text = "```typescript\nconst changed = false;\n```";
		expect(draw().join("\n")).toContain("changed");
		const content = draw();
		const beforeInvalidation = highlights;
		highlightSuffix = " // refreshed";
		component.invalidate();
		expect(component.invalidations).toBe(1);
		expect(content.join("\n")).not.toContain("refreshed");
		expect(draw().join("\n")).toContain("refreshed");
		expect(highlights).toBeGreaterThan(beforeInvalidation);
		ui.theme = { fg: (_token: string, text: string) => `\x1b[31m${text}\x1b[39m` };
		expect(draw().join("\n")).toContain("\x1b[31m");
		const beforeMarkdownTheme = highlights;
		component.markdownTheme = { ...markdownTheme };
		draw();
		expect(highlights).toBeGreaterThan(beforeMarkdownTheme);
		const beforeSettings = highlights;
		writeFileSync(join(world().agent, "settings.json"), JSON.stringify({ "pi-tool-renderer": { styledCodeBlocks: false } }));
		clearPackageConfigCache();
		draw();
		expect(highlights).toBeGreaterThan(beforeSettings);
		const beforeShutdown = __test.renderRawUserMessageLines(component, 60, ui.theme, world().cwd);
		handlers.get("session_shutdown")!();
		expect(__test.renderRawUserMessageLines(component, 60, ui.theme, world().cwd)).not.toBe(beforeShutdown);
		expect(component.render()).toEqual(["upstream"]); } finally { handlers.get("session_shutdown")!(); }
});

test("restored user messages get inline stamps from the active session branch", () => { const timestamp = new Date(2024, 0, 2, 3, 4, 5).getTime();
	const theme = { fg: (_token: string, text: string) => text };
	const handlers = new Map<string, (...args: any[]) => void>();
	class Message { text = "restored user message";
		markdownTheme = getMarkdownTheme();
		render(_width = 60) { return ["upstream"]; } }
	__stampTest.pendingUserStamps.length = 0;
	writeFileSync(join(world().agent, "settings.json"), JSON.stringify({ "pi-tool-renderer": { compactUserMessages: true, messageStamps: "inline", messageStampFormat: "24h", messageStampSeconds: true } }));
	clearPackageConfigCache();
	installUserMessageRenderer({ on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) } as never, Message);
	const component = new Message();
	try { handlers.get("session_start")!({}, { cwd: world().cwd,
			hasUI: true,
			ui: { theme },
			sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", timestamp } }] }, });
		expect(component.render(60).join("\n")).toContain("03:04:05"); } finally { handlers.get("session_shutdown")!();
		__stampTest.pendingUserStamps.length = 0; }
});

test("user layouts keep oversized content and drop old component layouts at the count bound", () => { const theme = { fg: (_token: string, text: string) => text };
	const component = { text: "first", markdownTheme: getMarkdownTheme() };
	const first = __test.renderRawUserMessageLines(component, 80, theme);
	for (let index = 0; index < 256; index++) __test.renderRawUserMessageLines({ text: "next", markdownTheme: component.markdownTheme }, 80, theme);
	expect(__test.renderRawUserMessageLines(component, 80, theme)).not.toBe(first);
	// Folding off, so this is the whole message's layout and not a short preview.
	writeFileSync(join(world().agent, "settings.json"), JSON.stringify({ "pi-tool-renderer": { userMessageFoldChars: 0, userMessageFoldLines: 0 } }));
	clearPackageConfigCache();
	component.text = "a".repeat(64 * 1024 + 1);
	const oversized = __test.renderRawUserMessageLines(component, 80, theme);
	// Redrawing an unchanged message must not lay it out again, whatever its size.
	expect(__test.renderRawUserMessageLines(component, 80, theme)).toBe(oversized);
});

test("an oversized prompt shows a bounded preview, opens with the expand toggle or a click, and reuses each view", () => {
	const theme = { fg: (_token: string, text: string) => text };
	const handlers = new Map<string, (...args: any[]) => void>();
	class Message { text = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
		markdownTheme = getMarkdownTheme();
		invalidations = 0;
		invalidate() { this.invalidations++; }
		render(_width = 60) { return ["upstream"]; } }
	installUserMessageRenderer({ on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) } as never, Message);
	const component = new Message() as Message & { setExpanded(expanded: boolean): void; handleMouse(event: unknown): unknown };
	try { handlers.get("session_start")!({}, { cwd: world().cwd, hasUI: true, ui: { theme }, sessionManager: { getBranch: () => [] } });
		const folded = component.render(60);
		expect(folded.join("\n")).toContain("line 12");
		expect(folded.join("\n")).not.toContain("line 13");
		expect(folded.join("\n")).toContain("188 more lines");
		expect(component.render(60)).toBe(folded);

		component.setExpanded(true);
		expect(component.invalidations).toBe(1);
		const open = component.render(60);
		expect(open.join("\n")).toContain("line 200");
		expect(open.join("\n")).not.toContain("more lines");
		expect(component.render(60)).toBe(open);

		expect(component.handleMouse({ type: "click", button: "left" })).toEqual({ handled: true });
		expect(component.render(60).join("\n")).not.toContain("line 200");
		component.handleMouse({ type: "click", button: "left" });
		expect(component.render(60).join("\n")).toContain("line 200");
		component.setExpanded(false);
		expect(component.render(60).join("\n")).toContain("188 more lines"); } finally { handlers.get("session_shutdown")!(); }
});

test("a single oversized line folds within the character bound", () => {
	const theme = { fg: (_token: string, text: string) => text };
	const component = { text: "x".repeat(50_000), markdownTheme: getMarkdownTheme() };
	const lines = __test.renderRawUserMessageLines(component, 80, theme)!;
	expect(lines.join("").length).toBeLessThan(2_200);
	expect(lines.at(-1)).toContain("50,000 chars");
});

test("re-folding leaves the opened layout collectible", async () => {
	const theme = { fg: (_token: string, text: string) => text };
	const handlers = new Map<string, (...args: any[]) => void>();
	class Message { text = Array.from({ length: 500 }, (_, index) => `row ${index}`).join("\n");
		markdownTheme = getMarkdownTheme();
		render(_width = 60) { return ["upstream"]; } }
	installUserMessageRenderer({ on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) } as never, Message);
	const component = new Message() as Message & { setExpanded(expanded: boolean): void };
	try { handlers.get("session_start")!({}, { cwd: world().cwd, hasUI: true, ui: { theme }, sessionManager: { getBranch: () => [] } });
		component.setExpanded(true);
		const opened = (() => new WeakRef(component.render(60)))();
		component.setExpanded(false);
		component.render(60);
		Bun.gc(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		Bun.gc(true);
		expect(opened.deref()).toBeUndefined(); } finally { handlers.get("session_shutdown")!(); }
});

test("prompts within the bounds, and every prompt with folding off, render whole and ignore the toggle", () => {
	const theme = { fg: (_token: string, text: string) => text };
	const handlers = new Map<string, (...args: any[]) => void>();
	class Message { text = "a short prompt";
		markdownTheme = getMarkdownTheme();
		render(_width = 60) { return ["upstream"]; } }
	installUserMessageRenderer({ on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler) } as never, Message);
	const component = new Message() as Message & { setExpanded(expanded: boolean): void; handleMouse(event: unknown): unknown };
	try { handlers.get("session_start")!({}, { cwd: world().cwd, hasUI: true, ui: { theme }, sessionManager: { getBranch: () => [] } });
		const whole = component.render(60);
		expect(whole.join("\n")).toContain("a short prompt");
		expect(whole.join("\n")).not.toContain("expand");
		expect(component.handleMouse({ type: "click", button: "left" })).toBeUndefined();
		component.setExpanded(true);
		expect(component.render(60)).toBe(whole);

		writeFileSync(join(world().agent, "settings.json"), JSON.stringify({ "pi-tool-renderer": { userMessageFoldChars: 0, userMessageFoldLines: 0 } }));
		clearPackageConfigCache();
		component.text = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
		component.setExpanded(false);
		expect(component.render(60).join("\n")).toContain("line 200"); } finally { handlers.get("session_shutdown")!(); }
});
