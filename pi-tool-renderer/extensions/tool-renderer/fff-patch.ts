/**
 * Adopt fff's search tools into this extension's row style. fff registers its
 * tools during its own `session_start`, so a plain early wrap of
 * `pi.registerTool` catches them regardless of extension load order: whenever
 * a tool named `ffgrep`/`fffind`/`fff-multi-grep` (or fff's override names)
 * appears with its own renderers, the renderers are replaced with ours and
 * fff's execution is left untouched. Harmless no-op when fff is absent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { renderFffCall, renderFffResult } from "./fff.js";
import { settingBoolean } from "./settings.js";

const FFF_TOOL_NAMES = new Set(["ffgrep", "fffind", "fff-multi-grep", "grep", "find", "multi_grep"]);

const REGISTER_TOOL_PATCH_SYMBOL = Symbol.for("kendex.pi-tool-renderer.fff-renderer-patch");

export function installFffRenderers(pi: ExtensionAPI): void {
	const original = (pi as unknown as Record<PropertyKey, unknown>).registerTool as ((tool: any) => unknown) | undefined;
	if (typeof original !== "function") return;
	const host = pi as unknown as Record<PropertyKey, unknown>;
	if (host[REGISTER_TOOL_PATCH_SYMBOL]) return;
	host[REGISTER_TOOL_PATCH_SYMBOL] = true;
	host.registerTool = function fffAwareRegisterTool(this: unknown, tool: any): unknown {
		try {
			const cwd = process.cwd();
			if (
				tool && typeof tool.name === "string" && FFF_TOOL_NAMES.has(tool.name)
				&& typeof tool.execute === "function"
				&& settingBoolean("fffRenderers", true, cwd)
				&& !tool.rrenderKendexOwned
			) {
				tool.renderCall = (args: any, theme: any, context: any) => renderFffCall(tool.name, args, theme, context, cwd);
				tool.renderResult = (result: any, options: any, theme: any, context: any) => renderFffResult(tool.name, result, options ?? {}, theme, context, cwd);
			}
		} catch {
			// Presentation adoption is best-effort; fff keeps its own renderers.
		}
		return original.call(this, tool);
	};
}
