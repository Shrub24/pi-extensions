import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { QuotaSource } from "./quota";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const PACKAGE_ID = "@vanillagreen/pi-native-router";
/** Exactly one key source: an environment variable name or an absolute file path (e.g. a sops-nix secret). */
export type KeySource = { apiKeyEnv: string; apiKeyFile?: undefined } | { apiKeyFile: string; apiKeyEnv?: undefined };
/** One key of a multi-account provider. Its id is what routes, the footer and telemetry show. */
export type Account = KeySource & { quota?: QuotaSource };
/**
 * Everything the router knows about one provider. Shared settings sit on the provider: a single key or quota
 * when it has no accounts. `accounts` holds several keys, each with its own quota.
 */
export interface ProviderConfig {
  name?: string;
  key?: KeySource;
  quota?: QuotaSource;
  accounts: Record<string, Account>;
}
export interface Candidate { provider: string; id: string; thinkingLevel: ModelThinkingLevel; cacheTtlMs?: number; account?: string }
export interface RouteConfig {
  candidates: Candidate[];
  contextWindow: number;
  outputReserve: number;
  stayRetries: number;
  maxTransitions: number;
  maxRecoveries: number;
}
/** Footer label for each provider. Model labels come from Pi's own model name, not from config. */
export interface Display { providers: Record<string, string> }
/** Pi leaves ctrl+shift+m unbound; ctrl+shift+p is app.model.cycleBackward. */
export const DEFAULT_CYCLE_PIN = "ctrl+shift+m";
export interface Config {
  shortcuts: { cyclePin: string };
  display: Display;
  providers: Record<string, ProviderConfig>;
  routes: Record<string, RouteConfig>;
  flushTimeoutMs: number;
  sharedHealth: boolean;
  pricingOverrides: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
}
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
function nonEmpty(label: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}
/** Parses exactly one key source from `value`; `label` names the setting in errors. */
function parseKeySource(label: string, value: Record<string, unknown>): KeySource {
  const hasEnv = value.apiKeyEnv !== undefined;
  const hasFile = value.apiKeyFile !== undefined;
  if (hasEnv === hasFile) throw new Error(`Invalid ${label}: set exactly one of apiKeyEnv or apiKeyFile`);
  if (hasFile && (typeof value.apiKeyFile !== "string" || !value.apiKeyFile.startsWith("/"))) throw new Error(`Invalid ${label}: apiKeyFile must be an absolute path`);
  if (hasEnv && (typeof value.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv))) throw new Error(`Invalid ${label}: apiKeyEnv must be an environment variable name, not a key`);
  return hasFile ? { apiKeyFile: value.apiKeyFile as string } : { apiKeyEnv: value.apiKeyEnv as string };
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

function parseProviders(value: unknown): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};
  const accountOwners = new Map<string, string>();
  for (const [id, raw] of Object.entries(record(value ?? {}))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === "route") throw new Error(`Invalid provider id: ${id}`);
    const p = record(raw);
    keys(p, ["name", "apiKeyEnv", "apiKeyFile", "quota", "accounts"]);
    const name = p.name === undefined ? undefined : nonEmpty(`providers.${id}.name`, p.name);
    const hasKey = p.apiKeyEnv !== undefined || p.apiKeyFile !== undefined;
    if (hasKey && p.accounts !== undefined) throw new Error(`providers.${id}: set a single key or accounts, not both`);
    const accounts: Record<string, Account> = {};
    for (const [accountId, accountRaw] of Object.entries(record(p.accounts ?? {}))) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(accountId)) throw new Error(`Invalid account id: ${accountId}`);
      const owner = accountOwners.get(accountId);
      if (owner !== undefined) throw new Error(`Account id ${accountId} is used by providers ${owner} and ${id}; account ids must be unique`);
      accountOwners.set(accountId, id);
      const account = record(accountRaw);
      keys(account, ["apiKeyEnv", "apiKeyFile", "quota"]);
      accounts[accountId] = { ...parseKeySource(`account ${accountId}`, account), ...(account.quota === undefined ? {} : { quota: parseQuota(`account ${accountId}`, account.quota) }) };
    }
    if (p.accounts !== undefined && Object.keys(accounts).length === 0) throw new Error(`providers.${id}.accounts must not be empty`);
    const quota = p.quota === undefined ? undefined : parseQuota(`providers.${id}`, p.quota);
    if (quota && Object.keys(accounts).length > 0) throw new Error(`providers.${id}: put quota on each account when accounts are set`);
    providers[id] = {
      ...(name === undefined ? {} : { name }),
      ...(hasKey ? { key: parseKeySource(`providers.${id}`, p) } : {}),
      ...(quota === undefined ? {} : { quota }),
      accounts,
    };
  }
  return providers;
}

function displayOf(providers: Record<string, ProviderConfig>): Display {
  const display: Display = { providers: {} };
  for (const [id, provider] of Object.entries(providers)) if (provider.name !== undefined) display.providers[id] = provider.name;
  return display;
}

export function parseConfig(raw: unknown): Config {
  const config = record(raw);
  keys(config, ["providers", "routes", "flushTimeoutMs", "sharedHealth", "pricing", "shortcuts"]);
  const shortcutsRaw = record(config.shortcuts ?? {});
  keys(shortcutsRaw, ["cyclePin"]);
  const cyclePin = shortcutsRaw.cyclePin ?? DEFAULT_CYCLE_PIN;
  if (typeof cyclePin !== "string" || !cyclePin.trim()) throw new Error("shortcuts.cyclePin must be a non-empty key id");
  const providers = parseProviders(config.providers);
  const pricingOverrides: Config["pricingOverrides"] = {};
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
  const routes: Record<string, RouteConfig> = {};
  for (const [role, value] of Object.entries(record(config.routes ?? {}))) {
    if (!/^[a-z][a-z0-9-]*$/.test(role)) throw new Error(`Invalid route role: ${role}`);
    const r = record(value);
    keys(r, ["candidates", "contextWindow", "outputReserve", "stayRetries", "maxTransitions", "maxRecoveries"]);
    if (!Array.isArray(r.candidates) || r.candidates.length === 0 || r.candidates.length > 32) throw new Error(`Route ${role} needs 1..32 candidates`);
    // A candidate without an account on a provider with accounts expands to one candidate per account, in
    // configured order. Each expansion keeps its own health, stickiness and cache epoch.
    const candidates = r.candidates.flatMap((value): Candidate[] => {
      const c = record(value);
      keys(c, ["provider", "id", "thinkingLevel", "cacheTtlMs", "account"]);
      if (typeof c.provider !== "string" || !c.provider || c.provider === "route" || c.provider.includes("#") || typeof c.id !== "string" || !c.id || c.id.includes("#")) throw new Error("Candidate needs physical provider and id");
      const accounts = providers[c.provider]?.accounts ?? {};
      if (c.account !== undefined && (typeof c.account !== "string" || !accounts[c.account])) throw new Error(`Candidate account must reference an account of provider ${c.provider}`);
      const thinkingLevel = c.thinkingLevel ?? "off";
      if (typeof thinkingLevel !== "string" || !levels.includes(thinkingLevel)) throw new Error("Invalid thinkingLevel");
      const cacheTtlMs = c.cacheTtlMs === undefined ? undefined : integer(c.cacheTtlMs, 0, 1, Number.MAX_SAFE_INTEGER);
      const base = { provider: c.provider, id: c.id, thinkingLevel: thinkingLevel as ModelThinkingLevel, ...(cacheTtlMs === undefined ? {} : { cacheTtlMs }) };
      if (typeof c.account === "string") return [{ ...base, account: c.account }];
      const pool = Object.keys(accounts);
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
  return {
    providers,
    display: displayOf(providers),
    routes,
    flushTimeoutMs: integer(config.flushTimeoutMs, 5000, 1, 60_000),
    sharedHealth: config.sharedHealth !== false,
    pricingOverrides,
    shortcuts: { cyclePin: cyclePin.trim() },
  };
}

// User-owned settings only: project config must not silently redirect paid requests.
export function readConfig(): Config {
  let text: string;
  try { text = readFileSync(join(getAgentDir(), "settings.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({}); throw error; }
  const settings = JSON.parse(text);
  return parseConfig(settings.kendex?.extensionManager?.config?.[PACKAGE_ID] ?? {});
}
