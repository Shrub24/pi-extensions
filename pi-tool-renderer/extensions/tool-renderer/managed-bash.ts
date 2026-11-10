import {
	bashLiveOutputDelayMs,
	bashOutputMode,
	settingNumber,
	stackToolCalls,
} from "./settings.js";
import { getIntent } from "./intent.js";
import { renderBashDiffOutput, shouldRenderBashDiffsForCommand, suppressReadOnlyBashDiffOutput } from "./diff.js";
import { toolLabel } from "./theme.js";
import {
	bashCallBlock,
	boundedBashCommand,
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
	elapsedTimer?: ReturnType<typeof setInterval>;
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

/**
 * A foreground call row shows a live elapsed time, and Pi only repaints a row
 * when something invalidates it. The partial updates that would do that fire
 * only when the tail grows, so a silent command would hold a frozen clock; one
 * repaint a second keeps it honest while the call is still in its foreground
 * window.
 */
export function scheduleBashElapsedTimer(state: BashLiveTailState, context: any): void {
	if (state.elapsedTimer || typeof context?.invalidate !== "function") return;
	state.elapsedTimer = setInterval(() => {
		try {
			context.invalidate();
		} catch {
			// Best-effort repaint only; tool execution continues either way.
		}
	}, 1_000);
	state.elapsedTimer.unref?.();
}

export function clearBashElapsedTimer(state: BashLiveTailState): void {
	if (!state.elapsedTimer) return;
	clearInterval(state.elapsedTimer);
	state.elapsedTimer = undefined;
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
	/**
	 * Live task of this call, supplied while the call is inside its foreground
	 * window. Pi renders a call component and a partial result component side by
	 * side, so the call row is the only place the head, intent and command may
	 * be drawn during the run; the partial result adds its tail and nothing else.
	 * A result row gets the task only once the command outlived that window and
	 * really is a background task.
	 */
	task?: ManagedBashRowTask;
}

export function renderManagedBashCall({ args, context, theme, cwd, task }: ManagedBashRenderInput): TruncatedLines | ReturnType<typeof makeEmpty> {
	const state = markBashStarted(context);
	const effectiveCwd = context?.cwd ?? cwd;
	const live = task && context?.isPartial ? task : undefined;
	if (!live) {
		clearBashElapsedTimer(state);
		const { head, command } = bashCallBlock(args ?? {}, theme, effectiveCwd, { leadingIntent: getIntent(args) });
		return renderPendingCall(`${head}\n${command}`, theme, context, cwd);
	}
	scheduleBashElapsedTimer(state, context);
	// The same head a yielded task row draws, so the row does not change shape
	// when a command outlives its foreground window and becomes a task.
	return renderPendingCall(`${managedBashTaskHead(live, theme, false)}\n${managedBashTaskCommand(args, theme, effectiveCwd, Boolean(context?.expanded))}`, theme, context, cwd);
}

export interface ManagedBashRenderResultInput extends ManagedBashRenderInput {
	result: any;
	expanded: boolean;
	isPartial: boolean;
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
/**
 * Status line of a task-driven row: label, id, live state, elapsed and output
 * size stay readable even when the command itself is long. The id only appears
 * once the task really is a background task, so a foreground command is not
 * claimed early. The chrome bullet is the caller's; it is not drawn here.
 */
function managedBashTaskHead(task: ManagedBashRowTask, theme: any, showId: boolean): string {
	const header = [toolLabel(theme, "Bash")];
	if (showId) header.push(` ${theme.fg("accent", task.id)}`);
	header.push(` ${theme.fg("dim", "·")} ${managedBashStatusText(task, theme)}`);
	header.push(theme.fg("dim", ` · ${formatElapsed(task.elapsedMs)}`));
	header.push(theme.fg("dim", ` · ${task.lineCount} line${task.lineCount === 1 ? "" : "s"}`));
	return header.join("");
}

/** The declared intent and the command, below a task row's status line. */
function managedBashTaskCommand(args: Record<string, unknown> | undefined, theme: any, cwd: string, expanded: boolean): string {
	const declaredIntent = typeof args?.intent === "string" ? args.intent.trim() : "";
	const intentLead = declaredIntent ? `${theme.fg("dim", "— ")}${theme.fg("accent", declaredIntent)}\n` : "";
	return `${intentLead}${theme.fg("dim", "$ ")}${theme.fg("toolOutput", bashCommandText(args ?? {}, expanded, cwd))}`;
}

function renderManagedBashTaskRow({ task, expanded, isPartial, context, theme, cwd, args }: ManagedBashRenderInput & { task: ManagedBashRowTask; expanded: boolean; isPartial: boolean }): TruncatedLines {
	const mode = bashOutputMode(cwd);
	if (mode === "hidden") return makeEmpty() as TruncatedLines;
	let text = `${stackPrefix(theme)}${managedBashTaskHead(task, theme, !isPartial || task.status !== "running")}`;
	text += `\n${managedBashTaskCommand(args, theme, cwd, expanded)}`;
	const limit = Math.max(1, Math.floor(settingNumber(expanded ? "bashPreviewLines" : "bashCollapsedLines", expanded ? 80 : 5, cwd)));
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
	return boundedBashCommand(typeof args?.command === "string" ? args.command : "", cwd, expanded);
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
	const { head, command } = bashCallBlock(context?.args ?? {}, theme, effectiveCwd, { full: expanded, leadingIntent: getIntent(context?.args) });
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
				// Expanding a running call asks for more of its output, so the tail
				// takes the full preview budget instead of the live-tail one.
				const limit = Math.max(1, Math.floor(settingNumber(expanded ? "bashPreviewLines" : "bashLiveTailLines", expanded ? 80 : 4, effectiveCwd)));
				const tailText = renderBashTail(output, limit, theme, effectiveCwd);
				if (tailText) return makeTruncatedLines(tailText);
			}
			scheduleBashLiveTailRerender(liveTailState, context, delayMs);
		}
		return makeEmpty();
	}
	clearBlink(context);
	clearBashLiveTailTimer(liveTailState);
	// Pi's own verdict wins over the output text. A command whose *output* happens
	// to mention an exit code — a manual page, a test asserting on the string —
	// must not read as a failure, and a timeout or cancellation carries no exit
	// code at all, so it can only be reported from `isError`.
	const failed = Boolean(context?.isError || result?.isError);
	const exit = failed ? commandExit(output) : null;
	const count = lineCount(output);
	const exitLabel = exit === null ? (failed ? "failed" : "exit 0") : `exit ${exit}`;
	let summary = theme.fg(failed ? "error" : "success", exitLabel);
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
	// The head carries the label, intent and status; the command sits below it.
	let text = `${stackPrefix(theme)}${head}${theme.fg("dim", " · ")}${summary}\n${command}`;
	const renderDiffs = shouldRenderBashDiffsForCommand(context?.args ?? {}, effectiveCwd);
	const suppressDiffOutput = output ? suppressReadOnlyBashDiffOutput(context?.args ?? {}, output, effectiveCwd) : false;
	const diffPreview = output && mode !== "summary" ? renderBashDiffOutput(output, theme, expanded, effectiveCwd, renderDiffs) : null;
	if (diffPreview) {
		text += `\n${diffPreview}`;
	} else if (!suppressDiffOutput && mode === "preview" && output) {
		const limit = Math.max(1, Math.floor(settingNumber(expanded ? "bashPreviewLines" : "bashCollapsedLines", expanded ? 80 : 5, effectiveCwd)));
		text += `\n${splitTerminalLines(preview(output, limit, "tail", effectiveCwd))
			.map((line) => theme.fg("dim", line))
			.join("\n")}`;
		if (count > limit) text += `\n${theme.fg("muted", `… ${count - limit} older line(s)`)}`;
	}
	return makeTruncatedLines(text);
}
