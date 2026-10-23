import { expect, test } from "bun:test";

import { Markdown, visibleWidth } from "@earendil-works/pi-tui";

import { installAssistantMarkdownLayout, transformBoxDrawnTables } from "../tool-renderer/assistant-layout.js";

const markdownTheme = Object.fromEntries([
	"bold", "code", "codeBlock", "codeBlockBorder", "heading", "italic", "link", "linkUrl",
	"quote", "quoteBorder", "strikethrough", "underline", "listBullet", "hr",
].map((name) => [name, (text: string) => text]));

const widths = [24, 46, 48];

function wrapCell(text: string, width: number): string[] {
	const lines = [""];
	for (const word of text.split(/\s+/)) {
		const current = lines[lines.length - 1]!;
		if (current && current.length + word.length + 1 > width) lines.push(word);
		else lines[lines.length - 1] = current ? `${current} ${word}` : word;
	}
	return lines;
}

function border(left: string, join: string, right: string): string {
	return left + widths.map((width) => "─".repeat(width + 2)).join(join) + right;
}

function row(cells: string[]): string[] {
	const wrapped = cells.map((cell, index) => wrapCell(cell, widths[index]!));
	const height = Math.max(...wrapped.map((lines) => lines.length));
	return Array.from({ length: height }, (_, line) => `│${wrapped.map((cell, column) => ` ${cell[line] ?? ""}`.padEnd(widths[column]! + 1) + " ").join("│")}│`);
}

const reportedTable = [
	border("┌", "┬", "┐"),
	...row(["Area", "Files", "Work"]),
	border("├", "┼", "┤"),
	...row(["Manual, high risk", "context-handler.ts, index.ts, tools/index.ts, ctx-note.ts", "Real merges; prefixBound is derived twice and both paths must share it."]),
	border("├", "┼", "┤"),
	...row(["Tests rewritten upstream", "issue-665-hold-review-r2.test.ts, context-handler.test.ts", "Re-apply the virtualRoute driver option to the rewritten test driver."]),
	border("├", "┼", "┤"),
	...row(["Regenerate", "schema.json, configuration.md, PARITY.md", "Rebuild generated docs, then restore the fork-specific notes."]),
	border("├", "┼", "┤"),
	...row(["Ours only", "flake.nix, nix/, context/, memory-policy.ts", "Carry these forward unchanged; they have no upstream edits."]),
	border("└", "┴", "┘"),
].join("\n");

test("a too-wide reported box table becomes readable header/value blocks", () => {
	const transformed = transformBoxDrawnTables(reportedTable, 60);
	expect(transformed).not.toBe(reportedTable);
	expect(transformed).not.toContain("┌");
	expect(transformed).toContain("Area: Manual, high risk");
	expect(transformed).toContain("Files");
	expect(transformed).toContain("context-handler.ts");
	expect(transformed).toContain("Work");
	expect(transformed).toContain("prefixBound");
	const lines = new Markdown(transformed, 0, 0, markdownTheme as any).render(60);
	expect(Math.max(...lines.map(visibleWidth))).toBeLessThanOrEqual(60);
});

test("the Markdown transformer adapts assistant output only", () => {
	let transform: ((markdown: string, context: { messageType: string; availableWidth: number }) => string) | undefined;
	installAssistantMarkdownLayout({ registerMarkdownTransformer: (handler: typeof transform) => { transform = handler; } } as any);
	expect(transform).toBeFunction();
	expect(transform!(reportedTable, { messageType: "assistant", availableWidth: 60 })).not.toBe(reportedTable);
	expect(transform!(reportedTable, { messageType: "user", availableWidth: 60 })).toBe(reportedTable);
	expect(transform!(reportedTable, { messageType: "assistant-thinking", availableWidth: 60 })).toBe(reportedTable);
});

test("a fitting box table stays a grid and incomplete border art stays untouched", () => {
	expect(transformBoxDrawnTables(reportedTable, 180)).toBe(reportedTable);
	const malformed = "┌─────┬─────┐\n│ Area│ Files│\n├────┼─────┤\n│ x   │ y   │";
	expect(transformBoxDrawnTables(malformed, 30)).toBe(malformed);
	const fenced = `\`\`\`text\n${reportedTable}\n\`\`\``;
	expect(transformBoxDrawnTables(fenced, 60)).toBe(fenced);
	const markdownTable = "| Area | Work |\n| --- | --- |\n| Manual | Preserve the existing Pi table renderer. |";
	expect(transformBoxDrawnTables(markdownTable, 20)).toBe(markdownTable);
});
