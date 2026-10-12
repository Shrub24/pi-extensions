import type { CauseRecord, LeaseRecord } from "./health-store";

/**
 * How this process coordinates health: through the shared store, through the process-local mirror after
 * the store failed, or local-only because `sharedHealth` is off. Operators must be able to tell these apart.
 */
export type HealthMode = "shared" | "degraded-local" | "local-only";

const MODE_LABEL: Record<HealthMode, string> = {
  shared: "shared across same-user processes",
  "degraded-local": "DEGRADED: shared store unavailable, process-local health only",
  "local-only": "local-only: sharedHealth is disabled",
};

/** Secret-free report of causes and probe leases. Reasons are normalized labels, never raw provider bodies. */
export function healthReport(
  state: { causes: CauseRecord[]; leases: LeaseRecord[]; revision: number },
  now: number,
  mode: HealthMode,
): string[] {
  const lines = [`native-router health (${MODE_LABEL[mode]}; revision ${state.revision})`];
  for (const cause of state.causes) {
    const status = cause.until <= now ? " (expired, probe eligible)" : "";
    lines.push(`  ${cause.key}: ${cause.kind} until ${new Date(cause.until).toISOString()}${status} [${cause.reason}]`);
  }
  for (const lease of state.leases) lines.push(`  probe ${lease.key}: held until ${new Date(lease.expires).toISOString()}`);
  if (state.causes.length === 0 && state.leases.length === 0) lines.push("  no active causes");
  return lines;
}
