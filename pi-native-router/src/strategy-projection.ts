import type { Estimate } from "./pricing/catalog";
import type { StrategyPrice, StrategyQuota, StrategyQuotaWindow } from "./strategy";

/** Project a stored tracker row only; this helper does not own or invoke a refresh source. */
export function projectQuotaObservation(
  row: { observedAt: number; body: unknown | null; error: string | null } | undefined,
  configured: boolean,
  now: number,
  freshMs: number,
): StrategyQuota {
  if (!configured) return { status: "unconfigured", windows: [] };
  if (!row || row.error || !row.body || typeof row.body !== "object") return { status: "unavailable", ...(row?.error ? { error: "refresh failed" } : {}), windows: [] };
  const body = row.body as { source?: unknown; authoritative?: unknown; observedAt?: unknown; windows?: unknown };
  const observedAt = typeof body.observedAt === "number" && Number.isFinite(body.observedAt) ? body.observedAt : row.observedAt;
  if (!Number.isFinite(observedAt) || observedAt > now || !Array.isArray(body.windows)) return { status: "unavailable", error: "snapshot invalid", windows: [] };
  const windows: StrategyQuotaWindow[] = [];
  for (const value of body.windows) {
    if (!value || typeof value !== "object") return { status: "unavailable", error: "snapshot invalid", windows: [] };
    const window = value as { slot?: unknown; label?: unknown; usedPercent?: unknown; resetsAt?: unknown; windowMinutes?: unknown };
    if (typeof window.slot !== "string" || typeof window.label !== "string" || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100)
      return { status: "unavailable", error: "snapshot invalid", windows: [] };
    windows.push({ slot: window.slot, label: window.label, usedPercent: window.usedPercent,
      ...(typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt) ? { resetsAt: window.resetsAt } : {}),
      ...(typeof window.windowMinutes === "number" && Number.isFinite(window.windowMinutes) ? { windowMinutes: window.windowMinutes } : {}) });
  }
  return { status: now - observedAt <= freshMs ? "fresh" : "stale", ...(typeof body.source === "string" ? { source: body.source } : {}),
    authoritative: body.authoritative === true, observedAt, windows };
}

/** Project Pi or exact catalog prices without turning an unknown zero into a free model. */
export function projectStrategyPrice(
  native: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined,
  catalog: Estimate,
  retrievedAt?: number,
): StrategyPrice {
  const nativeHasPrice = native !== undefined && Object.values(native).some(value => typeof value === "number" && value > 0);
  const rates = nativeHasPrice ? native : catalog.status === "unpriced" ? undefined : catalog.record;
  if (!rates) return { status: "unpriced" };
  const fields = [rates.input, rates.output, rates.cacheRead, rates.cacheWrite];
  const status = fields.every(value => typeof value === "number") && (nativeHasPrice || catalog.status === "complete") ? "complete" : "partial";
  return {
    status,
    provenance: nativeHasPrice ? "pi-model" : catalog.status === "unpriced" ? undefined : catalog.record.provenance,
    ...(!nativeHasPrice && retrievedAt !== undefined ? { asOf: retrievedAt } : {}),
    ...(rates.input === undefined ? {} : { inputPerMillion: rates.input }),
    ...(rates.output === undefined ? {} : { outputPerMillion: rates.output }),
    ...(rates.cacheRead === undefined ? {} : { cacheReadPerMillion: rates.cacheRead }),
    ...(rates.cacheWrite === undefined ? {} : { cacheWritePerMillion: rates.cacheWrite }),
    ...(catalog.status === "partial" ? { missing: catalog.missing } : {}),
    ...(!nativeHasPrice && catalog.status !== "unpriced" ? { tiered: catalog.record.tiered } : {}),
  };
}
