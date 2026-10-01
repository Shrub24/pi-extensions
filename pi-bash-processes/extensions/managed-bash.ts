import { Type } from "typebox";

import { antiPollLine } from "./auto-background.js";
import type { TaskToolSurface } from "./tool-surface.js";
import type { ForegroundOutcome, ForegroundWaiter } from "./types.js";

/**
 * Bounded managed-Bash v1 helpers (pure, no Pi host access).
 *
 * The model-facing `bash` tool spawns every command exactly once under the
 * existing task manager, waits a bounded soft interval (`foregroundYieldMs`),
 * and then either returns the truthful completion or a Running result while
 * the same process continues. A call a codemode script makes is the exception:
 * it runs to completion through Pi's own bash tool (see `isCodemodeCall`).
 * These helpers hold the single-owner, provenance, and formatting contracts so
 * both the extension closure and the test suite exercise the same code. Nothing
 * here is persisted.
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

/**
 * Pi's built-in bash `outputSchema` (`bashOutputSchema` in the coding agent's
 * core bash tool), field for field. The replacement bash tool declares it
 * unchanged so a programmatic caller — a codemode script, for example — reads
 * the same structured result from either bash.
 */
export const BASH_OUTPUT_SCHEMA = Type.Object({
	output: Type.String({
		description: "Combined stdout and stderr, up to 1 MiB. Longer output keeps its first and last 512 KiB around an omission marker.",
	}),
	truncated: Type.Boolean({ description: "Whether `output` omits part of the command output" }),
	full_output_path: Type.Optional(Type.String({ description: "Temp file with the full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

/** Byte cap of `structuredContent.output`; Pi's built-in bash uses the same cap. */
export const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

/** What Pi's bash puts between the kept head and tail of a truncated `output`. */
export function structuredOutputOmittedMarker(omittedBytes: number): string {
	return `\n\n[... ${omittedBytes} bytes omitted ...]\n\n`;
}

/**
 * What a structured result can honestly describe about a finished command's
 * output: the log read when the log holds the record, the bounded text the
 * caller already holds otherwise, and the bytes the task recorded as received
 * (dropped bytes included).
 */
export interface StructuredOutputSource {
	logFile: string;
	/** Output read from `logFile`, or null when the log cannot supply it. */
	read: { output: string; truncated: boolean } | null;
	/** Bounded text the caller holds — the same tail the model reads. */
	text: string;
	/** Bytes the command produced, as the task recorded them. */
	outputBytes: number;
}

export interface ManagedBashStructuredOutput {
	output: string;
	truncated: boolean;
	full_output_path?: string;
	exit_code: number;
	wall_time_seconds: number;
}

/**
 * `structuredContent` of a managed command that finished inside its foreground
 * window.
 *
 * `output` is the log read whenever the caller has one, and the bounded text it
 * already holds otherwise: a log whose last write failed or is stalled is short
 * by whatever it dropped, so it is not this command's record and
 * `full_output_path` — which promises the complete output — is left out with
 * it. `truncated` compares the recorded byte count with what the returned text
 * carries, so a caller is never told that an incomplete output is complete.
 *
 * `exitCode` is a real exit code. A command that ended without one is a
 * termination failure the caller reports; nothing here invents a `0` for it.
 */
export function structuredOutputFor(
	source: StructuredOutputSource,
	exitCode: number,
	elapsedMs: number,
): ManagedBashStructuredOutput {
	const output = source.read ?? {
		output: source.text,
		truncated: source.outputBytes > Buffer.byteLength(source.text, "utf8"),
	};
	return {
		output: output.output,
		truncated: output.truncated,
		...(output.truncated && source.read ? { full_output_path: source.logFile } : {}),
		exit_code: exitCode,
		wall_time_seconds: Math.round(elapsedMs / 100) / 10,
	};
}

/**
 * Pi's `codemode` tool name; its scripts call other tools as nested calls. A
 * `tool_call` event carries only the name, not the definition's parameter schema
 * Pi itself compares to recognize its own codemode tool, so the name is the
 * signal available here.
 */
export const CODEMODE_TOOL_NAME = "codemode";

/** The `tool_call` fields that carry nested-call provenance (Pi 0.99 `ToolCallEvent`). */
export interface NestedToolCallEvent {
	toolCallId: string;
	toolName: string;
	parentToolCallId?: string;
}

/**
 * Whether a `tool_call` is `codemode` itself or a call one of its scripts made.
 *
 * Pi runs a codemode script's nested calls through the same tool pipeline as
 * model-issued calls and sets `parentToolCallId` to the calling call's id (the
 * nested call's own id is `<parent id>/<n>`). Provenance is therefore a chain of
 * call ids: `known` holds every id already attributed to a codemode script — the
 * `codemode` call and each call it made — and the root of a chain is the
 * `codemode` call itself, whichever caller issued it. Wrappers that run other
 * tools (`tool_batch`, for example) are attributed by their parent alone, so
 * calls they make on their own keep the managed path.
 */
export function isCodemodeCall(known: ReadonlySet<string>, event: NestedToolCallEvent): boolean {
	if (event.toolName === CODEMODE_TOOL_NAME) return true;
	const parent = typeof event.parentToolCallId === "string" && event.parentToolCallId.length > 0 ? event.parentToolCallId : undefined;
	return parent !== undefined && known.has(parent);
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
	outputTail: string;
	statusText: string;
}

/** Truthful fast-path text: actual (bounded) output plus real status. */
export function formatManagedBashCompletionText(text: ManagedBashCompletionText): string {
	const footer = `[${text.id}: ${text.statusText} in ${text.elapsedText}]`;
	return text.outputTail ? `${text.outputTail}\n\n${footer}` : `(no output)\n\n${footer}`;
}

export interface ManagedBashRunningText {
	elapsedText: string;
	id: string;
	outputTail: string;
	pid: number;
}

/**
 * Slow-path text. Deliberately not success: output/artifacts are unusable
 * yet, polling is forbidden, only independent work may continue, and
 * completion arrives automatically as a wake message.
 */
export function formatManagedBashRunningText(text: ManagedBashRunningText, surface: TaskToolSurface = "compat"): string {
	const lines = [
		`Running ${text.id} (pid ${text.pid}) after ${text.elapsedText}. The command is still executing and has not finished yet.`,
		antiPollLine(surface),
	];
	if (text.outputTail) lines.splice(1, 0, `Output so far (bounded tail):\n${text.outputTail}`);
	return lines.join("\n\n");
}
