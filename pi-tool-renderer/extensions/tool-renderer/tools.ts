import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

import {
	attachDiffDetails,
	buildStructuredDiff,
	diffSummary,
	editOperationsFromArgs,
	existingSmallTextOrUndefined,
	readTextForDiff,
	renderBashDiffOutput,
	renderMutationCallPreview,
	renderStructuredDiff,
	shouldRenderBashDiffsForCommand,
	suppressReadOnlyBashDiffOutput,
	type StructuredDiff,
} from "./diff.js";
import { renderReadImages } from "./images.js";
import { intentHardRequired, intentModeFor, intentParameters, intentPrepare, stripIntent, withIntentParameter } from "./intent.js";
import {
	readOutputMode,
	searchOutputMode,
	settingNumber,
	stackToolCalls,
} from "./settings.js";
import { stackPrefix, toolLabel, treeConnector } from "./theme.js";
import {
	bashCallText,
	clearBlink,
	commandExit,
	componentHasVisibleLines,
	lineCount,
	makeEmpty,
	makeTruncatedLines,
	preview,
	readCallText,
	readOnlyCallText,
	readResultSummary,
	renderPathListPreview,
	renderToolPathText,
	renderPendingCall,
	renderPendingDetail,
	resultTruncated,
	splitTerminalLines,
	textContent,
} from "./text.js";
import { renderStackedToolResult, type StackableToolName } from "./stack.js";
import { renderManagedBashCall, renderManagedBashResult } from "./managed-bash.js";

export type BuiltInToolName = StackableToolName | "edit" | "write";
export type BuiltInToolSet = Partial<Record<BuiltInToolName, any>>;

const builtInToolCache = new Map<string, BuiltInToolSet>();
const MANAGED_BASH_SYMBOL = Symbol.for("kendex.background-tasks.managed-bash");

export function normalizedCwd(cwd?: string): string {
	return resolve(cwd || process.cwd());
}

function createBuiltInToolSet(agent: any, cwd: string): BuiltInToolSet {
	return {
		read: agent.createReadTool?.(cwd),
		bash: agent.createBashTool?.(cwd),
		edit: agent.createEditTool?.(cwd),
		write: agent.createWriteTool?.(cwd),
		grep: agent.createGrepTool?.(cwd),
		find: agent.createFindTool?.(cwd),
		ls: agent.createLsTool?.(cwd),
	};
}

export function getBuiltInTool(agent: any, cwd: string, toolName: BuiltInToolName): any {
	const key = normalizedCwd(cwd);
	let tools = builtInToolCache.get(key);
	if (!tools) {
		tools = createBuiltInToolSet(agent, key);
		builtInToolCache.set(key, tools);
	}
	return tools[toolName];
}

/**
 * Fields of the wrapped AgentTool that Pi's agent loop reads, which a
 * replacement definition carries unchanged. `description`, `parameters` and
 * `constrainedSampling` are the tool as declared to the model, the last being
 * Pi's schema-sampling choice, strict-prefer on read, bash, edit and write.
 * `prepareArguments` runs before arguments validate against `parameters`, so
 * without it the shapes Pi's own tool accepts fail before `execute` delegates.
 * `outputSchema` lets codemode read the unchanged result's `structuredContent`;
 * on Pi below 0.99.0 the wrapped tool leaves it undefined.
 */
function piToolContract(original: any) {
	return {
		description: original.description,
		parameters: original.parameters,
		constrainedSampling: original.constrainedSampling,
		prepareArguments: original.prepareArguments,
		outputSchema: original.outputSchema,
	};
}

export function contextCwd(context: any, fallback: string): string {
	return context?.cwd ?? fallback;
}

export function registerRead(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = getBuiltInTool(agent, cwd, "read");
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: "read",
		label: "read",
		...piToolContract(original),
		parameters: intentParameters("read", original.parameters, cwd),
		prepareArguments: intentPrepare("read", "Reading the file", cwd),
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			return getBuiltInTool(agent, contextCwd(context, cwd), "read").execute(id, stripIntent(params), signal, onUpdate, context);
		},
		renderCall(args: any, theme: any, context: any) {
			const intentLead = typeof args?.intent === "string" && args.intent.trim()
				? `${theme.fg("dim", "— ")}${theme.fg("accent", args.intent.trim())}${theme.fg("dim", " · ")}`
				: "";
			return renderPendingCall(`${readCallText(args ?? {}, theme, context?.cwd ?? cwd)}${intentLead}`, theme, context, cwd);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const stacked = stackToolCalls(context?.cwd ?? cwd);
			if (stacked) return renderStackedToolResult("read", result, isPartial, expanded, theme, context, cwd);
			const call = readCallText(context?.args ?? {}, theme, context?.cwd ?? cwd);
			if (isPartial) return renderPendingDetail("reading…", theme);
			clearBlink(context);
			const content = textContent(result);
			const count = lineCount(content);
			const summary = readResultSummary(result, context?.args ?? {}, theme);
			const mode = readOutputMode(context?.cwd ?? cwd);
			if (mode === "hidden") return renderReadImages(makeEmpty(), result, expanded, theme, context, cwd);
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			if (mode === "preview" && expanded && content) {
				const limit = Math.max(1, Math.floor(settingNumber("readPreviewLines", 80, context?.cwd)));
				text += `\n${splitTerminalLines(preview(content, limit, "head", context?.cwd))
					.map((line) => `${treeConnector(theme, "│")}${theme.fg("dim", line)}`)
					.join("\n")}`;
				if (count > limit) text += `\n${treeConnector(theme, "│")}${theme.fg("muted", `… ${count - limit} more line(s)`)}`;
			}
			return renderReadImages(makeTruncatedLines(text), result, expanded, theme, context, cwd);
		},
	});
}

export function registerBash(pi: ExtensionAPI, agent: any, cwd: string): void {
	if ((globalThis as unknown as Record<PropertyKey, unknown>)[MANAGED_BASH_SYMBOL]) return;
	const original = getBuiltInTool(agent, cwd, "bash");
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: "bash",
		label: "bash",
		...piToolContract(original),
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			return getBuiltInTool(agent, contextCwd(context, cwd), "bash").execute(id, params, signal, onUpdate, context);
		},
		renderCall(args: any, theme: any, context: any) {
			return renderManagedBashCall({ args, context, theme, cwd });
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			return renderManagedBashResult({ result, expanded, isPartial, context, theme, cwd });
		},
	});
}

export function registerBashOnSessionStart(pi: ExtensionAPI, agent: any, cwd: string): void {
	let attempted = false;
	pi.on("session_start", () => {
		if (attempted) return;
		attempted = true;
		registerBash(pi, agent, cwd);
	});
}

export function registerEdit(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = getBuiltInTool(agent, cwd, "edit");
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: "edit",
		label: "edit",
		...piToolContract(original),
		parameters: intentParameters("edit", original.parameters, cwd),
		// Pi's agent loop prepares arguments before schema validation; the
		// replacement definition has to carry the hook or the shapes Pi's own
		// tool accepts fail validation before execute() can delegate. The
		// intent arg is stripped and backfilled before the original shim runs.
		prepareArguments(args: Record<string, unknown>) {
			const prepared = intentPrepare("edit", "Editing the file", cwd)(args);
			return original.prepareArguments ? original.prepareArguments(prepared) : prepared;
		},
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			const effectiveCwd = contextCwd(context, cwd);
			const targetPath = params?.path ?? params?.file_path;
			const before = readTextForDiff(targetPath, effectiveCwd);
			const result = await getBuiltInTool(agent, effectiveCwd, "edit").execute(id, stripIntent(params), signal, onUpdate, context);
			const after = result?.isError ? before : readTextForDiff(targetPath, effectiveCwd);
			return attachDiffDetails(result, before, after, typeof targetPath === "string" ? targetPath : undefined);
		},
		renderCall(args: any, theme: any, context: any) {
			const effectiveCwd = context?.cwd ?? cwd;
			const targetPath = args?.path ?? args?.file_path ?? "";
			if (context?.argsComplete) {
				const diffs = editOperationsFromArgs(args).map((edit) => ({ ...buildStructuredDiff(edit.oldText, edit.newText), path: targetPath }));
				const previewComponent = renderMutationCallPreview("Edit", String(targetPath), diffs, theme, context, effectiveCwd);
				if (componentHasVisibleLines(previewComponent)) return previewComponent;
			}
			const intentLead = typeof args?.intent === "string" && args.intent.trim()
				? `${theme.fg("dim", "— ")}${theme.fg("accent", args.intent.trim())}${theme.fg("dim", " · ")}`
				: "";
			return renderPendingCall(`${toolLabel(theme, "Edit ")}${intentLead}${renderToolPathText(targetPath, theme, effectiveCwd)}`, theme, context, cwd);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const args = context?.args ?? {};
			const targetPath = args.path ?? args.file_path ?? "";
			const call = `${toolLabel(theme, "Edit ")}${renderToolPathText(targetPath, theme, context?.cwd ?? cwd)}`;
			if (isPartial) return renderPendingDetail("editing…", theme);
			clearBlink(context);
			const structured = result?.details?.kendexDiff as StructuredDiff | undefined;
			if (context?.isError || result?.isError) {
				const errorText = splitTerminalLines(textContent(result))[0] || "edit failed";
				return makeTruncatedLines(`${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${theme.fg("error", errorText)}`);
			}
			const summary = structured ? diffSummary(structured, theme, context?.cwd ?? cwd) : theme.fg("success", "applied");
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			if (structured) text += `\n${renderStructuredDiff(structured, theme, expanded, context?.cwd ?? cwd, undefined, targetPath)}`;
			return makeTruncatedLines(text);
		},
	});
}

export function registerWrite(pi: ExtensionAPI, agent: any, cwd: string): void {
	const original = getBuiltInTool(agent, cwd, "write");
	if (!original) return;
	pi.registerTool({
		renderShell: "self",
		name: "write",
		label: "write",
		...piToolContract(original),
		parameters: intentParameters("write", original.parameters, cwd),
		prepareArguments: intentPrepare("write", "Writing the file", cwd),
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			const effectiveCwd = contextCwd(context, cwd);
			const targetPath = params?.path ?? params?.file_path;
			const before = readTextForDiff(targetPath, effectiveCwd);
			const result = await getBuiltInTool(agent, effectiveCwd, "write").execute(id, stripIntent(params), signal, onUpdate, context);
			const after = result?.isError ? before : typeof params?.content === "string" ? params.content : readTextForDiff(targetPath, effectiveCwd);
			return attachDiffDetails(result, before, after, typeof targetPath === "string" ? targetPath : undefined);
		},
		renderCall(args: any, theme: any, context: any) {
			const effectiveCwd = context?.cwd ?? cwd;
			const targetPath = args?.path ?? args?.file_path ?? "";
			const lineTotal = lineCount(args?.content ?? "");
			if (context?.argsComplete && typeof args?.content === "string") {
				const before = existingSmallTextOrUndefined(String(targetPath), effectiveCwd);
				const label: "Write" | "Create" = before === undefined ? "Create" : "Write";
				const diff = { ...buildStructuredDiff(before ?? "", args.content), path: String(targetPath) };
				const previewComponent = renderMutationCallPreview(label, String(targetPath), [diff], theme, context, effectiveCwd);
				if (componentHasVisibleLines(previewComponent)) return previewComponent;
			}
			const intentLead = typeof args?.intent === "string" && args.intent.trim()
				? `${theme.fg("dim", "— ")}${theme.fg("accent", args.intent.trim())}${theme.fg("dim", " · ")}`
				: "";
			return renderPendingCall(`${toolLabel(theme, "Write ")}${intentLead}${renderToolPathText(targetPath, theme, effectiveCwd)} ${theme.fg("dim", `· ${lineTotal} lines`)}`, theme, context, cwd);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const args = context?.args ?? {};
			const targetPath = args.path ?? args.file_path ?? "";
			const lineTotal = lineCount(args.content ?? "");
			const label = result?.details?.kendexDiffWasNewFile ? "Create " : "Write ";
			const call = `${toolLabel(theme, label)}${renderToolPathText(targetPath, theme, context?.cwd ?? cwd)} ${theme.fg("dim", `· ${lineTotal} lines`)}`;
			if (isPartial) return renderPendingDetail("writing…", theme);
			clearBlink(context);
			const structured = result?.details?.kendexDiff as StructuredDiff | undefined;
			if (context?.isError || result?.isError) {
				const errorText = splitTerminalLines(textContent(result))[0] || "write failed";
				return makeTruncatedLines(`${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${theme.fg("error", errorText)}`);
			}
			const summary = structured ? diffSummary(structured, theme, context?.cwd ?? cwd) : theme.fg("success", "written");
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			if (structured) text += `\n${renderStructuredDiff(structured, theme, expanded, context?.cwd ?? cwd, undefined, targetPath)}`;
			return makeTruncatedLines(text);
		},
	});
}

export function registerReadOnly(pi: ExtensionAPI, agent: any, cwd: string, toolName: "grep" | "find" | "ls"): void {
	const original = getBuiltInTool(agent, cwd, toolName);
	if (!original) return;
	pi.registerTool({
		rrenderKendexOwned: true,
		renderShell: "self",
		name: toolName,
		label: toolName,
		...piToolContract(original),
		description: toolName === "find"
			? "Fuzzy path and glob search. Use when the target is fundamentally a path or filename, or as a scoped fallback after indexed/semantic code discovery. Do not use as the first tool for conceptual, behavioral, symbol, caller, or architecture discovery."
			: original.description,
		parameters: intentParameters(toolName, original.parameters, cwd),
		prepareArguments: intentPrepare(toolName, `Running ${toolName}`, cwd),
		async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, context: any) {
			return getBuiltInTool(agent, contextCwd(context, cwd), toolName).execute(id, stripIntent(params), signal, onUpdate, context);
		},
		renderCall(args: any, theme: any, context: any) {
			return renderPendingCall(readOnlyCallText(toolName, args ?? {}, theme, context?.cwd ?? cwd), theme, context, cwd);
		},
		renderResult(result: any, { expanded, isPartial }: any, theme: any, context: any) {
			const stacked = stackToolCalls(context?.cwd ?? cwd);
			if (stacked) return renderStackedToolResult(toolName, result, isPartial, expanded, theme, context, cwd);
			const call = readOnlyCallText(toolName, context?.args ?? {}, theme, context?.cwd ?? cwd);
			if (isPartial) return renderPendingDetail(`${toolName}…`, theme);
			clearBlink(context);
			const output = textContent(result);
			const count = output.trim() ? lineCount(output) : 0;
			const label = toolName === "grep"
				? `${count} match${count === 1 ? "" : "es"}`
				: toolName === "ls"
					? `${count} entr${count === 1 ? "y" : "ies"}`
					: `${count} file${count === 1 ? "" : "s"}`;
			let summary = count === 0 ? theme.fg("muted", toolName === "grep" ? "no matches" : toolName === "ls" ? "empty" : "no files") : theme.fg("success", label);
			if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
			const mode = searchOutputMode(context?.cwd ?? cwd);
			if (mode === "hidden") return makeEmpty();
			let text = `${stackPrefix(theme)}${call}${theme.fg("dim", " · ")}${summary}`;
			if (mode === "preview" && expanded && output) {
				if (toolName === "find" || toolName === "ls") {
					text += `\n${renderPathListPreview(output, toolName, theme, expanded, context?.cwd)}`;
				} else {
					const limit = Math.max(1, Math.floor(settingNumber("searchPreviewLines", 80, context?.cwd)));
					text += `\n${splitTerminalLines(preview(output, limit, "head", context?.cwd))
						.map((line) => `${treeConnector(theme, "│")}${theme.fg("dim", line)}`)
						.join("\n")}`;
					if (count > limit) text += `\n${treeConnector(theme, "│")}${theme.fg("muted", `… ${count - limit} more result line(s)`)}`;
				}
			}
			return makeTruncatedLines(text);
		},
	});
}

