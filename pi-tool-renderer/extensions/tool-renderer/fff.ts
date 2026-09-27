/**
 * Presentation adapters for fff's search tools (`ffgrep`, `fffind`,
 * `fff-multi-grep`). fff ships functional renderers of its own; these adapters
 * re-express the same rows in this extension's style — chrome bullet, dim
 * summary, bounded previews — without touching execution.
 */
import { clearBlink, lineCount, makeEmpty, makeTruncatedLines, preview, readOnlyCallText, renderPathListPreview, renderPendingCall, resultTruncated, splitTerminalLines, stackPrefix, textContent } from "./text.js";
import { treeConnector } from "./theme.js";
import { renderStackedToolResult, type StackableToolName } from "./stack.js";
import { settingNumber, stackToolCalls } from "./settings.js";
import type { TruncatedLines } from "./text.js";

type Theme = any;
type Context = any;

/** fff's three tools map onto the native grep/find row shapes. */
export function fffStackName(toolName: string): StackableToolName {
	return toolName === "fffind" ? "find" : "grep";
}

function fffCallText(toolName: string, args: any, theme: Theme, cwd?: string): string {
	return readOnlyCallText(fffStackName(toolName), args ?? {}, theme, cwd);
}

export function renderFffCall(toolName: string, args: any, theme: Theme, context: Context, cwd: string) {
	return renderPendingCall(fffCallText(toolName, args, theme, context?.cwd ?? cwd), theme, context, cwd);
}

/**
 * Same summary + bounded-preview contract as the native grep/find rows. fff
 * result text is plain output, so line counts and truncation carry over.
 */
export function renderFffResult(toolName: string, result: any, options: { expanded?: boolean; isPartial?: boolean }, theme: Theme, context: Context, cwd: string): TruncatedLines | ReturnType<typeof makeEmpty> {
	const effectiveCwd = context?.cwd ?? cwd;
	const stacked = stackToolCalls(effectiveCwd);
	if (stacked) return renderStackedToolResult(fffStackName(toolName), result, Boolean(options.isPartial), Boolean(options.expanded), theme, context, effectiveCwd);
	const call = fffCallText(toolName, context?.args ?? {}, theme, effectiveCwd);
	if (options.isPartial) return makeTruncatedLines(`${stackPrefix(theme)}${call}${theme.fg("dim", " · searching…")}`);
	clearBlink(context);
	const output = textContent(result);
	const count = output.trim() ? lineCount(output) : 0;
	const expanded = Boolean(options.expanded);
	const label = count === 0
		? theme.fg("muted", toolName === "fffind" ? "no files" : "no matches")
		: theme.fg("success", `${count} ${toolName === "fffind" ? `file${count === 1 ? "" : "s"}` : `match${count === 1 ? "" : "es"}`}`);
	let summary = label;
	if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
	let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
	if (output && expanded) {
		if (toolName === "fffind") {
			text += `\n${renderPathListPreview(output, "find", theme, expanded, effectiveCwd)}`;
		} else {
			const limit = Math.max(1, Math.floor(settingNumber("searchPreviewLines", 80, effectiveCwd)));
			text += `\n${splitTerminalLines(preview(output, limit, "head", effectiveCwd))
				.map((line) => `${treeConnector(theme, "│")}${theme.fg("dim", line)}`)
				.join("\n")}`;
			if (count > limit) text += `\n${treeConnector(theme, "│")}${theme.fg("muted", `… ${count - limit} more result line(s)`)}`;
		}
	}
	return makeTruncatedLines(text);
}
