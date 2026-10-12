import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeySource } from "./config";

type RuntimeKeys = { setRuntimeApiKey(provider: string, apiKey: string): Promise<void> | void };

// Pi 1.1.0 keeps credential mutation on ModelRuntime; the facade reaches it only through a private field.
// Feature-detected, so a host without the operation fails closed before any named-account dispatch.
function runtimeKeys(ctx: ExtensionContext): (RuntimeKeys & object) | undefined {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
  return runtime && typeof (runtime as RuntimeKeys).setRuntimeApiKey === "function" ? (runtime as RuntimeKeys & object) : undefined;
}

/** Whether this Pi host exposes the runtime key operation that named or provider keys need. */
export function runtimeKeysAvailable(ctx: ExtensionContext): boolean {
  return runtimeKeys(ctx) !== undefined;
}

// One queue per Pi runtime: runtime key mutations run one at a time, each verified before the next starts.
const mutations = new WeakMap<object, Promise<unknown>>();

/**
 * Reads a key at use time, from its environment variable or its key file (e.g. a sops-nix secret path).
 * A missing, unreadable or empty source is unavailable, never a silent fallback.
 */
export function readKey(source: KeySource, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (source.apiKeyFile !== undefined) {
    try { return readFileSync(source.apiKeyFile, "utf8").trim() || undefined; }
    catch { return undefined; }
  }
  return env[source.apiKeyEnv] || undefined;
}

export async function keyActive(ctx: ExtensionContext, source: KeySource, provider: string): Promise<boolean> {
  const secret = readKey(source);
  return secret !== undefined && (await ctx.modelRegistry.getApiKeyForProvider(provider)) === secret;
}

/**
 * Makes the key the effective key for `provider` in this Pi runtime. Provider-global: the active key
 * serves every request in this runtime for the provider. Mutations are serialized per runtime, and an
 * activation is confirmed by reading the effective key back; any failure rejects before dispatch.
 */
export async function useKey(ctx: ExtensionContext, provider: string, source: KeySource): Promise<void> {
  const secret = readKey(source);
  if (secret === undefined) throw new Error(`Key for ${provider} is missing: its key file is missing or empty, or its environment variable is unset`);
  const keys = runtimeKeys(ctx);
  if (!keys) throw new Error(`Key for ${provider} requires Pi runtime key activation, which this Pi host does not expose`);
  const previous = mutations.get(keys) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    if (await keyActive(ctx, source, provider)) return;
    await keys.setRuntimeApiKey(provider, secret);
    if (!(await keyActive(ctx, source, provider))) throw new Error(`Key activation for ${provider} could not be verified`);
  });
  mutations.set(keys, run);
  await run;
}
