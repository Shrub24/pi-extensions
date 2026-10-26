import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { radarBaselineExtensionPath } from "./radar-baseline.ts";

test("the Radar baseline resolves to pi-radar's extension entry on disk", () => {
  const path = radarBaselineExtensionPath();
  assert.ok(path !== undefined, "a source checkout resolves pi-radar");
  assert.match(path, /pi-radar\/extension\/baseline\.ts$/);
  assert.ok(existsSync(path), `${path} exists`);
});
