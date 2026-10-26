import { expect, test } from "bun:test";
import { createCodemodeExtension, initTheme } from "@earendil-works/pi-coding-agent";
import { createTwoFilesPatch } from "diff";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../tool-renderer/ansi.js";
import { installCodemodeRendering } from "../tool-renderer/codemode-view.js";
import { CODEMODE_DISPLAY_BYTES, CODEMODE_DISPLAY_KEY } from "../tool-renderer/codemode-capture.js";
import { useWorld } from "./helpers/world.js";

const world = useWorld();
const theme: any = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
const patch = createTwoFilesPatch("a.ts", "a.ts", "const before = 1;\n", "const after = 2;\n");

function host() {
	initTheme("dark", false);
	const handlers = new Map<string, Function[]>();
	let resolver: any;
	let base: any;
	createCodemodeExtension()({ registerTool: (tool: any) => { base = tool; }, on() {} } as any);
	installCodemodeRendering({
		on: (name: string, fn: Function) => handlers.set(name, [...handlers.get(name) ?? [], fn]),
		registerToolRenderer: (fn: Function) => { resolver = fn; },
	} as any);
	const emit = (type: string, event: any) => {
		let returned: any;
		for (const fn of handlers.get(type) ?? []) returned = fn({ type, ...event });
		return returned;
	};
	const start = (id: string, name: string, args: any = {}, parent?: string) => emit("tool_execution_start", { toolCallId: id, toolName: name, args, parentToolCallId: parent });
	const end = (id: string, name: string, result: any, parent?: string, isError = false) => emit("tool_execution_end", { toolCallId: id, toolName: name, result, parentToolCallId: parent, isError });
	let redraws = 0;
	const ctx: any = {
		toolCallId: "root", args: { code: "// intent: update attachment claiming\ntext(await tools.edit({path: 'a.ts', edits: [{oldText: 'before', newText: 'after'}]}));" },
		executionStarted: true, isPartial: false, argsComplete: true, expanded: false,
		cwd: world().cwd, state: {}, showImages: false, invalidate: () => { redraws++; },
	};
	const renderers = resolver("codemode", () => base);
	const render = (result: any, expanded = false, width = 80, partial = false) => {
		const context = { ...ctx, expanded, isPartial: partial };
		return renderers.renderResult(result, { expanded, isPartial: partial }, theme, context).render(width).map(stripAnsi);
	};
	const save = (id: string, result: any) => {
		const changed = emit("tool_result", { toolCallId: id, toolName: "codemode", ...result });
		return { ...result, ...changed };
	};
	return { emit, start, end, save, render, ctx, renderers, redraws: () => redraws };
}
const result = (text: string, details: any = {}) => ({ content: [{ type: "text", text }], details });

test("parallel nested calls keep start order, show real outcomes, and survive resume as diffs", () => {
	const h = host();
	h.start("root", "codemode");
	h.start("root/1", "edit", { path: "a.ts", edits: [{ oldText: "secret old payload", newText: "requested new payload" }] }, "root");
	h.start("root/2", "bash", { command: "cargo test" }, "root");
	const live = h.renderers.renderResult(result(""), { expanded: false, isPartial: true }, theme, { ...h.ctx, isPartial: true });
	expect(live.render(80).join("\n")).toContain("… edit a.ts");
	h.end("root/2", "bash", result("all tests pass"), "root");
	h.end("root/1", "edit", result("edited", { patch, kendexDiffSummary: { lineCount: 1 } }), "root");
	expect(h.redraws()).toBeGreaterThan(0);
	const rows = live.render(80).map(stripAnsi).join("\n");
	expect(rows.indexOf("✓ edit a.ts +1 −1")).toBeLessThan(rows.indexOf("✓ bash"));
	expect(rows.indexOf("✓ bash")).toBeLessThan(rows.indexOf("cargo test"));
	expect(rows).toContain("all tests pass");
	expect(rows).not.toContain("oldText");
	const original = result("Script completed\nWall time 0.1 seconds\nOutput:\n", { calls: [] });
	const saved = h.save("root", original);
	expect(saved.content).toBe(original.content);
	expect(original.details).not.toHaveProperty(CODEMODE_DISPLAY_KEY);
	h.end("root", "codemode", saved);
	// No live capture remains: use only a JSON round trip of the parent result.
	const restored = JSON.parse(JSON.stringify(saved));
	const expanded = h.render(restored, true).join("\n");
	expect(expanded).toContain("const before = 1;");
	expect(expanded).toContain("const after = 2;");
	expect(JSON.stringify(restored.details)).not.toContain("secret old payload");
	expect(JSON.stringify(restored.details)).not.toContain('"type":"add"');
});

test("failed edits show the error, never a diff inferred from requested arguments; root output stays separate", () => {
	const h = host();
	h.start("root", "codemode");
	h.start("root/1", "edit", { path: "missing.ts", oldText: "old", newText: "invented change" }, "root");
	h.end("root/1", "edit", result("Could not find the text to replace."), "root", true);
	const saved = h.save("root", result("script-authored combined answer"));
	h.end("root", "codemode", saved);
	for (const expanded of [false, true]) {
		const text = h.render(saved, expanded).join("\n");
		expect(text).toContain("✗ edit missing.ts");
		expect(text).toContain("Could not find the text to replace.");
		expect(text).not.toContain("invented change");
		expect(text.indexOf("Output")).toBeLessThan(text.indexOf("script-authored combined answer"));
	}
});

test("simultaneous roots and helper descendants remain isolated; shutdown releases live data", () => {
	const h = host();
	h.start("root", "codemode"); h.start("other", "codemode");
	h.start("root/1", "helper", {}, "root");
	h.start("root/1/1", "read", { path: "owned.ts" }, "root/1");
	h.start("other/1", "read", { path: "unrelated.ts" }, "other");
	h.end("root/1/1", "read", result("owned content"), "root/1");
	const saved = h.save("root", result(""));
	expect(JSON.stringify(saved)).toContain("owned.ts");
	expect(JSON.stringify(saved)).not.toContain("unrelated.ts");
	expect(saved.details[CODEMODE_DISPLAY_KEY].calls[0].status).toBe("cancelled");
	h.emit("session_shutdown", {});
	expect(h.save("root", result(""))).not.toHaveProperty(`details.${CODEMODE_DISPLAY_KEY}`);
});

test("large patches and outputs obey both per-patch and serialized parent budgets", () => {
	const h = host();
	h.start("root", "codemode");
	for (let i = 0; i < 132; i++) {
		h.start(`root/${i}`, "edit", { path: `file-${i}` }, "root");
		h.end(`root/${i}`, "edit", result("x".repeat(5000), { patch: i === 0 ? "x".repeat(70_000) : patch + " ".repeat(40_000) }), "root");
	}
	const saved = h.save("root", result(""));
	const display = saved.details[CODEMODE_DISPLAY_KEY];
	expect(Buffer.byteLength(JSON.stringify(display))).toBeLessThanOrEqual(CODEMODE_DISPLAY_BYTES);
	expect(display.omitted).toBe(4);
	expect(display.calls[0].patch).toBeUndefined();
	expect(display.calls[0].notice).toContain("budget exceeded");
	expect(display.calls.some((call: any) => call.notice?.includes("details unavailable"))).toBe(true);
});

test("streaming updates replace cached diffs and an oversized final patch cannot leave a stale preview", () => {
	const h = host();
	h.start("root", "codemode");
	h.start("root/1", "edit", { path: "a.ts" }, "root");
	const live = h.renderers.renderResult(result(""), { expanded: true, isPartial: true }, theme, { ...h.ctx, expanded: true });
	h.emit("tool_execution_update", { toolCallId: "root/1", partialResult: result("", { patch }) });
	expect(live.render(80).map(stripAnsi).join("\n")).toContain("const after = 2;");
	const newer = createTwoFilesPatch("a.ts", "a.ts", "const before = 1;\n", "const newest = 3;\n");
	h.emit("tool_execution_update", { toolCallId: "root/1", partialResult: result("", { patch: newer }) });
	expect(live.render(80).map(stripAnsi).join("\n")).toContain("const newest = 3;");
	h.end("root/1", "edit", result("edited", { patch: "x".repeat(70_000) }), "root");
	const final = h.render(h.save("root", result("")), true).join("\n");
	expect(final).toContain("diff unavailable · display budget exceeded");
	expect(final).not.toContain("const newest");
});

test("collapsed source yields to combined result; expansion retains native source and old sessions degrade honestly", () => {
	const h = host();
	const pending = { ...h.ctx, isPartial: true };
	const call = h.renderers.renderCall(h.ctx.args, theme, pending);
	expect(call.render(80).join("")).toContain("codemode");
	h.renderers.renderResult(result(""), { expanded: false, isPartial: true }, theme, pending);
	expect(call.render(80).join("").trim()).toBe("");
	const source = h.renderers.renderCall(h.ctx.args, theme, { ...h.ctx, expanded: true, lastComponent: call }).render(80).map(stripAnsi).join("\n");
	expect(source).toContain("text(await tools.edit");
	const old = result("", { calls: [{ id: "root/1", name: "edit", args: '{"path":"old.ts"}', status: "ok", durationMs: 5 }] });
	const expanded = h.render(old, true).join("\n");
	expect(expanded).toContain("✓ edit old.ts");
	expect(expanded).toContain("no retained patch");
});

test("later failures stay visible when successful calls exceed the collapsed budget", () => {
	const h = host();
	h.start("root", "codemode");
	for (let i = 0; i < 10; i++) {
		h.start(`root/${i}`, "read", { path: `file-${i}` }, "root");
		h.end(`root/${i}`, "read", result(i === 9 ? "late failure" : "ok"), "root", i === 9);
	}
	const text = h.render(h.save("root", result(""))).join("\n");
	expect(text).toContain("✗ read file-9");
	expect(text).toContain("late failure");
	expect(text).toContain("1 more calls");
});

test("nested diffs and previews fit actual viewport width and strip terminal controls", () => {
	const h = host();
	h.start("root", "codemode");
	h.start("root/1", "edit", { path: "a.ts" }, "root");
	h.end("root/1", "edit", result("edited", { patch }), "root");
	h.start("root/2", "read", { path: "\x1b[31mevil.ts\x07" }, "root");
	h.end("root/2", "read", result("\x1b[2J" + "wide 界 ".repeat(30)), "root");
	const saved = h.save("root", result(""));
	for (const width of [24, 40, 80, 120]) for (const expanded of [false, true]) {
		const rows = h.render(saved, expanded, width);
		for (const line of rows) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(rows.join("\n")).not.toContain("\x1b[2J");
	}
});
