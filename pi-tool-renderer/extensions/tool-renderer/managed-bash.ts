import {
	bashLiveOutputDelayMs,
	bashLiveTailLines,
	bashOutputMode,
	settingNumber,
	stackToolCalls,
} from "./settings.js";
import { getIntent } from "./intent.js";
import { renderBashDiffOutput, shouldRenderBashDiffsForCommand, suppressReadOnlyBashDiffOutput } from "./diff.js";
import { truncateText } from "./glyphs.js";
import { toolLabel } from "./theme.js";
import {
	bashCallText,
	clearBlink,
	commandExit,
	lineCount,
	linkPath,
	makeEmpty,
	makeTruncatedLines,
	preview,
	renderPendingCall,
	resultTruncated,
	splitTerminalLines,
	stackPrefix,
	textContent,
	type TruncatedLines,
} from "./text.js";
import { renderStackedToolResult } from "./stack.js";

/**
 * Pure managed-Bash presentation shared with pi-bash-processes. These helpers
 * only format/transform; they never register tools or touch Pi's extension
 * API, so either package can call them regardless of load order.
 */

export interface BashLiveTailState {
	startedAt?: number;
	tailShown?: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

export function bashLiveTailState(context: any): BashLiveTailState {
	const state = context?.state;
	if (!state || typeof state !== "object") return {};
	const record = state as Record<string, unknown>;
	if (!record.kendexBashLiveTail || typeof record.kendexBashLiveTail !== "object") record.kendexBashLiveTail = {};
	return record.kendexBashLiveTail as BashLiveTailState;
}

export function markBashStarted(context: any): BashLiveTailState {
	const state = bashLiveTailState(context);
	if (!state.startedAt && context?.executionStarted) state.startedAt = Date.now();
	return state;
}

export function clearBashLiveTailTimer(state: BashLiveTailState): void {
	if (!state.timer) return;
	clearTimeout(state.timer);
	state.timer = undefined;
}

export function scheduleBashLiveTailRerender(state: BashLiveTailState, context: any, delayMs: number): void {
	if (state.tailShown || state.timer || typeof context?.invalidate !== "function") return;
	const startedAt = state.startedAt ?? Date.now();
	const remaining = Math.max(0, startedAt + delayMs - Date.now());
	state.timer = setTimeout(() => {
		state.timer = undefined;
		try {
			context.invalidate();
		} catch {
			// Best-effort redraw only; tool execution continues either way.
		}
	}, remaining);
	state.timer.unref?.();
}

export function renderBashTail(output: string, limit: number, theme: any, cwd?: string): string {
	const trimmed = output.replace(/(?:\r?\n)+$/, "");
	if (!trimmed) return "";
	const tailLines = splitTerminalLines(preview(trimmed, limit, "tail", cwd));
	return tailLines.map((line) => theme.fg("dim", line)).join("\n");
}

export interface ManagedBashRenderInput {
	args: Record<string, unknown> | undefined;
	context: any;
	theme: any;
	cwd: string;
}

export function renderManagedBashCall({ args, context, theme, cwd }: ManagedBashRenderInput): TruncatedLines | ReturnType<typeof makeEmpty> {
	markBashStarted(context);
	return renderPendingCall(`${bashCallText(args ?? {}, theme, context?.cwd ?? cwd, { leadingIntent: getIntent(args) })}`, theme, context, cwd);
}

export interface ManagedBashRenderResultInput extends ManagedBashRenderInput {
	result: any;
	expanded: boolean;
	isPartial: boolean;
	/**
	 * Live task state supplied by the process manager. Present for every
	 * managed Bash result, so the row can report the task's *current* status
	 * and expose the bounded output without parsing the model-facing text.
	 */
	task?: ManagedBashRowTask;
}

/** Bounded, render-ready view of one managed task. */
export interface ManagedBashRowTask {
	id: string;
	status: string;
	exitCode: number | null;
	elapsedMs: number;
	lineCount: number;
	logFile: string;
	tail: string;
}

/** Status text for a managed Bash row: exit code when terminal, otherwise live state. */
function managedBashStatusText(task: ManagedBashRowTask, theme: any): string {
	if (task.status === "running") return theme.fg("warning", "running");
	if (task.status === "timed_out") return theme.fg("error", "timed out");
	if (task.status === "cancelled") return theme.fg("warning", "cancelled");
	const exit = task.exitCode;
	if (exit === null) return theme.fg("success", "completed");
	return exit === 0 ? theme.fg("success", "exit 0") : theme.fg("error", `exit ${exit}`);
}

/**
 * Bash-shaped row driven by task state rather than by the result text. A
 * yielded command keeps the same chrome as a foreground one, streams its
 * bounded tail while running, and expands to the tail plus the log path.
 */
function renderManagedBashTaskRow({ task, expanded, isPartial, context, theme, cwd, args }: ManagedBashRenderInput & { task: ManagedBashRowTask; expanded: boolean; isPartial: boolean }): TruncatedLines {
	const mode = bashOutputMode(cwd);
	if (mode === "hidden") return makeEmpty() as TruncatedLines;
	// Status line first: id, live state, elapsed and output size stay readable
	// even when the command itself is long. The id only appears once the task
	// really is a background task, so a foreground command is not claimed early.
	// The chrome bullet comes from stackPrefix; do not add another one.
	const header = [toolLabel(theme, "Bash")];
	if (!isPartial || task.status !== "running") header.push(` ${theme.fg("accent", task.id)}`);
	header.push(` ${theme.fg("dim", "·")} ${managedBashStatusText(task, theme)}`);
	header.push(theme.fg("dim", ` · ${formatElapsed(task.elapsedMs)}`));
	header.push(theme.fg("dim", ` · ${task.lineCount} line${task.lineCount === 1 ? "" : "s"}`));
	let text = `${stackPrefix(theme)}${header.join("")}`;
	const declaredIntent = typeof args?.intent === "string" ? args.intent.trim() : "";
	const intentLead = declaredIntent ? `\n${theme.fg("dim", "— ")}${theme.fg("accent", declaredIntent)}\n` : "";
	text += `${intentLead}${theme.fg("dim", "$ ")}${theme.fg("accent", bashCommandText(args ?? {}, expanded, cwd))}`;
	const limit = Math.max(1, Math.floor(settingNumber(expanded ? "bashPreviewLines" : "bashCollapsedLines", expanded ? 80 : 10, cwd)));
	const showTail = mode !== "summary" && task.tail.length > 0 && (!isPartial || task.status !== "running" || expanded);
	if (showTail) {
		const tail = renderBashTail(task.tail, limit, theme, cwd);
		if (tail) text += `\n${tail}`;
		if (task.lineCount > limit) text += `\n${theme.fg("muted", `… ${task.lineCount - limit} older line(s)`)}`;
	}
	if (expanded) text += `\n${linkPath(theme.fg("muted", `log: ${task.logFile}`), task.logFile, cwd)}`;
	else if (task.lineCount > limit && task.tail.length > 0) text += `\n${theme.fg("dim", "ctrl+o to expand")}`;
	return makeTruncatedLines(text);
}

/**
 * The command as shown on a task row. Expanded rows show it verbatim; collapsed
 * rows are bounded to `commandHeaderLines` lines and `commandPreviewChars`
 * characters so one heredoc cannot take over the transcript.
 */
function bashCommandText(args: Record<string, unknown> | undefined, expanded: boolean, cwd?: string): string {
	const raw = typeof args?.command === "string" ? args.command : "";
	if (expanded) return raw;
	const maxChars = Math.max(20, Math.floor(settingNumber("commandPreviewChars", 96, cwd)));
	const maxLines = Math.max(1, Math.floor(settingNumber("commandHeaderLines", 1, cwd)));
	const bounded = truncateText(raw, maxChars, cwd);
	const lines = splitTerminalLines(bounded);
	if (lines.length <= maxLines) return bounded;
	return `${lines.slice(0, maxLines).join("\n")}…`;
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1_000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function renderManagedBashResult({ result, expanded, isPartial, context, theme, cwd, task }: ManagedBashRenderResultInput): TruncatedLines | ReturnType<typeof makeEmpty> {
	const stacked = stackToolCalls(context?.cwd ?? cwd);
	if (stacked) return renderStackedToolResult("bash", result, isPartial, expanded, theme, context, cwd);
	const effectiveCwd = context?.cwd ?? cwd;
	const liveTailState = markBashStarted(context);
	if (task) return renderManagedBashTaskRow({ args: context?.args, context, theme, cwd: effectiveCwd, task, expanded, isPartial });
	const call = bashCallText(context?.args ?? {}, theme, effectiveCwd, { full: expanded, leadingIntent: getIntent(context?.args) });
	const output = textContent(result);
	if (isPartial) {
		const trimmedOutput = output.trim();
		const partialMode = bashOutputMode(effectiveCwd);
		if (partialMode !== "summary" && partialMode !== "hidden" && trimmedOutput) {
			const delayMs = bashLiveOutputDelayMs(effectiveCwd);
			const startedAt = liveTailState.startedAt ?? Date.now();
			if (Date.now() - startedAt >= delayMs) {
				clearBashLiveTailTimer(liveTailState);
				liveTailState.tailShown = true;
				const tailText = renderBashTail(output, bashLiveTailLines(effectiveCwd), theme, effectiveCwd);
				if (tailText) return makeTruncatedLines(tailText);
			}
			scheduleBashLiveTailRerender(liveTailState, context, delayMs);
		}
		return makeEmpty();
	}
	clearBlink(context);
	clearBashLiveTailTimer(liveTailState);
	const exit = commandExit(output);
	const count = lineCount(output);
	const exitLabel = exit === null ? "exit 0" : `exit ${exit}`;
	let summary = exit !== null && exit !== 0 ? theme.fg("error", exitLabel) : theme.fg("success", exitLabel);
	summary += theme.fg("dim", ` · ${count} line${count === 1 ? "" : "s"}`);
	// Foreground rows show wall time once the task snapshot carries timing.
	const foreground = result?.details?.task as { startedAt?: number; updatedAt?: number } | undefined;
	const durationText = typeof foreground?.startedAt === "number" && typeof foreground?.updatedAt === "number"
		? formatElapsed(foreground.updatedAt - foreground.startedAt)
		: null;
	if (durationText) summary += theme.fg("dim", ` · ${durationText}`);
	if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
	const mode = bashOutputMode(effectiveCwd);
	if (mode === "hidden") return makeEmpty();
	let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
	const renderDiffs = shouldRenderBashDiffsForCommand(context?.args ?? {}, effectiveCwd);
	const suppressDiffOutput = output ? suppressReadOnlyBashDiffOutput(context?.args ?? {}, output, effectiveCwd) : false;
	const diffPreview = output && mode !== "summary" ? renderBashDiffOutput(output, theme, expanded, effectiveCwd, renderDiffs) : null;
	if (diffPreview) {
		text += `\n${diffPreview}`;
	} else if (!suppressDiffOutput && mode === "preview" && output) {
		const limit = Math.max(1, Math.floor(settingNumber(expanded ? "bashPreviewLines" : "bashCollapsedLines", expanded ? 80 : 10, effectiveCwd)));
		text += `\n${splitTerminalLines(preview(output, limit, "tail", effectiveCwd))
			.map((line) => theme.fg("dim", line))
			.join("\n")}`;
		if (count > limit) text += `\n${theme.fg("muted", `… ${count - limit} older line(s)`)}`;
	} else if (!suppressDiffOutput && mode === "opencode" && expanded && output) {
		const limit = Math.max(1, Math.floor(settingNumber("bashPreviewLines", 80, effectiveCwd)));
		text += `\n${splitTerminalLines(preview(output, limit, "tail", effectiveCwd))
			.map((line) => theme.fg("dim", line))
			.join("\n")}`;
		if (count > limit) text += `\n${theme.fg("muted", `… ${count - limit} older line(s)`)}`;
	} else if (!suppressDiffOutput && mode === "opencode" && liveTailState.tailShown && output) {
		const tailText = renderBashTail(output, bashLiveTailLines(effectiveCwd), theme, effectiveCwd);
		if (tailText) text += `\n${tailText}`;
	}
	return makeTruncatedLines(text);
}
