import { beforeEach, expect, test } from "bun:test";
import { parseSmapsRollup, takeSample } from "../extensions/sample.js";
import { readReporters, reporters } from "../extensions/registry.js";
import memtrace from "../extensions/index.js";

beforeEach(() => reporters().clear());

test("a reporter's counts are read at sample time, not at registration", () => {
	let entries = 2;
	reporters().set("ext.cache", () => ({ entries }));
	entries = 5;
	expect(readReporters()).toEqual({ "ext.cache": { entries: 5 } });
});

test("a reporter that throws is recorded and does not stop the others", () => {
	reporters().set("broken", () => {
		throw new Error("boom");
	});
	reporters().set("fine", () => ({ bytes: 16 }));
	expect(readReporters()).toEqual({ broken: { error: "boom" }, fine: { bytes: 16 } });
});

test("the registry is shared through globalThis, so separate modules see one map", () => {
	const shared = ((globalThis as any)[Symbol.for("pi-memtrace.reporters")] ??= new Map());
	shared.set("from-another-module", () => ({ n: 1 }));
	expect(reporters().get("from-another-module")?.()).toEqual({ n: 1 });
});

test("smaps_rollup kB fields become bytes, and missing fields stay undefined", () => {
	const text = "Rss:             1883020 kB\nPss:             1802734 kB\nAnonymous:       1781788 kB\nSwap: 12 kB\n";
	expect(parseSmapsRollup(text)).toEqual({ rss: 1883020 * 1024, anon: 1781788 * 1024, swap: 12 * 1024 });
	expect(parseSmapsRollup("Pss: 1 kB\n")).toEqual({ rss: undefined, anon: undefined, swap: undefined });
});

test("a sample carries heap, runtime and reporter readings, tagged with session and turn", () => {
	reporters().set("ext.cache", () => ({ entries: 3 }));
	const sample = takeSample("session-1", 7);
	expect(sample.session).toBe("session-1");
	expect(sample.turn).toBe(7);
	expect(sample.heapUsed).toBeGreaterThan(0);
	expect(sample.rss).toBeGreaterThan(0);
	expect(sample.reporters).toEqual({ "ext.cache": { entries: 3 } });
});

test("menu toggles per-turn sampling without restarting the extension", async () => {
	const commands: Record<string, any> = {};
	const events: Record<string, any> = {};
	memtrace({ registerCommand: (name: string, command: unknown) => { commands[name] = command; }, on: (name: string, handler: unknown) => { events[name] = handler; } } as any);
	const titles: string[] = [];
	const choices = ["Enable sampling (every turn)", undefined];
	const ctx = { ui: { select: async (title: string) => { titles.push(title); return choices.shift(); } }, sessionManager: { getSessionId: () => "test-menu" } };
	await commands.memtrace.handler("", ctx);
	expect(titles[0]).toContain("sampling off");
	expect(titles[1]).toContain("sampling every 1 turns");
	expect(typeof events.turn_end).toBe("function");
});
