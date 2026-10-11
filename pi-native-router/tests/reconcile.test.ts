import { expect, test } from "bun:test";
import { applyPeak, backfillCost, isDeepSeekPeak, priceFromCatalog, type CostUsage } from "../src/pricing/reconcile";
import type { PriceRecord } from "../src/pricing/catalog";

const at = (iso: string) => Date.parse(iso);
const usage = (total = 0): CostUsage => ({
  input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 0,
  cost: { input: 0.15, output: 0.3, cacheRead: 0.006, cacheWrite: 0, total },
});

test("DeepSeek peak covers weekday 01-04 and 06-10 UTC only", () => {
  expect(isDeepSeekPeak(at("2026-10-12T01:00:00Z"))).toBe(true);   // Monday 01:00
  expect(isDeepSeekPeak(at("2026-10-12T03:59:59Z"))).toBe(true);
  expect(isDeepSeekPeak(at("2026-10-12T04:00:00Z"))).toBe(false);
  expect(isDeepSeekPeak(at("2026-10-12T06:00:00Z"))).toBe(true);
  expect(isDeepSeekPeak(at("2026-10-12T10:00:00Z"))).toBe(false);
  expect(isDeepSeekPeak(at("2026-10-17T02:00:00Z"))).toBe(false);  // Saturday
  expect(isDeepSeekPeak(at("2026-10-18T07:00:00Z"))).toBe(false);  // Sunday
});

test("peak doubles every recorded component for OpenCode Go DeepSeek only", () => {
  const peak = at("2026-10-12T02:00:00Z");
  const u = usage(0.476);
  expect(applyPeak(u, "opencode-go", "deepseek-v4-flash", peak)).toBe(true);
  expect(u.cost.input).toBeCloseTo(0.3);
  expect(u.cost.output).toBeCloseTo(0.6);
  expect(u.cost.total).toBeCloseTo(0.912);
  const other = usage(0.476);
  expect(applyPeak(other, "opencode-go", "mimo-v2.5", peak)).toBe(false);
  expect(applyPeak(other, "anthropic", "deepseek-v4-flash", peak)).toBe(false);
  expect(applyPeak(other, "opencode-go", "deepseek-v4-flash", at("2026-10-12T12:00:00Z"))).toBe(false);
  expect(other.cost.total).toBeCloseTo(0.476);
});

test("catalog backup prices a complete record and leaves a partial or tiered one unknown", () => {
  const complete: PriceRecord = { provider: "p", model: "m", provenance: "models.dev", input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, tiered: false };
  const priced = priceFromCatalog(usage(), complete);
  expect(priced?.input).toBeCloseTo(1);
  expect(priced?.output).toBeCloseTo(1);
  expect(priced?.total).toBeCloseTo(2.2);
  expect(priceFromCatalog(usage(), { ...complete, cacheWrite: undefined })).toBeUndefined();
  expect(priceFromCatalog(usage(), { ...complete, tiered: true })).toBeUndefined();
});

test("backup only applies when Pi has no price for the model, and never overwrites Pi's own cost", () => {
  const record: PriceRecord = { provider: "p", model: "m", provenance: "litellm", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiered: false };
  const piPriced = usage(0.476);
  expect(backfillCost(piPriced, true, record)).toBe(false);
  expect(piPriced.cost.total).toBeCloseTo(0.476);
  const unpriced = usage(0);
  expect(backfillCost(unpriced, false, record)).toBe(true);
  expect(unpriced.cost.total).toBeGreaterThan(0);
  const none = usage(0);
  expect(backfillCost(none, false, undefined)).toBe(false);
});
