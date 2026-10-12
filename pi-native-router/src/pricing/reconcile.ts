import type { PriceRecord } from "./catalog";

/**
 * Cost reconciliation for a finalized assistant message. Pi's own cost is the source of truth. Two
 * adjustments exist, and nothing else:
 *   1. Time-of-day pricing: OpenCode Go bills its DeepSeek models at DeepSeek's peak rate, which is
 *      exactly twice the off-peak rate Pi records. Peak is applied to Pi's recorded cost.
 *   2. Backup: the catalog snapshot prices a message only when Pi's cost is missing or a placeholder.
 *      Missing means Pi's registry has no model for it. A placeholder means Pi recorded zero cost for
 *      a message with tokens. A partial or tiered record, or one that prices the usage at zero, leaves
 *      Pi's cost unchanged.
 */

export interface CostUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** Set when time-of-day pricing scaled the cost; pi-otel exports it as pi.pricing.peak_multiplier. */
  peakMultiplier?: number;
}

export const PEAK_MULTIPLIER = 2;
const DEEPSEEK_PEAK_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro", "deepseek-v4.1-flash", "deepseek-flash"]);

/** DeepSeek peak: weekdays 01:00-04:00 and 06:00-10:00 UTC; weekends are off-peak. */
export function isDeepSeekPeak(atMs: number): boolean {
  const at = new Date(atMs);
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function isPeakPriced(provider: string, model: string, atMs: number): boolean {
  return provider === "opencode-go" && DEEPSEEK_PEAK_MODELS.has(model) && isDeepSeekPeak(atMs);
}

/** Multiplies every recorded cost component by the peak factor. Returns true when it changed the cost. */
export function applyPeak(usage: CostUsage, provider: string, model: string, atMs: number): boolean {
  if (!isPeakPriced(provider, model, atMs)) return false;
  usage.cost.input *= PEAK_MULTIPLIER;
  usage.cost.output *= PEAK_MULTIPLIER;
  usage.cost.cacheRead *= PEAK_MULTIPLIER;
  usage.cost.cacheWrite *= PEAK_MULTIPLIER;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  usage.peakMultiplier = PEAK_MULTIPLIER;
  return true;
}

/** Prices usage from a complete catalog record, in USD per million tokens. Partial records return undefined. */
export function priceFromCatalog(usage: CostUsage, record: PriceRecord): CostUsage["cost"] | undefined {
  if (record.tiered || record.input === undefined || record.output === undefined || record.cacheRead === undefined || record.cacheWrite === undefined) return undefined;
  const perToken = (rate: number, tokens: number) => (rate / 1_000_000) * tokens;
  const cost = {
    input: perToken(record.input, usage.input),
    output: perToken(record.output, usage.output),
    cacheRead: perToken(record.cacheRead, usage.cacheRead),
    cacheWrite: perToken(record.cacheWrite, usage.cacheWrite),
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return cost;
}

/**
 * Backs Pi's cost up from the catalog when Pi has no price for the model, or recorded a zero cost
 * for a message with tokens. A nonzero Pi cost is never overwritten. A genuinely free model keeps
 * zero because its exact catalog record also prices the usage at zero.
 */
export function backfillCost(usage: CostUsage, piHasPrice: boolean, record: PriceRecord | undefined): boolean {
  if (!record) return false;
  if (piHasPrice && usage.cost.total !== 0) return false;
  const cost = priceFromCatalog(usage, record);
  if (!cost || cost.total === 0) return false;
  usage.cost = cost;
  return true;
}
