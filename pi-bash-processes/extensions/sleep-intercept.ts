import { basename } from "node:path";

/**
 * Deterministic sleep-interception gate for model-facing bash. The agent's
 * recurring anti-pattern is `sleep 30 && tail /tmp/kendex-pi-bg/bg-7.log` — a
 * poll loop written by hand. When every piece of such a command is a *wait*
 * plus *pure reads of managed task logs*, the same information is available
 * without the sleep: bounded-wait on the task, then run the reads now.
 *
 * The gate is deliberately narrow and fails open: anything it cannot parse
 * with certainty runs exactly as written. A misfire here would rewrite an
 * agent's command, so ambiguity always means "run as asked".
 */

const MIN_SLEEP_SECONDS = 3;

const READ_TOOLS = new Set(["cat", "tail", "head", "grep", "less", "bat", "zcat", "wc", "pi-bg"]);

/** Pure-read argv: the tool itself, its flags, and path arguments. */
const isReadInvocation = (segment: string): boolean => {
	const parts = segment.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return false;
	if (!READ_TOOLS.has(parts[0]!)) return false;
	for (const part of parts.slice(1)) {
		if (part.startsWith("-") || FD_REDIRECT.test(part)) continue;
		if (part.includes(">") || part.includes("<") || part.includes("|") || part.includes("`") || part.includes("$") || part.includes("&") || part.includes(";")) return false;
	}	return true;
};

/** A pipeline whose every stage is a pure read (cat f | grep x | tail -5). */
const isReadPipeline = (segment: string): boolean => {
	if (segment.includes("|")) {
		const stages = segment.split("|").map((stage) => stage.trim()).filter(Boolean);
		return stages.length > 0 && stages.every(isReadInvocation);
	}
	return isReadInvocation(segment);
};

/**
 * Characters that make a segment something other than a plain read.
 * `2>/dev/null` is allowed: discarding stderr cannot change what the read
 * returns, and agents append it habitually. Any other redirect, expansion,
 * or control operator still fails open.
 */
const FD_REDIRECT = /2>\s*\/dev\/null\b/g;
const hasUnsafeShell = (segment: string): boolean =>
	/[&<>;$`]|\$\(|\|\||&&|\n/.test(segment.replace(FD_REDIRECT, ""));

/** `sleep N[s|m|h]`: coreutils accepts unit suffixes; agents write them. */
const parseSleepSeconds = (token: string): number | null => {
	const match = token.match(/^(\d+(?:\.\d+)?)([smh]?)$/);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return null;
	const unit = match[2] ?? "";
	const multiplier = unit === "h" ? 3_600 : unit === "m" ? 60 : unit === "s" ? 1 : 1;
	return value * multiplier;
};

export interface SleepIntercept {
	/** Whole seconds the caller wanted to wait. */
	sleepSeconds: number;
	/** Managed task ids the read segments reference (parsed from log paths). */
	logPaths: string[];
	/** The command with the leading sleep removed. */
	remainder: string;
}

/**
 * Matches `sleep <N>` followed only by pure reads joined with && or ;.
 * Returns null whenever the shape is anything else — the command then runs
 * exactly as the agent wrote it.
 */
export function matchSleepIntercept(command: string): SleepIntercept | null {
	const trimmed = command.trim();
	if (!/^sleep\s+\S+/.test(trimmed)) return null;
	const segments = trimmed.split(/\s*(?:&&|;)\s*/).filter(Boolean);
	if (segments.length < 1) return null;
	const head = segments[0]!.trim().split(/\s+/);
	if (head.length !== 2 || head[0] !== "sleep") return null;
	const seconds = parseSleepSeconds(head[1]!);
	if (seconds === null || seconds < MIN_SLEEP_SECONDS) return null;
	for (const segment of segments.slice(1)) {
		if (hasUnsafeShell(segment)) return null;
		if (!isReadPipeline(segment)) return null;
	}
	if (segments.length === 1) return null; // bare `sleep N`: pacing, not a poll; leave it alone
	return {
		sleepSeconds: seconds,
		logPaths: segments.slice(1).flatMap((segment) => segment.split(/\s+/).filter((part) => !part.startsWith("-") && part.includes("/"))),
		remainder: segments.slice(1).join(" && "),
	};
}

/** True when a read target is (or points under) a managed task log. */
export const isManagedLogPath = (path: string, taskLogFiles: Iterable<string>): boolean => {
	const base = basename(path.trim());
	for (const logFile of taskLogFiles) {
		if (path.trim() === logFile || base === basename(logFile)) return true;
	}
	return false;
};
