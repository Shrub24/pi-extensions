import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Container, Image, resetCapabilitiesCache, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";

import { stripAnsi } from "../tool-renderer/ansi.js";
import { __test, installToolChromePatch, withResultTheme } from "../tool-renderer/chrome.js";
import { clearTrackedToolExecutionComponents, refreshToolExecutionComponents } from "../tool-renderer/live-settings.js";
import { RESERVED_IMAGE_ROW_MARKER, TOOL_RENDER_OVERLAY_CHECK_SYMBOL } from "../tool-renderer/overlay.js";
import { clearPackageConfigCache, recordProjectTrust } from "../tool-renderer/package-config.js";

const createdDirs: string[] = [];

afterEach(() => { resetCapabilitiesCache();
	clearTrackedToolExecutionComponents();
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	clearPackageConfigCache();
});

const theme = { fg(token: string, text: string) { if (token === "borderMuted") return `\x1b[90m${text}\x1b[39m`;
		return text; },
};

function tempCwd(config?: Record<string, unknown>): string { const dir = mkdtempSync(join(tmpdir(), "pi-tool-renderer-chrome-"));
	createdDirs.push(dir);
	if (config) { writeConfig(dir, config);
		recordProjectTrust({ cwd: dir, isProjectTrusted: () => true }); }
	return dir;
}

function writeConfig(dir: string, config: Record<string, unknown>): void { mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ "pi-tool-renderer": config , }));
}

function toolComponent(cwd: string): any { return { cwd,
		toolCallId: "call-1",
		toolName: "bash",
		ui: { theme }, };
}

describe("tool chrome", () => { test("adjacent tool entries share only the run's outer outline", () => {
		const cwd = tempCwd({ toolChrome: "outlines" });
		class ToolEntry extends Container {
			toolCallId: string;
			toolName = "bash";
			cwd: string;
			ui = { theme };
			hideComponent = false;
			constructor(id: string) {
				super();
				this.toolCallId = id;
				this.cwd = cwd;
				this.addChild({ render: () => [`content ${id}`], invalidate() {} } as never);
			}
		}
		const transcript = new Container();
		transcript.addChild(new ToolEntry("call-1"));
		transcript.addChild(new ToolEntry("call-2"));
		transcript.addChild({ render: () => ["assistant response"], invalidate() {} } as never);
		transcript.addChild(new ToolEntry("call-3"));
		installToolChromePatch();

		const lines = transcript.render(40).map(stripAnsi);
		const rules = lines.filter((line) => line === "─".repeat(39));
		expect(rules).toHaveLength(4);
		expect(lines.indexOf("content call-1")).toBeLessThan(lines.indexOf("content call-2"));
		expect(lines.indexOf("content call-2")).toBeLessThan(lines.indexOf("assistant response"));
		expect(lines.indexOf("assistant response")).toBeLessThan(lines.indexOf("content call-3"));
		expect(lines.slice(lines.indexOf("content call-1"), lines.indexOf("content call-2"))).not.toContain("─".repeat(39));
	});

	test("transparent chrome leaves adjacent entries ungrouped", () => {
		const cwd = tempCwd({ toolChrome: "transparent" });
		const makeTool = (id: string) => {
			const component: any = new Container();
			component.toolName = "bash";
			component.toolCallId = id;
			component.cwd = cwd;
			component.ui = { theme };
			component.hideComponent = false;
			component.addChild({ render: () => [`content ${id}`], invalidate() {} });
			return component;
		};
		const transcript = new Container();
		transcript.addChild(makeTool("call-1"));
		transcript.addChild(makeTool("call-2"));
		installToolChromePatch();
		const lines = transcript.render(40).map(stripAnsi);
		expect(lines).toEqual(["content call-1", "content call-2"]);
	});

	test("hidden tool entries do not split an adjacent visible run", () => {
		const cwd = tempCwd({ toolChrome: "outlines" });
		const makeTool = (id: string, hidden = false) => {
			const component: any = new Container();
			component.toolName = "bash";
			component.toolCallId = id;
			component.cwd = cwd;
			component.ui = { theme };
			component.hideComponent = hidden;
			component.render = hidden ? () => [] : Container.prototype.render;
			if (!hidden) component.addChild({ render: () => [`content ${id}`], invalidate() {} });
			return component;
		};
		const transcript = new Container();
		transcript.addChild(makeTool("call-1"));
		transcript.addChild(makeTool("call-hidden", true));
		transcript.addChild(makeTool("call-2"));
		installToolChromePatch();

		const lines = transcript.render(40).map(stripAnsi);
		expect(lines.filter((line) => line === "─".repeat(39))).toHaveLength(2);
		expect(lines).toContain("content call-1");
		expect(lines).toContain("content call-2");
	});

	test("adding and removing a sibling refreshes cached outer boundaries", () => {
		const cwd = tempCwd({ toolChrome: "outlines" });
		const makeTool = (id: string) => {
			const component: any = new Container();
			component.toolName = "bash";
			component.toolCallId = id;
			component.cwd = cwd;
			component.ui = { theme };
			component.hideComponent = false;
			component.addChild({ render: () => [`content ${id}`], invalidate() {} });
			return component;
		};
		const transcript = new Container();
		const first = makeTool("call-1");
		transcript.addChild(first);
		installToolChromePatch();
		expect(transcript.render(40).filter((line) => stripAnsi(line) === "─".repeat(39))).toHaveLength(2);
		const second = makeTool("call-2");
		transcript.addChild(second);
		expect(transcript.render(40).filter((line) => stripAnsi(line) === "─".repeat(39))).toHaveLength(2);
		transcript.removeChild(second);
		expect(transcript.render(40).filter((line) => stripAnsi(line) === "─".repeat(39))).toHaveLength(2);
	});

	test("self-rendered tools regain outline rules after Pi trims empty shell rows", () => { const cwd = tempCwd({ toolChrome: "outlines" });
		const rendered = ["", "● Bash $ echo hi", ""];
		const lines = __test.renderToolChromeLines(toolComponent(cwd), rendered, 40);

		expect(lines).toHaveLength(3);
		expect(stripAnsi(lines[0]!)).toBe("─".repeat(39));
		expect(stripAnsi(lines[1]!)).toBe("● Bash $ echo hi");
		expect(stripAnsi(lines[2]!)).toBe("─".repeat(39));
		expect(lines.every((line) => visibleWidth(line) <= 39)).toBe(true); });

	test("unchanged input reuses the chrome lines; new content, width, rule or mode redraws", () => { const cwd = tempCwd({});
		const component = toolComponent(cwd);
		const first = __test.renderToolChromeLines(component, ["● Bash $ echo hi"], 40);
		expect(__test.renderToolChromeLines(component, ["● Bash $ echo hi"], 40)).toBe(first);

		const changed = __test.renderToolChromeLines(component, ["● Bash $ echo bye"], 40);
		expect(stripAnsi(changed[1]!)).toBe("● Bash $ echo bye");
		const narrow = __test.renderToolChromeLines(component, ["● Bash $ echo bye"], 20);
		expect(stripAnsi(narrow[0]!)).toBe("─".repeat(19));
		__test.renderToolChromeLines(component, ["● Bash $ echo bye", "bye"], 20);
		expect(__test.renderToolChromeLines(component, ["● Bash $ echo bye"], 20).map(stripAnsi)).not.toContain("bye");

		component.ui = { theme: { fg: (token: string, text: string) => (token === "borderMuted" ? `\x1b[94m${text}\x1b[39m` : text) } };
		expect(__test.renderToolChromeLines(component, ["● Bash $ echo bye"], 20)[0]).toBe(`\x1b[94m${"─".repeat(19)}\x1b[39m`);
		// A live settings change clears the config cache; the chrome follows on the next render.
		// The rule key also changes here (transparent has none), so only dropping both mode and rule reddens this.
		writeConfig(cwd, { toolChrome: "transparent" });
		clearPackageConfigCache();
		expect(__test.renderToolChromeLines(component, ["● Bash $ echo bye"], 20)).toEqual(["● Bash $ echo bye"]); });

	test("transparent chrome still trims blank self-render shell rows without rules", () => { const cwd = tempCwd({ toolChrome: "transparent" });
		const lines = __test.renderToolChromeLines(toolComponent(cwd), ["", "● Bash $ echo hi", ""], 40);

		expect(lines).toEqual(["● Bash $ echo hi"]); });

	test("off chrome leaves Pi-rendered shell rows unchanged", () => { const cwd = tempCwd({ toolChrome: "off" });
		const rendered = ["", "● Bash $ echo hi", ""];

		expect(__test.renderToolChromeLines(toolComponent(cwd), rendered, 40)).toEqual(rendered); });

	test("result renderers receive live overlay state and register for settings refresh", () => { let overlayActive = false;
		let invalidations = 0;
		let renderRequests = 0;
		const context: any = {};
		const wrapped = withResultTheme(
			{ invalidate: () => invalidations++,
				ui: { hasOverlay: () => overlayActive,
					requestRender: () => renderRequests++, }, },
			(_result: any, _options: any, _theme: any, renderContext: any) => renderContext,
		);

		wrapped({}, {}, theme, context);
		expect(context[TOOL_RENDER_OVERLAY_CHECK_SYMBOL]()).toBe(false);
		overlayActive = true;
		expect(context[TOOL_RENDER_OVERLAY_CHECK_SYMBOL]()).toBe(true);
		refreshToolExecutionComponents();
		expect(invalidations).toBe(1);
		expect(renderRequests).toBe(1); });

	test("preserves blank rows reserved by Kitty image components", () => { const cwd = tempCwd({ toolChrome: "outlines" });
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const image = new Image(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"image/png",
			{ fallbackColor: (text: string) => text },
			{ maxHeightCells: 3, maxWidthCells: 4 },
		);
		const imageLines = image.render(20);
		const rendered = ["", "read image.png", "", ...imageLines];
		const lines = __test.renderToolChromeLines(toolComponent(cwd), rendered, 20);
		const imageLineIndex = lines.findIndex((line) => line.includes("\x1b_G"));

		expect(imageLines.length).toBeGreaterThan(1);
		expect(imageLineIndex).toBeGreaterThan(0);
		expect(lines.slice(imageLineIndex + 1, -1)).toEqual(imageLines.slice(1)); });

	test("preserves hidden image padding markers and trailing rows", () => { const cwd = tempCwd({ toolChrome: "outlines" });
		const lines = __test.renderToolChromeLines(
			toolComponent(cwd),
			["", "read image.png", "", RESERVED_IMAGE_ROW_MARKER, "", ""],
			20,
		);
		const markerIndex = lines.findIndex((line) => line.includes(RESERVED_IMAGE_ROW_MARKER));

		expect(markerIndex).toBeGreaterThan(0);
		expect(lines.slice(markerIndex + 1, -1)).toEqual(["", ""]); });
});
