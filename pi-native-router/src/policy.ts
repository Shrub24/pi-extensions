import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { RouteConfig, Candidate } from "./config";

export const identity = (model: { provider: string; id: string }, account?: string) => `${model.provider}/${model.id}${account ? `#${account}` : ""}`;
export const physicalOf = (key: string) => key.split("#")[0];
export const accountOf = (key: string) => key.split("#")[1];
export type FailureKind = "transient" | "rate" | "quota" | "auth" | "unsafe";
export interface Failure { kind: FailureKind; scope: "model" | "provider"; delayMs: number }
export function classify(message: Pick<AssistantMessage, "stopReason" | "content" | "errorMessage">, now = Date.now()): Failure {
  const unsafe: Failure = { kind: "unsafe", scope: "model", delayMs: 0 };
  if (message.stopReason !== "error" || message.content.some(c => c.type === "text" ? c.text.trim().length > 0 : c.type === "thinking" ? c.thinking.trim().length > 0 : true)) return unsafe;
  const text = message.errorMessage ?? "";
  if (/context.{0,20}(length|window|limit)|too many tokens|invalid.request|malformed|abort|cancel/i.test(text)) return unsafe;
  let fields: Record<string, unknown> = {};
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed; } catch {}
  const nativeStatus = text.match(/^(?:(\d{3})(?=:| status code\b)|[^\r\n]+ error \((\d{3})\):)/i);
  const status = fields.status ?? Number(nativeStatus?.[1] ?? nativeStatus?.[2]);
  let kind: FailureKind = "unsafe";
  if (/insufficient.quota|quota.{0,30}(exhaust|exceed)|credit.{0,20}(balance|exhaust)|billing|usage.?limit|available balance|out of budget/i.test(text)) kind = "quota";
  else if (status === 401 || status === 403 || /unauthorized|invalid.api.key|authentication|permission.denied/i.test(text)) kind = "auth";
  else if (status === 429 || /rate.limit|too many requests/i.test(text)) kind = "rate";
  else if ((typeof status === "number" && status >= 500 && status <= 599) || /\b50[0-9]\b|overloaded|server.error|service.unavailable|timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed/i.test(text)) kind = "transient";
  if (kind === "unsafe") return unsafe;
  const base = { transient: 30_000, rate: 60_000, quota: 300_000, auth: 300_000 }[kind];
  const hint = typeof fields.retryAfterSeconds === "number" ? fields.retryAfterSeconds * 1000 : typeof fields.resetAt === "number" ? fields.resetAt - now : base;
  return { kind, scope: kind === "quota" || kind === "auth" || fields.scope === "provider" ? "provider" : "model", delayMs: Number.isFinite(hint) ? Math.min(900_000, Math.max(1000, hint)) : base };
}

export class Health {
  private until = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  mark(model: { provider: string; id: string }, failure: Failure, account?: string) {
    if (failure.kind === "unsafe") return;
    const key = failure.scope === "provider" ? `${model.provider}${account ? `#${account}` : ""}` : identity(model, account);
    this.until.set(key, Math.max(this.until.get(key) ?? 0, this.now() + failure.delayMs));
  }
  eligible(model: { provider: string; id: string }, account?: string) {
    for (const key of [`${model.provider}${account ? `#${account}` : ""}`, identity(model, account)]) {
      const until = this.until.get(key);
      if (until !== undefined && until > this.now()) return false;
      if (until !== undefined) this.until.delete(key);
    }
    return true;
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
export function choose(route: RouteConfig, available: Resolved[], health: Health, tokens: number, floor: number, preferred?: string, exclude?: string): Resolved | undefined {
  const usable = available.filter(({ model, candidate }) => identity(model, candidate.account) !== exclude && health.eligible(model, candidate.account) && model.contextWindow >= Math.max(route.contextWindow, floor, tokens + Math.max(route.outputReserve, model.maxTokens)) && model.maxTokens >= route.outputReserve);
  return usable.find(c => identity(c.model, c.candidate.account) === preferred) ?? usable[0];
}
