import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { buildSnapshot, parseLiteLLM, parseModelsDev } from "../src/pricing/catalog";
import { saveSnapshot } from "../src/pricing/cache";
import { installRouter } from "../src/index";

// Drives the installed message_end handler against a saved catalog snapshot, as Pi does on each finished message.
test("message_end backfills a zero Pi cost from the exact catalog record, and leaves a free model at zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-router-backfill-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    saveSnapshot(join(dir, "pi-native-router", "pricing.json"), buildSnapshot(parseModelsDev({
      anthropic: { id: "anthropic", models: { "claude-haiku-4-5": { cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } } } },
      "opencode-go": { id: "opencode-go", models: { "longcat-2.5-preview-free": { cost: { input: 0, output: 0, cache_read: 0 } } } },
    }), parseLiteLLM({}), 1000));
    const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const pi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { if (name === "message_end") handlers.push(handler); },
      registerCommand() {}, registerVirtualModel() {}, registerProvider() {}, appendEntry() {},
      setActiveTools() {}, getActiveTools: () => [], getAllTools: () => [],
      events: { on() {}, emit() {} },
    };
    installRouter(pi as never, parseConfig({ routes: { worker: { candidates: [{ provider: "fake-a", id: "model" }] } } }), { healthPath: join(dir, "h.sqlite") });
    // Pi's registry prices these models at zero, so the recorded cost is a placeholder.
    const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const ctx = { modelRegistry: { find: () => ({ cost: zeroCost }) } };
    const run = (provider: string, model: string) => {
      const message = {
        role: "assistant", provider, model, timestamp: Date.parse("2026-10-12T12:00:00Z"),
        usage: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, totalTokens: 2_000_000, cost: { ...zeroCost } },
      };
      let replaced: { usage: { cost: { total: number } } } | undefined;
      for (const handler of handlers) {
        const result = handler({ type: "message_end", message }, ctx) as { message?: typeof replaced } | undefined;
        if (result?.message) replaced = result.message;
      }
      return replaced;
    };
    expect(run("anthropic", "claude-haiku-4-5")?.usage.cost.total).toBeCloseTo(6);
    expect(run("opencode-go", "longcat-2.5-preview-free")).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
