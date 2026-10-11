import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Account } from "./config";

type RuntimeKeys = { setRuntimeApiKey(provider: string, apiKey: string): Promise<void> | void };

// Pi 1.1.0 keeps credential mutation on ModelRuntime; the facade reaches it only through a private field.
// Feature-detected, so a host without the operation fails closed before any named-account dispatch.
function runtimeKeys(ctx: ExtensionContext): RuntimeKeys | undefined {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
  return runtime && typeof (runtime as RuntimeKeys).setRuntimeApiKey === "function" ? (runtime as RuntimeKeys) : undefined;
}

/**
 * Reads an account's key at use time, from its environment variable or its key file (e.g. a sops-nix
 * secret path). A missing, unreadable or empty source is unavailable, never a silent fallback.
 */
export function readAccountKey(account: Account, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (account.apiKeyFile !== undefined) {
    try { return readFileSync(account.apiKeyFile, "utf8").trim() || undefined; }
    catch { return undefined; }
  }
  return env[account.apiKeyEnv] || undefined;
}

export function accountSecret(account: Account): string | undefined {
  return readAccountKey(account);
}

export async function accountActive(ctx: ExtensionContext, account: Account, provider: string): Promise<boolean> {
  const secret = accountSecret(account);
  return secret !== undefined && (await ctx.modelRegistry.getApiKeyForProvider(provider)) === secret;
}

// Provider-global: the active key serves every request in this Pi runtime for the provider.
export async function useAccount(ctx: ExtensionContext, provider: string, account: Account): Promise<void> {
  const secret = accountSecret(account);
  if (secret === undefined) throw new Error(`Named account for ${provider} is missing its API-key environment variable`);
  if (await accountActive(ctx, account, provider)) return;
  const keys = runtimeKeys(ctx);
  if (!keys) throw new Error(`Named account for ${provider} requires Pi runtime key activation; this host does not expose it`);
  await keys.setRuntimeApiKey(provider, secret);
  if (!(await accountActive(ctx, account, provider))) throw new Error(`Named account activation for ${provider} could not be verified`);
}
