import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateStrategy, immutableSnapshot, loadStrategy, type RoutingContext } from "../src/strategy";
import { projectQuotaObservation, projectStrategyPrice } from "../src/strategy-projection";

const context: RoutingContext = {
  version: 1, now: 100, mode: "dispatch", reason: "initial", options: {},
  route: { role: "work", contextWindow: 100_000, outputReserve: 8_000, stayRetries: 1, maxTransitions: 2, maxRecoveries: 1, configuredOrder: ["a/m", "b/m"] },
  targets: [], eligibleTargetIds: ["a/m", "b/m"], excludedTargetIds: [],
  budgets: { retriesRemaining: 1, transitionsRemaining: 2, recoveriesRemaining: 1 },
  request: { contextTokens: 10, estimateSource: "pi-usage", outputReserve: 8_000 },
};

test("choice validates target/reason, freezes a cloned snapshot, and falls back without leaking module errors", () => {
  const strategy = { id: "/trusted/strategy.ts", choose: (snapshot: RoutingContext) => {
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.route)).toBe(true);
    return { targetId: "b/m", reason: "prefer target" };
  } };
  expect(evaluateStrategy(strategy, context, () => "a/m")).toMatchObject({ targetId: "b/m", strategyId: strategy.id, reason: "prefer target" });
  for (const choose of [
    () => ({ targetId: "missing", reason: "bad" }),
    () => ({ targetId: "a/m", reason: "\n" }),
    () => ({ targetId: "a/m", reason: "x".repeat(513) }),
    () => { throw new Error("secret or provider detail"); },
    (() => Promise.reject(new Error("async"))) as unknown as () => { targetId: string; reason: string },
  ]) {
    const result = evaluateStrategy({ id: "/trusted/bad.ts", choose }, context, () => "a/m");
    expect(result).toMatchObject({ targetId: "a/m", fallback: "strategy execution or result validation failed" });
    expect(JSON.stringify(result)).not.toContain("secret");
  }
  expect(evaluateStrategy(undefined, context, () => "a/m")).toMatchObject({ targetId: "a/m", strategyId: "ordered" });
  let invoked = false;
  const empty = { ...context, eligibleTargetIds: [] };
  expect(evaluateStrategy({ id: "never-called", choose: () => { invoked = true; return { targetId: "a/m", reason: "bad" }; } }, empty, () => undefined))
    .toMatchObject({ strategyId: "ordered", reason: "no eligible targets" });
  expect(invoked).toBe(false);
  const source = { nested: { value: 1 } };
  const copy = immutableSnapshot(source);
  expect(copy).not.toBe(source);
  expect(Object.isFrozen(copy.nested)).toBe(true);
});

test("quota projection preserves freshness, authority and every window without fetching", () => {
  const body = { source: "api", authoritative: true, observedAt: 9_500, windows: [
    { slot: "primary", label: "weekly", usedPercent: 72, resetsAt: 20_000, windowMinutes: 10_080 },
    { slot: "secondary", label: "monthly", usedPercent: 40 },
  ] };
  const row = { observedAt: 9_500, body, error: null };
  expect(projectQuotaObservation(row, true, 10_000, 5_000)).toMatchObject({ status: "fresh", source: "api", authoritative: true, windows: body.windows });
  expect(projectQuotaObservation({ ...row, observedAt: 1, body: { ...body, observedAt: 1 } }, true, 10_000, 5_000).status).toBe("stale");
  expect(projectQuotaObservation({ ...row, body: null, error: "private tracker detail" }, true, 10_000, 5_000)).toEqual({ status: "unavailable", error: "refresh failed", windows: [] });
  expect(projectQuotaObservation(undefined, false, 10_000, 5_000)).toEqual({ status: "unconfigured", windows: [] });
  expect(projectQuotaObservation({ ...row, body: { ...body, windows: [{ slot: "primary", label: "bad", usedPercent: "unknown" }] } }, true, 10_000, 5_000).status).toBe("unavailable");
  expect(projectQuotaObservation({ ...row, body: { ...body, windows: [{ slot: "primary", label: "bad", usedPercent: 110 }] } }, true, 10_000, 5_000).status).toBe("unavailable");
});

test("price projection distinguishes known-free from unknown and keeps partial/tiered estimates conservative", () => {
  const freeCatalog = { status: "complete" as const, record: { provider: "p", model: "free", provenance: "models.dev" as const,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiered: false } };
  expect(projectStrategyPrice({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { status: "unpriced" })).toEqual({ status: "unpriced" });
  expect(projectStrategyPrice(undefined, freeCatalog, 20)).toMatchObject({ status: "complete", inputPerMillion: 0, provenance: "models.dev", asOf: 20 });
  expect(projectStrategyPrice(undefined, { status: "partial", record: { ...freeCatalog.record, input: 1, output: undefined, cacheRead: undefined, cacheWrite: undefined, tiered: true }, missing: ["output", "cacheRead", "cacheWrite"] }, 30))
    .toMatchObject({ status: "partial", inputPerMillion: 1, missing: ["output", "cacheRead", "cacheWrite"], tiered: true });
  expect(projectStrategyPrice({ input: 2, output: 4, cacheRead: 1, cacheWrite: 3 }, freeCatalog).provenance).toBe("pi-model");
});

test("loads and validates a local TypeScript strategy module once per process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-strategy-"));
  try {
    const filename = join(dir, "custom.ts");
    await writeFile(filename, 'export default { version: 1, choose: () => ({ targetId: "a/m", reason: "test" }) };');
    const loaded = await loadStrategy({ module: filename, options: {} });
    expect(loaded.choose(context)).toEqual({ targetId: "a/m", reason: "test" });
    await writeFile(filename, 'export default { version: 1, choose: () => ({ targetId: "b/m", reason: "edited" }) };');
    const cached = await loadStrategy({ module: filename, options: {} });
    expect(cached).toBe(loaded);
    expect(cached.choose(context)).toEqual({ targetId: "a/m", reason: "test" });
    const invalid = join(dir, "invalid.ts");
    await writeFile(invalid, 'export default { version: 2, choose: () => ({ targetId: "a/m", reason: "test" }) };');
    await expect(loadStrategy({ module: invalid, options: {} })).rejects.toThrow("unsupported strategy module contract");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
