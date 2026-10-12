import { expect, test } from "bun:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config";
import { cacheExpiry, choose, classify, Health, observe, partialOutput, restore } from "../src/policy";
import { nativeHttpError } from "./native-error";

const error = (errorMessage: string, content: AssistantMessage["content"] = []) => ({ stopReason: "error" as const, errorMessage, content });
const config = parseConfig({ routes: { work: { candidates: [{ provider: "a", id: "one" }, { provider: "a", id: "two" }, { provider: "b", id: "one" }] } } }).routes.work;
const models = config.candidates.map(candidate => ({ candidate, model: { ...candidate, name: candidate.id, baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 300_000, maxTokens: 16_384, api: "openai-completions" } as Model<Api> }));

test("configuration is opt-in and invalid paid-route definitions fail rather than silently defaulting", () => {
  expect(parseConfig({}).routes).toEqual({});
  for (const raw of [
    { routes: { work: { candidates: [] } } },
    { routes: { work: { candidates: [{ provider: "route", id: "nested" }] } } },
    { routes: { work: { candidates: [{ provider: "a", id: "one", thinkingLevel: "unbounded" }] } } },
    { routes: { work: { candidates: [{ provider: "a", id: "one" }, { provider: "a", id: "one" }] } } },
    { flushTimeoutMs: -1 }, { unknownSetting: true },
    { routes: { work: { candidates: [{ provider: "a", id: "one", cacheTtlMs: 0 }] } } },
    { routes: { work: { candidates: [{ provider: "a", id: "one", cacheTtlMs: 1.5 }] } } },
  ]) expect(() => parseConfig(raw)).toThrow();
});

test("classification distinguishes account failures, rate limits, model transport errors and unsafe errors", () => {
  expect(classify(error("insufficient_quota"))).toMatchObject({ kind: "quota", scope: "provider" });
  expect(classify(error("401 unauthorized"))).toMatchObject({ kind: "auth", scope: "provider" });
  expect(classify(error("rate limit exceeded"))).toMatchObject({ kind: "rate", scope: "model" });
  expect(classify(error("503 overloaded"))).toMatchObject({ kind: "transient", scope: "model" });
  for (const text of ["context window exceeded", "invalid request", "extension failed", "cancelled"])
    expect(classify(error(text)).kind).toBe("unsafe");
  expect(classify(error("insufficient_quota", [{ type: "text", text: "partial" }])).kind).toBe("unsafe");
  expect(classify(error("insufficient_quota", [{ type: "thinking", thinking: "partial thinking" }])).kind).toBe("unsafe");
});

test("native HTTP status formatting preserves auth/rate classification without relaxing safety guards", () => {
  for (const status of [401, 403, 429]) {
    const expected = status === 429 ? { kind: "rate", scope: "model" } : { kind: "auth", scope: "provider" };
    for (const text of [nativeHttpError(status), nativeHttpError(status, "opaque provider refusal"), nativeHttpError(status, undefined, "OpenAI API error")]) {
      expect(classify(error(text))).toMatchObject(expected);
    }
  }
  for (const text of [nativeHttpError(403, "context window exceeded"), nativeHttpError(429, "invalid request"), nativeHttpError(400), "provider queued 429 requests", "403 records available"])
    expect(classify(error(text)).kind).toBe("unsafe");
  expect(classify(error(nativeHttpError(401), [{ type: "text", text: "partial work" }])).kind).toBe("unsafe");
  expect(classify({ ...error(nativeHttpError(403)), stopReason: "aborted" }).kind).toBe("unsafe");
});

test("model cooldown isolates siblings; provider cooldown suppresses siblings; expiry and structured hints are bounded", () => {
  let now = 1000;
  const health = new Health(() => now);
  health.mark(models[0].model, classify(error('{"status":503,"retryAfterSeconds":2}'), now));
  expect(choose(config, models, health, 10)?.model.id).toBe("two");
  now += 2001;
  expect(choose(config, models, health, 10)?.model.id).toBe("one");
  health.mark(models[0].model, classify(error("insufficient_quota"), now));
  expect(choose(config, models, health, 10)?.model.provider).toBe("b");
  expect(classify(error('{"status":429,"scope":"provider","resetAt":2000000000000}'), now)).toMatchObject({ scope: "provider", delayMs: 900_000 });
  expect(classify(error('{"status":429,"resetAt":999999999999}'), now).delayMs).toBe(60_000);
  expect(classify(error('{"status":429,"retryAfterSeconds":-1}'), now).delayMs).toBe(1000);
  now += 300_001;
  expect(health.eligible(models[0].model)).toBe(true);
});

test("the route's declared capacity and this request's need exclude undersized models", () => {
  const health = new Health();
  // A route declaring more capacity than its candidates provide has no dispatchable target.
  const wide = parseConfig({ routes: { work: { contextWindow: 400_000, candidates: [{ provider: "a", id: "one" }] } } }).routes.work;
  expect(choose(wide, models, health, 10)).toBeUndefined();
  // This request alone needs more room than a 300k window with a 16k output reserve leaves.
  expect(choose(config, models, health, 299_999)).toBeUndefined();
  expect(choose(config, models, health, 10, "b/one")?.model.provider).toBe("b");
  const changed = models.filter(c => c.model.provider !== "b");
  expect(choose(config, changed, health, 10, "b/one")?.model.provider).toBe("a");
});

test("cache TTL uses successful activity epoch, exact threshold, consumption, identity and rollback", () => {
  const activity = { logical: "route/work", physical: "a/one", at: 1000 };
  expect(cacheExpiry(undefined, "route/work", "a/one", 100, 1100)).toBe(false);
  expect(cacheExpiry(activity, "route/work", "a/one", undefined, 5000)).toBe(false);
  expect(cacheExpiry(activity, "route/work", "a/one", 100, 1099)).toBe(false);
  expect(cacheExpiry(activity, "route/work", "a/one", 100, 1100)).toBe(true);
  expect(cacheExpiry({ ...activity, consumedAt: 1000 }, "route/work", "a/one", 100, 1100)).toBe(false);
  expect(cacheExpiry(activity, "route/other", "a/one", 100, 1100)).toBe(false);
  expect(cacheExpiry(activity, "route/work", "b/one", 100, 1100)).toBe(false);
  expect(cacheExpiry(activity, "route/work", "a/one", 100, 999)).toBe(false);
});

test("branch state is JSON-serializable, malformed versions are not trusted, and a legacy floor is ignored", () => {
  const state = { version: 1 as const, physical: "a/one", turn: "turn", retries: 1, transitions: 2, recoveries: 1 };
  expect(restore(JSON.parse(JSON.stringify(state)))).toEqual(state);
  expect(restore({ ...state, version: 2 })).toBeUndefined();
  expect(restore({ ...state, retries: -1 })).toBeUndefined();
  // State written before the capacity floor was removed still decodes; the extra field is ignored.
  expect(restore({ ...state, floor: 300_000 })).toMatchObject(state);
});

test("named accounts are validated and cooldowns isolate accounts of the same provider", () => {
  const accounts = { "go-a": { provider: "opencode-go", apiKeyEnv: "GO_A" }, "go-b": { provider: "opencode-go", apiKeyEnv: "GO_B" } };
  const parsed = parseConfig({ accounts, routes: { work: { candidates: [{ provider: "opencode-go", id: "m", account: "go-a" }, { provider: "opencode-go", id: "m", account: "go-b" }] } } });
  expect(parsed.routes.work.candidates.map(c => c.account)).toEqual(["go-a", "go-b"]);
  // A bare candidate for a provider with named accounts expands to its pool, in configured order.
  const pooled = parseConfig({ accounts, routes: { work: { candidates: [{ provider: "opencode-go", id: "m", thinkingLevel: "low" }] } } });
  expect(pooled.routes.work.candidates).toEqual([
    { provider: "opencode-go", id: "m", thinkingLevel: "low", account: "go-a" },
    { provider: "opencode-go", id: "m", thinkingLevel: "low", account: "go-b" },
  ]);
  // An explicit account is kept and not expanded.
  const explicit = parseConfig({ accounts, routes: { work: { candidates: [{ provider: "opencode-go", id: "m", account: "go-b" }] } } });
  expect(explicit.routes.work.candidates.map(c => c.account)).toEqual(["go-b"]);
  // A pool and an explicit entry that repeat the same account are duplicates.
  expect(() => parseConfig({ accounts, routes: { work: { candidates: [{ provider: "opencode-go", id: "m" }, { provider: "opencode-go", id: "m", account: "go-a" }] } } })).toThrow(/Duplicate/);
  expect(() => parseConfig({ accounts, routes: { work: { candidates: [{ provider: "other", id: "m", account: "go-a" }] } } })).toThrow(/configured other account/);
  expect(() => parseConfig({ accounts: { "bad id": { provider: "p", apiKeyEnv: "K" } } })).toThrow(/Invalid account id/);
  expect(() => parseConfig({ accounts: { a: { provider: "p", apiKeyEnv: "literal key value" } } })).toThrow(/Invalid account a/);
  const health = new Health(() => 1000);
  const model = { provider: "opencode-go", id: "m" };
  health.mark(model, { kind: "quota", scope: "provider", delayMs: 60_000 }, "go-a");
  expect(health.eligible(model, "go-a")).toBe(false);
  expect(health.eligible(model, "go-b")).toBe(true);
  const weekly = new Health(() => 1000);
  weekly.mark(model, { kind: "rate", scope: "model", delayMs: 60_000 }, "go-a");
  expect(weekly.eligible(model, "go-a")).toBe(false);
  expect(weekly.eligible(model, "go-b")).toBe(true);
});

test("Pi non-retryable provider limit errors classify as provider-scoped quota failures", () => {
  for (const text of ["GoUsageLimitError: monthly limit", "FreeUsageLimitError: free tier exhausted", "Monthly usage limit reached", "insufficient_quota", "You have no available balance", "Request failed: out of budget"]) {
    expect(classify(error(text))).toMatchObject({ kind: "quota", scope: "provider" });
  }
});

test("cache epochs are tied to one account and model combination", () => {
  const activity = { logical: "route/work", physical: "opencode-go/m#go-a", at: 1000 };
  expect(cacheExpiry(activity, "route/work", "opencode-go/m#go-a", 100, 1100)).toBe(true);
  expect(cacheExpiry(activity, "route/work", "opencode-go/m#go-b", 100, 1100)).toBe(false);
  expect(cacheExpiry(activity, "route/work", "opencode-go/other#go-a", 100, 1100)).toBe(false);
});

test("partial-output provider quota is observed for health but never replayable", () => {
  const partial = { stopReason: "error" as const, content: [{ type: "text" as const, text: "partial work" }], errorMessage: "insufficient_quota" };
  expect(classify(partial).kind).toBe("unsafe");
  expect(observe(partial)).toMatchObject({ kind: "quota", scope: "provider" });
  expect(observe({ stopReason: "aborted", content: [], errorMessage: "insufficient_quota" }).kind).toBe("unsafe");
  expect(partialOutput({ content: [{ type: "text", text: "  " }] })).toBe(false);
});
