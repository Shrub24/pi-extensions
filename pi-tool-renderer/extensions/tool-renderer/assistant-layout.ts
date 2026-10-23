import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

function borderSegments(line: string, left: string, join: string, right: string): number[] | undefined {
	const chars = Array.from(line.trim());
	if (chars[0] !== left || chars[chars.length - 1] !== right) return undefined;
	const segments: number[] = [];
	let segmentWidth = 0;
	for (const char of chars.slice(1, -1)) {
		if (char === "─") segmentWidth++;
		else if (char === join && segmentWidth > 0) {
			segments.push(segmentWidth);
			segmentWidth = 0;
		} else return undefined;
	}
	if (segmentWidth === 0) return undefined;
	segments.push(segmentWidth);
	return segments;
}

function rowCells(line: string, widths: number[]): string[] | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("│") || !trimmed.endsWith("│")) return undefined;
	const cells = trimmed.slice(1, -1).split("│");
	if (cells.length !== widths.length || cells.some((cell, index) => visibleWidth(cell) !== widths[index])) return undefined;
	return cells.map((cell) => cell.trim());
}

function parseBoxTable(lines: string[], start: number): { end: number; width: number; rows: string[][] } | undefined {
	const widths = borderSegments(lines[start] ?? "", "┌", "┬", "┐");
	if (!widths || widths.length < 2) return undefined;
	const rows: string[][] = [];
	let pending: string[][] = [];
	let headerSeparated = false;
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const middle = borderSegments(line, "├", "┼", "┤");
		const bottom = borderSegments(line, "└", "┴", "┘");
		if (middle || bottom) {
			const segments = middle ?? bottom!;
			if (segments.length !== widths.length || segments.some((width, column) => width !== widths[column]) || pending.length === 0) return undefined;
			rows.push(widths.map((_, column) => pending.map((row) => row[column]!).filter(Boolean).join(" ")));
			pending = [];
			if (bottom) {
				if (!headerSeparated || rows.length < 2) return undefined;
				return { end: index, width: visibleWidth((lines[start] ?? "").trim()), rows };
			}
			headerSeparated = true;
			continue;
		}
		const row = rowCells(line, widths);
		if (!row) return undefined;
		pending.push(row);
	}
	return undefined;
}

function renderRowsAsCards(rows: string[][]): string {
	const headers = rows[0]!;
	return rows.slice(1).map((cells) => {
		const title = cells[0] ?? "";
		const titleLabel = headers[0] || "Column 1";
		const fields = headers.map((header, column) => {
			if (column === 0 && title) return "";
			const label = header || `Column ${column + 1}`;
			const value = cells[column] ?? "";
			return value ? `- **${label}:** ${value}` : "";
		}).filter(Boolean);
		return [title ? `**${titleLabel}: ${title}**` : "", ...fields].filter(Boolean).join("\n");
	}).join("\n\n");
}

/** Convert only complete, rectangular box-drawn tables that cannot fit the current viewport. */
export function transformBoxDrawnTables(markdown: string, availableWidth: number): string {
	const lines = markdown.split("\n");
	const output: string[] = [];
	let fence: { char: string; length: number } | undefined;
	for (let index = 0; index < lines.length;) {
		const line = lines[index] ?? "";
		const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fenceMatch) {
			const token = fenceMatch[1]!;
			if (!fence) fence = { char: token[0]!, length: token.length };
			else if (token[0] === fence.char && token.length >= fence.length) fence = undefined;
			output.push(line);
			index++;
			continue;
		}
		const table = fence ? undefined : parseBoxTable(lines, index);
		if (!table || table.width <= Math.max(1, availableWidth)) {
			output.push(line);
			index++;
			continue;
		}
		output.push(renderRowsAsCards(table.rows));
		index = table.end + 1;
	}
	return output.join("\n");
}

export function installAssistantMarkdownLayout(pi: ExtensionAPI): void {
	const register = (pi as any).registerMarkdownTransformer;
	if (typeof register !== "function") return;
	register.call(pi, (markdown: string, context: { messageType: string; availableWidth: number }) =>
		context.messageType === "assistant" ? transformBoxDrawnTables(markdown, context.availableWidth) : markdown,
	);
}
