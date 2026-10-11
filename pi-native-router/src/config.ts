import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { QuotaSource } from "./quota";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const PACKAGE_ID = "@vanillagreen/pi-native-router";
/** Exactly one key source: an environment variable name or an absolute file path (e.g. a sops-nix secret). */
export type Account = { provider: string; quota?: QuotaSource } & ({ apiKeyEnv: string; apiKeyFile?: undefined } | { apiKeyFile: string; apiKeyEnv?: undefined });
export interface Candidate { provider: string; id: string; thinkingLevel: ModelThinkingLevel; cacheTtlMs?: number; account?: string }
export interface RouteConfig {
  candidates: Candidate[];
  contextWindow: number;
  outputReserve: number;
  stayRetries: number;
  maxTransitions: number;
  maxRecoveries: number;
}
export interface Config { routes: Record<string, RouteConfig>; accounts: Record<string, Account>; quotas: Record<string, QuotaSource>; flushTimeoutMs: number; sharedHealth: boolean; pricingOverrides: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }> }
const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Router config must be an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown router setting: ${key}`);
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Router integer must be ${min}..${max}`);
  return n;
}
/** Strict CodexBar quota mapping. Enforcement is opt-in until the source is verified as authoritative. */
function parseQuota(where: string, value: unknown): QuotaSource {
  const q = record(value);
  keys(q, ["source", "provider", "account", "enforce"]);
  if (q.source !== "codexbar") throw new Error(`Invalid ${where}: quota source must be codexbar`);
  if (typeof q.provider !== "string" || !q.provider) throw new Error(`Invalid ${where}: quota provider is required`);
  if (q.account !== undefined && (typeof q.account !== "string" || !q.account)) throw new Error(`Invalid ${where}: quota account must be a label`);
  if (q.enforce !== undefined && typeof q.enforce !== "boolean") throw new Error(`Invalid ${where}: quota enforce must be a boolean`);
  return { source: "codexbar", provider: q.provider, ...(q.account === undefined ? {} : { account: q.account }), enforce: q.enforce === true };
}

export function parseConfig(raw: unknown): Config {
  const config = record(raw);
  keys(config, ["routes", "accounts", "quotas", "flushTimeoutMs", "sharedHealth", "pricing"]);
  const pricingOverrides: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }> = {};
  for (const [id, value] of Object.entries(record(record(config.pricing ?? {}).overrides ?? {}))) {
    const parts = id.split("/");
    if (parts.length < 2 || !parts[0] || !parts.slice(1).join("/")) throw new Error(`Invalid pricing override key ${id}: use provider/model`);
    const o = record(value);
    keys(o, ["input", "output", "cacheRead", "cacheWrite"]);
    const rates: Record<string, number> = {};
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (o[field] === undefined) continue;
      if (typeof o[field] !== "number" || !Number.isFinite(o[field]) || (o[field] as number) < 0) throw new Error(`Pricing override ${id}.${field} must be a finite non-negative number`);
      rates[field] = o[field] as number;
    }
    pricingOverrides[id] = rates;
  }
  if (config.sharedHealth !== undefined && typeof config.sharedHealth !== "boolean") throw new Error("sharedHealth must be a boolean");
  const accounts: Record<string, Account> = {};
  for (const [id, value] of Object.entries(record(config.accounts ?? {}))) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) throw new Error(`Invalid account id: ${id}`);
    const account = record(value);
    keys(account, ["provider", "apiKeyEnv", "apiKeyFile", "quota"]);
    const hasEnv = account.apiKeyEnv !== undefined;
    const hasFile = account.apiKeyFile !== undefined;
    if (hasEnv === hasFile) throw new Error(`Invalid account ${id}: set exactly one of apiKeyEnv or apiKeyFile`);
    if (hasFile && (typeof account.apiKeyFile !== "string" || !account.apiKeyFile.startsWith("/"))) throw new Error(`Invalid account ${id}: apiKeyFile must be an absolute path`);
    if (typeof account.provider !== "string" || !account.provider || account.provider === "route") throw new Error(`Invalid account ${id}: a provider is required`);
    if (hasEnv && (typeof account.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(account.apiKeyEnv))) throw new Error(`Invalid account ${id}: apiKeyEnv must be an environment variable name, not a key`);
    const quota = account.quota === undefined ? undefined : parseQuota(`account ${id}`, account.quota);
    const source = hasFile ? { apiKeyFile: account.apiKeyFile as string } : { apiKeyEnv: account.apiKeyEnv as string };
    accounts[id] = { provider: account.provider, ...source, ...(quota ? { quota } : {}) };
  }
  // Provider-level quota for default-auth providers (Pi's own login), with no named accounts.
  const quotas: Record<string, QuotaSource> = {};
  for (const [provider, value] of Object.entries(record(config.quotas ?? {}))) {
    if (!provider || provider === "route") throw new Error(`Invalid quota provider: ${provider}`);
    if (Object.values(accounts).some(account => account.provider === provider)) throw new Error(`quotas.${provider} conflicts with named accounts for ${provider}; put the quota on those accounts`);
    quotas[provider] = parseQuota(`quotas.${provider}`, value);
  }
  const routes: Record<string, RouteConfig> = {};
  for (const [role, value] of Object.entries(record(config.routes ?? {}))) {
    if (!/^[a-z][a-z0-9-]*$/.test(role)) throw new Error(`Invalid route role: ${role}`);
    const r = record(value);
    keys(r, ["candidates", "contextWindow", "outputReserve", "stayRetries", "maxTransitions", "maxRecoveries"]);
    if (!Array.isArray(r.candidates) || r.candidates.length === 0 || r.candidates.length > 32) throw new Error(`Route ${role} needs 1..32 candidates`);
    // A candidate without an account on a provider with named accounts expands to one candidate per
    // account, in configured order. Each expansion keeps its own health, stickiness and cache epoch.
    const candidates = r.candidates.flatMap((value): Candidate[] => {
      const c = record(value);
      keys(c, ["provider", "id", "thinkingLevel", "cacheTtlMs", "account"]);
      if (typeof c.provider !== "string" || !c.provider || c.provider === "route" || c.provider.includes("#") || typeof c.id !== "string" || !c.id || c.id.includes("#")) throw new Error("Candidate needs physical provider and id");
      if (c.account !== undefined && (typeof c.account !== "string" || !accounts[c.account] || accounts[c.account].provider !== c.provider)) throw new Error(`Candidate account must reference a configured ${c.provider} account`);
      const thinkingLevel = c.thinkingLevel ?? "off";
      if (typeof thinkingLevel !== "string" || !levels.includes(thinkingLevel)) throw new Error("Invalid thinkingLevel");
      const cacheTtlMs = c.cacheTtlMs === undefined ? undefined : integer(c.cacheTtlMs, 0, 1, Number.MAX_SAFE_INTEGER);
      const base = { provider: c.provider, id: c.id, thinkingLevel: thinkingLevel as ModelThinkingLevel, ...(cacheTtlMs === undefined ? {} : { cacheTtlMs }) };
      if (typeof c.account === "string") return [{ ...base, account: c.account }];
      const pool = Object.entries(accounts).filter(([, account]) => account.provider === c.provider).map(([id]) => id);
      return pool.length === 0 ? [base] : pool.map(account => ({ ...base, account }));
    });
    if (candidates.length > 32) throw new Error(`Route ${role} expands to more than 32 candidates`);
    if (new Set(candidates.map(c => JSON.stringify([c.provider, c.id, c.account ?? null]))).size !== candidates.length) throw new Error(`Duplicate candidates in ${role}`);
    routes[role] = {
      candidates,
      contextWindow: integer(r.contextWindow, 200_000, 1, 10_000_000),
      outputReserve: integer(r.outputReserve, 8192, 1, 1_000_000),
      stayRetries: integer(r.stayRetries, 1, 0, 10),
      maxTransitions: integer(r.maxTransitions, 3, 0, 32),
      maxRecoveries: integer(r.maxRecoveries, 2, 0, 10),
    };
    if (routes[role].outputReserve >= routes[role].contextWindow) throw new Error("outputReserve must be below contextWindow");
  }
  return { routes, accounts, quotas, flushTimeoutMs: integer(config.flushTimeoutMs, 5000, 1, 60_000), sharedHealth: config.sharedHealth !== false, pricingOverrides };
}

// User-owned settings only: project config must not silently redirect paid requests.
export function readConfig(): Config {
  let text: string;
  try { text = readFileSync(join(getAgentDir(), "settings.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({}); throw error; }
  const settings = JSON.parse(text);
  return parseConfig(settings.kendex?.extensionManager?.config?.[PACKAGE_ID] ?? {});
}
