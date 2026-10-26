/**
 * One renderer resolver for every tool row this package draws. Pi asks the
 * resolver chain for a row's renderers by tool name, so a row takes this
 * package's style whichever extension registered the name:
 *
 * - the read-only search tools this package registers (`grep`, `find`, `ls`),
 *   which fff's override mode replaces with its own tools of the same names;
 * - fff's search tools (`ffgrep`, `fffind`, `fff-multi-grep`, `multi_grep`);
 * - the cbmem adapter's tools;
 * - tools that have no renderer from anyone, drawn with the generic row.
 *
 * Existing renderers are preserved; the resolver opts their row into this
 * package's shell so toolChrome applies consistently. Pi before 1.0.1 has no
 * resolver seam, so rows keep Pi's own shell.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { CBM_TOOL_NAMES, renderCbmCall, renderCbmResult } from "./cbm.js";
import { renderFffCall, renderFffResult } from "./fff.js";
import { renderGenericToolCall, renderGenericToolResult } from "./generic.js";
import { settingBoolean } from "./settings.js";
import { makeEmpty } from "./text.js";
import { readOnlyRowDefinitions } from "./tools.js";

const FFF_TOOL_NAMES = new Set(["ffgrep", "fffind", "fff-multi-grep", "multi_grep"]);

/** A row drawn in this package's shell: chrome lines and the bounded body. */
function rowRenderers(renderCall: (...args: any[]) => any, renderResult: (...args: any[]) => any) {
	return { renderShell: "self" as const, renderCall, renderResult };
}

/** The plain text of a node the package's renderers returned (a pi-tui `Text`). */
function textOf(node: any): string {
	return typeof node?.text === "string" ? node.text : "";
}

/**
 * One line per todo state change. The call draws alone while it is pending;
 * once its result is in, the call is dropped and the result draws the call and
 * its status together, so `todo → Subject  ● completed` is a single row.
 */
function inlineTodoRow(base: any) {
	return rowRenderers(
		(args, theme, context) => (context?.isPartial === false ? makeEmpty() : base.renderCall(args, theme, context)),
		(result, options, theme, context) => {
			const call = textOf(base.renderCall(context?.args ?? {}, theme, context));
			const status = textOf(base.renderResult(result, options, theme, context));
			return new Text(status ? `${call}  ${status}` : call, 0, 0);
		},
	);
}

export function installRowRenderers(pi: ExtensionAPI): void {
	if (typeof pi.registerToolRenderer !== "function") return;
	pi.registerToolRenderer((toolName, next) => {
		const cwd = process.cwd();
		const own = readOnlyRowDefinitions.get(toolName);
		if (own) return rowRenderers(own.renderCall, own.renderResult);
		if (FFF_TOOL_NAMES.has(toolName) && settingBoolean("fffRenderers", true, cwd)) {
			return rowRenderers(
				(args, theme, context) => renderFffCall(toolName, args, theme, context, cwd),
				(result, options, theme, context) => renderFffResult(toolName, result, options ?? {}, theme, context, cwd),
			);
		}
		if (CBM_TOOL_NAMES.has(toolName) && settingBoolean("cbmRenderers", true, cwd)) {
			return rowRenderers(
				(args, theme) => renderCbmCall(toolName, args ?? {}, theme),
				(result, options, theme) => renderCbmResult(toolName, result, options ?? {}, theme),
			);
		}
		const base = next();
		if (toolName === "todo" && base?.renderCall && base?.renderResult) return inlineTodoRow(base);
		if (base?.renderCall || base?.renderResult) {
			return base.renderShell === "self" ? base : { ...base, renderShell: "self" };
		}
		if (!settingBoolean("genericToolRenderers", true, cwd)) return base;
		return rowRenderers(
			(args, theme, context) => renderGenericToolCall(toolName, args, theme, context),
			(result, options, theme, context) => renderGenericToolResult(toolName, result, options, theme, context),
		);
	});
}
