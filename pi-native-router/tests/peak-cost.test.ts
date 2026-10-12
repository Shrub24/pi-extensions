import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { installRouter } from "../src/index";

// Drives the router's installed message_end handlers directly, as Pi does, and checks the replacement
// message that pi-otel will read on turn_end.
test("a DeepSeek opencode-go message at peak returns doubled cost with the peak marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-router-peak-"));
  try {
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    const pi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { (handlers[name] ??= []).push(handler); },
      registerCommand() {}, registerVirtualModel() {}, registerProvider() {}, appendEntry() {},
      setActiveTools() {}, getActiveTools: () => [], getAllTools: () => [],
      events: { on() {}, emit() {} },
    };
    installRouter(pi as never, parseConfig({ routes: { worker: { candidates: [{ provider: "fake-a", id: "model" }] } } }), { healthPath: join(dir, "h.sqlite") });
    // 2026-10-12 is a Monday; 02:00 UTC is DeepSeek peak.
    const timestamp = Date.parse("2026-10-12T02:00:00Z");
    const message = {
      role: "assistant", provider: "opencode-go", model: "deepseek-v4-flash", timestamp,
      usage: { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500_000,
        cost: { input: 0.15, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.45 } },
    };
    const ctx = { model: undefined, modelRegistry: { find: () => ({ cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } }) }, sessionManager: { getSessionId: () => "s" } };
    let replaced: { usage: { cost: { total: number; input: number }; peakMultiplier?: number } } | undefined;
    for (const handler of handlers.message_end ?? []) {
      const result = handler({ type: "message_end", message }, ctx) as { message?: typeof replaced } | undefined;
      if (result?.message) replaced = result.message;
    }
    expect(replaced).toBeDefined();
    expect(replaced!.usage.cost.input).toBeCloseTo(0.3);
    expect(replaced!.usage.cost.total).toBeCloseTo(0.9);
    expect(replaced!.usage.peakMultiplier).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a Command Code DeepSeek message at peak keeps its recorded cost and carries the peak marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-router-peak-"));
  try {
    const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const pi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { if (name === "message_end") handlers.push(handler); },
      registerCommand() {}, registerVirtualModel() {}, registerProvider() {}, appendEntry() {},
      setActiveTools() {}, getActiveTools: () => [], getAllTools: () => [],
      events: { on() {}, emit() {} },
    };
    installRouter(pi as never, parseConfig({ routes: { worker: { candidates: [{ provider: "fake-a", id: "model" }] } } }), { healthPath: join(dir, "h.sqlite") });
    // Pi's commandcode cost already reflects peak (0.30 per million input); the router must not double it.
    const message = {
      role: "assistant", provider: "commandcode", model: "deepseek/deepseek-v4.1-flash", timestamp: Date.parse("2026-10-12T07:10:00Z"),
      usage: { input: 70_312, output: 1945, cacheRead: 3456, cacheWrite: 0, totalTokens: 75_713,
        cost: { input: 0.0210936, output: 0.001167, cacheRead: 0.0000104, cacheWrite: 0, total: 0.0222710 } },
    };
    const ctx = { modelRegistry: { find: () => ({ cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } }) } };
    let replaced: { usage: { cost: { total: number; input: number }; peakMultiplier?: number } } | undefined;
    for (const handler of handlers) {
      const result = handler({ type: "message_end", message }, ctx) as { message?: typeof replaced } | undefined;
      if (result?.message) replaced = result.message;
    }
    expect(replaced).toBeDefined();
    expect(replaced!.usage.cost.input).toBeCloseTo(0.0210936);
    expect(replaced!.usage.cost.total).toBeCloseTo(0.022271);
    expect(replaced!.usage.peakMultiplier).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an off-peak message is returned unchanged and without the marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-router-peak-"));
  try {
    const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const pi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { if (name === "message_end") handlers.push(handler); },
      registerCommand() {}, registerVirtualModel() {}, registerProvider() {}, appendEntry() {},
      setActiveTools() {}, getActiveTools: () => [], getAllTools: () => [],
      events: { on() {}, emit() {} },
    };
    installRouter(pi as never, parseConfig({ routes: { worker: { candidates: [{ provider: "fake-a", id: "model" }] } } }), { healthPath: join(dir, "h.sqlite") });
    const message = {
      role: "assistant", provider: "opencode-go", model: "deepseek-v4-flash", timestamp: Date.parse("2026-10-12T12:00:00Z"),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 } },
    };
    const ctx = { modelRegistry: { find: () => ({ cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } }) } };
    const results = handlers.map(handler => handler({ type: "message_end", message }, ctx));
    expect(results.every(result => !(result as { message?: unknown } | undefined)?.message)).toBe(true);
    expect(message.usage).not.toHaveProperty("peakMultiplier");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
