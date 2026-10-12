import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { KeySource, ProviderConfig } from "./config";
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

/**
 * Providers CodexBar takes as one provider-level `apiKey` rather than `tokenAccounts`
 * (`codexbar config validate` reports token accounts as unused for these).
 */
export const PROVIDER_KEY_ONLY = new Set(["commandcode"]);

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
 * (accounts get token accounts; a single key goes on the provider; default-auth providers get a login-backed entry).
 * Every other provider and top-level key in `existing` is kept exactly as it was.
 */
export function generateCodexbarConfig(
  providers: Record<string, ProviderConfig>,
  readKey: (source: KeySource) => string | undefined,
  addedAt: number,
  existing?: Document,
): GeneratedConfig {
  const byProvider = new Map<string, Array<{ accountId: string; entry: Record<string, unknown> }>>();
  const included: string[] = [];
  const skipped: GeneratedConfig["skipped"] = [];
  for (const [id, provider] of Object.entries(providers)) {
    for (const [accountId, account] of Object.entries(provider.accounts)) {
      if (account.quota === undefined) continue;
      const token = readKey(account);
      const source = account.apiKeyFile ?? account.apiKeyEnv;
      if (!token) { skipped.push({ account: accountId, reason: `${source} is not available` }); continue; }
      const label = account.quota.account ?? accountId;
      const entries = byProvider.get(account.quota.provider) ?? [];
      if (entries.some(member => member.entry.label === label)) { skipped.push({ account: accountId, reason: `duplicate CodexBar label ${label}` }); continue; }
      entries.push({ accountId, entry: { id: stableUuid(accountId), label, token, addedAt } });
      byProvider.set(account.quota.provider, entries);
    }
    // A single-key provider contributes its one key under its own quota mapping; it has no account label.
    if (provider.key !== undefined && provider.quota !== undefined) {
      const token = readKey(provider.key);
      if (!token) { skipped.push({ account: id, reason: `${provider.key.apiKeyFile ?? provider.key.apiKeyEnv} is not available` }); continue; }
      const entries = byProvider.get(provider.quota.provider) ?? [];
      entries.push({ accountId: id, entry: { id: stableUuid(`provider:${id}`), label: id, token, addedAt } });
      byProvider.set(provider.quota.provider, entries);
    }
  }

  const existingById = new Map((existing?.providers ?? []).map(entry => [entry.id, entry]));
  const owned = new Map<string, ProviderEntry>();
  for (const [provider, members] of byProvider) {
    const { tokenAccounts: _staleAccounts, apiKey: _staleKey, ...kept }: Partial<ProviderEntry> = existingById.get(provider) ?? {};
    if (PROVIDER_KEY_ONLY.has(provider)) {
      // CodexBar takes these as one provider-level key; token accounts are reported as unused.
      if (members.length !== 1) {
        for (const member of members) skipped.push({ account: member.accountId, reason: `${provider} takes one key; keep a single account for it` });
        continue;
      }
      const [only] = members;
      included.push(only.accountId);
      owned.set(provider, { ...kept, id: provider, enabled: true, source: "api", apiKey: only.entry.token });
      continue;
    }
    included.push(...members.map(member => member.accountId));
    // Authoritative account meters: `auto` can return device-local estimates instead.
    owned.set(provider, { ...kept, id: provider, enabled: true, source: "api", tokenAccounts: { version: 1, activeIndex: 0, accounts: members.map(member => member.entry) } });
  }
  for (const provider of Object.values(providers)) {
    // Default-auth: a quota-mapped provider with no key of its own uses Pi's login, which CodexBar reads.
    const quota = provider.quota;
    if (quota === undefined || provider.key !== undefined || owned.has(quota.provider)) continue;
    // Default-auth provider: CodexBar reads its own logged-in account. OAuth is the source verified
    // for these providers; an existing entry keeps whatever source the operator chose.
    const current = existingById.get(quota.provider);
    owned.set(quota.provider, { ...current, id: quota.provider, enabled: true, source: current?.source ?? "oauth" });
  }

  const kept = (existing?.providers ?? []).filter(entry => !owned.has(entry.id));
  const merged = [...kept, ...owned.values()];
  return { document: { ...existing, version: 1, providers: merged }, included, skipped };
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
