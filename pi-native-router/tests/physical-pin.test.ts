import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config";
import { modelText, providerText } from "../src/footer";
import { choose, classify, cycleTarget, Health, identity, type Resolved } from "../src/policy";

const config = parseConfig({ routes: { work: { candidates: [{ provider: "a", id: "one" }, { provider: "a", id: "two" }, { provider: "b", id: "one" }] } } }).routes.work;
const models: Resolved[] = config.candidates.map(candidate => ({
  candidate,
  model: { ...candidate, name: candidate.id, api: "openai-completions", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 300_000, maxTokens: 16_384 } as unknown as Model<Api>,
}));
const block = (health: Health, index: number) => health.mark(models[index].model, classify({ stopReason: "error", errorMessage: "insufficient_quota", content: [] } as never, 1000));

test("an eligible pin is chosen ahead of the current physical model", () => {
  const health = new Health();
  expect(choose(config, models, health, 10, identity(models[2].model))?.model.provider).toBe("b");
});

test("a pin that cannot serve falls back to route order and does not change the choice", () => {
  const health = new Health(() => 1000);
  block(health, 2);
  expect(choose(config, models, health, 10, identity(models[2].model))?.model.id).toBe("one");
  expect(choose(config, models, health, 10, identity(models[2].model))?.model.provider).toBe("a");
});

test("cycling moves to the next eligible candidate and wraps", () => {
  const health = new Health();
  expect(cycleTarget(config, models, health, 10, identity(models[0].model))?.model.id).toBe("two");
  expect(cycleTarget(config, models, health, 10, identity(models[2].model))?.model.provider).toBe("a");
});

test("cycling skips ineligible candidates and reports nothing when none is eligible", () => {
  const health = new Health(() => 1000);
  block(health, 1);
  expect(cycleTarget(config, models, health, 10, identity(models[0].model))?.model.provider).toBe("b");
  block(health, 0);
  block(health, 2);
  expect(cycleTarget(config, models, health, 10, identity(models[0].model))).toBeUndefined();
});

test("the cycle hotkey defaults to ctrl+shift+m and accepts a configured key", () => {
  expect(parseConfig({}).shortcuts.cyclePin).toBe("ctrl+shift+m");
  expect(parseConfig({ shortcuts: { cyclePin: "alt+shift+x" } }).shortcuts.cyclePin).toBe("alt+shift+x");
  expect(() => parseConfig({ shortcuts: { cyclePin: "" } })).toThrow("shortcuts.cyclePin");
  expect(() => parseConfig({ shortcuts: { other: "x" } })).toThrow("Unknown router setting: other");
});

test("the footer marks a pinned physical model without words", () => {
  expect(providerText("a", "go-a")).toBe("a · go-a");
  expect(providerText("a", undefined)).toBe("a");
  expect(modelText("One", true)).toBe("One ⚑");
  expect(modelText("One")).toBe("One");
});
