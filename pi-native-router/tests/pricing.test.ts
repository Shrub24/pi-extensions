import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, lookup, parseLiteLLM, parseModelsDev } from "../src/pricing/catalog";
import { loadSnapshot, refreshSnapshot, saveSnapshot } from "../src/pricing/cache";
import { parseConfig } from "../src/config";

// Shapes taken from models.dev /api.json and LiteLLM model_prices_and_context_window.json.
const modelsDev = {
  "opencode-go": { id: "opencode-go", models: {
    "mimo-v2.5": { cost: { input: 0.14, output: 0.28, cache_read: 0.0028 } },
    "claude-haiku-5-5": { cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 }, tiers: [{ input: 0.5 }] },
    "free-model": { cost: { input: 0, output: 0, cache_read: 0 } },
  } },
  anthropic: { id: "anthropic", models: { "claude-haiku-4-5": { cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } } } },
};
const litellm = {
  "claude-haiku-4-5": { litellm_provider: "anthropic", input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, cache_read_input_token_cost: 1e-7, cache_creation_input_token_cost: 1.25e-6 },
  "claude-haiku-4-5-experimental": { litellm_provider: "anthropic", input_cost_per_token: 2e-6, output_cost_per_token: 9e-6 },
  "gpt-4o": { litellm_provider: "openai", input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
  "no-prices": { litellm_provider: "openai" },
};

test("models.dev rates keep unknown components unknown and free models known as zero", () => {
  const records = parseModelsDev(modelsDev);
  const mimo = records.find(r => r.model === "mimo-v2.5")!;
  expect(mimo).toMatchObject({ provider: "opencode-go", input: 0.14, cacheRead: 0.0028, tiered: false });
  expect(mimo.cacheWrite).toBeUndefined();
  expect(records.find(r => r.model === "free-model")).toMatchObject({ input: 0, output: 0 });
  expect(records.find(r => r.model === "claude-haiku-5-5")?.tiered).toBe(true);
});

test("LiteLLM per-token prices convert to per-million USD and skip unpriced entries", () => {
  const records = parseLiteLLM(litellm);
  expect(records.find(r => r.model === "claude-haiku-4-5")).toMatchObject({ provider: "anthropic", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
  expect(records.find(r => r.model === "no-prices")).toBeUndefined();
});

test("models.dev is authoritative and LiteLLM only fills an exact missing physical model", () => {
  const snapshot = buildSnapshot(parseModelsDev(modelsDev), parseLiteLLM(litellm), 1000);
  expect(snapshot.records["anthropic/claude-haiku-4-5"].provenance).toBe("models.dev");
  expect(snapshot.records["anthropic/claude-haiku-4-5-experimental"].provenance).toBe("litellm");
  expect(snapshot.records["openai/gpt-4o"].provenance).toBe("litellm");
});

test("lookup is exact on provider and model, never by name similarity", () => {
  const snapshot = buildSnapshot(parseModelsDev(modelsDev), parseLiteLLM(litellm), 1000);
  expect(lookup(snapshot, "opencode-go", "claude-haiku-4-5").status).toBe("unpriced");
  expect(lookup(snapshot, "anthropic", "claude-haiku-4").status).toBe("unpriced");
  expect(lookup(undefined, "anthropic", "claude-haiku-4-5").status).toBe("unpriced");
});

test("complete, partial and tiered estimates report what is missing", () => {
  const snapshot = buildSnapshot(parseModelsDev(modelsDev), parseLiteLLM(litellm), 1000);
  expect(lookup(snapshot, "anthropic", "claude-haiku-4-5").status).toBe("complete");
  const mimo = lookup(snapshot, "opencode-go", "mimo-v2.5");
  expect(mimo).toMatchObject({ status: "partial", missing: ["cacheWrite"] });
  const tiered = lookup(snapshot, "opencode-go", "claude-haiku-5-5");
  expect(tiered).toMatchObject({ status: "partial", missing: ["tier"] });
});

test("an override fills only the components it names and keeps its provenance", () => {
  const snapshot = buildSnapshot(parseModelsDev(modelsDev), parseLiteLLM(litellm), 1000);
  const estimate = lookup(snapshot, "opencode-go", "mimo-v2.5", { "opencode-go/mimo-v2.5": { cacheWrite: 0.2 } });
  expect(estimate).toMatchObject({ status: "complete", record: { provenance: "override", cacheWrite: 0.2, input: 0.14 } });
});

test("the snapshot cache is private, atomic and tolerates corruption", () => {
  const root = mkdtempSync(join(tmpdir(), "native-router-pricing-"));
  try {
    const path = join(root, "nested", "pricing.json");
    expect(loadSnapshot(path)).toBeUndefined();
    const snapshot = buildSnapshot(parseModelsDev(modelsDev), [], 1234);
    saveSnapshot(path, snapshot);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadSnapshot(path)?.retrievedAt).toBe(1234);
    writeFileSync(path, "{not json");
    expect(loadSnapshot(path)).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("{not json");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failing source is reported and the other is kept; total failure yields no snapshot", async () => {
  const healthy = (async (url: string) => new Response(JSON.stringify(String(url).includes("models.dev") ? modelsDev : litellm), { status: 200 })) as typeof fetch;
  const partial = await refreshSnapshot(5, async (url: string | URL | Request) => {
    if (String(url).includes("litellm")) throw new Error("offline");
    return healthy(String(url));
  });
  expect(partial.snapshot?.records["anthropic/claude-haiku-4-5"]).toBeDefined();
  expect(partial.failures).toEqual(["litellm: offline"]);
  const none = await refreshSnapshot(5, async () => { throw new Error("offline"); });
  expect(none.snapshot).toBeUndefined();
  expect(none.failures).toHaveLength(2);
});

test("a redirect or error status is refused rather than followed", async () => {
  const result = await refreshSnapshot(5, async () => new Response("nope", { status: 503 }));
  expect(result.snapshot).toBeUndefined();
  expect(result.failures.join(" ")).toContain("503");
});

test("pricing overrides validate as exact provider/model keys with finite non-negative rates", () => {
  const base = { routes: { worker: { candidates: [{ provider: "a", id: "m" }] } } };
  expect(parseConfig({ ...base, pricing: { overrides: { "opencode-go/mimo-v2.5": { cacheWrite: 0.2 } } } }).pricingOverrides).toEqual({ "opencode-go/mimo-v2.5": { cacheWrite: 0.2 } });
  expect(() => parseConfig({ ...base, pricing: { overrides: { "no-slash": { input: 1 } } } })).toThrow(/provider\/model/);
  expect(() => parseConfig({ ...base, pricing: { overrides: { "a/m": { input: -1 } } } })).toThrow(/finite non-negative/);
});
