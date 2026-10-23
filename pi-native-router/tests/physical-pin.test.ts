import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config";
import { modelEntryText, providerText, stripProviderPrefix, PEAK_GLYPH, PIN_FALLBACK_GLYPH, PIN_GLYPH } from "../src/footer";
import { choose, classify, cycleTarget, Health, identity, type Resolved } from "../src/policy";

const config = parseConfig({ routes: { work: { candidates: [{ provider: "a", id: "one" }, { provider: "a", id: "two" }, { provider: "b", id: "one" }] } } }).routes.work;
const models: Resolved[] = config.candidates.map(candidate => ({
  candidate,
  model: { ...candidate, name: candidate.id, api: "openai-completions", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 300_000, maxTokens: 16_384 } as unknown as Model<Api>,
}));
const block = (health: Health, index: number) => health.mark(models[index].model, classify({ stopReason: "error", errorMessage: "insufficient_quota", content: [] } as never, 1000));

test("an explicitly preferred candidate is selected ahead of configured route order", () => {
  const health = new Health();
  expect(choose(config, models, health, 10, identity(models[2].model))?.model.provider).toBe("b");
});

test("a pin that cannot serve falls back to route order and does not change the choice", () => {
  const health = new Health(() => 1000);
  block(health, 2);
  expect(choose(config, models, health, 10, identity(models[2].model))?.model.id).toBe("one");
  expect(choose(config, models, health, 10, identity(models[2].model))?.model.provider).toBe("a");
});

test("cycling walks every configured candidate in route order and wraps", () => {
  expect(cycleTarget(models, identity(models[0].model))?.model.id).toBe("two");
  expect(cycleTarget(models, identity(models[2].model))?.model.provider).toBe("a");
  expect(cycleTarget([], "a/one")).toBeUndefined();
});

test("cycling keeps cooling candidates selectable; automatic choice still skips them", () => {
  const health = new Health(() => 1000);
  block(health, 1);
  expect(cycleTarget(models, identity(models[0].model))?.model.id).toBe("two");
  expect(choose(config, models, health, 10)?.model.id).toBe("one");
  expect(health.blockedReason(models[1].model)).toBeDefined();
});

test("the cycle hotkey defaults to ctrl+shift+m and accepts a configured key", () => {
  expect(parseConfig({}).shortcuts.cyclePin).toBe("ctrl+shift+m");
  expect(parseConfig({ shortcuts: { cyclePin: "alt+shift+x" } }).shortcuts.cyclePin).toBe("alt+shift+x");
  expect(() => parseConfig({ shortcuts: { cyclePin: "" } })).toThrow("shortcuts.cyclePin");
  expect(() => parseConfig({ shortcuts: { other: "x" } })).toThrow("Unknown router setting: other");
});

test("the model entry carries pin, model and peak in one entry, pin first and fallback-coloured", () => {
  expect(providerText("a", "go-a")).toBe("a · go-a");
  expect(providerText("a", undefined)).toBe("a");
  const entry = (pin?: "pinned" | "fallback", peak = false, blocked = false) => modelEntryText({ name: "Claude Haiku 5.5", provider: "anthropic", providerLabel: "Claude", pin, blocked, peak });
  expect(entry()).toBe("Haiku 5.5");
  expect(entry("pinned", true)).toBe(`${PIN_GLYPH} Haiku 5.5 \x1b[33m${PEAK_GLYPH}\x1b[39m`);
  expect(entry("fallback")).toBe(`\x1b[33m${PIN_FALLBACK_GLYPH}\x1b[39m Haiku 5.5`);
  expect(entry("pinned", false, true)).toBe(`\x1b[31m${PIN_GLYPH}\x1b[39m Haiku 5.5`);
  expect(entry("fallback", false, true)).toBe(`\x1b[31m${PIN_FALLBACK_GLYPH}\x1b[39m Haiku 5.5`);
});

test("a provider prefix is removed from the model name only when something remains", () => {
  expect(stripProviderPrefix("Claude Haiku 5.5", "Claude", "anthropic")).toBe("Haiku 5.5");
  expect(stripProviderPrefix("claude · Sonnet", "Claude", "anthropic")).toBe("Sonnet");
  expect(stripProviderPrefix("DeepSeek V4", "OpenCode Go", "opencode-go")).toBe("DeepSeek V4");
  expect(stripProviderPrefix("Claude", "Claude", "anthropic")).toBe("Claude");
});
