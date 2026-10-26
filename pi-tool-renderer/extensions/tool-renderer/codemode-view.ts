import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CODEMODE_DISPLAY_KEY, CodemodeCapture, codemodeDisplayText, codemodeTarget, installCodemodeCapture, type CodemodeCall, type CodemodeDisplay } from "./codemode-capture.js";
import { memoizeByOwner, renderStructuredDiff, structuredDiffFromPatch, type StructuredDiff } from "./diff.js";
import { codemodePurpose } from "./intent.js";

function actualDiff(call: CodemodeCall): StructuredDiff | undefined {
	return call.patch ? memoizeByOwner(call, () => structuredDiffFromPatch(call.patch!, call.lineCount)) : undefined;
}
function title(args: any, theme: any): string {
	const purpose = codemodePurpose(args);
	return theme.fg("toolTitle", theme.bold("codemode")) + (purpose ? theme.fg("accent", ` — ${codemodeDisplayText(purpose)}`) : "");
}
function fallbackCalls(result: any): CodemodeCall[] {
	return (result.details?.calls ?? []).map((call: any) => {
		let target = "";
		try { target = codemodeTarget(JSON.parse(call.args)); } catch { /* Pi's argument preview may be truncated JSON. */ }
		return { id: call.id, name: call.name, target, status: call.status, durationMs: call.durationMs, output: call.error };
	});
}
function savedDisplay(result: any): CodemodeDisplay | undefined {
	const display = result.details?.[CODEMODE_DISPLAY_KEY];
	return display?.version === 1 && Array.isArray(display.calls) ? display : undefined;
}

function callRows(call: CodemodeCall, expanded: boolean, width: number, theme: any, cwd: string): string[] {
	const diff = actualDiff(call);
	const error = call.status === "error";
	const [icon, color] = call.status === "running" ? ["…", "warning"] : error ? ["✗", "error"] : call.status === "cancelled" ? ["⊘", "muted"] : ["✓", "success"];
	let head = `  ${theme.fg(color, icon)} ${theme.fg("toolTitle", codemodeDisplayText(call.name))}`;
	if (call.target && call.name !== "bash") head += ` ${theme.fg("muted", codemodeDisplayText(call.target))}`;
	const additions = diff && !diff.skipped ? diff.additions : call.additions;
	const removals = diff && !diff.skipped ? diff.removals : call.removals;
	if (!error && (additions !== undefined || removals !== undefined)) head += ` ${theme.fg("success", `+${additions ?? 0}`)} ${theme.fg("error", `−${removals ?? 0}`)}`;
	if (call.durationMs !== undefined) head += theme.fg("dim", ` · ${call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}`);
	const out = wrapTextWithAnsi(head, Math.max(1, width));
	if (call.name === "bash" && call.target) {
		out.push(...wrapTextWithAnsi(codemodeDisplayText(call.target), Math.max(1, width - 4))
			.map((line) => truncateToWidth(`    ${theme.fg("toolOutput", line)}`, width)));
	}
	if (expanded && diff && !error) {
		out.push(...renderStructuredDiff(diff, theme, true, cwd, undefined, call.target, 0, width).split("\n"));
	} else if (call.output && (error || call.name !== "edit")) {
		const body = wrapTextWithAnsi(codemodeDisplayText(call.output), Math.max(1, width - 4));
		const limit = expanded ? body.length : 3;
		out.push(...body.slice(0, limit).map((line) => truncateToWidth(`    ${theme.fg(error ? "error" : "toolOutput", line)}`, width)));
		if (body.length > limit) out.push(truncateToWidth(theme.fg("dim", `    … ${body.length - limit} more output lines · expand for preview`), width));
	}
	if (call.notice) out.push(truncateToWidth(theme.fg("muted", `    ${call.notice}`), width));
	if (expanded && call.name === "edit" && !error && !diff && !call.notice) out.push(truncateToWidth(theme.fg("muted", "    diff unavailable · no retained patch"), width));
	return out;
}

/** One renderer resolver; execution and native source/script output remain Pi's. */
export function installCodemodeRendering(pi: ExtensionAPI): void {
	if (typeof pi.registerToolRenderer !== "function") return;
	const capture = new CodemodeCapture();
	installCodemodeCapture(pi, capture);
	pi.registerToolRenderer((name, next) => {
		const base = next();
		if (name !== "codemode" || !base?.renderCall || !base?.renderResult) return base;
		return {
			...base,
			renderShell: "self",
			renderCall(args: any, theme: any, context: any) {
				if (context.expanded) return base.renderCall!(args, theme, { ...context, lastComponent: undefined });
				// Give Pi its call lifecycle (including timing), without asking it to
				// highlight a source preview that the compact view will never show.
				const compact = base.renderCall!({ ...args, code: "" }, theme, { ...context, lastComponent: undefined });
				const render = compact.render.bind(compact);
				compact.render = (width: number) => context.state.kendexCodemodeResult || context.isPartial === false ? [] : render(width);
				return compact;
			},
			renderResult(result: any, options: any, theme: any, context: any) {
				context.state.kendexCodemodeResult = true;
				const component = new Container();
				// Keep native script output, diagnostics, image handling and timing.
				// Remove only the native per-call JSON list we replace below.
				const native = base.renderResult!({ ...result, details: { ...result.details, calls: [] } }, options, theme, { ...context, lastComponent: undefined });
				let cached: { width: number; display: CodemodeDisplay | undefined; rows: string[] } | undefined;
				component.addChild({
					render(width: number) {
						const display = capture.get(context.toolCallId, context.invalidate) ?? savedDisplay(result);
						if (cached?.width === width && cached.display === display) return cached.rows;
						const calls = display?.calls ?? fallbackCalls(result);
						// Model calls are recorded by codemode, not nested-tool events.
						const models = display ? fallbackCalls(result).filter((call) => call.name.startsWith("models.")) : [];
						const all = [...calls, ...models];
						const shown = options.expanded ? all : all.filter((call, index) => index < 8 || call.status === "error");
						const rows = options.expanded ? [] : wrapTextWithAnsi(title(context.args, theme), Math.max(1, width));
						for (const call of shown) rows.push(...callRows(call, options.expanded, width, theme, context.cwd));
						if (!all.length && options.isPartial) rows.push(theme.fg("muted", "  Running script…"));
						if (all.length > shown.length) rows.push(truncateToWidth(theme.fg("dim", `  … ${all.length - shown.length} more calls · expand to view`), width));
						if (display?.omitted) rows.push(truncateToWidth(theme.fg("muted", `  ${display.omitted} calls omitted · display budget exceeded`), width));
						const cost = (result.details?.calls ?? []).reduce((sum: number, call: any) => sum + (call.cost ?? 0), 0);
						if (cost) rows.push(truncateToWidth(theme.fg("dim", `  Model calls: $${cost.toFixed(4)}`), width));
						const output = native.render(width);
						const hasOutput = !options.isPartial && result.content.some((block: any, index: number) =>
							block.type === "text" && block.text.trim() && !(index === 0 && /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/.test(block.text)));
						if (hasOutput) rows.push(truncateToWidth(theme.fg("muted", "Output"), width));
						rows.push(...output);
						cached = { width, display, rows };
						return rows;
					},
					invalidate() { cached = undefined; native.invalidate(); },
				});
				return component;
			},
		};
	});
}
