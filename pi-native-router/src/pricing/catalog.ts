/**
 * Catalog pricing for physical models. Values are list-price estimates in USD per million tokens,
 * never provider-billed amounts. Unknown components stay unknown; they are never coerced to zero.
 */
export type Provenance = "models.dev" | "litellm" | "override";

export interface PriceRecord {
  provider: string;
  model: string;
  provenance: Provenance;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Context-tiered pricing exists; base rates alone are not a complete estimate for long contexts. */
  tiered: boolean;
}

export interface PriceSnapshot {
  retrievedAt: number;
  sources: Provenance[];
  records: Record<string, PriceRecord>;
}

export const MAX_CATALOG_BYTES = 12 * 1024 * 1024;
const MAX_RECORDS = 20_000;

const key = (provider: string, model: string) => `${provider}/${model}`;
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** models.dev: { <provider>: { models: { <id>: { cost: { input, output, cache_read?, cache_write? }, tiers? } } } } */
export function parseModelsDev(document: unknown): PriceRecord[] {
  const out: PriceRecord[] = [];
  if (typeof document !== "object" || document === null) throw new Error("models.dev catalog is not an object");
  for (const [provider, value] of Object.entries(document as Record<string, unknown>)) {
    const models = (value as { models?: unknown } | null)?.models;
    if (typeof models !== "object" || models === null) continue;
    for (const [model, body] of Object.entries(models as Record<string, unknown>)) {
      const cost = (body as { cost?: Record<string, unknown> } | null)?.cost;
      if (typeof cost !== "object" || cost === null) continue;
      const tiers = (body as { tiers?: unknown; context_over_200k?: unknown }).tiers;
      out.push({
        provider,
        model,
        provenance: "models.dev",
        input: finite(cost.input),
        output: finite(cost.output),
        cacheRead: finite(cost.cache_read),
        cacheWrite: finite(cost.cache_write),
        tiered: Array.isArray(tiers) && tiers.length > 0,
      });
    }
  }
  return out;
}

/** LiteLLM: { <model>: { litellm_provider, input_cost_per_token, output_cost_per_token, ... } } (per token) */
export function parseLiteLLM(document: unknown): PriceRecord[] {
  const out: PriceRecord[] = [];
  if (typeof document !== "object" || document === null) throw new Error("LiteLLM catalog is not an object");
  const perMillion = (value: unknown) => {
    const n = finite(value);
    return n === undefined ? undefined : Math.round(n * 1e6 * 1e9) / 1e9;
  };
  for (const [model, body] of Object.entries(document as Record<string, unknown>)) {
    if (typeof body !== "object" || body === null) continue;
    const entry = body as Record<string, unknown>;
    if (typeof entry.litellm_provider !== "string") continue;
    if (entry.input_cost_per_token === undefined && entry.output_cost_per_token === undefined) continue;
    out.push({
      provider: entry.litellm_provider,
      model,
      provenance: "litellm",
      input: perMillion(entry.input_cost_per_token),
      output: perMillion(entry.output_cost_per_token),
      cacheRead: perMillion(entry.cache_read_input_token_cost),
      cacheWrite: perMillion(entry.cache_creation_input_token_cost),
      tiered: false,
    });
  }
  return out;
}

/**
 * Builds a snapshot. models.dev is authoritative; a LiteLLM record fills a physical model only when
 * its provider and model id match exactly and models.dev has no record for it.
 */
export function buildSnapshot(modelsDev: PriceRecord[], litellm: PriceRecord[], retrievedAt: number): PriceSnapshot {
  const records: Record<string, PriceRecord> = {};
  for (const record of modelsDev) records[key(record.provider, record.model)] = record;
  for (const record of litellm) {
    const id = key(record.provider, record.model);
    if (!records[id]) records[id] = record;
  }
  const entries = Object.keys(records);
  if (entries.length > MAX_RECORDS) throw new Error(`pricing catalog exceeds ${MAX_RECORDS} records`);
  return { retrievedAt, sources: ["models.dev", "litellm"], records };
}

export type Estimate =
  | { status: "complete"; record: PriceRecord }
  | { status: "partial"; record: PriceRecord; missing: string[] }
  | { status: "unpriced" };

/** Lookup is exact on provider and model; no name similarity. */
export function lookup(snapshot: PriceSnapshot | undefined, provider: string, model: string, overrides: Record<string, Partial<PriceRecord>> = {}): Estimate {
  const id = key(provider, model);
  const override = overrides[id];
  const base = snapshot?.records[id];
  const record: PriceRecord | undefined = override
    ? {
        provider,
        model,
        provenance: "override",
        tiered: base?.tiered ?? false,
        input: override.input ?? base?.input,
        output: override.output ?? base?.output,
        cacheRead: override.cacheRead ?? base?.cacheRead,
        cacheWrite: override.cacheWrite ?? base?.cacheWrite,
      }
    : base;
  if (!record) return { status: "unpriced" };
  const missing = (["input", "output", "cacheRead", "cacheWrite"] as const).filter(field => record[field] === undefined);
  if (missing.length > 0 || record.tiered) return { status: "partial", record, missing: record.tiered ? [...missing, "tier"] : missing };
  return { status: "complete", record };
}
