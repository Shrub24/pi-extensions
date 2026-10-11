import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Account } from "./config";
import type { QuotaSource } from "./quota";

/**
 * Generates CodexBar's config from router accounts so each key is defined once. Keys come from the
 * same environment references the router uses; the document contains secrets and is written 0600.
 */
export interface GeneratedConfig {
  document: Record<string, unknown>;
  included: string[];
  skipped: Array<{ account: string; reason: string }>;
}

type ProviderEntry = Record<string, unknown> & { id: string };
type Document = Record<string, unknown> & { providers?: ProviderEntry[] };

/** Stable token-account id derived from the router account id, so regeneration does not churn ids. */
export function stableUuid(seed: string): string {
  const bytes = createHash("sha256").update(`pi-native-router:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Merges router quota scopes into CodexBar's document. Providers the router owns are replaced
 * (named accounts get token accounts; default-auth providers get a login-backed entry with no tokens).
 * Every other provider and top-level key in `existing` is kept exactly as it was.
 */
export function generateCodexbarConfig(
  accounts: Record<string, Account>,
  quotas: Record<string, QuotaSource>,
  readKey: (account: Account) => string | undefined,
  addedAt: number,
  existing?: Document,
): GeneratedConfig {
  const byProvider = new Map<string, Array<Record<string, unknown>>>();
  const included: string[] = [];
  const skipped: GeneratedConfig["skipped"] = [];
  for (const [id, account] of Object.entries(accounts)) {
    if (account.quota === undefined) continue;
    const token = readKey(account);
    const source = account.apiKeyFile !== undefined ? account.apiKeyFile : account.apiKeyEnv;
    if (!token) { skipped.push({ account: id, reason: `${source} is not available` }); continue; }
    const label = account.quota.account ?? id;
    const entries = byProvider.get(account.quota.provider) ?? [];
    if (entries.some(entry => entry.label === label)) { skipped.push({ account: id, reason: `duplicate CodexBar label ${label}` }); continue; }
    entries.push({ id: stableUuid(id), label, token, addedAt });
    byProvider.set(account.quota.provider, entries);
    included.push(id);
  }

  const existingById = new Map((existing?.providers ?? []).map(entry => [entry.id, entry]));
  const owned = new Map<string, ProviderEntry>();
  for (const [provider, entries] of byProvider) {
    // Authoritative account meters: `auto` can return device-local estimates instead.
    owned.set(provider, { ...existingById.get(provider), id: provider, enabled: true, source: "api", tokenAccounts: { version: 1, activeIndex: 0, accounts: entries } });
  }
  for (const quota of Object.values(quotas)) {
    if (owned.has(quota.provider)) continue;
    // Default-auth provider: CodexBar reads its own logged-in account. OAuth is the source verified
    // for these providers; an existing entry keeps whatever source the operator chose.
    const current = existingById.get(quota.provider);
    owned.set(quota.provider, { ...current, id: quota.provider, enabled: true, source: current?.source ?? "oauth" });
  }

  const kept = (existing?.providers ?? []).filter(entry => !owned.has(entry.id));
  const providers = [...kept, ...owned.values()];
  return { document: { ...existing, version: 1, providers }, included, skipped };
}

/** Reads an existing CodexBar document. Throws when the file exists but is not a parseable document. */
export function readCodexbarConfig(path: string): Document | undefined {
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} is not a CodexBar config object; refusing to overwrite it`);
  return parsed as Document;
}

/** Default CodexBar config location, honouring the same overrides CodexBar reads. */
export function codexbarConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEXBAR_CONFIG) return env.CODEXBAR_CONFIG;
  if (env.XDG_CONFIG_HOME?.startsWith("/")) return join(env.XDG_CONFIG_HOME, "codexbar", "config.json");
  return join(homedir(), ".config", "codexbar", "config.json");
}

/** Writes via a private temporary file and rename. Refuses to replace an existing file unless asked. */
export function writeCodexbarConfig(path: string, document: Record<string, unknown>, replace: boolean): void {
  if (existsSync(path) && !replace) throw new Error(`${path} exists; rerun with --replace to overwrite it`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
