import { getCapabilities, hyperlink, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as os from "node:os";
import { basename, extname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { stableRenderWidth, stripAnsi } from "./ansi.js";
import { glyphs, truncateText } from "./glyphs.js";
import { bashCommandMaxChars, fileHyperlinkMode, pendingStatusAnimation, settingNumber, stackToolCalls } from "./settings.js";
import { stackPrefix, toolLabel, treeConnector, type TreeBranch } from "./theme.js";

export class TruncatedLines {
	private cachedLines?: string[];
	private cachedWidth?: number;
	private readonly lines: string[];

	constructor(text: string) {
		this.lines = text ? splitTerminalLines(text) : [];
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const targetWidth = stableRenderWidth(width);
		const lines = this.lines.flatMap((line) => {
			const wrapped = wrapTextWithAnsi(line, targetWidth);
			return wrapped.length > 0 ? wrapped : [""];
		});
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

export function makeTruncatedLines(text: string): TruncatedLines {
	return new TruncatedLines(text);
}

export function makeEmpty() {
	return {
		invalidate() {},
		render(): string[] {
			return [];
		},
	};
}

export function componentHasVisibleLines(component: unknown): boolean {
	try {
		const render = (component as any)?.render;
		return typeof render === "function" && render.call(component, 120).length > 0;
	} catch {
		return false;
	}
}

export function normalizeTerminalText(text: string): string {
	return text.replace(/\r\n|\r/g, "\n").replace(/\t/g, "   ");
}

export function splitTerminalLines(text: string): string[] {
	return normalizeTerminalText(text).split("\n");
}

export function lineCount(text: string): number {
	if (!text) return 0;
	const normalized = normalizeTerminalText(text).replace(/\n$/, "");
	if (!normalized) return 0;
	return normalized.split("\n").length;
}

export function textContent(result: any): string {
	const part = result?.content?.find?.((candidate: any) => candidate?.type === "text" && typeof candidate.text === "string");
	return part?.text ?? "";
}

export function clipLine(line: string, cwd?: string): string {
	const max = Math.max(40, Math.floor(settingNumber("maxLineWidth", 1000, cwd)));
	return truncateText(line, max, cwd);
}

export function preview(text: string, count: number, direction: "head" | "tail", cwd?: string): string {
	const lines = splitTerminalLines(text);
	const selected = direction === "head" ? lines.slice(0, count) : lines.slice(-count);
	return selected.map((line) => clipLine(line, cwd)).join("\n");
}

export function commandExit(text: string): number | null {
	const match = text.match(/(?:^|\n)Command exited with code (\d+)\s*$/);
	return match ? Number.parseInt(match[1]!, 10) : null;
}

export function diffStats(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of splitTerminalLines(diff)) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
	}
	return { additions, removals };
}

export function truncatedMarker(text: string): boolean {
	return /^\s*\[(?:Output|Full output|Read output|Search output|Bash output)[^\n\]]*truncated|^\s*\[[^\n\]]*Full output saved to:/im.test(text);
}

export function resultTruncated(result: any): boolean {
	const details = result?.details;
	if (typeof details?.truncation?.truncated === "boolean") return details.truncation.truncated;
	if (typeof details?.truncated === "boolean") return details.truncated;
	return truncatedMarker(textContent(result));
}

export function readResultSummary(result: any, args: any, theme: any): string {
	const truncation = result?.details?.truncation;
	if (truncation?.truncated && typeof truncation.outputLines === "number" && typeof truncation.totalLines === "number") {
		let summary = theme.fg("success", `${truncation.outputLines}/${truncation.totalLines} lines`) + theme.fg("warning", " · truncated");
		if (!truncation.firstLineExceedsLimit && truncation.outputLines > 0) {
			const startLine = Math.max(1, Math.floor(Number(args?.offset) || 1));
			summary += theme.fg("dim", ` · continue offset=${startLine + truncation.outputLines}`);
		}
		return summary;
	}
	const count = lineCount(textContent(result));
	let summary = theme.fg("success", `${count} line${count === 1 ? "" : "s"}`);
	if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
	return summary;
}

interface BlinkEntry {
	/** The row may already be gone: a weak reference keeps an abandoned pending row collectable. */
	context: WeakRef<{ invalidate?: () => void }>;
}

const blinkEntries = new Map<string, BlinkEntry>();
let blinkTimer: ReturnType<typeof setInterval> | undefined;

/** A row without an id cannot be cleared later, so it is never tracked. */
function blinkKey(context: any): string | undefined {
	const key = context?.toolCallId ?? context?.id;
	return typeof key === "string" && key.length > 0 ? key : undefined;
}

function sweepBlinkEntries(): void {
	for (const [key, entry] of blinkEntries) {
		const context = entry.context.deref();
		if (!context) {
			blinkEntries.delete(key);
			continue;
		}
		try {
			context.invalidate?.();
		} catch {
			// Rendering invalidation is best-effort only.
		}
	}
	if (blinkEntries.size === 0) stopBlinkTimer();
}

function stopBlinkTimer(): void {
	if (!blinkTimer) return;
	clearInterval(blinkTimer);
	blinkTimer = undefined;
}

/** A session boundary drops every tracked row: their contexts belong to the session that made them. */
export function resetBlinkStore(): void {
	blinkEntries.clear();
	stopBlinkTimer();
}

function startBlinkTimer(): void {
	if (blinkTimer) return;
	blinkTimer = setInterval(sweepBlinkEntries, 450);
	blinkTimer.unref?.();
}

function trackBlink(context: any): void {
	const key = blinkKey(context);
	if (!key || typeof context?.invalidate !== "function") return;
	blinkEntries.set(key, { context: new WeakRef(context) });
	startBlinkTimer();
}

export function clearBlink(context: any): void {
	const key = blinkKey(context);
	if (key) blinkEntries.delete(key);
	if (blinkEntries.size === 0) stopBlinkTimer();
}

/**
 * Read-only size of the blink store, for `/renderdebug memory`. Each entry holds
 * one weak reference, so the entry count is the honest number.
 */
export function blinkStoreStats(): { entries: number; timerRunning: boolean } {
	return { entries: blinkEntries.size, timerRunning: blinkTimer !== undefined };
}

export function blinkingPrefix(theme: any, context: any, cwd?: string): string {
	trackBlink(context);
	const on = Math.floor(Date.now() / 450) % 2 === 0;
	const g = glyphs(context?.cwd ?? cwd);
	return theme.fg(on ? "success" : "muted", on ? g.bullet : g.emptyBullet);
}

export function pendingStatusPrefix(theme: any, context: any, cwd?: string): string {
	if (pendingStatusAnimation(context?.cwd ?? cwd)) return blinkingPrefix(theme, context, cwd);
	clearBlink(context);
	return theme.fg("warning", glyphs(context?.cwd ?? cwd).bullet);
}

export function renderPendingCall(call: string, theme: any, context: any, cwd?: string): TruncatedLines | ReturnType<typeof makeEmpty> {
	if (!context?.executionStarted || !context?.isPartial || stackToolCalls(context?.cwd ?? cwd)) return makeEmpty();
	return makeTruncatedLines(`${pendingStatusPrefix(theme, context, cwd)}${call}`);
}

export function renderPendingDetail(text: string, theme: any, cwd?: string): TruncatedLines {
	return makeTruncatedLines(`${treeConnector(theme, "└", cwd)}${theme.fg("warning", text)}`);
}

const NF_DIR = "";
const NF_FILE = "";
const ICON_BY_NAME: Record<string, string> = {
	"dockerfile": "",
	"license": "",
	"makefile": "",
	"package.json": "",
	"readme.md": "󰂺",
	"tsconfig.json": "",
};
const ICON_BY_EXT: Record<string, string> = {
	bash: "",
	c: "",
	cpp: "",
	css: "",
	gif: "",
	go: "",
	graphql: "󰡷",
	html: "",
	java: "",
	jpg: "",
	jpeg: "",
	js: "",
	json: "",
	jsx: "",
	lock: "",
	lua: "",
	md: "󰍔",
	png: "",
	py: "",
	rb: "",
	rs: "",
	scss: "",
	sh: "",
	sql: "",
	svg: "󰜡",
	svelte: "",
	toml: "",
	ts: "",
	tsx: "",
	vue: "",
	xml: "󰗀",
	yaml: "",
	yml: "",
	zsh: "",
};


export function nerdIcon(pathText: string, isDirectory = false, theme?: any, cwd?: string): string {
	if (glyphs(cwd).line === "-") return theme?.fg ? theme.fg(isDirectory ? "accent" : "muted", isDirectory ? "d" : "f") : (isDirectory ? "d" : "f");
	if (isDirectory) return theme?.fg ? theme.fg("accent", NF_DIR) : NF_DIR;
	const clean = stripAnsi(pathText).trim().replace(/\/$/, "");
	const name = basename(clean).toLowerCase();
	const icon = ICON_BY_NAME[name] ?? ICON_BY_EXT[extname(name).replace(/^\./, "").toLowerCase()] ?? NF_FILE;
	const token = icon === NF_FILE ? "muted" : "accent";
	return theme?.fg ? theme.fg(token, icon) : icon;
}

export function renderPathListPreview(output: string, toolName: "find" | "ls", theme: any, expanded: boolean, cwd?: string): string {
	const rawItems = splitTerminalLines(output).filter((line) => line.trim().length > 0);
	if (rawItems.length === 0) return theme.fg("muted", toolName === "ls" ? "empty directory" : "no files found");
	const limit = Math.max(1, Math.floor(settingNumber("searchPreviewLines", 80, cwd)));
	const shown = rawItems.slice(0, expanded ? limit : Math.min(limit, 12));
	const lines = shown.map((item, index) => {
		const clean = stripAnsi(item).trim();
		const isDir = clean.endsWith("/");
		const branch = index === shown.length - 1 && shown.length === rawItems.length ? "└" : "├";
		const icon = nerdIcon(clean, isDir, theme, cwd);
		const label = isDir ? theme.fg("accent", theme.bold(clean)) : theme.fg("dim", clean);
		return `${treeConnector(theme, branch as "├" | "└", cwd)}${icon} ${label}`;
	});
	const remaining = rawItems.length - shown.length;
	if (remaining > 0) {
		const noun = toolName === "ls" ? (remaining === 1 ? "entry" : "entries") : `file${remaining === 1 ? "" : "s"}`;
		lines.push(`${treeConnector(theme, "└", cwd)}${theme.fg("muted", `${glyphs(cwd).ellipsis} ${remaining} more ${noun}`)}`);
	}
	return lines.join("\n");
}

export function shortenPath(pathText: string): string {
	if (typeof pathText !== "string") return "";
	const home = os.homedir();
	if (pathText === home) return "~";
	if (pathText.startsWith(`${home}/`)) return `~${pathText.slice(home.length)}`;
	return pathText;
}

function pathHyperlinksEnabled(cwd?: string, override?: boolean): boolean {
	if (override !== undefined) return override;
	const mode = fileHyperlinkMode(cwd);
	return mode === "on" || (mode === "auto" && getCapabilities().hyperlinks);
}

export function linkPath(styledText: string, rawPath: string, cwd?: string, hyperlinks?: boolean): string {
	if (!pathHyperlinksEnabled(cwd, hyperlinks)) return styledText;
	const absolutePath = resolvePath(cwd || process.cwd(), rawPath || ".");
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function renderToolPathText(rawPath: unknown, theme: any, cwd?: string, options?: { emptyFallback?: string }, hyperlinks?: boolean): string {
	const value = typeof rawPath === "string" ? rawPath : rawPath == null ? "" : String(rawPath);
	const displayPath = value || options?.emptyFallback;
	if (!displayPath) return theme.fg("accent", "");
	return linkPath(theme.fg("accent", shortenPath(displayPath)), displayPath, cwd, hyperlinks);
}

export function readCallText(args: any, theme: any, cwd?: string, hyperlinks?: boolean): string {
	const range = args?.offset || args?.limit ? `:${args.offset ?? 1}${args.limit ? `-${Number(args.offset ?? 1) + Number(args.limit) - 1}` : ""}` : "";
	return `${toolLabel(theme, "Read ")}${renderToolPathText(args?.path ?? args?.file_path ?? "", theme, cwd, undefined, hyperlinks)}${range ? theme.fg("accent", range) : ""}`;
}

/**
 * The command text for a bash row. Expanded rows show the command the model
 * actually sent; collapsed rows keep the bounded preview so one long heredoc
 * cannot flood the transcript.
 */
function bashCommandSource(args: any, cwd: string | undefined, full: boolean): string {
	return boundedBashCommand(typeof args?.command === "string" ? args.command : "", cwd, full);
}

/**
 * The command as a bash row shows it. Collapsed rows keep `commandHeaderLines`
 * lines (the line budget is the primary limit) and, only when `commandPreviewChars`
 * is set, a character cap as well. Expanded rows show the command verbatim.
 */
export function boundedBashCommand(raw: string, cwd: string | undefined, full: boolean): string {
	if (full) return raw;
	const maxChars = bashCommandMaxChars(cwd);
	const bounded = maxChars === undefined ? raw : truncateText(raw, maxChars, cwd);
	const maxLines = Math.max(1, Math.floor(settingNumber("commandHeaderLines", 1, cwd)));
	const lines = splitTerminalLines(bounded);
	if (lines.length <= maxLines) return bounded;
	return `${lines.slice(0, maxLines).join("\n")}…`;
}

/** The model-written intent: it is the why, and more informative than the command. */
function bashIntentText(theme: any, leadingIntent: string | undefined): string {
	return typeof leadingIntent === "string" && leadingIntent.trim() ? theme.fg("accent", leadingIntent.trim()) : "";
}

export function bashCallText(args: any, theme: any, cwd?: string, options: { full?: boolean; leadingIntent?: string } = {}): string {
	const intent = bashIntentText(theme, options.leadingIntent);
	const intentLead = intent ? `${theme.fg("dim", "— ")}${intent}${theme.fg("dim", " · ")}` : "";
	const [firstLine = "", ...continuationLines] = splitTerminalLines(bashCommandSource(args, cwd, options.full === true));
	const styledFirstLine = theme.fg("accent", firstLine);
	const styledContinuation = continuationLines.map((line) => theme.fg("accent", line)).join("\n");
	return `${toolLabel(theme, "Bash ")}${intentLead}${theme.fg("dim", "$ ")}${styledFirstLine}${styledContinuation ? `\n${styledContinuation}` : ""}`;
}

/**
 * Standalone bash rows: the label and intent form the head line, and the command
 * sits on the line below in `toolOutput`, so it stays apart from the intent.
 */
export function bashCallBlock(args: any, theme: any, cwd?: string, options: { full?: boolean; leadingIntent?: string } = {}): { head: string; command: string } {
	const intent = bashIntentText(theme, options.leadingIntent);
	const head = intent ? `${toolLabel(theme, "Bash")} ${theme.fg("dim", "— ")}${intent}` : toolLabel(theme, "Bash");
	const [first = "", ...rest] = splitTerminalLines(bashCommandSource(args, cwd, options.full === true));
	const lines = [`  ${theme.fg("dim", "$ ")}${theme.fg("toolOutput", first)}`, ...rest.map((line) => `    ${theme.fg("toolOutput", line)}`)];
	return { head, command: lines.join("\n") };
}

export function isGitDiffCommand(command: unknown): boolean {
	if (typeof command !== "string" || !command.trim()) return false;
	const normalized = command.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
	// Match common shell forms such as `git diff`, `git --no-pager diff`,
	// `git -C repo diff`, `env GIT_PAGER=cat git diff`, and chained commands.
	return /(?:^|[;&|()]\s*)(?:(?:env\s+(?:-\S+\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)|(?:command\s+))*git(?:\s+(?!--?diff\b)(?:-[A-Za-z]\S*|--\S+)(?:\s+(?!diff(?:\s|$))\S+)*)*\s+diff(?:\s|$)/.test(normalized);
}

/**
 * Jujutsu commands that print a unified diff by default. `jj diff` and
 * `jj show` always do; `jj log` only with `-p`/`--patch`. jj emits Git-format
 * diffs unless `ui.diff.format` is reconfigured, so the same parser applies.
 */
// Module-level patterns: the matcher runs on every bash result render.
const JJ_PREFIX = "(?:^|[;&|()]\\s*)(?:(?:env\\s+(?:-\\S+\\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*)|(?:command\\s+))*jj\\b";
const JJ_LIST_ONLY = /--(?:stat|name-only|summary|types)\b/;
const JJ_PATCH_COMMAND = new RegExp(`${JJ_PREFIX}(?:\\s+-\\S+|\\s+--\\S+)*\\s+(?:diff|show)(?:\\s|$)`);
const JJ_LOG_COMMAND = new RegExp(`${JJ_PREFIX}(?:\\s+-\\S+|\\s+--\\S+)*\\s+log(?:\\s|$)`);
const PATCH_FLAG = /(?:^|\s)(?:-p|--patch)(?:\s|$)/;

export function isJjDiffCommand(command: unknown): boolean {
	if (typeof command !== "string" || !command.trim()) return false;
	const normalized = command.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
	// `--stat`/`--name-only`/`--summary` print a list, not a patch.
	if (JJ_LIST_ONLY.test(normalized)) return false;
	if (JJ_PATCH_COMMAND.test(normalized)) return true;
	return JJ_LOG_COMMAND.test(normalized) && PATCH_FLAG.test(normalized);
}

/** A command that prints a unified diff for an explicit VCS invocation. */
export function isVcsDiffCommand(command: unknown): boolean {
	return isGitDiffCommand(command) || isJjDiffCommand(command);
}

export function readOnlyCallText(toolName: string, args: any, theme: any, cwd?: string, hyperlinks?: boolean): string {
	const intentLead = typeof args?.intent === "string" && args.intent.trim()
		? `${theme.fg("dim", "— ")}${theme.fg("accent", args.intent.trim())}${theme.fg("dim", " · ")}`
		: "";
	if (toolName === "ls") return `${toolLabel(theme, `${toolName} `)}${intentLead}${renderToolPathText(args?.path ?? ".", theme, cwd, undefined, hyperlinks)}`;
	const query = args?.pattern ?? args?.glob ?? args?.path ?? args?.query ?? "";
	const rendered = args?.pattern === undefined && args?.glob === undefined && typeof args?.path === "string"
		? renderToolPathText(args.path, theme, cwd, undefined, hyperlinks)
		: theme.fg("accent", clipLine(String(query), cwd));
	return `${toolLabel(theme, `${toolName} `)}${intentLead}${rendered}`;
}

export function plural(count: number, singular: string, pluralText = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralText}`;
}

export function joinPhrases(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
	return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

// stackPrefix re-exported here so callers can keep a single import surface.
export { stackPrefix };
