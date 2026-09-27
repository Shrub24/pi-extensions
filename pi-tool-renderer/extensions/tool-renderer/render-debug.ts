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
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
		description: "Show live TUI render diagnostics (frames, redraws, cache hit rates)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const sub = args.trim().toLowerCase();
			if (sub === "reset") {
				state.frames.length = 0;
				state.gutter = { hits: 0, misses: 0 };
				state.chrome = { hits: 0, misses: 0 };
				ctx.ui.notify("Render diagnostics reset", "info");
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
