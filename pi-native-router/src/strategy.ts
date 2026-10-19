import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { JsonValue, RouteStrategyConfig } from "./config";

export interface StrategyQuotaWindow {
  slot: string;
  label: string;
  /** Source-reported percentage used (0–100); it is not a headroom guarantee for another meter. */
  usedPercent: number;
  /** Reset time as epoch milliseconds. */
  resetsAt?: number;
  windowMinutes?: number;
}
export interface StrategyQuota {
  status: "fresh" | "stale" | "unavailable" | "unconfigured";
  source?: string;
  /** True only for the tracker's verified server-reported usage source. */
  authoritative?: boolean;
  /** Source observation time as epoch milliseconds. */
  observedAt?: number;
  error?: string;
  windows: StrategyQuotaWindow[];
}
export interface StrategyPrice {
  /** USD list-price rates per million tokens; absent components remain unknown, not zero. */
  status: "complete" | "partial" | "unpriced";
  /** Pi model metadata, models.dev, LiteLLM or local override; never a verified subscription charge. */
  provenance?: string;
  /** Catalog retrieval time in epoch milliseconds. */
  asOf?: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  missing?: string[];
  tiered?: boolean;
}
export interface StrategyTarget {
  targetId: string;
  provider: string;
  model: string;
  account?: string;
  configuredOrder: number;
  registered: boolean;
  eligible: boolean;
  rejectionReasons: string[];
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevel: string;
  effectiveThinkingLevel?: string;
  quota: StrategyQuota;
  pricing: StrategyPrice;
  peak: { active: boolean; multiplier: number; costTreatment: "router-applies" | "provider-recorded" | "none" };
  cache: { status: "known" | "unknown"; lastSuccessfulAt?: number; estimatedExpiresAt?: number; source?: string };
  /** Cache-rebuild cost is not inferred from cache age alone; only same-target selection is known to avoid a switch. */
  switchingCost: { status: "same-target" | "unknown"; reason?: string };
}
export type DeepReadonly<T> = T extends null | string | number | boolean ? T
  : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type RoutingContext = DeepReadonly<{
  version: 1;
  now: number;
  mode: "preview" | "dispatch";
  reason: "initial" | "continuation" | "direct" | "failover" | "admission-retry";
  options: Record<string, JsonValue>;
  route: { role: string; contextWindow: number; outputReserve: number; stayRetries: number; maxTransitions: number; maxRecoveries: number; configuredOrder: string[] };
  targets: StrategyTarget[];
  eligibleTargetIds: string[];
  currentTargetId?: string;
  pinnedTargetId?: string;
  recoveryTargetId?: string;
  excludedTargetIds: string[];
  failure?: { kind: string; failedTargetId?: string };
  budgets: { retriesRemaining: number; transitionsRemaining: number; recoveriesRemaining: number };
  request: { contextTokens: number; estimateSource: "pi-usage" | "message-heuristic"; outputReserve: number; thinkingLevel?: string };
}>;
export interface RoutingChoice { targetId: string; reason: string }
export interface RoutingStrategy { readonly version: 1; choose(context: RoutingContext): RoutingChoice }
export interface LoadedStrategy { id: string; choose(context: RoutingContext): RoutingChoice }

const loaded = new Map<string, Promise<LoadedStrategy>>();

/** Loads trusted local TypeScript through the host's native module loader, once per canonical path per Pi process. */
export async function loadStrategy(config: RouteStrategyConfig): Promise<LoadedStrategy> {
  const filename = await realpath(config.module);
  let promise = loaded.get(filename);
  if (!promise) {
    promise = (async () => {
      const namespace = await import(pathToFileURL(filename).href) as { default?: unknown };
      const value = namespace.default as Partial<RoutingStrategy> | undefined;
      if (!value || value.version !== 1 || typeof value.choose !== "function") throw new Error("unsupported strategy module contract");
      return { id: filename, choose: value.choose.bind(value) };
    })();
    loaded.set(filename, promise);
  }
  return promise;
}

export function immutableSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}

export function evaluateStrategy(
  strategy: LoadedStrategy | undefined,
  context: RoutingContext,
  fallback: () => string | undefined,
): { targetId?: string; strategyId: string; reason: string; fallback?: string } {
  if (context.eligibleTargetIds.length === 0) return { targetId: fallback(), strategyId: "ordered", reason: "no eligible targets" };
  if (!strategy) return { targetId: fallback(), strategyId: "ordered", reason: "configured order or current target" };
  try {
    const result: unknown = strategy.choose(immutableSnapshot(context));
    if (result && typeof result === "object" && "then" in result && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => {});
      throw new Error("async strategies are unsupported");
    }
    if (!result || typeof result !== "object") throw new Error("invalid result");
    const choice = result as Partial<RoutingChoice>;
    if (typeof choice.targetId !== "string" || !context.eligibleTargetIds.includes(choice.targetId)) throw new Error("ineligible target");
    if (typeof choice.reason !== "string" || !choice.reason.trim()) throw new Error("missing reason");
    const reason = choice.reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!reason || reason.length > 512) throw new Error("invalid reason");
    return { targetId: choice.targetId, strategyId: strategy.id, reason };
  } catch {
    return { targetId: fallback(), strategyId: strategy.id, reason: "ordered compatibility fallback", fallback: "strategy execution or result validation failed" };
  }
}
