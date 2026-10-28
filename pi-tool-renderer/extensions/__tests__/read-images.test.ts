import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";

import { clearTrackedToolExecutionComponents,
	installLiveSettingsRefresh,
	trackToolExecutionComponent,
} from "../tool-renderer/live-settings.js";
import { RESERVED_IMAGE_ROW_MARKER, TOOL_RENDER_OVERLAY_CHECK_SYMBOL } from "../tool-renderer/overlay.js";
import { clearPackageConfigCache, recordProjectTrust } from "../tool-renderer/package-config.js";
import { registerRead } from "../tool-renderer/tools.js";

const createdDirs: string[] = [];
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type ReadImageSetting = "off" | "always" | "on" | boolean;

afterEach(() => { resetCapabilitiesCache();
	clearTrackedToolExecutionComponents();
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	clearPackageConfigCache();
});

function writeSettings(cwd: string, config: Record<string, unknown>): void { writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ "pi-tool-renderer": config , }),
	);
}

function tempCwd(showReadImages?: ReadImageSetting, overrides: Record<string, unknown> = {}): string { const cwd = mkdtempSync(join(tmpdir(), "pi-tool-renderer-read-images-"));
	createdDirs.push(cwd);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const config = { ...overrides };
	if (showReadImages !== undefined) config.showReadImages = showReadImages;
	writeSettings(cwd, config);
	recordProjectTrust({ cwd, isProjectTrusted: () => true });
	return cwd;
}

function writeImageMode(cwd: string, showReadImages: ReadImageSetting): void { writeSettings(cwd, { showReadImages });
}

function readRenderer(cwd: string): any { let definition: any;
	const pi = { registerTool(tool: any) { definition = tool; }, };
	const agent = { createReadTool: () => ({ description: "read",
			parameters: {},
			execute: async () => ({ content: [] }), }), };
	registerRead(pi as any, agent, cwd);
	return definition;
}

function renderImageResult(
	definition: any,
	cwd: string,
	expanded: boolean,
	showImages: boolean,
	state: Record<string, unknown> = {},
	overlayCheck?: () => boolean,
): string[] { const context: any = { args: { path: "image.png" },
		cwd,
		invalidate() {},
		showImages,
		state, };
	if (overlayCheck) context[TOOL_RENDER_OVERLAY_CHECK_SYMBOL] = overlayCheck;
	const component = definition.renderResult(
		{ content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: imageData, mimeType: "image/png" },
			], },
		{ expanded, isPartial: false },
		{ bold: (text: string) => text, fg: (_token: string, text: string) => text },
		context,
	);
	return component.render(40);
}

function hasTerminalImage(lines: string[]): boolean { return lines.some((line) => line.includes("\x1b_G"));
}

function renderImageComponent(
	definition: any,
	cwd: string,
	expanded: boolean,
	showImages: boolean,
	state: Record<string, unknown>,
): any {
	const context: any = { args: { path: "image.png" }, cwd, invalidate() {}, showImages, state };
	return definition.renderResult(
		{ content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: imageData, mimeType: "image/png" },
		] },
		{ expanded, isPartial: false },
		{ bold: (text: string) => text, fg: (_token: string, text: string) => text },
		context,
	);
}

/** The image wrappers a rendered read row holds, however deeply the row nests them. */
function imageComponents(component: any): any[] {
	const found: any[] = [];
	const walk = (node: any): void => {
		if (!node || typeof node !== "object") return;
		if (node.constructor?.name === "OverlayAwareImage") found.push(node);
		for (const child of Array.isArray(node.children) ? node.children : []) walk(child);
	};
	walk(component);
	return found;
}

describe("read image rendering", () => { test("a re-rendered read row mounts a fresh image, never the one it showed before", () => {
		// Pi-Bolt records each rendered child's owners and holds them strongly, so a
		// cached image re-mounted into a new container would keep every container it
		// had ever been shown in, and with them the row's content and rendered lines.
		const cwd = tempCwd("always");
		const definition = readRenderer(cwd);
		const state = {};
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		const first = imageComponents(renderImageComponent(definition, cwd, false, false, state));
		const second = imageComponents(renderImageComponent(definition, cwd, false, false, state));
		expect(first.length).toBe(1);
		expect(second.length).toBe(1);
		expect(second[0]).not.toBe(first[0]); });

	test("on follows expanded state across repeated toggles", () => { const cwd = tempCwd("on");
		const definition = readRenderer(cwd);
		const state = {};
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		expect(hasTerminalImage(renderImageResult(definition, cwd, false, false, state))).toBe(false);
		expect(hasTerminalImage(renderImageResult(definition, cwd, true, false, state))).toBe(true);
		expect(hasTerminalImage(renderImageResult(definition, cwd, false, false, state))).toBe(false);
		expect(hasTerminalImage(renderImageResult(definition, cwd, true, false, state))).toBe(true); });

	test("always shows images in collapsed and expanded output even when read text is hidden", () => { const cwd = tempCwd("always", { readOutputMode: "hidden" });
		const definition = readRenderer(cwd);
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		expect(hasTerminalImage(renderImageResult(definition, cwd, false, false))).toBe(true);
		expect(hasTerminalImage(renderImageResult(definition, cwd, true, false))).toBe(true); });

	test("a settings rewrite applies at the next session start", () => { const cwd = tempCwd("off");
		const lifecycleHandlers = new Map<string, Array<() => void>>();
		const pi = { on(event: string, handler: () => void) { const handlers = lifecycleHandlers.get(event) ?? [];
					handlers.push(handler);
					lifecycleHandlers.set(event, handlers); }, };
		installLiveSettingsRefresh(pi as any);
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		// Settings are file-managed: the file is the input, and a session start is
		// where the memo drops. A rewrite inside the window is not seen until then.
		expect(hasTerminalImage(renderImageResult(readRenderer(cwd), cwd, false, false, {}))).toBe(false);
		writeImageMode(cwd, "always");
		expect(hasTerminalImage(renderImageResult(readRenderer(cwd), cwd, false, false, {}))).toBe(false);
		for (const handler of lifecycleHandlers.get("session_start") ?? []) handler();
		expect(hasTerminalImage(renderImageResult(readRenderer(cwd), cwd, false, false, {}))).toBe(true);

		for (const handler of lifecycleHandlers.get("session_shutdown") ?? []) handler(); });

	test("floating overlays hide images without removing their reserved rows", () => { const cwd = tempCwd("always");
		const definition = readRenderer(cwd);
		const state = {};
		let overlayActive = false;
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		const visibleLines = renderImageResult(definition, cwd, false, false, state, () => overlayActive);
		overlayActive = true;
		const hiddenLines = renderImageResult(definition, cwd, false, false, state, () => overlayActive);
		overlayActive = false;
		const restoredLines = renderImageResult(definition, cwd, false, false, state, () => overlayActive);

		expect(hasTerminalImage(visibleLines)).toBe(true);
		expect(hasTerminalImage(hiddenLines)).toBe(false);
		expect(hiddenLines).toHaveLength(visibleLines.length);
		expect(hiddenLines.some((line) => line.includes(RESERVED_IMAGE_ROW_MARKER))).toBe(true);
		expect(hasTerminalImage(restoredLines)).toBe(true);
		expect(restoredLines).toHaveLength(visibleLines.length); });

	test("off and an unset setting keep custom images hidden", () => { setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		for (const setting of ["off", undefined] as const) { const cwd = tempCwd(setting);
			const definition = readRenderer(cwd);
			expect(hasTerminalImage(renderImageResult(definition, cwd, false, false))).toBe(false);
			expect(hasTerminalImage(renderImageResult(definition, cwd, true, false))).toBe(false); } });

	test("keeps boolean true compatible with expanded-only behavior", () => { const cwd = tempCwd(true);
		const definition = readRenderer(cwd);
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		expect(hasTerminalImage(renderImageResult(definition, cwd, false, false))).toBe(false);
		expect(hasTerminalImage(renderImageResult(definition, cwd, true, false))).toBe(true); });

	test("does not duplicate Pi's built-in image rendering", () => { const cwd = tempCwd("always");
		const definition = readRenderer(cwd);
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

		expect(hasTerminalImage(renderImageResult(definition, cwd, true, true))).toBe(false); });
});
