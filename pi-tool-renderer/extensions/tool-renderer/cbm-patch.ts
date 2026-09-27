/**
 * Adopt the official cbmem adapter's tools into this extension's row style.
 * cbmem.ts registers its 17 tools without renderers during its own load, so a
 * registerTool intercept (same mechanism as fff-patch.ts) catches them
 * regardless of load order and swaps in real rows. Nothing inside the
 * generated adapter file is touched; regeneration is safe. No-op when the
 * adapter is absent. Gated by `cbmRenderers` (default on).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CBM_TOOL_NAMES, renderCbmCall, renderCbmResult } from "./cbm.js";
import { settingBoolean } from "./settings.js";

const CBM_PATCH_SYMBOL = Symbol.for("kendex.pi-tool-renderer.cbm-renderer-patch");

export function installCbmRenderers(pi: ExtensionAPI): void {
	const original = (pi as unknown as Record<PropertyKey, unknown>).registerTool as ((tool: any) => unknown) | undefined;
	if (typeof original !== "function") return;
	const host = pi as unknown as Record<PropertyKey, unknown>;
	if (host[CBM_PATCH_SYMBOL]) return;
	host[CBM_PATCH_SYMBOL] = true;
	host.registerTool = function cbmAwareRegisterTool(this: unknown, tool: any): unknown {
		try {
			const cwd = process.cwd();
			if (
				tool && typeof tool.name === "string" && CBM_TOOL_NAMES.has(tool.name)
				&& typeof tool.execute === "function"
				&& settingBoolean("cbmRenderers", true, cwd)
				&& !tool.rrenderKendexOwned
			) {
				tool.renderCall = (args: any, theme: any) => renderCbmCall(tool.name, args ?? {}, theme);
				tool.renderResult = (result: any, options: any, theme: any) => renderCbmResult(tool.name, result, options ?? {}, theme);
			}
		} catch {
			// Presentation adoption is best-effort; the adapter keeps its own (absent) renderers.
		}
		return original.call(this, tool);
	};
}
