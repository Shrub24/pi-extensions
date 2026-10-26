import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { copiedText, markedRange } from "./source.js";

export interface CopyResult {
	/** Number of source lines copied. */
	readonly copied: number;
}

export interface CopyViewStyle {
	readonly cursor: (text: string) => string;
	readonly marked: (text: string) => string;
	readonly muted: (text: string) => string;
}

export interface CopyViewOptions {
	readonly title: string;
	readonly lines: readonly string[];
	/** Writes text to the clipboard; a rejection keeps the view open and shows the reason. */
	readonly copy: (text: string) => Promise<void>;
	/** Closes the view. `undefined` means the user cancelled. */
	readonly done: (result: CopyResult | undefined) => void;
	/** Asks the TUI to redraw after a state change. */
	readonly requestRender: () => void;
	/** Display rows shown at once; the cursor scrolls the window to stay in view. */
	readonly viewportRows?: number;
	readonly style?: CopyViewStyle;
}

const identity = (text: string) => text;
const DEFAULT_STYLE: CopyViewStyle = { cursor: identity, marked: identity, muted: identity };
const DEFAULT_ROWS = 20;

/**
 * Overlay that moves a cursor over raw source lines, marks a range and copies it.
 * It keeps logical source lines, so wrapping only affects what is drawn.
 */
export class CopyModeView implements Component {
	private cursor = 0;
	private mark: number | null = null;
	private top = 0;
	private status = "";
	private busy = false;
	private closed = false;
	private readonly rows: number;
	private readonly style: CopyViewStyle;

	constructor(private readonly options: CopyViewOptions) {
		this.rows = Math.max(1, options.viewportRows ?? DEFAULT_ROWS);
		this.style = options.style ?? DEFAULT_STYLE;
	}

	handleInput(data: string): void {
		if (this.busy || this.closed) return;
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.finish(undefined);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "y")) {
			void this.copySelection();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) this.moveTo(this.cursor + 1);
		else if (matchesKey(data, "up") || matchesKey(data, "k")) this.moveTo(this.cursor - 1);
		else if (matchesKey(data, "pageDown")) this.moveTo(this.cursor + this.rows);
		else if (matchesKey(data, "pageUp")) this.moveTo(this.cursor - this.rows);
		else if (matchesKey(data, "home") || matchesKey(data, "g")) this.moveTo(0);
		else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) this.moveTo(this.lastIndex());
		else if (matchesKey(data, "v")) this.mark = this.mark === null ? this.cursor : null;
		else return;
		this.status = "";
		this.options.requestRender();
	}

	render(width: number): string[] {
		const lines = this.options.lines;
		const range = markedRange(this.cursor, this.mark);
		const marked = this.mark === null ? "no mark" : `${range.end - range.start + 1} marked`;
		const header = `${this.options.title} · ${lines.length} lines · ${marked}`;
		const hint = "j/k move · v mark · enter/y copy · esc cancel";
		const out = [truncateToWidth(header, width), truncateToWidth(this.style.muted(hint), width)];

		const numberWidth = String(lines.length).length;
		const prefixWidth = 2 + numberWidth + 1;
		const contentWidth = Math.max(1, width - prefixWidth);
		this.keepCursorVisible(contentWidth);

		let shown = 0;
		for (let index = this.top; index < lines.length && shown < this.rows; index++) {
			const inRange = this.mark !== null && index >= range.start && index <= range.end;
			const segments = this.wrap(index, contentWidth);
			for (let part = 0; part < segments.length && shown < this.rows; part++, shown++) {
				const first = part === 0;
				const pointer = first && index === this.cursor ? "›" : " ";
				const bar = inRange ? "▌" : " ";
				const number = first ? String(index + 1).padStart(numberWidth) : " ".repeat(numberWidth);
				const row = truncateToWidth(`${pointer}${bar}${number} ${segments[part]}`, width);
				out.push(first && index === this.cursor ? this.style.cursor(row) : inRange ? this.style.marked(row) : row);
			}
		}
		out.push(truncateToWidth(this.style.muted(this.footer()), width));
		return out;
	}

	/** Display segments of one logical source line; tabs are expanded for display only. */
	private wrap(index: number, contentWidth: number): string[] {
		const text = (this.options.lines[index] ?? "").replace(/\t/g, "    ");
		return wrapTextWithAnsi(text, contentWidth);
	}

	private async copySelection(): Promise<void> {
		const range = markedRange(this.cursor, this.mark);
		const text = copiedText(this.options.lines, range);
		this.busy = true;
		this.status = "Copying…";
		this.options.requestRender();
		try {
			await this.options.copy(text);
			this.finish({ copied: range.end - range.start + 1 });
		} catch (error) {
			this.busy = false;
			this.status = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
			this.options.requestRender();
		}
	}

	private finish(result: CopyResult | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.options.done(result);
	}

	private moveTo(index: number): void {
		this.cursor = Math.min(Math.max(0, index), this.lastIndex());
	}

	private lastIndex(): number {
		return Math.max(0, this.options.lines.length - 1);
	}

	/**
	 * Scrolls so the cursor line sits inside the viewport, counting display rows: a
	 * wrapped line occupies several rows.
	 */
	private keepCursorVisible(contentWidth: number): void {
		if (this.cursor < this.top) this.top = this.cursor;
		const rowsBetween = (from: number) => {
			let total = 0;
			for (let index = from; index <= this.cursor; index++) total += this.wrap(index, contentWidth).length;
			return total;
		};
		while (this.top < this.cursor && rowsBetween(this.top) > this.rows) this.top++;
	}

	private footer(): string {
		if (this.status) return this.status;
		const shown = this.options.lines.length === 0 ? 0 : this.cursor + 1;
		return `line ${shown}/${this.options.lines.length}`;
	}
}
