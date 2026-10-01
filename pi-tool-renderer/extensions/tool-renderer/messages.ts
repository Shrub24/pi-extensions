import { getMarkdownTheme, keyText, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, MouseRegion, Text } from "@earendil-works/pi-tui";

import {
	ANSI_FG_RESET,
	ansiGreen,
	ansiPartsFromStyled,
	ansiRed,
	applyBaseTextFg,
	isThinkingOnlyAssistantMessage,
	stableRenderWidth,
	stripAnsi,
	trimOuterBlankLinesAroundRules,
	trimThinkingOnlyAssistantLines,
	trimTrailingBlankLines,
	truncateAnsi,
	visibleWidth,
	wrapTextWithAnsi,
} from "./ansi.js";
import { renderSettingsRevision } from "./settings-revision.js";
import { readkendexConfig, settingBoolean, settingEnum, settingNumber, settingString } from "./settings.js";
import { frameGlyphs, glyphs } from "./glyphs.js";
import { mutedHorizontalRule } from "./chrome.js";
import { recordGutterHit, recordGutterMiss } from "./render-debug.js";
import { formatClock, messageStampMode, stampLabel, withInlineStamp, withTrailingGap } from "./stamps.js";
import { FALLBACK_THEME, stackPrefix, toolLabel, treeConnector } from "./theme.js";
import { makeTruncatedLines } from "./text.js";

const USER_MESSAGE_PATCH_SYMBOL = Symbol.for("kendex.pi-tool-renderer.user-message-patch");
const USER_MESSAGE_BOX_STATE_SYMBOL = Symbol.for("kendex.pi-tool-renderer.user-message-box-state");
const ASSISTANT_MESSAGE_PATCH_SYMBOL = Symbol.for("kendex.pi-tool-renderer.assistant-message-patch");
const CUSTOM_MESSAGE_SPACING_PATCH_SYMBOL = Symbol.for("kendex.pi-tool-renderer.custom-message-spacing-patch");
const COMPACTION_SUMMARY_RENDERER_PATCH_SYMBOL = Symbol.for("kendex.pi-tool-renderer.compaction-summary-renderer-patch");
const SKILL_INVOCATION_RENDERER_PATCH_SYMBOL = Symbol.for("kendex.pi-tool-renderer.skill-invocation-renderer-patch");
const MARKDOWN_CODE_BLOCK_PATCH_SYMBOL = Symbol.for("kendex.pi-tool-renderer.markdown-code-block-patch");

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

interface PromptZoneMarkers {
	end: boolean;
	final: boolean;
	start: boolean;
}

function stripPromptZoneMarkers(lines: string[]): { lines: string[]; markers: PromptZoneMarkers } {
	const markers: PromptZoneMarkers = { end: false, final: false, start: false };
	const stripped = lines.map((line) => {
		let next = line;
		if (next.includes(OSC133_ZONE_START)) {
			markers.start = true;
			next = next.split(OSC133_ZONE_START).join("");
		}
		if (next.includes(OSC133_ZONE_END)) {
			markers.end = true;
			next = next.split(OSC133_ZONE_END).join("");
		}
		if (next.includes(OSC133_ZONE_FINAL)) {
			markers.final = true;
			next = next.split(OSC133_ZONE_FINAL).join("");
		}
		return next;
	});
	return { lines: stripped, markers };
}

function applyPromptZoneMarkers(lines: string[], markers: PromptZoneMarkers): string[] {
	if (lines.length === 0) return lines;
	const marked = [...lines];
	if (markers.start) marked[0] = `${OSC133_ZONE_START}${marked[0] ?? ""}`;
	const endPrefix = `${markers.end ? OSC133_ZONE_END : ""}${markers.final ? OSC133_ZONE_FINAL : ""}`;
	if (endPrefix) {
		const last = marked.length - 1;
		marked[last] = `${endPrefix}${marked[last] ?? ""}`;
	}
	return marked;
}

function renderUserMessageBorder(lines: string[], width: number, theme: any, cwd?: string, forcePromptZone = false): string[] {
	if (lines.length === 0 || width < 4) return lines;
	// Pi wraps user messages with OSC 133 prompt-zone markers. With compact
	// padding, a single-line message can carry start/end/final markers on the
	// content row; terminals that honor OSC 133 then treat the middle of the box
	// as prompt chrome. Strip those markers from the body and rewrap the whole
	// framed card so the terminal sees one stable prompt zone.
	const unwrapped = stripPromptZoneMarkers(lines);
	if (forcePromptZone) {
		unwrapped.markers.start = true;
		unwrapped.markers.end = true;
		unwrapped.markers.final = true;
	}
	const innerWidth = Math.max(1, width - 2);
	const frame = frameGlyphs(cwd);
	const prompt = glyphs(cwd).prompt;
	const border = (text: string) => {
		for (const token of ["userMessageText", "border", "accent"]) {
			try {
				const styled = theme?.fg?.(token, text);
				if (typeof styled === "string" && styled !== text) return styled;
			} catch {
				continue;
			}
		}
		return ansiGreen(text);
	};
	const marker = (text: string) => ansiRed(text);
	const topBorder = () => {
		if (innerWidth < 5) return border(frame.h.repeat(innerWidth));
		const left = `${frame.h} `;
		const right = ` ${frame.h.repeat(Math.max(0, innerWidth - visibleWidth(left) - visibleWidth(prompt) - 1))}`;
		return `${border(left)}${marker(prompt)}${border(right)}`;
	};
	const bodyLeftPadding = " ";
	const bodyContentWidth = Math.max(1, innerWidth - visibleWidth(bodyLeftPadding));
	const fitLine = (line: string) => {
		const clipped = truncateAnsi(line, bodyContentWidth);
		return applyBaseTextFg(clipped, theme) + " ".repeat(Math.max(0, bodyContentWidth - visibleWidth(clipped)));
	};

	return applyPromptZoneMarkers([
		`${border(frame.tl)}${topBorder()}${border(frame.tr)}`,
		...unwrapped.lines.map((line) => `${border(frame.v)}${bodyLeftPadding}${fitLine(line)}${border(frame.v)}`),
		`${border(frame.bl)}${border(frame.h.repeat(innerWidth))}${border(frame.br)}`,
	], unwrapped.markers);
}

function safeCtxCwd(ctx?: ExtensionContext): string {
	try {
		return ctx?.cwd ?? process.cwd();
	} catch {
		return process.cwd();
	}
}

function safeCtxHasUI(ctx?: ExtensionContext): boolean {
	try {
		return Boolean(ctx?.hasUI);
	} catch {
		return false;
	}
}

function safeCtxTheme(ctx?: ExtensionContext): any {
	try {
		if (!ctx?.hasUI) return FALLBACK_THEME;
		return ctx.ui?.theme ?? FALLBACK_THEME;
	} catch {
		return FALLBACK_THEME;
	}
}

export const __test = { applyPromptZoneMarkers, assistantTextGutterLines, renderCompactUserMessageLines, renderRawUserMessageLines, renderStyledCodeBlock, renderUserMessageBorder, safeCtxCwd, safeCtxHasUI, safeCtxTheme, stripPromptZoneMarkers };

function appendUserMessageBreak(lines: string[], width: number, cwd?: string): string[] {
	if (lines.length === 0 || !settingBoolean("userMessageTrailingBlankLine", true, cwd)) return lines;
	// A visual blank row does not need to fill the terminal width. Keeping it empty
	// avoids writing a printable character into the last column, which can trigger
	// auto-wrap/scroll flashes in tmux and some terminal emulators when streaming
	// output is already sitting on the bottom row.
	return [...lines, ""];
}

interface UserMessagePatchState {
	activeCtx?: ExtensionContext;
	hadOwnInvalidate?: boolean;
	invalidatePatched?: boolean;
	originalInvalidate?: () => void;
	originalRender: (width: number) => string[];
	originalInvalidate?: (this: object) => void;
}

/**
 * Timestamp per user message component. Live messages are queued on
 * message_start and claimed oldest-first by the renderer; replayed history has
 * no event, so those messages simply render unstamped.
 */
const userStampTimes = new WeakMap<object, number>();
const pendingUserStamps: number[] = [];
export const __stampTest = { userStampTimes, pendingUserStamps };

/** A message longer than this is never cached: the layout exists to keep a
 *  frame cheap, and a one-off 100 KB message would cost more held than redrawn. */
const USER_LAYOUT_MAX_CHARS = 40_000;

interface UserMessageLayout {
	text: string;
	theme: unknown;
	markdownTheme: unknown;
	settings: unknown;
	revision: number;
	markdown: Markdown;
	width?: number;
	lines?: string[];
}
let userMessageLayouts = new WeakMap<object, UserMessageLayout>();
let userMessageLayoutCount = 0;

function renderRawUserMessageLines(component: any, width: number, theme: any, cwd?: string): string[] | undefined {
	const text = typeof component?.text === "string" ? component.text : undefined;
	if (text === undefined) return undefined;
	const markdownTheme = component?.markdownTheme;
	const settings = readkendexConfig(cwd);
	// The revision is in the key alongside the parsed settings for the replayed
	// case: a record and its settings can both be referentially unchanged across
	// a settings edit, and the entry would otherwise serve stale lines.
	const revision = renderSettingsRevision();
	let layout = userMessageLayouts.get(component);
	if (!layout || layout.theme !== theme || layout.markdownTheme !== markdownTheme || layout.settings !== settings || layout.revision !== revision) {
		layout = {
			text, theme, markdownTheme, settings, revision,
			markdown: new Markdown(text, 0, 0, markdownTheme ?? getMarkdownTheme(),
				{ color: (content: string) => theme.fg("userMessageText", content) },
				{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true }),
		};
	} else if (layout.text !== text) {
		layout.markdown.setText(text);
		layout.text = text;
		layout.lines = undefined;
	}
	if (layout.lines && layout.width === width) return layout.lines;
	const lines = layout.markdown.render(width);
	if (text.length <= USER_LAYOUT_MAX_CHARS && lines.reduce((size, line) => size + line.length, 0) <= USER_LAYOUT_MAX_CHARS) {
		layout.width = width;
		layout.lines = lines;
		if (!userMessageLayouts.has(component)) {
			if (userMessageLayoutCount >= 256) {
				userMessageLayouts = new WeakMap();
				userMessageLayoutCount = 0;
			}
			userMessageLayoutCount++;
		}
		userMessageLayouts.set(component, layout);
	} else if (userMessageLayouts.delete(component)) {
		userMessageLayoutCount--;
	}
	return lines;
}

interface CompactUserMessageRenderCacheEntry {
	cwd: string;
	frameWidth: number;
	lines: string[];
	rawLines: string[];
	revision: number;
	theme: any;
	width: number;
}

const compactUserMessageRenderCache = new WeakMap<object, CompactUserMessageRenderCacheEntry>();

function claimUserStamp(component: any): void {
	if (userStampTimes.has(component) || pendingUserStamps.length === 0) return;
	userStampTimes.set(component, pendingUserStamps.shift()!);
}

function renderCompactUserMessageLines(component: any, width: number, frameWidth: number, theme: any, cwd: string): string[] | undefined {
	claimUserStamp(component);
	const rawLines = renderRawUserMessageLines(component, Math.max(1, frameWidth - 2), theme);
	if (!rawLines) return undefined;
	const revision = renderSettingsRevision();
	const cached = compactUserMessageRenderCache.get(component);
	if (cached
		&& cached.cwd === cwd
		&& cached.frameWidth === frameWidth
		&& cached.rawLines === rawLines
		&& cached.revision === revision
		&& cached.theme === theme
		&& cached.width === width) return cached.lines;

	let lines = appendUserMessageBreak(renderUserMessageBorder(rawLines, frameWidth, theme, cwd, true), width, cwd);
	const cwdForStamp = cwd;
	if (messageStampMode(cwdForStamp) === "inline") {
		const stampTs = userStampTimes.get(component);
		const label = stampLabel({ theme, timestamp: stampTs, cwd: cwdForStamp });
		lines = withInlineStamp(lines, theme, label, width);
	}
	compactUserMessageRenderCache.set(component, { cwd, frameWidth, lines, rawLines, revision, theme, width });
	return lines;
}

export function installUserMessageRenderer(pi: ExtensionAPI, UserMessageComponent: any): void {
	const prototype = UserMessageComponent?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.render !== "function") return;

	let state = prototype[USER_MESSAGE_PATCH_SYMBOL] as UserMessagePatchState | undefined;
	if (!state) {
		state = {
			originalRender: prototype.render as (width: number) => string[],
		};
		prototype[USER_MESSAGE_PATCH_SYMBOL] = state;
		// `invalidate` may already carry a wrapper from an earlier install in the
		// same process (a second Pi session in one runtime). Guard on the flag so
		// the chain stays one deep: without this, each install wraps the previous
		// wrapper and `state.originalInvalidate` ends up pointing at the wrapper.
		if (!state.invalidatePatched) {
			state.invalidatePatched = true;
			state.originalInvalidate = prototype.invalidate as UserMessagePatchState["originalInvalidate"];
			prototype.invalidate = function invalidateUserMessageLayout(this: object): void {
				const layout = userMessageLayouts.get(this);
				if (layout) {
					layout.lines = undefined;
					layout.markdown.invalidate();
				}
				state!.originalInvalidate?.call(this);
			};
		}
		prototype.render = function compactUserMessageRender(this: any, width: number): string[] {
			const ctx = state?.activeCtx;
			const cwd = safeCtxCwd(ctx);
			const hasUI = safeCtxHasUI(ctx);
			const compact = hasUI && settingBoolean("compactUserMessages", true, cwd);

			if (compact && width >= 4) {
				const theme = safeCtxTheme(ctx);
				const frameWidth = stableRenderWidth(width, cwd);
				const lines = renderCompactUserMessageLines(this, width, frameWidth, theme, cwd);
				if (lines) return lines;
			}

			const box = this?.contentBox;
			if (box && hasUI) {
				const paddingY = compact ? 0 : 1;
				const boxState = compact ? `${paddingY}:border:theme:text:pi-red:left` : `${paddingY}:background:userMessageBg`;

				if (box[USER_MESSAGE_BOX_STATE_SYMBOL] !== boxState) {
					box.paddingY = paddingY;
					if (compact) {
						box.setBgFn?.(undefined);
					} else {
						box.setBgFn?.((content: string) => {
							const theme = safeCtxTheme(state?.activeCtx);
							if (!theme?.bg) return content;
							try {
								return theme.bg("userMessageBg", content);
							} catch {
								return content;
							}
						});
					}
					box.invalidateCache?.();
					box[USER_MESSAGE_BOX_STATE_SYMBOL] = boxState;
				}

				if (compact && width >= 4) {
					const theme = safeCtxTheme(ctx);
					const frameWidth = stableRenderWidth(width, cwd);
					const lines = state!.originalRender.call(this, Math.max(1, frameWidth - 2));
					return appendUserMessageBreak(renderUserMessageBorder(lines, frameWidth, theme, cwd), width, cwd);
				}
			}

			return appendUserMessageBreak(state!.originalRender.call(this, width), width, cwd);
		};
	}

	if (!state.invalidatePatched) {
		state.hadOwnInvalidate = Object.prototype.hasOwnProperty.call(prototype, "invalidate");
		state.originalInvalidate = typeof prototype.invalidate === "function" ? prototype.invalidate as () => void : undefined;
		prototype.invalidate = function invalidateCompactUserMessage(this: any): void {
			userMessageLayouts.delete(this);
			compactUserMessageRenderCache.delete(this);
			state?.originalInvalidate?.call(this);
		};
		state.invalidatePatched = true;
	}

	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		state!.activeCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (prototype[USER_MESSAGE_PATCH_SYMBOL] === state) {
			prototype.render = state!.originalRender as unknown;
			if (state!.invalidatePatched) {
				if (state!.hadOwnInvalidate) prototype.invalidate = state!.originalInvalidate as unknown;
				else delete prototype.invalidate;
			}
			delete prototype[USER_MESSAGE_PATCH_SYMBOL];
		}
		userMessageLayouts = new WeakMap();
		userMessageLayoutCount = 0;
		state!.activeCtx = undefined;
	});
}

interface AssistantRenderCacheEntry {
	width: number;
	revision: number;
	fingerprint: number;
	lines: string[];
	quickKey: number;
}

/** Cheap change detector over the message content, settings and width. */
function assistantInputFingerprint(component: any, width: number, turnEnded: boolean): number {
	const message = component?.lastMessage;
	const content = Array.isArray(message?.content) ? message.content : [];
	let hash = width | 0;
	hash = (hash * 31 + content.length) | 0;
	for (const block of content) {
		const text = typeof block?.text === "string" ? block.text.length : (typeof block?.thinking === "string" ? block.thinking.length : 0);
		hash = (hash * 31 + text) | 0;
		hash = (hash * 31 + String(block?.type ?? "").length) | 0;
	}
	hash = (hash * 31 + (component?.hasToolCalls ? 7 : 3)) | 0;
	hash = (hash * 31 + (turnEnded ? 11 : 5)) | 0;
	hash = (hash * 31 + renderSettingsRevision()) | 0;
	hash = (hash * 31 + (startTimes.get(component) ?? 0) % 100000) | 0;
	hash = (hash * 31 + (endTimes.get(component) ?? 0) % 100000) | 0;
	return hash;
}

const assistantRenderCache = new WeakMap<object, AssistantRenderCacheEntry>();

/** Cheap content hash over the rendered lines and stamp inputs. */
function assistantFingerprint(lines: string[], stamp: string | undefined, style: string, paneled: boolean, turnRule: boolean): number {
	let hash = lines.length;
	for (const line of lines) hash = (hash * 31 + line.length) | 0;
	if (lines.length > 0) hash = (hash * 131 + lines[lines.length - 1]!.length) | 0;
	hash = (hash * 31 + (stamp ? stamp.length + stamp.charCodeAt(0) : 0)) | 0;
	hash = (hash * 31 + style.length) | 0;
	hash = (hash * 31 + (paneled ? 1 : 0) + (turnRule ? 2 : 0)) | 0;
	return hash;
}

/** First-content and completion times per assistant component, for response-time stamps. */
const startTimes = new WeakMap<object, number>();
const endTimes = new WeakMap<object, number>();

interface AssistantMessagePatchState {
	activeCtx?: ExtensionContext;
	originalRender: (width: number) => string[];
	originalUpdateContent: (message: any) => void;
	/** Most recently updated assistant component, used to place the turn rule. */
	lastAssistant?: any;
	/** Component whose turn already ended; cleared when it streams again. */
	turnEnded?: any;
}

/**
 * Assistant text gutter. `bar` repeats a thin accent bar on every line, the way
 * quoted blocks are marked; `agent` labels the first line with the configured
 * marker (a robot glyph by default) and hangs the rest of the block on a
 * matching indent. Both re-wrap to the gutter width so lines cannot overflow.
 */
function assistantTextStyle(cwd?: string): "plain" | "bar" | "agent" {
	return settingEnum("assistantMessageStyle", ["plain", "bar", "agent"] as const, "plain", cwd);
}

interface GutterCacheEntry {
	lines: string[];
	style: "bar" | "agent";
	width: number;
	revision: number;
	message: unknown;
	fingerprint: number;
	skipPrefix?: string;
}

let gutterCache = new WeakMap<object, GutterCacheEntry>();

/**
 * The gutter rewrites every line of every assistant message on every TUI frame.
 * During streaming that runs per token burst; re-wrapping is the single most
 * expensive thing this patch does, so results are memoized per component until
 * the message content or render width changes.
 */
function assistantTextGutterLinesCached(component: any, lines: string[], width: number, theme: any, cwd: string | undefined, style: "bar" | "agent", skipPrefix?: string): string[] {
	let fingerprint = lines.length;
	for (const line of lines) fingerprint = (fingerprint * 31 + line.length) | 0;
	if (lines.length > 0) fingerprint = (fingerprint * 31 + lines[lines.length - 1]!.length) | 0;
	const revision = renderSettingsRevision();
	const cached = gutterCache.get(component);
	if (cached && cached.style === style && cached.width === width && cached.revision === revision
		&& cached.skipPrefix === skipPrefix
		&& cached.message === component?.lastMessage && cached.fingerprint === fingerprint) {
		recordGutterHit();
		return cached.lines;
	}
	recordGutterMiss();
	const result = assistantTextGutterLines(lines, width, theme, cwd, style, skipPrefix);
	gutterCache.set(component, { lines: result, style, width, revision, message: component?.lastMessage, fingerprint, skipPrefix });
	return result;
}

function assistantTextGutterLines(lines: string[], width: number, theme: any, cwd: string | undefined, style: "bar" | "agent", skipPrefix?: string): string[] {
	const gutterWidth = style === "agent" ? 3 : 2;
	const inner = Math.max(1, stableRenderWidth(width, cwd) - gutterWidth);
	const marker = style === "agent"
		? settingString("assistantMessageMarker", "\u{f06a9}", cwd) || glyphs(cwd).agent
		: glyphs(cwd).accentBar;
	const colors = style === "agent" ? ["accent", "muted"] : ["borderMuted", "borderMuted"];
	const gutter = (text: string, first: boolean) => theme.fg(first ? colors[0]! : colors[1]!, text);
	const out: string[] = [];
	let first = true;
	for (const line of lines) {
		// Thinking panels are Box-painted rows: a gutter lead would shift their
		// background and break the fill, and the marker belongs on the message
		// itself rather than above it.
		if (line.startsWith(THINKING_ROW_SENTINEL)) {
			out.push(line.slice(THINKING_ROW_SENTINEL.length));
			continue;
		}
		if (skipPrefix && line.startsWith(skipPrefix)) {
			out.push(line);
			continue;
		}
		if (stripAnsi(line).trim().length === 0) {
			out.push(line);
			continue;
		}
		const wrapped = wrapTextWithAnsi(line, inner);
		for (const piece of (wrapped.length > 0 ? wrapped : [""])) {
			// `agent` labels the block once and hangs the rest on the gutter
			// indent; `bar` repeats its mark on every line.
			const lead = style === "agent"
				? (first ? `${gutter(marker, true)}  ` : "   ")
				: `${gutter(marker, false)} `;
			out.push(`${lead}${piece}`);
			first = false;
		}
	}
	return out;
}

/**
 * End-of-turn boundary for the last assistant message of a turn. The rule is
 * appended only after the turn ends and disappears again if that message
 * streams more content.
 */
function appendTurnRule(lines: string[], width: number, theme: any, cwd?: string): string[] {
	if (lines.length === 0) return lines;
	return [...lines, mutedHorizontalRule(theme, width, cwd)];
}

function alignAssistantContent(component: any): void {
	const children = component?.contentContainer?.children;
	if (!Array.isArray(children)) return;
	for (const child of children) {
		if (child instanceof Markdown || child instanceof Text) {
			child.paddingX = 0;
			child.invalidate?.();
		}
	}
}

/**
 * Wrap each thinking block in a backgrounded section with a heading, the way
 * entry renderers do it. pi builds thinking blocks as MouseRegion-wrapped
 * Text/Markdown, so the click-to-toggle handler survives the rewrap; assistant
 * text blocks are bare Markdown and are left alone.
 */
const thinkingPanelCache = new WeakMap<object, { count: number }>();

/**
 * Zero-width marker prepended to every thinking-panel row so the assistant
 * gutter can recognise panel rows without guessing at theme escape codes. OSC
 * with a private code: terminals ignore what they do not know, and stripAnsi
 * removes it for width maths.
 */
export const THINKING_ROW_SENTINEL = "\u001b]1337;kx-thinking\u0007";

function panelizeThinkingBlocks(component: any, theme: any): void {
	const children = component?.contentContainer?.children;
	if (!Array.isArray(children) || typeof theme?.bg !== "function") return;
	// updateContent fires on every streaming frame. Rewrapping untouched blocks
	// each frame allocates Boxes for nothing and churns the container; only
	// convert children that are still unconverted, and only rescan when the
	// child count changed.
	const cached = thinkingPanelCache.get(component);
	if (cached && cached.count === children.length) return;
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
		if (!(child instanceof MouseRegion)) continue;
		const box = new Box(1, 0, (text: string) => `${THINKING_ROW_SENTINEL}${theme.bg("customMessageBg", text)}`);
		box.addChild(new Text(theme.bold(theme.fg("muted", "thinking"))));
		box.addChild(child);
		children[index] = box;
	}
	thinkingPanelCache.set(component, { count: children.length });
}

export function installAssistantMessageRenderer(pi: ExtensionAPI, AssistantMessageComponent: any): void {
	const prototype = AssistantMessageComponent?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.render !== "function" || typeof prototype.updateContent !== "function") return;

	let state = prototype[ASSISTANT_MESSAGE_PATCH_SYMBOL] as AssistantMessagePatchState | undefined;
	if (!state) {
		state = {
			originalRender: prototype.render as (width: number) => string[],
			originalUpdateContent: prototype.updateContent as (message: any) => void,
		};
		prototype[ASSISTANT_MESSAGE_PATCH_SYMBOL] = state;
		prototype.render = function spacedAssistantRender(this: any, width: number): string[] {
			// Hot path while the user types or reads: the transcript re-renders every
			// frame, and re-running the message pipeline for an unchanged message is
			// pure waste. Message content is fingerprinted cheaply (block count and
			// text lengths) before touching pi's renderer.
			const quickKey = assistantInputFingerprint(this, width, state!.turnEnded === this);
			const quickCached = assistantRenderCache.get(this);
			if (quickCached && quickCached.quickKey === quickKey) return quickCached.lines;
			const rendered = state!.originalRender.call(this, width);
			if (!Array.isArray(rendered) || rendered.length === 0) return rendered;
			if (isThinkingOnlyAssistantMessage(this?.lastMessage)) return trimThinkingOnlyAssistantLines(rendered);
			const cwd = safeCtxCwd(state?.activeCtx);
			const theme = safeCtxTheme(state?.activeCtx);
			const style = assistantTextStyle(cwd);
			const stampAlong = messageStampMode(cwd) === "inline";
			const turnRule = Boolean(theme && state!.turnEnded === this && settingBoolean("assistantTurnRule", false, cwd));
			const paneled = Boolean(theme && settingBoolean("thinkingPanel", false, cwd));
			// pi re-renders the whole message component on every streaming frame.
			// The gutter, marker stripping and stamping are pure functions of these
			// inputs, so the rendered block is memoized until one of them changes.
			const stamp = stampAlong
				? stampLabel({
						theme,
						timestamp: typeof this?.lastMessage?.timestamp === "number" ? this.lastMessage.timestamp : undefined,
						startedAt: startTimes.get(this),
						completedAt: endTimes.get(this),
						cwd,
						responseTime: true,
					})
				: undefined;
			const fingerprint = assistantFingerprint(rendered, stamp, style, paneled, turnRule);
			const revision = renderSettingsRevision();
			const cached = assistantRenderCache.get(this);
			if (cached && cached.width === width && cached.revision === revision && cached.fingerprint === fingerprint) {
				return cached.lines;
			}
			const stripped = stripPromptZoneMarkers(rendered);
			const thinkingPrefix = paneled && typeof theme?.bg === "function"
				? theme.bg("customMessageBg", "")
				: undefined;
			const styled = theme && style !== "plain"
				? applyPromptZoneMarkers(assistantTextGutterLinesCached(this, stripped.lines, width, theme, cwd, style, thinkingPrefix), stripped.markers)
				: rendered;
			const finish = (lines: string[]): string[] => {
				assistantRenderCache.set(this, { width, revision, fingerprint, lines, quickKey });
				return lines;
			};
			if (this?.hasToolCalls) return finish(styled);
			const end = trimTrailingBlankLines(styled);
			if (end.length === 0) return finish(styled);
			const stamped = stampAlong ? withInlineStamp(end, theme, stamp, width) : end;
			const withGap = withTrailingGap(stamped);
			if (turnRule) return finish(appendTurnRule(withGap, width, theme, cwd));
			return finish(withGap);
		};
		prototype.updateContent = function alignedAssistantUpdateContent(this: any, message: any): void {
			state!.lastAssistant = this;
			if (!startTimes.has(this) && typeof message?.timestamp === "number") startTimes.set(this, Date.now());
			if (state!.turnEnded === this) state!.turnEnded = undefined;
			state!.originalUpdateContent.call(this, message);
			const cwd = safeCtxCwd(state?.activeCtx);
			if (settingBoolean("alignAssistantMessages", true, cwd)) alignAssistantContent(this);
			const theme = safeCtxTheme(state?.activeCtx);
			if (theme && settingBoolean("thinkingPanel", false, cwd)) panelizeThinkingBlocks(this, theme);
		};
	}

	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		state!.activeCtx = ctx;
	});
	pi.on("message_start", (event: any) => {
		const message = event?.message;
		if (message?.role === "user" && typeof message.timestamp === "number") {
			pendingUserStamps.push(message.timestamp);
			if (pendingUserStamps.length > 200) pendingUserStamps.splice(0, pendingUserStamps.length - 200);
		}
	});
	pi.on("message_end", (event: any) => {
		const ended = state!.lastAssistant;
		if (!ended) return;
		endTimes.set(ended, Date.now());
	});
	pi.on("turn_end", () => {
		const ended = state!.lastAssistant;
		if (!ended) return;
		if (!endTimes.has(ended)) endTimes.set(ended, Date.now());
		state!.turnEnded = ended;
		ended?.invalidate?.();
	});
	pi.on("turn_start", () => {
		if (state!.turnEnded) {
			state!.turnEnded.invalidate?.();
			state!.turnEnded = undefined;
		}
	});
	pi.on("session_shutdown", () => {
		if (prototype[ASSISTANT_MESSAGE_PATCH_SYMBOL] === state) {
			prototype.render = state!.originalRender as unknown;
			prototype.updateContent = state!.originalUpdateContent as unknown;
			delete prototype[ASSISTANT_MESSAGE_PATCH_SYMBOL];
		}
		state!.activeCtx = undefined;
		state!.lastAssistant = undefined;
		state!.turnEnded = undefined;
	});
}

interface CompactionSummaryPatchState {
	activeCtx?: ExtensionContext;
	originalUpdateDisplay: () => void;
}

export function installCompactionSummaryRenderer(pi: ExtensionAPI, Component: any): void {
	const prototype = Component?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.updateDisplay !== "function") return;

	let state = prototype[COMPACTION_SUMMARY_RENDERER_PATCH_SYMBOL] as CompactionSummaryPatchState | undefined;
	if (!state) {
		state = {
			originalUpdateDisplay: prototype.updateDisplay as () => void,
		};
		prototype[COMPACTION_SUMMARY_RENDERER_PATCH_SYMBOL] = state;
		prototype.updateDisplay = function compactCompactionSummaryDisplay(this: any): void {
			const ctx = state?.activeCtx;
			const cwd = safeCtxCwd(ctx);
			if (!settingBoolean("compactCompactionMessages", true, cwd)) {
				state!.originalUpdateDisplay.call(this);
				return;
			}

			const theme = safeCtxTheme(ctx);
			const message = this?.message ?? {};
			const tokensBefore = Number.isFinite(Number(message.tokensBefore)) ? Number(message.tokensBefore) : 0;
			const tokenStr = tokensBefore.toLocaleString();
			const expanded = Boolean(this?.expanded);
			const summary = typeof message.summary === "string" && message.summary.trim() ? message.summary.trim() : "No summary was recorded.";

			this.paddingX = 0;
			this.paddingY = 0;
			this.setBgFn?.(undefined);
			this.clear?.();

			const hint = expanded ? "" : theme.fg("dim", " · ctrl+o to expand");
			this.addChild?.(makeTruncatedLines(`${stackPrefix(theme)}${toolLabel(theme, "Compacted ")}${theme.fg("success", `${tokenStr} tokens`)}${hint}`));

			if (expanded) {
				this.addChild?.(makeTruncatedLines(`${treeConnector(theme, "└", cwd)}${theme.fg("muted", "Summary")}`));
				this.addChild?.(new Markdown(summary, 0, 0, this?.markdownTheme ?? getMarkdownTheme(), {
					color: (text: string) => theme.fg("customMessageText", text),
				}));
			}
		};
	}

	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		state!.activeCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (prototype[COMPACTION_SUMMARY_RENDERER_PATCH_SYMBOL] === state) {
			prototype.updateDisplay = state!.originalUpdateDisplay as unknown;
			delete prototype[COMPACTION_SUMMARY_RENDERER_PATCH_SYMBOL];
		}
		state!.activeCtx = undefined;
	});
}

interface SkillInvocationPatchState {
	activeCtx?: ExtensionContext;
	originalUpdateDisplay: () => void;
}

interface CustomMessageSpacingPatchState {
	originalRender: (width: number) => string[];
}

export function installCustomMessageSpacingPatch(pi: ExtensionAPI, CustomMessageComponent: any): void {
	const prototype = CustomMessageComponent?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.render !== "function") return;

	let state = prototype[CUSTOM_MESSAGE_SPACING_PATCH_SYMBOL] as CustomMessageSpacingPatchState | undefined;
	if (!state) {
		state = { originalRender: prototype.render as (width: number) => string[] };
		prototype[CUSTOM_MESSAGE_SPACING_PATCH_SYMBOL] = state;
		prototype.render = function compactRuledCustomMessageRender(this: any, width: number): string[] {
			const rendered = state!.originalRender.call(this, width);
			if (!Array.isArray(rendered) || rendered.length === 0) return rendered;
			return trimOuterBlankLinesAroundRules(rendered);
		};
	}

	pi.on("session_shutdown", () => {
		if (prototype[CUSTOM_MESSAGE_SPACING_PATCH_SYMBOL] === state) {
			prototype.render = state!.originalRender as unknown;
			delete prototype[CUSTOM_MESSAGE_SPACING_PATCH_SYMBOL];
		}
	});
}

export function installSkillInvocationRenderer(pi: ExtensionAPI, Component: any): void {
	const prototype = Component?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.updateDisplay !== "function") return;

	let state = prototype[SKILL_INVOCATION_RENDERER_PATCH_SYMBOL] as SkillInvocationPatchState | undefined;
	if (!state) {
		state = {
			originalUpdateDisplay: prototype.updateDisplay as () => void,
		};
		prototype[SKILL_INVOCATION_RENDERER_PATCH_SYMBOL] = state;
		prototype.updateDisplay = function compactSkillInvocationDisplay(this: any): void {
			const ctx = state?.activeCtx;
			const cwd = safeCtxCwd(ctx);
			if (!settingBoolean("compactSkillMessages", true, cwd)) {
				state!.originalUpdateDisplay.call(this);
				return;
			}

			const th = safeCtxTheme(ctx);
			const skillBlock = this?.skillBlock ?? {};
			const name = typeof skillBlock.name === "string" && skillBlock.name.trim() ? skillBlock.name.trim() : "skill";
			const content = typeof skillBlock.content === "string" ? skillBlock.content : "";
			const expanded = Boolean(this?.expanded);

			this.paddingX = 0;
			this.paddingY = 0;
			this.setBgFn?.(undefined);
			this.clear?.();

			const hint = expanded ? "" : th.fg("dim", ` · ${keyText("app.tools.expand")} expand`);
			this.addChild?.(makeTruncatedLines(`${stackPrefix(th)}${toolLabel(th, "Skill ")}${th.fg("accent", name)}${hint}`));

			if (expanded) {
				this.addChild?.(makeTruncatedLines(`${treeConnector(th, "└", cwd)}${th.fg("muted", "Content")}`));
				this.addChild?.(new Markdown(`**${name}**\n\n${content}`, 0, 0, this?.markdownTheme ?? getMarkdownTheme(), {
					color: (text: string) => th.fg("customMessageText", text),
				}));
			}
		};
	}

	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		state!.activeCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (prototype[SKILL_INVOCATION_RENDERER_PATCH_SYMBOL] === state) {
			prototype.updateDisplay = state!.originalUpdateDisplay as unknown;
			delete prototype[SKILL_INVOCATION_RENDERER_PATCH_SYMBOL];
		}
		state!.activeCtx = undefined;
	});
}

interface MarkdownCodeBlockPatchState {
	activeCtx?: ExtensionContext;
	originalRenderToken: (token: any, width: number, nextTokenType?: string, styleContext?: unknown) => string[];
}

function codeBlockBgParts(ctx?: ExtensionContext): { open: string; close: string } {
	const marker = "\uE000";
	try {
		const theme = safeCtxHasUI(ctx) ? safeCtxTheme(ctx) : undefined;
		if (theme?.bg) return ansiPartsFromStyled(theme.bg("customMessageBg", marker));
	} catch {
		// Fall through to a neutral dark background.
	}
	return { open: "\x1b[48;5;236m", close: "\x1b[49m" };
}

function applyCodeBlockBg(line: string, ctx?: ExtensionContext): string {
	const { open, close } = codeBlockBgParts(ctx);
	if (!open) return line;
	const reapplied = line.replace(/\x1b\[(?:0|49)m/g, (reset) => `${reset}${open}`);
	return `${open}${reapplied}${close}`;
}

function padAnsiLine(line: string, width: number): string {
	return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

const codeHighlightCache = new Map<string, string[]>();
const CODE_HIGHLIGHT_CACHE_MAX = 120;

/**
 * Read-only size of the code-highlight cache, for `/renderdebug memory`. The key
 * is a copy of the block's code and the value its highlighted lines, so both
 * character totals are reported: they are what the cache holds now, capped by
 * entry count only. `String.length` is O(1), so this costs one pass over at most
 * `CODE_HIGHLIGHT_CACHE_MAX` entries and never runs on a render path.
 */
export function codeHighlightCacheStats(): { entries: number; keyChars: number; valueChars: number } {
	let keyChars = 0;
	let valueChars = 0;
	for (const [key, lines] of codeHighlightCache) {
		keyChars += key.length;
		for (const line of lines) valueChars += line.length;
	}
	return { entries: codeHighlightCache.size, keyChars, valueChars };
}

function highlightCodeCached(markdownTheme: any, code: string, lang: string | undefined): string[] {
	const key = `${lang ?? ""}\u0000${code}`;
	const cached = codeHighlightCache.get(key);
	if (cached) {
		// Refresh recency: Map preserves insertion order, so re-insert on hit.
		codeHighlightCache.delete(key);
		codeHighlightCache.set(key, cached);
		return cached;
	}
	const highlighted = markdownTheme?.highlightCode
		? markdownTheme.highlightCode(code, lang)
		: code.split("\n").map((line: string) => (markdownTheme?.codeBlock ? markdownTheme.codeBlock(line) : line));
	codeHighlightCache.set(key, highlighted);
	while (codeHighlightCache.size > CODE_HIGHLIGHT_CACHE_MAX) {
		const oldest = codeHighlightCache.keys().next().value;
		if (oldest === undefined) break;
		codeHighlightCache.delete(oldest);
	}
	return highlighted;
}

function renderStyledCodeBlock(token: any, width: number, markdownTheme: any, ctx?: ExtensionContext): string[] {
	const contentWidth = stableRenderWidth(width, safeCtxCwd(ctx));
	const rawLang = typeof token?.lang === "string" ? token.lang.trim() : "";
	const lang = rawLang.split(/\s+/)[0] || undefined;
	const code = typeof token?.text === "string" ? token.text : "";

	if (contentWidth < 8) {
		return code.split("\n").map((line) => (markdownTheme?.codeBlock ? markdownTheme.codeBlock(line) : line));
	}

	let highlightedLines: string[];
	try {
		highlightedLines = highlightCodeCached(markdownTheme, code, lang);
	} catch {
		highlightedLines = code.split("\n").map((line: string) => (markdownTheme?.codeBlock ? markdownTheme.codeBlock(line) : line));
	}

	const codeWidth = Math.max(1, contentWidth);
	const lines: string[] = [];
	for (const highlightedLine of highlightedLines) {
		const wrapped = wrapTextWithAnsi(highlightedLine, codeWidth);
		const segments = wrapped.length > 0 ? wrapped : [""];
		for (const segment of segments) {
			lines.push(applyCodeBlockBg(padAnsiLine(segment, codeWidth), ctx));
		}
	}
	return lines;
}

export function installMarkdownCodeBlockRenderer(pi: ExtensionAPI): void {
	const prototype = Markdown?.prototype as Record<PropertyKey, unknown> | undefined;
	if (!prototype || typeof prototype.renderToken !== "function") return;

	let state = prototype[MARKDOWN_CODE_BLOCK_PATCH_SYMBOL] as MarkdownCodeBlockPatchState | undefined;
	if (!state) {
		state = {
			originalRenderToken: prototype.renderToken as MarkdownCodeBlockPatchState["originalRenderToken"],
		};
		prototype[MARKDOWN_CODE_BLOCK_PATCH_SYMBOL] = state;
		prototype.renderToken = function styledCodeBlockRenderToken(this: any, token: any, width: number, nextTokenType?: string, styleContext?: unknown): string[] {
			const ctx = state?.activeCtx;
			const cwd = safeCtxCwd(ctx);
			if (token?.type === "code" && settingBoolean("styledCodeBlocks", true, cwd)) {
				const codeLines = renderStyledCodeBlock(token, width, this?.theme, ctx);
				if (nextTokenType && nextTokenType !== "space") return [...codeLines, ""];
				return codeLines;
			}
			return state!.originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		};
	}

	pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
		state!.activeCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (prototype[MARKDOWN_CODE_BLOCK_PATCH_SYMBOL] === state) {
			prototype.renderToken = state!.originalRenderToken as unknown;
			delete prototype[MARKDOWN_CODE_BLOCK_PATCH_SYMBOL];
		}
		state!.activeCtx = undefined;
	});
}
