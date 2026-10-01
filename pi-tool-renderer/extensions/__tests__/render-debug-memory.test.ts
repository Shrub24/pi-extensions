import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __test as messagesTest, codeHighlightCacheStats } from "../tool-renderer/messages.js";
import {
	formatMemoryDebugReport,
	megabytes,
	memoryDebugReportLines,
	readMemoryUsage,
	registerRenderDebugCommand,
	resolveForcedGc,
} from "../tool-renderer/render-debug.js";
import { clearPackageConfigCache } from "../tool-renderer/package-config.js";
import { CONFIG_ID } from "../tool-renderer/settings.js";
import { registerStackEvents, stackStoreStats } from "../tool-renderer/stack.js";
import { blinkStoreStats, blinkingPrefix, clearBlink } from "../tool-renderer/text.js";
import { builtInToolCacheStats, getBuiltInTool } from "../tool-renderer/tools.js";
import { useWorld } from "./helpers/world.js";

const world = useWorld();

const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };

describe("render debug memory report", () => {
	test("reads the five process.memoryUsage fields", () => {
		const expected = { rss: 100, heapUsed: 40, heapTotal: 60, external: 10, arrayBuffers: 0 };
		const memoryUsage = spyOn(process, "memoryUsage").mockReturnValue(expected);
		try {
			expect(readMemoryUsage()).toEqual(expected);
		} finally {
			memoryUsage.mockRestore();
		}
	});

	test("live memory readings are finite and non-negative", () => {
		for (const value of Object.values(readMemoryUsage())) {
			expect(Number.isFinite(value)).toBe(true);
			expect(value).toBeGreaterThanOrEqual(0);
		}
	});

	test("formats bytes as megabytes with one decimal", () => {
		expect([megabytes(0), megabytes(1024 * 1024), megabytes(1536 * 1024)]).toEqual(["0.0 MB", "1.0 MB", "1.5 MB"]);
	});

	test("labels rss as the whole process and heapUsed as the JS heap alone", () => {
		const lines = formatMemoryDebugReport(false).join("\n");
		expect(lines).toContain("rss:");
		expect(lines).toContain("(whole process)");
		expect(lines).toContain("heapUsed:");
		expect(lines).toContain("(JS heap only)");
		expect(lines).toContain("external:");
		expect(lines).toContain("arrayBuffers:");
	});

	test("names every strong store it sizes", () => {
		const lines = formatMemoryDebugReport(false).join("\n");
		for (const label of ["blink entries", "code highlight cache", "stack items", "built-in tool sets"]) {
			expect(lines).toContain(label);
		}
	});

	test("says the WeakMap render caches are not measured instead of reporting a size for them", () => {
		const lines = formatMemoryDebugReport(false).join("\n");
		expect(lines).toContain("WeakMaps");
		expect(lines).toContain("no live size");
	});

	test("a GC reading calls its heap drop reclaimed heap, never a retained delta", () => {
		const lines = formatMemoryDebugReport(true, 512 * 1024 * 1024).join("\n");
		expect(lines).toContain("explicit gc() ran");
		expect(lines).toContain("reclaimed heap");
		expect(lines).toContain("not this extension's retained set");
	});

	test("runs a forced GC when the runtime exposes one and reports the before/after heap", () => {
		const lines = memoryDebugReportLines(true);
		expect(resolveForcedGc()).toBeDefined();
		expect(lines.at(-1)).toContain("explicit gc() ran");
		expect(lines.at(-1)).toMatch(/heapUsed [\d.]+ MB → [\d.]+ MB/);
	});

	test("reports an unavailable collector instead of a fabricated reclaim", () => {
		const host = globalThis as { Bun?: { gc?: unknown }; gc?: unknown };
		const savedBunGc = host.Bun?.gc;
		const savedNodeGc = host.gc;
		let lines: string[];
		try {
			if (host.Bun) host.Bun.gc = undefined;
			host.gc = undefined;
			expect(resolveForcedGc()).toBeUndefined();
			lines = memoryDebugReportLines(true);
		} finally {
			if (host.Bun) host.Bun.gc = savedBunGc;
			host.gc = savedNodeGc;
		}
		expect(lines.join("\n")).toContain("no collection was forced");
		expect(lines.join("\n")).not.toContain("explicit gc() ran");
	});
});

describe("renderdebug command", () => {
	function fakePi() {
		let command: { description: string; handler: (args: string, ctx: any) => Promise<void> } | undefined;
		return {
			pi: { registerCommand: (_name: string, spec: any) => { command = spec; } },
			run: async (args: string) => {
				const notes: string[] = [];
				await command!.handler(args, { cwd: process.cwd(), ui: { notify: (message: string) => notes.push(message) } });
				return notes;
			},
			description: () => command!.description,
		};
	}

	test("prints the CPU report for a bare invocation", async () => {
		const host = fakePi();
		registerRenderDebugCommand(host.pi as any);
		const notes = await host.run("");
		expect(notes.join("\n")).toContain("frames (10s):");
		expect(notes.join("\n")).not.toContain("rss:");
	});

	test("prints the memory report for 'memory' and a forced collection for 'memory gc'", async () => {
		const host = fakePi();
		registerRenderDebugCommand(host.pi as any);
		const plain = await host.run("memory");
		expect(plain.join("\n")).toContain("heapUsed:");
		expect(plain.join("\n")).not.toContain("explicit gc() ran");
		expect(plain.join("\n")).not.toContain("frames (10s):");
		const forced = await host.run("MEMORY gc");
		expect(forced.join("\n")).toContain("explicit gc() ran");
	});

	test("still resets the CPU counters", async () => {
		const host = fakePi();
		registerRenderDebugCommand(host.pi as any);
		expect(await host.run("reset")).toEqual(["Render diagnostics reset"]);
	});

	test("advertises the memory subcommand", () => {
		const host = fakePi();
		registerRenderDebugCommand(host.pi as any);
		expect(host.description()).toContain("memory");
	});
});

describe("strong store size probes", () => {
	test("sizes the code highlight cache by entries, source chars and rendered chars", () => {
		const before = codeHighlightCacheStats();
		const markdownTheme = { highlightCode: (code: string) => code.split("\n").map((line) => `<${line}>`) };
		const code = "const a = 1;";
		const rendered = messagesTest.renderStyledCodeBlock({ type: "code", lang: "ts", text: code }, 40, markdownTheme);
		expect(rendered.length).toBeGreaterThan(0);
		const after = codeHighlightCacheStats();
		expect(after.entries - before.entries).toBe(1);
		// Key is `<lang>\0<code>`; value is the two highlighted lines, each padded by the wrapper.
		expect(after.keyChars - before.keyChars).toBe("ts".length + 1 + code.length);
		expect(after.valueChars - before.valueChars).toBe(`<${code}>`.length);
	});

	test("sizes the blink store and its timer, and releases both", () => {
		const before = blinkStoreStats();
		const context = { toolCallId: `blink-${before.entries}-${Date.now()}`, invalidate: () => {} };
		blinkingPrefix(theme, context);
		expect(blinkStoreStats()).toEqual({ entries: before.entries + 1, timerRunning: true });
		clearBlink(context);
		expect(blinkStoreStats()).toEqual({ entries: before.entries, timerRunning: false });
	});

	test("sizes the stack store by items, batches and kept result chars", () => {
		const { cwd } = world();
		writeStackSetting(cwd, true);
		const pi = fakePiStack();
		registerStackEvents(pi as any);
		pi.emit("session_start", {}, { cwd });
		expect(stackStoreStats()).toEqual({ items: 0, batches: 0, resultChars: 0 });
		pi.emit("agent_start", {}, { cwd });
		pi.emit("tool_execution_start", { toolName: "read", toolCallId: "mem-1", args: { path: "mem-1" } }, { cwd });
		pi.emit("tool_execution_end", { toolName: "read", toolCallId: "mem-1", result: { content: [{ type: "text", text: "abcde\n" }] }, isError: false }, { cwd });
		expect(stackStoreStats()).toEqual({ items: 1, batches: 1, resultChars: "abcde\n".length });
	});

	test("sizes the built-in tool cache by distinct cwd and reuses one set per cwd", () => {
		const before = builtInToolCacheStats();
		const cwd = mkdtempSync(join(tmpdir(), "pi-tool-renderer-cache-"));
		const created: string[] = [];
		const agent = {
			createReadTool: () => { created.push("read"); return { name: "read" }; },
			createBashTool: () => ({ name: "bash" }),
		};
		const first = getBuiltInTool(agent, cwd, "read");
		const second = getBuiltInTool(agent, join(cwd, "."), "read");
		expect(second).toBe(first);
		expect(created.length).toBe(1);
		expect(builtInToolCacheStats().cwds - before.cwds).toBe(1);
	});
});

function writeStackSetting(cwd: string, enabled: boolean): void {
	const { writeFileSync } = require("node:fs") as typeof import("node:fs");
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ kendex: { extensionManager: { config: { [CONFIG_ID]: { stackToolCalls: enabled } } } } }));
	clearPackageConfigCache();
}

function fakePiStack() {
	const handlers = new Map<string, ((event: any, ctx: any) => void)[]>();
	return {
		on(name: string, handler: (event: any, ctx: any) => void) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		emit(name: string, event: any, ctx: any) {
			for (const handler of handlers.get(name) ?? []) handler(event, ctx);
		},
	};
}
