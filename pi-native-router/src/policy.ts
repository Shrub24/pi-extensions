import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { RouteConfig, Candidate } from "./config";
import type { HealthStore } from "./health-store";
import type { CauseKind, ErrorCauseKind } from "./health-store";

export const identity = (model: { provider: string; id: string }, account?: string) => `${model.provider}/${model.id}${account ? `#${account}` : ""}`;
export const physicalOf = (key: string) => key.split("#")[0];
export const accountOf = (key: string) => key.split("#")[1];
export type FailureKind = "transient" | "rate" | "quota" | "auth" | "unsafe";
export interface Failure { kind: FailureKind; scope: "model" | "provider"; delayMs: number }
/** Quota and auth resets can be days away; transient and rate hints stay short. */
const HINT_CAP_MS = { quota: 8 * 24 * 3_600_000, auth: 8 * 24 * 3_600_000, transient: 900_000, rate: 900_000 } as const;
/** Replay safety: output already produced, or a tool call, makes migration unsafe. */
export function partialOutput(message: Pick<AssistantMessage, "content">): boolean {
  return message.content.some(c => c.type === "text" ? c.text.trim().length > 0 : c.type === "thinking" ? c.thinking.trim().length > 0 : true);
}
/**
 * Health observation, independent of replay safety. Provider evidence after partial output still
 * updates shared health; the caller must not replay that request.
 */
export function observe(message: Pick<AssistantMessage, "stopReason" | "content" | "errorMessage">, now = Date.now()): Failure {
  return classify({ ...message, content: [] }, now);
}
export function classify(message: Pick<AssistantMessage, "stopReason" | "content" | "errorMessage">, now = Date.now()): Failure {
  const unsafe: Failure = { kind: "unsafe", scope: "model", delayMs: 0 };
  if (message.stopReason !== "error" || partialOutput(message)) return unsafe;
  const text = message.errorMessage ?? "";
  if (/context.{0,20}(length|window|limit)|too many tokens|invalid.request|malformed|abort|cancel/i.test(text)) return unsafe;
  let fields: Record<string, unknown> = {};
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed; } catch {}
  const nativeStatus = text.match(/^(?:(\d{3})(?=:| status code\b)|[^\r\n]+ error \((\d{3})\):)/i);
  const status = fields.status ?? Number(nativeStatus?.[1] ?? nativeStatus?.[2]);
  let kind: FailureKind = "unsafe";
  // A 403 that names a model/entitlement is a model-access denial, not a dead key.
  const modelAccess = status === 403 && /model|entitle|not.{0,20}(allowed|available|access)/i.test(text) && !/invalid.api.key|unauthorized|authentication/i.test(text);
  if (/insufficient.quota|quota.{0,30}(exhaust|exceed)|credit.{0,20}(balance|exhaust)|billing|usage.?limit|available balance|out of budget/i.test(text)) kind = "quota";
  else if (modelAccess) kind = "auth";
  else if (status === 401 || status === 403 || /unauthorized|invalid.api.key|authentication|permission.denied/i.test(text)) kind = "auth";
  else if (status === 429 || /rate.limit|too many requests/i.test(text)) kind = "rate";
  else if ((typeof status === "number" && status >= 500 && status <= 599) || /\b50[0-9]\b|overloaded|server.error|service.unavailable|timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed/i.test(text)) kind = "transient";
  if (kind === "unsafe") return unsafe;
  const base = { transient: 30_000, rate: 60_000, quota: 300_000, auth: 300_000 }[kind];
  // resetAt must be epoch milliseconds; anything earlier than 2001 is an ambiguous unit and stays unknown.
  const resetAt = typeof fields.resetAt === "number" && fields.resetAt >= 1e12 ? fields.resetAt - now : undefined;
  const retryAfter = typeof fields.retryAfterSeconds === "number" ? fields.retryAfterSeconds * 1000 : undefined;
  const hint = retryAfter ?? resetAt ?? base;
  const scope = modelAccess ? "model" : kind === "quota" || kind === "auth" || fields.scope === "provider" ? "provider" : "model";
  return { kind, scope, delayMs: Number.isFinite(hint) ? Math.min(HINT_CAP_MS[kind as keyof typeof HINT_CAP_MS] ?? 900_000, Math.max(1000, hint)) : base };
}

/** Scope keys for a target: the account-wide or provider-wide key, and the model key. */
export function scopeKeys(model: { provider: string; id: string }, failure: Pick<Failure, "scope">, account?: string): string {
  return failure.scope === "provider" ? `${model.provider}${account ? `#${account}` : ""}` : identity(model, account);
}
export function admissionKeys(model: { provider: string; id: string }, account?: string): string[] {
  return [`${model.provider}${account ? `#${account}` : ""}`, identity(model, account)];
}

/**
 * Health used by routing. With a shared store it reads and writes that store; otherwise, or when the
 * store fails, it uses the process-local mirror and reports the degradation once per failure.
 */
/** The cause binding a target for diagnostics: its scope key, kind and deadline. */
export interface BlockedReason { key: string; kind: CauseKind; until: number }

export class Health {
  private local = new Map<string, { until: number; kind: ErrorCauseKind }>();
  constructor(
    private now: () => number = Date.now,
    private store?: HealthStore,
    private onDegrade: (error: unknown) => void = () => {},
  ) {}
  mark(model: { provider: string; id: string }, failure: Failure, account?: string) {
    if (failure.kind === "unsafe") return;
    const key = scopeKeys(model, failure, account);
    const until = this.now() + failure.delayMs;
    const current = this.local.get(key);
    if (!current || until >= current.until) this.local.set(key, { until, kind: failure.kind });
    const kind: ErrorCauseKind = failure.kind;
    this.attempt(() => this.store?.mark(key, kind, until, kind));
  }
  eligible(model: { provider: string; id: string }, account?: string) {
    const keys = admissionKeys(model, account);
    for (const key of keys) {
      const entry = this.local.get(key);
      if (entry !== undefined && entry.until > this.now()) return false;
    }
    if (!this.store) return true;
    return this.attempt(() => this.store!.blocked(keys) === undefined, true) ?? true;
  }
  /** The cause currently binding a target, for diagnostics. Reads local health first, then the shared store. */
  blockedReason(model: { provider: string; id: string }, account?: string): BlockedReason | undefined {
    const keys = admissionKeys(model, account);
    for (const key of keys) {
      const entry = this.local.get(key);
      if (entry !== undefined && entry.until > this.now()) return { key, kind: entry.kind, until: entry.until };
    }
    return this.attempt(() => this.store?.blocked(keys)) ?? undefined;
  }
  /** Runs a store operation, degrading to local health on failure instead of stalling dispatch. */
  attempt<T>(run: () => T): T | undefined;
  attempt<T>(run: () => T, fallback: T): T;
  attempt<T>(run: () => T, fallback?: T): T | undefined {
    try { return run(); } catch (error) { this.onDegrade(error); return fallback; }
  }
}
export interface CacheActivity { logical: string; physical: string; at: number; consumedAt?: number }
export interface State {
  version: 1;
  physical: string;
  floor: number;
  turn: string;
  retries: number;
  transitions: number;
  recoveries: number;
  next?: string;
  cacheActivity?: CacheActivity;
}
export function restore(raw: unknown): State | undefined {
  if (!raw || typeof raw !== "object") return;
  const s = raw as State;
  if (s.version !== 1 || typeof s.physical !== "string" || typeof s.turn !== "string" || (s.next !== undefined && typeof s.next !== "string")) return;
  if (![s.floor, s.retries, s.transitions, s.recoveries].every(n => Number.isSafeInteger(n) && n >= 0) || s.floor < 1) return;
  if (s.cacheActivity !== undefined) {
    const activity = s.cacheActivity;
    if (!activity || typeof activity.logical !== "string" || !activity.logical || typeof activity.physical !== "string" || !activity.physical || !Number.isSafeInteger(activity.at) || activity.at < 0 || (activity.consumedAt !== undefined && (!Number.isSafeInteger(activity.consumedAt) || activity.consumedAt < activity.at))) return;
  }
  return s;
}
export function cacheExpiry(activity: CacheActivity | undefined, logical: string, physical: string, ttl: number | undefined, now: number): boolean {
  return ttl !== undefined && activity?.logical === logical && activity.physical === physical && activity.consumedAt !== activity.at && now >= activity.at && now - activity.at >= ttl;
}
export interface Resolved { candidate: Candidate; model: Model<Api> }
export function choose(route: RouteConfig, available: Resolved[], health: Health, tokens: number, floor: number, preferred?: string, exclude?: string | ReadonlySet<string>): Resolved | undefined {
  const excluded = (id: string) => typeof exclude === "string" ? exclude === id : exclude?.has(id) ?? false;
  const usable = available.filter(({ model, candidate }) => !excluded(identity(model, candidate.account)) && health.eligible(model, candidate.account) && model.contextWindow >= Math.max(route.contextWindow, floor, tokens + Math.max(route.outputReserve, model.maxTokens)) && model.maxTokens >= route.outputReserve);
  return usable.find(c => identity(c.model, c.candidate.account) === preferred) ?? usable[0];
}

// Pi's thinking levels in increasing order, and the clamp Pi applies to a model's supported set (pi-ai).
export const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Levels a physical model supports, mirroring pi-ai's getSupportedThinkingLevels. */
export function supportedLevels(model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> }): string[] {
  if (!model.reasoning) return ["off"];
  return THINKING_ORDER.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}
/** Clamps a requested level to the nearest supported one, upward first, then downward (pi-ai's rule). */
export function clampLevel(model: Parameters<typeof supportedLevels>[0], level: string): string {
  const available = supportedLevels(model);
  if (available.includes(level)) return level;
  const index = THINKING_ORDER.indexOf(level as (typeof THINKING_ORDER)[number]);
  if (index === -1) return available[0] ?? "off";
  for (let i = index; i < THINKING_ORDER.length; i++) if (available.includes(THINKING_ORDER[i])) return THINKING_ORDER[i];
  for (let i = index - 1; i >= 0; i--) if (available.includes(THINKING_ORDER[i])) return THINKING_ORDER[i];
  return available[0] ?? "off";
}
