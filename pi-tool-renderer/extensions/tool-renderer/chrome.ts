import { ToolExecutionComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordChromeHit, recordChromeMiss } from "./render-debug.js";
import { renderSettingsRevision } from "./settings-revision.js";
import { Box, Container, Loader, Text } from "@earendil-works/pi-tui";

import {
	padVisible,
	stableRenderWidth,
	truncateAnsi,
	stripAnsi,
	stripLeadingBackgroundLayer,
	trimOuterBlankLines,
	trimTrailingWhitespaceBeforeAnsi,
	wrapTextWithAnsi,
} from "./ansi.js";
import { captureDiffBackgroundTheme } from "./diff.js";
import {
	renderApplyPatchCall,
	renderApplyPatchResult,
	renderGenericToolCall,
	renderGenericToolResult,
	renderUnknownToolCall,
	renderUnknownToolResult,
	shouldUseGenericRenderer,
	shouldUseUnknownToolRenderer,
	componentDefinesRenderer,
} from "./generic.js";
import { settingBoolean, settingEnum, toolChromeMode, type ToolChromeMode } from "./settings.js";
import { withCodemodePurpose } from "./codemode.js";
import { CODEMODE_TOOL_NAME } from "./intent.js";
import { RESERVED_IMAGE_ROW_MARKER, TOOL_RENDER_OVERLAY_CHECK_SYMBOL } from "./overlay.js";
import { trackToolExecutionComponent } from "./live-settings.js";
import { glyphs } from "./glyphs.js";
import { subtleRule } from "./theme.js";

const TOOL_EXECUTION_RENDERER_PATCH_SYMBOL = Symbol.for("kendex.pi-tool-renderer.tool-execution-renderer-patch.v2");
const TOOL_CHROME_PATCH_SYMBOL = Symbol.for("kendex.pi-tool-renderer.tool-chrome-patch");
const TOOL_CHROME_THEME_SYMBOL = Symbol.for("kendex.pi-tool-renderer.tool-chrome-theme");
const TOOL_CHROME_GROUP_SYMBOL = Symbol.for("kendex.pi-tool-renderer.tool-chrome-group");
const WORKING_LOADER_ALIGNMENT_PATCH_SYMBOL = Symbol.for("kendex.pi-tool-renderer.working-loader-alignment-patch");

interface ToolChromeRenderCacheEntry {
	cwd: string;
	lines: string[];
	mode: ToolChromeMode;
	revision: number;
	sourceLines: string[];
	theme: any;
	width: number;
	groupStart: boolean;
	groupEnd: boolean;
}

const toolChromeRenderCache = new WeakMap<object, ToolChromeRenderCacheEntry>();

function sameLines(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

export function rememberToolChromeTheme(component: any, theme: any): void {
	if (theme?.fg) component[TOOL_CHROME_THEME_SYMBOL] = theme;
}

export function withCallTheme(component: any, renderer: (args: any, theme: any, context: any) => any): (args: any, theme: any, context: any) => any {
	return function renderCallWithRememberedTheme(this: any, args: any, theme: any, context: any) {
		rememberToolChromeTheme(component, theme);
		return renderer.call(this, args, theme, context);
	};
}

export function withResultTheme(component: any, renderer: (result: any, options: any, theme: any, context: any) => any): (result: any, options: any, theme: any, context: any) => any {
	return function renderResultWithRememberedTheme(this: any, result: any, options: any, theme: any, context: any) {
		rememberToolChromeTheme(component, theme);
		trackToolExecutionComponent(component);
		if (context && typeof context === "object" && typeof component?.ui?.hasOverlay === "function") {
			context[TOOL_RENDER_OVERLAY_CHECK_SYMBOL] = () => component.ui.hasOverlay();
		}
		return renderer.call(this, result, options, theme, context);
	};
}

export function installToolExecutionRendererPatch(pi: ExtensionAPI): void {
	const proto = ToolExecutionComponent?.prototype as any;
	if (!proto) return;
	const existing = proto[TOOL_EXECUTION_RENDERER_PATCH_SYMBOL] as { originalGetCallRenderer?: unknown; originalGetRenderShell?: unknown; originalGetResultRenderer?: unknown; originalHasRendererDefinition?: unknown; originalRender?: unknown } | undefined;
	const originalGetCallRenderer = existing?.originalGetCallRenderer ?? proto.getCallRenderer;
	const originalGetResultRenderer = existing?.originalGetResultRenderer ?? proto.getResultRenderer;
	const originalHasRendererDefinition = existing?.originalHasRendererDefinition ?? proto.hasRendererDefinition;
	const originalGetRenderShell = existing?.originalGetRenderShell ?? proto.getRenderShell;
	const originalRender = existing?.originalRender ?? proto.render;
	if (typeof originalGetCallRenderer !== "function" || typeof originalGetResultRenderer !== "function" || typeof originalHasRendererDefinition !== "function" || typeof originalGetRenderShell !== "function" || typeof originalRender !== "function") return;
	const state = { originalGetCallRenderer, originalGetRenderShell, originalGetResultRenderer, originalHasRendererDefinition, originalRender };
	proto.render = function patchedToolExecutionRender(this: any, width: number): string[] {
		const rendered = originalRender.call(this, width);
		if (!Array.isArray(rendered) || typeof this?.toolName !== "string" || typeof this?.toolCallId !== "string") return rendered;
		if (isSelfRenderedTool(this)) return renderToolChromeLines(this, rendered, width);
		return trimOuterBlankLines(rendered);
	};
	proto.hasRendererDefinition = function patchedHasRendererDefinition(this: any) {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		if (shouldUseUnknownToolRenderer(this, toolName)) return true;
		return originalHasRendererDefinition.call(this);
	};
	proto.getRenderShell = function patchedGetRenderShell(this: any) {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		if (shouldUseUnknownToolRenderer(this, toolName)) return "self";
		return originalGetRenderShell.call(this);
	};
	proto.getCallRenderer = function patchedGetCallRenderer(this: any) {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		if (shouldUseUnknownToolRenderer(this, toolName)) {
			return withCallTheme(this, (args: any, theme: any, context: any) => renderUnknownToolCall(toolName, args, theme, context));
		}
		if (toolName === "apply_patch" && settingBoolean("applyPatchRenderer", true) && !componentDefinesRenderer(this, "renderCall")) {
			return withCallTheme(this, (args: any, theme: any, context: any) => renderApplyPatchCall(args, theme, context));
		}
		if (settingBoolean("genericToolRenderers", true) && shouldUseGenericRenderer(toolName) && !componentDefinesRenderer(this, "renderCall")) {
			return withCallTheme(this, (args: any, theme: any, context: any) => renderGenericToolCall(toolName, args, theme, context));
		}
		if (toolName === CODEMODE_TOOL_NAME) {
			// Pi's own codemode renderer keeps the row; the wrapper only adds the
			// script's leading purpose to the title it already draws.
			const renderer = originalGetCallRenderer.call(this);
			return typeof renderer === "function" ? withCallTheme(this, withCodemodePurpose(renderer)) : renderer;
		}
		const renderer = originalGetCallRenderer.call(this);
		return typeof renderer === "function" ? withCallTheme(this, renderer) : renderer;
	};
	proto.getResultRenderer = function patchedGetResultRenderer(this: any) {
		const toolName = typeof this?.toolName === "string" ? this.toolName : "";
		if (shouldUseUnknownToolRenderer(this, toolName)) {
			return withResultTheme(this, (result: any, options: any, theme: any, context: any) => renderUnknownToolResult(toolName, result, options, theme, context));
		}
		if (toolName === "apply_patch" && settingBoolean("applyPatchRenderer", true) && !componentDefinesRenderer(this, "renderResult")) {
			return withResultTheme(this, (result: any, options: any, theme: any, context: any) => renderApplyPatchResult(result, options, theme, context));
		}
		if (settingBoolean("genericToolRenderers", true) && shouldUseGenericRenderer(toolName) && !componentDefinesRenderer(this, "renderResult")) {
			return withResultTheme(this, (result: any, options: any, theme: any, context: any) => renderGenericToolResult(toolName, result, options, theme, context));
		}
		const renderer = originalGetResultRenderer.call(this);
		return typeof renderer === "function" ? withResultTheme(this, renderer) : renderer;
	};
	proto[TOOL_EXECUTION_RENDERER_PATCH_SYMBOL] = state;
	pi.on("session_shutdown", () => {
		if (proto[TOOL_EXECUTION_RENDERER_PATCH_SYMBOL] !== state) return;
		proto.render = originalRender;
		proto.hasRendererDefinition = originalHasRendererDefinition;
		proto.getRenderShell = originalGetRenderShell;
		proto.getCallRenderer = originalGetCallRenderer;
		proto.getResultRenderer = originalGetResultRenderer;
		delete proto[TOOL_EXECUTION_RENDERER_PATCH_SYMBOL];
	});
}

function prepareToolChromeTheme(theme: any, cwd?: string): void {
	if (toolChromeMode(cwd) === "off") return;
	captureDiffBackgroundTheme(theme);
}

let activeToolChromeCtx: ExtensionContext | undefined;

export function mutedHorizontalRule(theme: any, width: number, cwd?: string): string {
	return subtleRule(theme, glyphs(cwd).line.repeat(stableRenderWidth(width, cwd)));
}

function shouldOmitBottomToolChromeRule(core: string[]): boolean {
	return core.some((line) => /(?:└─+(?:┴─+)?┘|\+-+(?:\+-+)?\+)/.test(stripAnsi(line ?? "")));
}

function isTerminalImageLine(line: string): boolean {
	return line.includes("\x1b_G") || line.includes("\x1b]1337;File=") || line.includes(RESERVED_IMAGE_ROW_MARKER);
}

function renderedToolCore(rendered: string[], width: number, cwd?: string): string[] | undefined {
	let start = 0;
	while (start < rendered.length && stripAnsi(rendered[start] ?? "").trim().length === 0) start++;
	let end = rendered.length - 1;
	if (!rendered.some(isTerminalImageLine)) {
		while (end >= start && stripAnsi(rendered[end] ?? "").trim().length === 0) end--;
	}
	if (start > end) return undefined;
	const renderWidth = stableRenderWidth(width, cwd);
	return rendered.slice(start, end + 1).flatMap((line) => {
		// Pi's Text/Box components pad rows before trailing SGR reset codes.
		// Plain trimEnd() cannot see those spaces when ANSI comes after them;
		// if they survive, the right-margin guard wraps each padded row into a
		// blank continuation line. Trim visually trailing spaces before wrapping.
		const wrapped = wrapTextWithAnsi(trimTrailingWhitespaceBeforeAnsi(stripLeadingBackgroundLayer(line)), renderWidth);
		return wrapped.length > 0 ? wrapped : [""];
	});
}

function toolChromeThemeFor(component: any): any {
	return component?.[TOOL_CHROME_THEME_SYMBOL] ?? component?.ui?.theme ?? (activeToolChromeCtx?.hasUI ? activeToolChromeCtx.ui.theme : undefined);
}

/** Last chrome output per component. Pi re-renders the whole tree on every
 * frame, and re-wrapping every tool block each time made long sessions spin.
 * The hit check compares line by line, never a joined copy: joining would
 * scan and retain every block's full text on every frame. */
type ToolChromeCacheEntry = { width: number; mode: ToolChromeMode; rule: string; rendered: string[]; lines: string[] };
const toolChromeCache = new WeakMap<object, ToolChromeCacheEntry>();

function toolChromeCacheHit(entry: ToolChromeCacheEntry | undefined, width: number, mode: ToolChromeMode, rule: string, rendered: string[]): entry is ToolChromeCacheEntry {
	return entry !== undefined
		&& entry.width === width
		&& entry.mode === mode
		&& entry.rule === rule
		&& entry.rendered.length === rendered.length
		&& rendered.every((line, i) => line === entry.rendered[i]);
}

function renderToolChromeLines(component: any, rendered: string[], width: number): string[] {
	const effectiveCwd = component?.cwd ?? process.cwd();
	const mode = toolChromeMode(effectiveCwd);
	if (mode === "off") return rendered;

	const revision = renderSettingsRevision();
	const cacheKey = component && typeof component === "object" ? component as object : undefined;
	const chromeTheme = mode === "outlines" || mode === "panel" ? toolChromeThemeFor(component) : undefined;
	const boundaries = mode === "outlines" ? component?.[TOOL_CHROME_GROUP_SYMBOL] ?? { start: true, end: true } : { start: true, end: true };
	const cached = cacheKey ? toolChromeRenderCache.get(cacheKey) : undefined;
	if (cached) recordChromeHit();
	else recordChromeMiss();
	if (cached
		&& cached.cwd === effectiveCwd
		&& cached.mode === mode
		&& cached.revision === revision
		&& cached.theme === chromeTheme
		&& cached.width === width
		&& cached.groupStart === boundaries.start
		&& cached.groupEnd === boundaries.end
		&& sameLines(cached.sourceLines, rendered)) return cached.lines;

	const core = renderedToolCore(rendered, width, effectiveCwd);
	let lines = rendered;
	if (core) {
		if (mode === "transparent") lines = core;
		else if (mode === "panel") lines = renderPanelChrome(component, core, chromeTheme, width);
		else {
			const rule = mutedHorizontalRule(chromeTheme, width, effectiveCwd);
			lines = [
				...(boundaries.start ? [rule] : []),
				...core,
				...(boundaries.end && !shouldOmitBottomToolChromeRule(core) ? [rule] : []),
			];
		}
	}
	if (cacheKey) toolChromeRenderCache.set(cacheKey, {
		cwd: effectiveCwd,
		lines,
		mode,
		revision,
		sourceLines: [...rendered],
		theme: chromeTheme,
		width,
		groupStart: boundaries.start,
		groupEnd: boundaries.end,
	});
	return lines;
}

/**
 * Backgrounded section: the tool's content is re-wrapped in a pi-tui Box so the
 * state background fills edge to edge at every render width (Box pads each line
 * to full width itself). No rules — that is what outlines mode is for.
 */
function renderPanelChrome(component: any, core: string[], theme: any, width: number): string[] {
	if (!theme || typeof theme.bg !== "function") return core;
	const stateBg = component?.isPartial
		? "toolPendingBg"
		: component?.result?.isError
			? "toolErrorBg"
			: "toolSuccessBg";
	const inner = Math.max(1, stableRenderWidth(width, component?.cwd) - 2);
	const box = new Box(1, 0, (text: string) => theme.bg(stateBg, text));
	for (const line of core) {
		if (line.length === 0) {
			// Text renders empty/whitespace-only strings as zero rows, which
			// would silently drop blank lines (and their background band).
			// Render a full-width filler row instead so the panel stays continuous.
			const filler: any = { render: (w: number) => [theme.bg(stateBg, " ".repeat(Math.max(1, w)))] };
			box.addChild(filler);
		} else {
			box.addChild(new Text(line, 0, 0));
		}
	}
	return box.render(width).map((line) => truncateAnsi(line, stableRenderWidth(width, component?.cwd)));
}

function isSelfRenderedTool(component: any): boolean {	try {
		return typeof component?.toolName === "string"
			&& typeof component?.toolCallId === "string"
			&& typeof component?.hasRendererDefinition === "function"
			&& typeof component?.getRenderShell === "function"
			&& component.hasRendererDefinition()
			&& component.getRenderShell() === "self";
	} catch {
		return false;
	}
}

export const __test = { renderPanelChrome, renderToolChromeLines, renderedToolCore, renderWidthFor: stableRenderWidth, shouldOmitBottomToolChromeRule };

function isVisibleToolComponent(component: any): boolean {
	return typeof component?.toolName === "string"
		&& typeof component?.toolCallId === "string"
		&& !component.hideComponent;
}

/**
 * A tool-call-only assistant message renders no lines, yet Pi gives each model
 * turn its own message component. Such a message must not split a run of tool
 * rows that the model issued across turns.
 */
function isSilentToolTurn(component: any): boolean {
	if (isVisibleToolComponent(component) || component?.hasToolCalls !== true) return false;
	const content = component?.lastMessage?.content;
	if (!Array.isArray(content)) return false;
	return !content.some((block: any) => (block?.type === "text" && String(block.text ?? "").trim().length > 0)
		|| (block?.type === "thinking" && String(block.thinking ?? "").trim().length > 0));
}

function isTransparentToolRunChild(component: any): boolean {
	return (typeof component?.toolCallId === "string" && component?.hideComponent === true) || isSilentToolTurn(component);
}

function markToolChromeGroupBoundaries(children: any[]): void {
	for (let index = 0; index < children.length; index++) {
		const component = children[index];
		if (!isVisibleToolComponent(component)) continue;
		let previous = index - 1;
		while (previous >= 0 && isTransparentToolRunChild(children[previous])) previous--;
		let next = index + 1;
		while (next < children.length && isTransparentToolRunChild(children[next])) next++;
		component[TOOL_CHROME_GROUP_SYMBOL] = {
			start: previous < 0 || !isVisibleToolComponent(children[previous]),
			end: next >= children.length || !isVisibleToolComponent(children[next]),
		};
	}
}

export function installToolChromePatch(): void {
	// Pi's transcript container is a `Container` from Pi's own resolution of
	// pi-tui, which need not be the copy this extension imports. The base class of
	// ToolExecutionComponent is the one Pi definitely uses, so it is patched first;
	// a second copy is patched too so a single runtime never mixes behaviours.
	const prototypes = new Set<any>();
	const fromToolExecution = Object.getPrototypeOf(ToolExecutionComponent?.prototype ?? {});
	if (fromToolExecution && fromToolExecution !== Object.prototype) prototypes.add(fromToolExecution);
	if (Container?.prototype) prototypes.add(Container.prototype);
	for (const proto of prototypes) {
		if (proto[TOOL_CHROME_PATCH_SYMBOL]) continue;
		const originalRender = proto.render;
		if (typeof originalRender !== "function") continue;
		proto.render = function patchedToolChromeRender(this: any, width: number): string[] {
			if (Array.isArray(this?.children)) markToolChromeGroupBoundaries(this.children);
			const rendered = originalRender.call(this, width);
			if (!Array.isArray(rendered) || rendered.length === 0) return rendered;
			if (typeof this?.toolName !== "string" || typeof this?.toolCallId !== "string") return rendered;
			return renderToolChromeLines(this, rendered, width);
		};
		proto[TOOL_CHROME_PATCH_SYMBOL] = true;
		// Marking on insertion as well as on render: Pi does not have to route the
		// transcript through the patched `render` for a run to collapse.
		const originalAddChild = proto.addChild;
		if (typeof originalAddChild === "function") {
			proto.addChild = function patchedAddChild(this: any, component: any): void {
				const result = originalAddChild.call(this, component);
				if (Array.isArray(this?.children) && typeof component?.toolCallId === "string") {
					markToolChromeGroupBoundaries(this.children);
				}
				return result;
			};
		}
	}
}

export function registerToolChromeEvents(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		activeToolChromeCtx = ctx;
		if (ctx.hasUI) prepareToolChromeTheme(ctx.ui.theme, ctx.cwd);
	});
	pi.on("turn_start", (_event, ctx) => {
		activeToolChromeCtx = ctx;
		if (ctx.hasUI) prepareToolChromeTheme(ctx.ui.theme, ctx.cwd);
	});
	pi.on("session_shutdown", () => {
		activeToolChromeCtx = undefined;
	});
}

export function installWorkingIndicator(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const mode = settingEnum("workingIndicator", ["default", "pulse", "hidden"] as const, "default", ctx.cwd);
		if (mode === "default") return;
		if (mode === "hidden") {
			ctx.ui.setWorkingIndicator({ frames: [] });
			return;
		}
		const g = glyphs(ctx.cwd);
		ctx.ui.setWorkingIndicator({
			frames: [ctx.ui.theme.fg("dim", g.dot.trim()), ctx.ui.theme.fg("muted", g.emptyBullet.trim()), ctx.ui.theme.fg("accent", g.bullet.trim()), ctx.ui.theme.fg("muted", g.emptyBullet.trim())],
			intervalMs: 120,
		});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWorkingIndicator();
	});
}

export function installWorkingLoaderAlignmentPatch(): void {
	const proto = Loader.prototype as unknown as Record<PropertyKey, any>;
	if (proto[WORKING_LOADER_ALIGNMENT_PATCH_SYMBOL]) return;
	const originalRender = proto.render;
	if (typeof originalRender !== "function") return;
	proto[WORKING_LOADER_ALIGNMENT_PATCH_SYMBOL] = true;
	proto.render = function patchedWorkingLoaderRender(this: any, width: number): string[] {
		const message = typeof this?.message === "string" ? this.message : "";
		if (!message.startsWith("Working...")) return originalRender.call(this, width);
		const originalPaddingX = this.paddingX;
		try {
			this.paddingX = 0;
			this.invalidate?.();
			return originalRender.call(this, width);
		} finally {
			this.paddingX = originalPaddingX;
			this.invalidate?.();
		}
	};
}
