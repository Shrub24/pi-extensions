import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { buildSnapshot, MAX_CATALOG_BYTES, parseLiteLLM, parseModelsDev, type PriceSnapshot } from "./catalog";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const PRICING_TIMEOUT_MS = 20_000;

export function defaultPricingPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-native-router", "pricing.json");
}

/** Reads the last valid snapshot. A missing or corrupt file is not an error: pricing is simply unknown. */
export function loadSnapshot(path: string): PriceSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PriceSnapshot;
    return typeof parsed.retrievedAt === "number" && typeof parsed.records === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic private write; the previous snapshot survives any failure. */
export function saveSnapshot(path: string, snapshot: PriceSnapshot): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** The fetch surface pricing needs; injectable for tests. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchJson(url: string, fetcher: Fetcher): Promise<unknown> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(PRICING_TIMEOUT_MS), redirect: "error" });
  if (!response.ok) throw new Error(`${new URL(url).host} responded ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_CATALOG_BYTES) throw new Error(`${new URL(url).host} catalog exceeds ${MAX_CATALOG_BYTES} bytes`);
  const text = await response.text();
  if (text.length > MAX_CATALOG_BYTES) throw new Error(`${new URL(url).host} catalog exceeds ${MAX_CATALOG_BYTES} bytes`);
  return JSON.parse(text);
}

/**
 * Fetches both catalogs off the dispatch path. A source that fails is skipped with a reason;
 * if nothing usable arrives, the caller keeps the last valid snapshot.
 */
export async function refreshSnapshot(
  now: number,
  fetcher: Fetcher = (url, init) => fetch(url, init),
): Promise<{ snapshot?: PriceSnapshot; failures: string[] }> {
  const failures: string[] = [];
  let modelsDev: ReturnType<typeof parseModelsDev> = [];
  let litellm: ReturnType<typeof parseLiteLLM> = [];
  try { modelsDev = parseModelsDev(await fetchJson(MODELS_DEV_URL, fetcher)); }
  catch (error) { failures.push(`models.dev: ${error instanceof Error ? error.message : String(error)}`); }
  try { litellm = parseLiteLLM(await fetchJson(LITELLM_URL, fetcher)); }
  catch (error) { failures.push(`litellm: ${error instanceof Error ? error.message : String(error)}`); }
  if (modelsDev.length === 0 && litellm.length === 0) return { failures };
  return { snapshot: buildSnapshot(modelsDev, litellm, now), failures };
}
