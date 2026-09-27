/**
 * Inline message stamps — replaces the standalone pi-stamp extension's transcript
 * entries with a dim right-aligned timestamp appended to the message's own last
 * line. No extra entries, no inter-entry spacing, no extra rows.
 *
 * Settings (pi-tool-renderer):
 * - `messageStamps`: "off" | "inline" (default "inline")
 * - `messageStampFormat`: "24h" | "12h" (default "24h")
 * - `messageStampSeconds`: boolean (default true)
 * - `messageStampResponseTime`: boolean (default false) — appends the assistant
 *   response duration when the message carried one through `updateContent`.
 */
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { settingBoolean, settingEnum } from "./settings.js";

export type MessageStampMode = "off" | "inline";

export function messageStampMode(cwd?: string): MessageStampMode {
	return settingEnum("messageStamps", ["off", "inline"] as const, "inline", cwd);
}

export function formatClock(timestamp: number, cwd?: string): string | undefined {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
	const cycle = settingEnum("messageStampFormat", ["24h", "12h"] as const, "24h", cwd);
	const seconds = settingBoolean("messageStampSeconds", true, cwd);
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	const hour24 = date.getHours();
	if (cycle === "12h") {
		const suffix = hour24 < 12 ? "am" : "pm";
		const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
		return seconds
			? `${hour12}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${suffix}`
			: `${hour12}:${pad(date.getMinutes())}${suffix}`;
	}
	return seconds
		? `${pad(hour24)}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
		: `${pad(hour24)}:${pad(date.getMinutes())}`;
}

function formatDuration(ms: number): string | undefined {
	if (!Number.isFinite(ms) || ms < 0) return undefined;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m${pad2(rest)}s`;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

export interface StampSuffixInput {
	theme: any;
	timestamp?: number;
	startedAt?: number;
	completedAt?: number;
	cwd?: string;
	responseTime?: boolean;
}

/** The dim label placed at the right edge of the message's last line. */
export function stampLabel(input: StampSuffixInput): string | undefined {
	const clock = formatClock(input.timestamp ?? Number.NaN, input.cwd);
	if (!clock) return undefined;
	if (input.responseTime && typeof input.startedAt === "number" && typeof input.completedAt === "number") {
		const duration = formatDuration(input.completedAt - input.startedAt);
		if (duration) return `${clock} · ${duration}`;
	}
	return clock;
}

/**
 * Append the stamp to the last non-empty line when there is room, otherwise to
 * a fresh line. Never wraps the label itself; if the terminal is narrower than
 * the label the message renders unstamped.
 */
export function withInlineStamp(lines: string[], theme: any, label: string | undefined, width: number): string[] {
	if (!label || lines.length === 0) return lines;
	const styled = theme?.fg ? theme.fg("dim", label) : label;
	const labelWidth = visibleWidth(styled);
	const gap = 2;
	if (labelWidth + gap + 8 > width) return lines;

	let target = -1;
	for (let index = lines.length - 1; index >= 0; index--) {
		if (lines[index]!.trim().length > 0) {
			target = index;
			break;
		}
	}
	if (target < 0) return lines;
	const line = lines[target]!;
	const lineWidth = visibleWidth(line);
	const padding = width - lineWidth - labelWidth;
	// The last line already fills the width: stamp on its own line rather than
	// colliding with content.
	if (padding < gap) return [...lines.slice(0, target + 1), " ".repeat(Math.max(0, width - labelWidth)) + styled, ...lines.slice(target + 1)];
	const out = [...lines];
	out[target] = `${line}${" ".repeat(padding)}${styled}`;
	return out;
}

/** Trailing-blank normalization keeps one gap row after a stamped message. */
export function withTrailingGap(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1]!.trim().length === 0) end--;
	if (end === 0) return lines;
	return [...lines.slice(0, end), ""];
}

export { wrapTextWithAnsi };
