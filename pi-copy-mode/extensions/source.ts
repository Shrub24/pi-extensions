/**
 * Source model for copy mode: the raw markdown text of assistant messages and the
 * line-range arithmetic behind a copy. Nothing here knows about the terminal, so the
 * copied text never carries rendered wrapping, gutters, borders or tints.
 */

export interface AssistantSource {
	/** Position in the newest-first list shown to the user. */
	readonly ordinal: number;
	/** Human label: ordinal, time and the first meaningful line of the message. */
	readonly label: string;
	/** Raw markdown source lines from the message's text blocks. */
	readonly lines: readonly string[];
}

export interface LineRange {
	/** First selected source line, inclusive. */
	readonly start: number;
	/** Last selected source line, inclusive. */
	readonly end: number;
}

const LABEL_LIMIT = 60;

/**
 * Joins the text blocks of an assistant message into raw source lines. Thinking
 * blocks, tool calls and images are not source text and are excluded.
 */
export function sourceLinesFromContent(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const blocks: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const { type, text } = block as { type?: unknown; text?: unknown };
		if (type !== "text" || typeof text !== "string") continue;
		const trimmed = text.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
		if (trimmed.trim().length > 0) blocks.push(trimmed);
	}
	return blocks.length === 0 ? [] : blocks.join("\n\n").split("\n");
}

/**
 * Lists assistant messages of a session branch with source text, newest first.
 * Entries that are not assistant messages, or that carry no text, are skipped.
 */
export function assistantSources(entries: readonly unknown[]): AssistantSource[] {
	const found: { lines: string[]; timestamp: number | undefined }[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const { type, message } = entry as { type?: unknown; message?: unknown };
		if (type !== "message" || !message || typeof message !== "object") continue;
		const { role, content, timestamp } = message as { role?: unknown; content?: unknown; timestamp?: unknown };
		if (role !== "assistant") continue;
		const lines = sourceLinesFromContent(content);
		if (lines.length === 0) continue;
		found.push({ lines, timestamp: typeof timestamp === "number" ? timestamp : undefined });
	}
	return found
		.reverse()
		.map((item, index) => ({
			ordinal: index + 1,
			label: `${index + 1}. ${clock(item.timestamp)} ${headline(item.lines)}`,
			lines: item.lines,
		}));
}

/** The inclusive source range from the cursor to the mark, or the cursor line alone. */
export function markedRange(cursor: number, mark: number | null): LineRange {
	if (mark === null) return { start: cursor, end: cursor };
	return { start: Math.min(cursor, mark), end: Math.max(cursor, mark) };
}

/** The raw source text for a range, joined with newlines and with no display decoration. */
export function copiedText(lines: readonly string[], range: LineRange): string {
	return lines.slice(range.start, range.end + 1).join("\n");
}

function headline(lines: readonly string[]): string {
	const first = lines.find((line) => line.trim().length > 0) ?? "";
	const plain = first.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/u, "").trim();
	return plain.length > LABEL_LIMIT ? `${plain.slice(0, LABEL_LIMIT - 1)}…` : plain;
}

function clock(timestamp: number | undefined): string {
	if (timestamp === undefined) return "--:--:--";
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
