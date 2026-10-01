/**
 * /renderdebug — live TUI draw diagnostics.
 *
 * Wraps the active TUI's render pipeline once (on first invocation) and counts,
 * per rolling window:
 * - frames drawn (doRender calls) and wall time spent rendering
 * - full redraws vs partial line-diff updates (pi-tui already tracks full redraws)
 * - lines repainted per frame (the cost driver during streaming)
 * - our own hot component renders: assistant message patches (cached vs re-wrapped),
 *   tool chrome cache hits/misses, gutter cache state
 *
 * Numbers print via ctx.ui.notify; counters keep accumulating until /renderdebug reset.
 *
 * `/renderdebug memory` prints the memory section instead of the CPU one:
 * `process.memoryUsage()` plus the live sizes of this package's strong stores.
 * `memory gc` first runs a forced collection, when the runtime exposes one.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { codeHighlightCacheStats } from "./messages.js";
import { stackStoreStats } from "./stack.js";
import { blinkStoreStats } from "./text.js";
import { builtInToolCacheStats } from "./tools.js";

interface FrameSample {
	at: number;
	durationMs: number;
	linesPainted: number;
	fullRedraw: boolean;
}

interface RenderDebugState {
	frames: FrameSample[];
	gutter: { hits: number; misses: number };
	chrome: { hits: number; misses: number };
	installed: boolean;
}

const state: RenderDebugState = {
	frames: [],
	gutter: { hits: 0, misses: 0 },
	chrome: { hits: 0, misses: 0 },
	installed: false,
};

export const RENDER_DEBUG_STATE = state;

const WINDOW_MS = 10_000;

function pruneFrames(now: number): void {
	const cutoff = now - WINDOW_MS;
	while (state.frames.length > 0 && state.frames[0]!.at < cutoff) state.frames.shift();
}

function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
	return sorted[index]!;
}

export function installRenderDebug(tui: any): void {
	if (state.installed || !tui) return;
	const mainScreen = tui.mainScreen ?? tui;
	const original = mainScreen.doRender;
	if (typeof original !== "function") return;
	state.installed = true;
	mainScreen.doRender = function patchedDoRender(this: any, ...args: unknown[]) {
		const started = performance.now();
		try {
			return original.apply(this, args);
		} finally {
			const durationMs = performance.now() - started;
			const fullRedraw = typeof this.fullRedrawCount === "number"
				? this.fullRedrawCount > (patchedDoRender as any)._lastFullRedraws
				: false;
			if (typeof this.fullRedrawCount === "number") {
				(patchedDoRender as any)._lastFullRedraws = this.fullRedrawCount;
			}
			const linesPainted = typeof this.previousLines === "object" && this.previousLines
				? (this.previousLines.length as number)
				: 0;
			state.frames.push({ at: Date.now(), durationMs, linesPainted, fullRedraw });
			if (state.frames.length > 600) state.frames.splice(0, state.frames.length - 600);
		}
	};
}

export function formatRenderDebugReport(cwd?: string): string[] {
	const now = Date.now();
	pruneFrames(now);
	const durations = state.frames.map((frame) => frame.durationMs).sort((a, b) => a - b);
	const fullRedraws = state.frames.filter((frame) => frame.fullRedraw).length;
	const lines = [
		`frames (10s): ${state.frames.length} · full redraws: ${fullRedraws} · partial: ${state.frames.length - fullRedraws}`,
		`render ms — p50: ${percentile(durations, 0.5).toFixed(1)} · p95: ${percentile(durations, 0.95).toFixed(1)} · max: ${(durations.at(-1) ?? 0).toFixed(1)}`,
		`assistant gutter — cached: ${state.gutter.hits} · re-wrapped: ${state.gutter.misses}`,
		`tool chrome — hits: ${state.chrome.hits} · misses: ${state.chrome.misses}`,
	];
	return lines;
}

/**
 * pi exposes no direct TUI handle, but widget factories receive `(tui, theme)`.
 * Borrow one render through a throwaway widget key to capture the live instance,
 * then clear it. Costs one empty frame at session start.
 */
export function installRenderDebugOnSessionStart(pi: ExtensionAPI): void {
	pi.on("session_start", (_event: any, ctx: any) => {
		if (!ctx?.hasUI) return;
		const key = "kendex-render-debug-handle";
		try {
			let cleared = false;
			ctx.ui.setWidget(key, (tui: any) => {
				installRenderDebug(tui);
				if (!cleared) {
					cleared = true;
					setTimeout(() => {
						try {
							ctx.ui.setWidget(key, undefined);
						} catch {
							// Widget cleanup is best-effort.
						}
					}, 0);
				}
				return { render: () => [], invalidate: () => {} };
			});
		} catch {
			// Diagnostics are optional.
		}
	});
}

export function registerRenderDebugCommand(pi: ExtensionAPI): void {
	pi.registerCommand("renderdebug", {
		description: "Show live TUI render diagnostics (frames, redraws, cache hit rates; memory with 'memory')",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const sub = parts[0];
			if (sub === "reset") {
				state.frames.length = 0;
				state.gutter = { hits: 0, misses: 0 };
				state.chrome = { hits: 0, misses: 0 };
				ctx.ui.notify("Render diagnostics reset", "info");
				return;
			}
			if (sub === "memory") {
				for (const line of memoryDebugReportLines(parts.includes("gc"))) ctx.ui.notify(line, "info");
				return;
			}
			for (const line of formatRenderDebugReport(ctx.cwd)) ctx.ui.notify(line, "info");
		},
	});
}

export function recordGutterHit(): void {
	state.gutter.hits += 1;
}

export function recordGutterMiss(): void {
	state.gutter.misses += 1;
}

export function recordChromeHit(): void {
	state.chrome.hits += 1;
}

export function recordChromeMiss(): void {
	state.chrome.misses += 1;
}

/**
 * The memory half of `/renderdebug`: `process.memoryUsage()` plus the live sizes
 * of this package's strong stores, and an explicit, user-requested GC.
 *
 * Labels are deliberately narrow. `rss` is the whole process, including Bun's
 * native allocations, V8/Bun heap pages and the loaded extensions; `heapUsed` is
 * the JavaScript heap alone, so it is always smaller and never the whole story.
 * A drop in `heapUsed` across `gc()` is *reclaimed* heap, not the live set: it
 * says how much garbage was reachable-then-dropped, not how much this extension
 * retains. Nothing here is a leak measurement; a leak is a store that keeps
 * growing across a session, which only repeated readings can show.
 */

/** One MB value with one decimal, so repeated reports are comparable by eye. */
export function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let gcWarned = false;

/**
 * The runtime's forced collector, feature-detected: Bun exposes `Bun.gc(force)`, a
 * Node host exposes `global.gc` only when started with `--expose-gc`. Returning
 * `undefined` is the honest answer when neither exists, and the report says so
 * rather than showing a zero-byte "reclaimed" number that never happened.
 */
export function resolveForcedGc(): ((force?: boolean) => void) | undefined {
	const bunGc = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun?.gc;
	if (typeof bunGc === "function") return (force = true) => bunGc(force);
	const nodeGc = (globalThis as { gc?: (force?: boolean) => void }).gc;
	if (typeof nodeGc === "function") return (force = true) => nodeGc(force);
	return undefined;
}

export interface MemoryUsageLine {
	rss: number;
	heapUsed: number;
	heapTotal: number;
	external: number;
	arrayBuffers: number;
}

/** The five `process.memoryUsage()` fields the report shows, in report order. */
export function readMemoryUsage(): MemoryUsageLine {
	const usage = process.memoryUsage();
	return {
		rss: usage.rss,
		heapUsed: usage.heapUsed,
		heapTotal: usage.heapTotal,
		external: usage.external,
		arrayBuffers: usage.arrayBuffers,
	};
}

/**
 * The memory report. `after` is present only when the caller ran a forced GC, and
 * `heapBefore` is the reading taken immediately before it.
 */
export function formatMemoryDebugReport(gcRan: boolean, heapBefore?: number): string[] {
	const now = readMemoryUsage();
	const blink = blinkStoreStats();
	const highlights = codeHighlightCacheStats();
	const stack = stackStoreStats();
	const tools = builtInToolCacheStats();

	const lines = [
		`memory — rss: ${megabytes(now.rss)} (whole process) · heapUsed: ${megabytes(now.heapUsed)} (JS heap only)`,
		`memory — heapTotal: ${megabytes(now.heapTotal)} · external: ${megabytes(now.external)} · arrayBuffers: ${megabytes(now.arrayBuffers)}`,
		`strong stores — blink entries: ${blink.entries} (timer ${blink.timerRunning ? "running" : "stopped"}) · only while pendingStatusAnimation is on`,
		`strong stores — code highlight cache: ${highlights.entries} entries · ${highlights.keyChars} source chars + ${highlights.valueChars} rendered chars (entry-capped at 120)`,
		`strong stores — stack items: ${stack.items} · batches: ${stack.batches} · ${stack.resultChars} result chars (only while stackToolCalls is on)`,
		`strong stores — built-in tool sets: ${tools.cwds} (one per distinct cwd, 7 host tool objects each)`,
	];

	lines.push("not measured — per-row render caches are WeakMaps keyed by Pi's components and have no live size; they die with the row");

	if (gcRan && heapBefore !== undefined) {
		const reclaimed = heapBefore - now.heapUsed;
		lines.push(`gc — explicit gc() ran: heapUsed ${megabytes(heapBefore)} → ${megabytes(now.heapUsed)} (delta ${megabytes(reclaimed)} = reclaimed heap, not this extension's retained set)`);
	}

	return lines;
}

/**
 * The `memory` subcommand: report, or run a forced GC first when the user asked
 * for it. GC is opt-in because it costs a full collection and changes timing.
 */
export function memoryDebugReportLines(runGc: boolean): string[] {
	const gc = runGc ? resolveForcedGc() : undefined;
	if (!runGc) return formatMemoryDebugReport(false);
	if (!gc) {
		if (!gcWarned) {
			gcWarned = true;
			return [...formatMemoryDebugReport(false), "gc — unavailable: no Bun.gc and no global.gc (a Node host needs --expose-gc); no collection was forced"];
		}
		return [...formatMemoryDebugReport(false), "gc — unavailable in this runtime; no collection was forced"];
	}
	const before = readMemoryUsage();
	gc(true);
	return formatMemoryDebugReport(true, before.heapUsed);
}
