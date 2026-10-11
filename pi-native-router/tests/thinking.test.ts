import { expect, test } from "bun:test";
import { clampLevel, supportedLevels } from "../src/policy";

test("a non-reasoning physical model supports only off", () => {
  expect(supportedLevels({ reasoning: false })).toEqual(["off"]);
  expect(clampLevel({ reasoning: false }, "high")).toBe("off");
});

test("unmapped levels are excluded; xhigh and max need an explicit mapping", () => {
  const model = { reasoning: true, thinkingLevelMap: { xhigh: null, max: "max" } };
  expect(supportedLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "max"]);
  expect(clampLevel(model, "xhigh")).toBe("max");
});

test("a requested level clamps upward first, then downward, as pi-ai does", () => {
  const model = { reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null } };
  expect(clampLevel(model, "low")).toBe("high");
  const topOnly = { reasoning: true, thinkingLevelMap: { high: null, medium: null, low: null, minimal: null, xhigh: null, max: null } };
  expect(clampLevel(topOnly, "max")).toBe("off");
  expect(supportedLevels(topOnly)).toEqual(["off", "max"].filter(level => level === "off"));
});
