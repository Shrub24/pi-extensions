import type { TaskWaitOutcome, TaskWaitWaiter } from "./types.js";

/**
 * Bounded `bg_task action:"wait"` helpers (pure, no Pi host access).
 *
 * A wait attaches to an existing managed task and resolves on whichever
 * comes first: the task settles, the wait window expires, a queued user
 * message arrives, or the tool call is aborted. These helpers hold the
 * clamp, single-owner, and formatting contracts so both the extension
 * closure and the test suite exercise the same code. Nothing here is
 * persisted.
 */

export const DEFAULT_TASK_WAIT_SECONDS = 30;
export const MAX_TASK_WAIT_SECONDS = 120;
// Pending-message poll cadence while — and only while — a wait is active.
// This is an internal early release for queued user input, not model polling.
export const TASK_WAIT_PENDING_POLL_MS = 100;

/**
 * Clamp the model-supplied wait window. Missing or non-finite input falls
 * back to the default; negative values become an immediate expiry; values
 * above the cap become the cap.
 */
export function clampTaskWaitSeconds(
	input: unknown,
	defaultSeconds = DEFAULT_TASK_WAIT_SECONDS,
	maxSeconds = MAX_TASK_WAIT_SECONDS,
): number {
	const max = Number.isFinite(maxSeconds) ? Math.max(0, maxSeconds) : MAX_TASK_WAIT_SECONDS;
	const fallback = Number.isFinite(defaultSeconds)
		? Math.max(0, Math.min(max, defaultSeconds))
		: Math.min(DEFAULT_TASK_WAIT_SECONDS, max);
	if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
	return Math.max(0, Math.min(max, input));
}

export function createTaskWaitWaiter(): TaskWaitWaiter {
	return { attached: true, expiryTimer: null, outcome: null, pollTimer: null, resolve: null, settled: false };
}

/**
 * Single-owner settle for a bounded wait. The first caller wins, clears both
 * wait timers, detaches, and takes the resolve callback; every later caller
 * (a late expiry, a late queued-message poll, a late abort) gets `false` and
 * must not deliver anything. Detaching is what re-enables the async exit
 * wake for completions that arrive after the wait ended.
 */
export function settleTaskWaitWaiter(
	waiter: TaskWaitWaiter | null | undefined,
	outcome: TaskWaitOutcome,
): boolean {
	if (!waiter || waiter.settled) return false;
	waiter.settled = true;
	waiter.attached = false;
	waiter.outcome = outcome;
	if (waiter.expiryTimer) {
		clearTimeout(waiter.expiryTimer);
		waiter.expiryTimer = null;
	}
	if (waiter.pollTimer) {
		clearInterval(waiter.pollTimer);
		waiter.pollTimer = null;
	}
	const resolve = waiter.resolve;
	waiter.resolve = null;
	resolve?.(outcome);
	return true;
}

export interface TaskWaitRunningText {
	elapsedText: string;
	id: string;
	outputTail: string;
	pid: number;
	waitSeconds: number;
}

/**
 * Slow-path text for a wait window that ended while the task was still
 * running. Deliberately not success: output/artifacts are unusable yet.
 * The model decides explicitly whether one more bounded wait is justified;
 * there is no hidden repeated wait, and the normal completion wake stays
 * armed.
 */
export function formatTaskWaitRunningText(text: TaskWaitRunningText): string {
	const lines = [
		`Still Running ${text.id} (pid ${text.pid}) after a ${text.elapsedText} bounded wait (wait window ${text.waitSeconds}s). The command has not finished; Running is not success, and its output or artifacts are not usable yet.`,
		`Do not call wait again as the default. If other work remains, continue it now — remaining tasks keep running and each completion wakes you as a new turn. End the turn when nothing independent is left; another bounded wait only for the narrow case where this turn cannot proceed (never poll).`,
	];
	if (text.outputTail) lines.splice(1, 0, `Output so far (bounded tail):\n${text.outputTail}`);
	return lines.join("\n\n");
}
