import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assistantSources } from "./source.js";
import { CopyModeView, type CopyResult } from "./view.js";

export const COPY_MODE_SHORTCUT = "ctrl+shift+y";

/**
 * Copy mode: pick an assistant message and copy raw markdown source lines from an
 * overlay. Copies carry no gutter, borders, tints or wrap breaks, unlike terminal
 * selection.
 */
export interface CopyModeDeps {
	/** Clipboard writer; defaults to Pi's clipboard. Injected by tests. */
	readonly copy?: (text: string) => Promise<void>;
}

export default function copyMode(pi: ExtensionAPI, deps: CopyModeDeps = {}): void {
	const copy = deps.copy ?? ((text: string) => copyToClipboard(text));
	const open = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		const sources = assistantSources(ctx.sessionManager.getBranch());
		if (sources.length === 0) {
			ctx.ui.notify("No assistant text to copy in this session branch.", "info");
			return;
		}

		let chosen = sources[0]!;
		if (sources.length > 1) {
			const labels = sources.map((source) => source.label);
			const picked = await ctx.ui.select("Copy from which assistant message?", labels);
			if (picked === undefined) return;
			chosen = sources[labels.indexOf(picked)] ?? chosen;
		}

		const result = await ctx.ui.custom<CopyResult | undefined>(
			(tui, theme, _keybindings, done) =>
				new CopyModeView({
					title: `Copy mode · ${chosen.label}`,
					lines: chosen.lines,
					copy,
					done,
					requestRender: () => tui.requestRender(),
					style: {
						cursor: (text) => theme.bg("selectedBg", text),
						marked: (text) => theme.fg("accent", text),
						muted: (text) => theme.fg("muted", text),
					},
				}),
			{
				overlay: true,
				overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
			},
		);
		if (result) ctx.ui.notify(`Copied ${result.copied} source line${result.copied === 1 ? "" : "s"}.`, "info");
	};

	pi.registerCommand("copy-mode", {
		description: "Copy raw markdown source lines from an assistant message",
		handler: async (_args, ctx) => {
			await open(ctx);
		},
	});

	pi.registerShortcut(COPY_MODE_SHORTCUT, {
		description: "Copy mode: raw markdown source from an assistant message",
		handler: async (ctx) => {
			await open(ctx);
		},
	});
}
