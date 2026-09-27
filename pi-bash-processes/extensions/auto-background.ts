import { compactText, formatRelativeTime, normalizedCommand, shellQuote } from "./format.js";
import { settingBoolean, settingString } from "./settings.js";
import type { BackgroundTaskSnapshot, BashBackgroundDecision } from "./types.js";
import { WAKE_MANIFEST_FIELD_MAX_CHARS, truncateForTranscript } from "./wake-events.js";

function parsePatternList(raw: string): RegExp[] {
	const patterns: RegExp[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^\/(.*)\/([gimsuy]*)$/);
		try {
			patterns.push(match ? new RegExp(match[1], match[2]) : new RegExp(trimmed, "i"));
		} catch {
			// Ignore malformed optional user patterns; built-in safe patterns still apply.
		}
	}
	return patterns;
}

function matchesAnyRegex(command: string, patterns: RegExp[]): boolean {
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		if (pattern.test(command)) return true;
	}
	return false;
}

function loopIterationCount(command: string): number | null {
	const match = command.match(/\$\(\s*seq\s+(?:(\d+)\s+)?(\d+)\s*\)/i);
	if (!match) return null;
	const start = match[1] ? Number.parseInt(match[1], 10) : 1;
	const end = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	return Math.abs(end - start) + 1;
}

function sleepSeconds(command: string): number | null {
	const match = command.match(/\bsleep\s+((?:\d+(?:\.\d+)?)|(?:\.\d+))\s*([smhd])?\b/i);
	if (!match) return null;
	const value = Number.parseFloat(match[1] ?? "");
	if (!Number.isFinite(value)) return null;
	const unit = (match[2] ?? "s").toLowerCase();
	if (unit === "d") return value * 86_400;
	if (unit === "h") return value * 3_600;
	if (unit === "m") return value * 60;
	return value;
}

function looksLikeSessionMonitor(command: string): boolean {
	return /\b(?:pi-bridge|tmux|capture-pane|list-panes|has-session|delegate-state|subagent|session)\b/i.test(command);
}

export function autoBackgroundDecision(command: string, cwd?: string): BashBackgroundDecision | null {
	const normalized = normalizedCommand(command);
	if (!normalized) return null;
	if (matchesAnyRegex(normalized, parsePatternList(settingString("autoBackgroundPatterns", "", cwd)))) {
		return {
			forced: false,
			notifyOnExit: true,
			notifyOnOutput: false,
			reason: "matched configured auto-background pattern",
			title: `auto: ${compactText(normalized, 72)}`,
		};
	}

	if (/(?:^|[;&|]\s*)watch(?:\s|$)/i.test(normalized)) {
		return {
			forced: false,
			notifyOnExit: true,
			notifyOnOutput: false,
			reason: "watch-style command",
			title: `watch: ${compactText(normalized, 72)}`,
		};
	}

	if (/\b(?:tail|journalctl)\b[^\n;|&]*\s-[^\s;|&]*f\b/i.test(normalized)) {
		return {
			forced: false,
			notifyOnExit: true,
			notifyOnOutput: false,
			reason: "follow-mode log command",
			title: `follow: ${compactText(normalized, 72)}`,
		};
	}

	const delaySeconds = sleepSeconds(normalized);
	if (delaySeconds !== null && delaySeconds >= 5 && looksLikeSessionMonitor(normalized)) {
		return {
			forced: false,
			notifyOnExit: true,
			notifyOnOutput: false,
			reason: "delayed session/tmux monitoring command",
			title: `monitor: ${compactText(normalized, 72)}`,
		};
	}

	const hasShellLoop = /\b(?:for|while|until)\b/i.test(normalized) && /\bdo\b/i.test(normalized) && /\bdone\b/i.test(normalized);
	const hasSleep = /\bsleep\s+(?:\d+(?:\.\d+)?|\.\d+)/i.test(normalized);
	if (hasShellLoop && hasSleep) {
		const iterations = loopIterationCount(normalized);
		const looksLikeMonitor = looksLikeSessionMonitor(normalized);
		const longFiniteLoop = iterations !== null && iterations >= 30;
		const openEndedLoop = /\bwhile\s+(?:true|:)\b/i.test(normalized) || /\buntil\b/i.test(normalized);
		if (looksLikeMonitor || longFiniteLoop || openEndedLoop) {
			return {
				forced: false,
				notifyOnExit: true,
				notifyOnOutput: false,
				// A sleep loop usually means the agent is waiting on another task.
				// Name that, so the ack teaches instead of just reporting.
				reason: looksLikeMonitor
					? "session/tmux monitoring loop"
					: "polling loop (agent waiting on something? prefer bg_task wait or ending the turn)",
				title: `monitor: ${compactText(normalized, 72)}`,
			};
		}
	}

	return null;
}

export function forcedBackgroundDecision(command: string, cwd?: string): BashBackgroundDecision {
	return {
		forced: true,
		notifyOnExit: true,
		notifyOnOutput: settingBoolean("forcedBackgroundNotifyOnOutput", false, cwd),
		reason: "requested by background shortcut",
		title: `shortcut: ${compactText(normalizedCommand(command), 72)}`,
	};
}

/**
 * One warning per duplicate shape, shared by bg_task spawn and the
 * auto-background ack: identical commands running now, similar ones, then the
 * recent-rerun note. Empty string when there is nothing to flag.
 */
export function duplicateTaskNote(
	identical: string[],
	related: string[],
	reran: { id: string; updatedAt: number }[],
): string {
	if (identical.length > 0) {
		return `WARNING: identical command already running: ${identical.join(", ")}. Prefer bg_task wait/log on the existing task, or stop it first.`;
	}
	if (related.length > 0) {
		return `Note: similar command already running: ${related.join(", ")}. If this was meant to poll or retry it, bg_task wait on the existing task is cheaper.`;
	}
	if (reran.length > 0) {
		return `Note: same command finished recently in this cwd: ${reran.map((t) => `${t.id} (${formatRelativeTime(t.updatedAt)})`).join(", ")}. Rerun only what changed (bg_task log ${reran[0]!.id} shows the previous tail) unless the code changed since.`;
	}
	return "";
}

/**
 * The one anti-poll line, shared by the auto-background ack and the
 * managed-bash yield text so both surfaces say exactly the same thing.
 */
export const ANTI_POLL_LINE =
	'Do not poll it (no sleep/tail loops, no repeated list/log calls) — continue independent work or end the turn; the exit wake arrives with an output tail. Need it this turn? bg_task action:"wait" blocks once, bounded.';

export function bashBackgroundAckText(
	task: BackgroundTaskSnapshot,
	decision: BashBackgroundDecision,
	otherRunning?: string[],
	duplicateNote?: string,
): string {
	const safeCommand = truncateForTranscript(task.command, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "";
	const safeCwd = truncateForTranscript(task.cwd, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "";
	const safeLog = truncateForTranscript(task.logFile, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "";
	const safePattern = truncateForTranscript(task.notifyPattern, WAKE_MANIFEST_FIELD_MAX_CHARS);
	const safeDedupe = truncateForTranscript(task.dedupeKey, WAKE_MANIFEST_FIELD_MAX_CHARS);
	return [
		`Started ${task.id} (pid ${task.pid}) in the background.`,
		`Reason: ${decision.reason}.`,
		`Command: ${safeCommand}`,
		`Cwd: ${safeCwd}`,
		`Log: ${safeLog}`,
		`Wakeups: exit=${task.notifyOnExit ? "yes" : "no"}, output=${task.notifyOnOutput ? (safePattern ?? "yes") : "no"}, mode=${task.notifyMode ?? "always"}${safeDedupe ? `, dedupeKey=${safeDedupe}` : ""}`,
		ANTI_POLL_LINE,
		...(duplicateNote ? [duplicateNote] : []),
		...(otherRunning && otherRunning.length > 0
			? [`Tasks still running: ${otherRunning.join(", ")} (includes this one). You will be woken once each; no polling needed.`]
			: otherRunning
				? ["No other background tasks are running."]
				: []),
	].join("\n");
}

export function bashBackgroundAck(task: BackgroundTaskSnapshot, decision: BashBackgroundDecision): string {
	return `printf '%s\\n' ${shellQuote(bashBackgroundAckText(task, decision))}`;
}
