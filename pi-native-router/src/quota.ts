import { execFile } from "node:child_process";
import type { HealthStore } from "./health-store";
import { PROVIDER_KEY_ONLY } from "./codexbar-config";

/** Source-neutral quota observations. Missing or stale data is unknown, never zero or available. */
export interface QuotaWindow { slot: "primary" | "secondary" | "tertiary"; label: string; usedPercent: number; resetsAt?: number; windowMinutes?: number }
/** `authoritative` is true only when the tracker reports account meters, not a device-local estimate. */
export interface QuotaSnapshot { provider: string; account: string; source: string; authoritative: boolean; observedAt: number; windows: QuotaWindow[] }
/** Router-side mapping of an account to a CodexBar provider (and optional CodexBar account label). */
export interface QuotaSource { source: "codexbar"; provider: string; account?: string; enforce: boolean }

export type Runner = (args: string[], timeoutMs: number) => Promise<string>;

export const QUOTA_FRESH_MS = 5 * 60_000;
/**
 * Minimum gap between CodexBar runs for one account, across every Pi process on the machine. Shorter than the
 * five-minute refresh timer so a timer tick is never skipped by its own previous fetch; a failed run also waits.
 */
export const QUOTA_REFRESH_GATE_MS = 4 * 60_000;
export const QUOTA_TIMEOUT_MS = 15_000;
export const QUOTA_MAX_OUTPUT = 64 * 1024;
/** Backoff when a window is exhausted but its reset is unusable. */
const UNKNOWN_RESET_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const SLOTS = ["primary", "secondary", "tertiary"] as const;

export type ParseResult = { snapshot: QuotaSnapshot } | { error: string };

/** Parses `codexbar usage --format json` output for one provider. Any unrecognized shape is an error. */
export function parseCodexbar(raw: string, account: string, provider: string, now: number): ParseResult {
  let document: unknown;
  try { document = JSON.parse(raw); } catch { return { error: "tracker output is not JSON" }; }
  if (!Array.isArray(document)) return { error: "tracker output is not an array" };
  const entry = document.find((item): item is Record<string, unknown> => typeof item === "object" && item !== null && (item as { provider?: unknown }).provider === provider);
  if (!entry) return { error: `no tracker entry for provider ${provider}` };
  if (typeof entry.error === "object" && entry.error !== null) return { error: "tracker reported a provider error" };
  const usage = entry.usage as Record<string, unknown> | undefined;
  if (typeof usage !== "object" || usage === null) return { error: "tracker entry has no usage" };
  const observedAt = typeof usage.updatedAt === "string" ? Date.parse(usage.updatedAt) : NaN;
  if (!Number.isFinite(observedAt) || observedAt > now + CLOCK_SKEW_MS) return { error: "tracker observation time is missing or in the future" };
  const labels = (typeof entry.rateWindowLabels === "object" && entry.rateWindowLabels !== null ? entry.rateWindowLabels : {}) as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  for (const slot of SLOTS) {
    const window = usage[slot] as Record<string, unknown> | null | undefined;
    // CodexBar reports an unused optional slot as null (Codex has no tertiary window).
    if (window === undefined || window === null) continue;
    if (typeof window !== "object" || window === null) return { error: `window ${slot} is malformed` };
    const usedPercent = window.usedPercent;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return { error: `window ${slot} has an invalid usedPercent` };
    const resetsAt = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : NaN;
    const windowMinutes = typeof window.windowMinutes === "number" && Number.isFinite(window.windowMinutes) ? window.windowMinutes : undefined;
    windows.push({
      slot,
      label: typeof labels[slot] === "string" ? (labels[slot] as string) : slot,
      usedPercent,
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      ...(windowMinutes === undefined ? {} : { windowMinutes }),
    });
  }
  if (windows.length === 0) return { error: "tracker entry has no windows" };
  const sourceLabel = typeof entry.source === "string" ? entry.source : "unknown";
  // Fresh, structurally valid readings are trusted by default; explicitly estimated or local-derived data is not.
  // CLI (including Claude's PTY usage command) is a provider reading, not device-local usage history.
  const localDerived = /local|codexbar-app/i.test(sourceLabel);
  const authoritative = usage.dataConfidence !== "estimated" && !localDerived;
  return { snapshot: { provider, account, source: sourceLabel, authoritative, observedAt, windows } };
}

/** Exhaustion from a fresh snapshot: the blocking deadline, or undefined when every window has capacity. */
export function exhaustedUntil(snapshot: QuotaSnapshot, now: number): number | undefined {
  const exhausted = snapshot.windows.filter(w => w.usedPercent >= 100);
  if (exhausted.length === 0) return undefined;
  const resets = exhausted.map(w => w.resetsAt).filter((t): t is number => t !== undefined && t > now);
  return resets.length === exhausted.length ? Math.max(...resets) : now + UNKNOWN_RESET_MS;
}

export const isFresh = (snapshot: QuotaSnapshot, now: number) => now - snapshot.observedAt <= QUOTA_FRESH_MS;

/** Runs the CodexBar CLI with a deadline and an output cap. Missing binary or failure rejects. */
export const codexbarRunner: Runner = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile("codexbar", args, { timeout: timeoutMs, maxBuffer: QUOTA_MAX_OUTPUT }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

export type RefreshOutcome =
  | { status: "refreshed"; snapshot: QuotaSnapshot }
  | { status: "unavailable"; reason: string }
  | { status: "leased" }
  | { status: "cached"; observedAt: number };

/**
 * Refreshes one account's quota under a shared lease. The shared store is the single source: a last attempt
 * (success or failure) newer than the gate is reused, so concurrent processes run CodexBar at most once per gate
 * unless `force` is set. Enforced accounts get a tracker-sourced cause for exhausted windows; a fresh, complete
 * healthy snapshot clears only causes that were already present when this fetch started.
 */
/**
 * Scope key for quota state: a named account (`provider#account`), or a default-auth provider
 * whose single login is the whole account (`provider`). Causes, snapshots and leases use this key.
 */
export function quotaScopeKey(provider: string, account?: string): string {
  return account === undefined ? provider : `${provider}#${account}`;
}

export async function refreshQuota(
  store: HealthStore,
  scope: { provider: string; account?: string },
  source: QuotaSource,
  run: Runner,
  now: () => number,
  holder: string,
  options: { force?: boolean } = {},
): Promise<RefreshOutcome> {
  const key = quotaScopeKey(scope.provider, scope.account);
  const leaseKey = `quota:${key}`;
  if (!store.acquireLease(leaseKey, holder, QUOTA_TIMEOUT_MS + 5_000)) return { status: "leased" };
  try {
    // Re-read under the lease: another process may have just fetched, which is why the gate is checked here.
    const last = store.getSnapshot(key);
    if (!options.force && last && now() - last.observedAt < QUOTA_REFRESH_GATE_MS) return { status: "cached", observedAt: last.observedAt };
    const started = store.revision();
    const args = ["usage", "--provider", source.provider, "--format", "json"];
    // Named accounts are labelled in the generated CodexBar config (router id by default). Default-auth
    // and key-only providers take no label: CodexBar rejects --account for them.
    const label = source.account ?? scope.account;
    if (label !== undefined && !PROVIDER_KEY_ONLY.has(source.provider)) args.push("--account", label);
    let raw: string;
    try { raw = await run(args, QUOTA_TIMEOUT_MS); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      store.putSnapshot(key, now(), null, `tracker unavailable: ${reason}`);
      return { status: "unavailable", reason };
    }
    const parsed = parseCodexbar(raw, key, source.provider, now());
    if ("error" in parsed) {
      store.putSnapshot(key, now(), null, parsed.error);
      return { status: "unavailable", reason: parsed.error };
    }
    const snapshot = parsed.snapshot;
    store.putSnapshot(key, now(), snapshot, null);
    if (!isFresh(snapshot, now())) return { status: "refreshed", snapshot };
    const until = exhaustedUntil(snapshot, now());
    // Only an enforced, authoritative exhaustion may block; any other fresh reading clears tracker quota.
    const blockingUntil = source.enforce && snapshot.authoritative ? until : undefined;
    store.reconcileTrackerQuota(key, blockingUntil, started, `tracker reports exhausted quota for ${source.provider}`);
    return { status: "refreshed", snapshot };
  } finally {
    store.releaseLease(leaseKey, holder);
  }
}

/** Human time until a reset, e.g. `2h 14m`, `3d 4h`; `due` once passed. */
export function formatRemaining(resetsAt: number, now: number): string {
  const minutes = Math.floor((resetsAt - now) / 60_000);
  if (minutes <= 0) return "due";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Used percentage to two decimals, e.g. `57.12%`. Display only: blocking compares the raw value. */
export const formatUsed = (usedPercent: number) => `${usedPercent.toFixed(2)}%`;

/** Fixed-width fill bar for used capacity, e.g. `[██████░░░░]`. Values outside 0-100 are clamped. */
export function usageBar(usedPercent: number, width = 20): string {
  const filled = Math.round(Math.min(100, Math.max(0, usedPercent)) / 100 * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}
