import { ANTI_POLL_LINE } from "./auto-background.js";
import type { ForegroundOutcome, ForegroundWaiter } from "./types.js";

/**
 * Bounded managed-Bash v1 helpers (pure, no Pi host access).
 *
 * The model-facing `bash` tool spawns every command exactly once under the
 * existing task manager, waits a bounded soft interval (`foregroundYieldMs`),
 * and then either returns the truthful completion or a Running result while
 * the same process continues. These helpers hold the single-owner and
 * formatting contracts so both the extension closure and the test suite
 * exercise the same code. Nothing here is persisted.
 */

export const MANAGED_BASH_PI_ENV_KEYS = [
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
] as const;

export function createForegroundWaiter(): ForegroundWaiter {
	return { outcome: null, resolve: null, settled: false, yieldTimer: null };
}

/**
 * Single-owner settle for the exit-vs-yield race. The first caller wins,
 * clears the pending yield timer, and takes the resolve callback; every
 * later caller (a late child close, a late yield fire, a retry after an
 * ambiguous spawn) gets `false` and must not deliver anything.
 */
export function settleForegroundWaiter(
	waiter: ForegroundWaiter | null | undefined,
	outcome: ForegroundOutcome,
): boolean {
	if (!waiter || waiter.settled) return false;
	waiter.settled = true;
	waiter.outcome = outcome;
	if (waiter.yieldTimer) {
		clearTimeout(waiter.yieldTimer);
		waiter.yieldTimer = null;
	}
	const resolve = waiter.resolve;
	waiter.resolve = null;
	resolve?.(outcome);
	return true;
}

/**
 * Preserve the Bash input `timeout` contract: a finite positive number of
 * seconds enforced as hard process runtime. Anything else disables the hard
 * kill (0). Never conflated with the soft foreground yield.
 */
export function normalizeManagedBashTimeoutSeconds(input: unknown): number {
	return typeof input === "number" && Number.isFinite(input) && input > 0 ? input : 0;
}

export interface ManagedBashSession {
	model?: string;
	provider?: string;
	reasoningLevel?: string;
	sessionFile?: string;
	sessionId?: string;
}

/**
 * Mirror Pi's built-in bash env contract: inherited env plus the five
 * per-command PI_* session/model keys. Shadowed inherited values are deleted
 * first so a stale shell export cannot impersonate the live session. The
 * input object is never mutated, and the result is never persisted.
 */
export function buildManagedBashEnv(
	base: NodeJS.ProcessEnv,
	session: ManagedBashSession = {},
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const key of MANAGED_BASH_PI_ENV_KEYS) delete env[key];
	if (session.sessionId) env.PI_SESSION_ID = session.sessionId;
	if (session.sessionFile) env.PI_SESSION_FILE = session.sessionFile;
	if (session.provider) env.PI_PROVIDER = session.provider;
	if (session.model) env.PI_MODEL = session.model;
	if (session.reasoningLevel) env.PI_REASONING_LEVEL = session.reasoningLevel;
	return env;
}

export interface ManagedBashCompletionText {
	elapsedText: string;
	id: string;
	logFile: string;
	outputTail: string;
	statusText: string;
}

/** Truthful fast-path text: actual (bounded) output plus real status. */
export function formatManagedBashCompletionText(text: ManagedBashCompletionText): string {
	const footer = `[${text.id}: ${text.statusText} in ${text.elapsedText}; log: ${text.logFile}]`;
	return text.outputTail ? `${text.outputTail}\n\n${footer}` : `(no output)\n\n${footer}`;
}

export interface ManagedBashRunningText {
	elapsedText: string;
	id: string;
	logFile: string;
	outputTail: string;
	pid: number;
}

/**
 * Slow-path text. Deliberately not success: output/artifacts are unusable
 * yet, polling is forbidden, only independent work may continue, and
 * completion arrives automatically as a wake message.
 */
export function formatManagedBashRunningText(text: ManagedBashRunningText): string {
	const lines = [
		`Running ${text.id} (pid ${text.pid}) after ${text.elapsedText}. The command is still executing and has not finished yet.`,
		ANTI_POLL_LINE,
		`Full log: ${text.logFile}`,
	];
	if (text.outputTail) lines.splice(1, 0, `Output so far (bounded tail):\n${text.outputTail}`);
	return lines.join("\n\n");
}
