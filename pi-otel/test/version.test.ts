import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extensionVersion } from "../src/version.ts";

describe("extensionVersion", () => {
  test("returns a non-empty semver-ish string matching package.json", () => {
    const v = extensionVersion();
    assert.ok(typeof v === "string");
    assert.ok(v.length > 0, "version is non-empty");
    assert.match(v, /^\d+\.\d+\.\d+/, "looks like a semver");
    // Must agree with the package.json in the repo root. Resolve relative to
    // this file so the suite passes from any checkout path.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    assert.equal(v, pkg.version, "matches package.json version");
  });

  test("is cached (same reference across calls is not required, same value is)", () => {
    assert.equal(extensionVersion(), extensionVersion());
  });
});
