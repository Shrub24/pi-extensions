import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const PACKAGE_ID = "@vanillagreen/pi-native-router";
export interface Account { provider: string; apiKeyEnv: string }
export interface Candidate { provider: string; id: string; thinkingLevel: ModelThinkingLevel; cacheTtlMs?: number; account?: string }
export interface RouteConfig {
  candidates: Candidate[];
  contextWindow: number;
  outputReserve: number;
  stayRetries: number;
  maxTransitions: number;
  maxRecoveries: number;
}
export interface Config { routes: Record<string, RouteConfig>; accounts: Record<string, Account>; flushTimeoutMs: number }
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
export function parseConfig(raw: unknown): Config {
  const config = record(raw);
  keys(config, ["routes", "accounts", "flushTimeoutMs"]);
  const accounts: Record<string, Account> = {};
  for (const [id, value] of Object.entries(record(config.accounts ?? {}))) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) throw new Error(`Invalid account id: ${id}`);
    const account = record(value);
    keys(account, ["provider", "apiKeyEnv"]);
    if (typeof account.provider !== "string" || !account.provider || account.provider === "route" || typeof account.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(account.apiKeyEnv)) throw new Error(`Invalid account ${id}: provider and API-key environment variable are required`);
    accounts[id] = { provider: account.provider, apiKeyEnv: account.apiKeyEnv };
  }
  const routes: Record<string, RouteConfig> = {};
  for (const [role, value] of Object.entries(record(config.routes ?? {}))) {
    if (!/^[a-z][a-z0-9-]*$/.test(role)) throw new Error(`Invalid route role: ${role}`);
    const r = record(value);
    keys(r, ["candidates", "contextWindow", "outputReserve", "stayRetries", "maxTransitions", "maxRecoveries"]);
    if (!Array.isArray(r.candidates) || r.candidates.length === 0 || r.candidates.length > 32) throw new Error(`Route ${role} needs 1..32 candidates`);
    const candidates = r.candidates.map((value): Candidate => {
      const c = record(value);
      keys(c, ["provider", "id", "thinkingLevel", "cacheTtlMs", "account"]);
      if (typeof c.provider !== "string" || !c.provider || c.provider === "route" || c.provider.includes("#") || typeof c.id !== "string" || !c.id || c.id.includes("#")) throw new Error("Candidate needs physical provider and id");
      if (c.account !== undefined && (typeof c.account !== "string" || !accounts[c.account] || accounts[c.account].provider !== c.provider)) throw new Error(`Candidate account must reference a configured ${c.provider} account`);
      const thinkingLevel = c.thinkingLevel ?? "off";
      if (typeof thinkingLevel !== "string" || !levels.includes(thinkingLevel)) throw new Error("Invalid thinkingLevel");
      const cacheTtlMs = c.cacheTtlMs === undefined ? undefined : integer(c.cacheTtlMs, 0, 1, Number.MAX_SAFE_INTEGER);
      return { provider: c.provider, id: c.id, thinkingLevel: thinkingLevel as ModelThinkingLevel, ...(cacheTtlMs === undefined ? {} : { cacheTtlMs }), ...(typeof c.account === "string" ? { account: c.account } : {}) };
    });
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
  const namedProviders = new Set(Object.values(accounts).map(account => account.provider));
  for (const [role, route] of Object.entries(routes)) for (const candidate of route.candidates) {
    if (namedProviders.has(candidate.provider) && !candidate.account) throw new Error(`Route ${role} must name an account for ${candidate.provider}; runtime credentials are provider-global`);
  }
  return { routes, accounts, flushTimeoutMs: integer(config.flushTimeoutMs, 5000, 1, 60_000) };
}

// User-owned settings only: project config must not silently redirect paid requests.
export function readConfig(): Config {
  let text: string;
  try { text = readFileSync(join(getAgentDir(), "settings.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({}); throw error; }
  const settings = JSON.parse(text);
  return parseConfig(settings.kendex?.extensionManager?.config?.[PACKAGE_ID] ?? {});
}
