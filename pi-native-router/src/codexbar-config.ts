import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Account } from "./config";

/**
 * Generates CodexBar's config from router accounts so each key is defined once. Keys come from the
 * same environment references the router uses; the document contains secrets and is written 0600.
 */
export interface GeneratedConfig { document: Record<string, unknown>; included: string[]; skipped: Array<{ account: string; reason: string }> }

/** Stable token-account id derived from the router account id, so regeneration does not churn ids. */
export function stableUuid(seed: string): string {
  const bytes = createHash("sha256").update(`pi-native-router:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function generateCodexbarConfig(
  accounts: Record<string, Account>,
  readKey: (account: Account) => string | undefined,
  addedAt: number,
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
  const providers = [...byProvider.entries()].map(([provider, entries]) => ({
    id: provider,
    enabled: true,
    // Authoritative account meters: `auto` can return device-local estimates instead.
    source: "api",
    tokenAccounts: { version: 1, activeIndex: 0, accounts: entries },
  }));
  return { document: { version: 1, providers }, included, skipped };
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
