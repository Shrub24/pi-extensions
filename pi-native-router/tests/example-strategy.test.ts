import { expect, test } from "bun:test";
import strategy from "../examples/peak-quota-strategy";
import type { RoutingContext, StrategyQuota, StrategyTarget } from "../src/strategy";

const base = (targetId: string, peak: boolean, quota: StrategyTarget["quota"]): StrategyTarget => ({
  targetId, provider: targetId.split("/")[0], model: "model", configuredOrder: targetId === "a/model" ? 0 : 1,
  registered: true, eligible: true, rejectionReasons: [], thinkingLevel: "off", quota, pricing: { status: "unpriced" },
  peak: { active: peak, multiplier: peak ? 2 : 1, costTreatment: peak ? "router-applies" : "none" }, cache: { status: "unknown" },
  switchingCost: { status: "unknown", reason: "not measured" },
});
const context = (targets: StrategyTarget[], currentTargetId?: string): RoutingContext => ({
  version: 1, now: 1_000, mode: "dispatch", reason: "initial", options: { resetHorizonMinutes: 60 },
  route: { role: "work", contextWindow: 100_000, outputReserve: 8_000, stayRetries: 1, maxTransitions: 2, maxRecoveries: 1,
    configuredOrder: ["a/model", "b/model"] }, targets, eligibleTargetIds: targets.map(target => target.targetId), excludedTargetIds: [],
  ...(currentTargetId ? { currentTargetId } : {}), budgets: { retriesRemaining: 1, transitionsRemaining: 2, recoveriesRemaining: 1 },
  request: { contextTokens: 1_000, estimateSource: "pi-usage", outputReserve: 8_000 },
});
const fresh: StrategyQuota = { status: "fresh", authoritative: true, observedAt: 900, windows: [{ slot: "primary", label: "weekly", usedPercent: 65, resetsAt: 20_000 }] };

test("example prefers fresh usable quota near reset, then non-peak, then incumbent/order", () => {
  const a = base("a/model", true, { status: "unconfigured", windows: [] });
  const b = base("b/model", false, fresh);
  expect(strategy.choose(context([a, b])).targetId).toBe("b/model");
  const offPeakA = base("a/model", false, { status: "unconfigured", windows: [] });
  expect(strategy.choose(context([offPeakA, base("b/model", false, { ...fresh, status: "stale" })], "a/model")).targetId).toBe("a/model");
  expect(strategy.choose(context([a, base("b/model", true, { ...fresh, windows: [{ slot: "primary", label: "weekly", usedPercent: 100, resetsAt: 20_000 }] })], "a/model")).targetId).toBe("a/model");
  expect(strategy.choose(context([a, base("b/model", true, { status: "unconfigured", windows: [] })])).targetId).toBe("a/model");
  expect(strategy.choose(context([base("a/model", true, { status: "unconfigured", windows: [] }), base("b/model", true, { status: "unconfigured", windows: [] })], "b/model")).targetId).toBe("b/model");
});
