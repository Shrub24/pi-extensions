import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sameCwd } from "./cwd.ts";

test("cwd comparisons accept equivalent symlink paths", () => {
  const real = mkdtempSync(join(tmpdir(), "pi-herdsman-cwd-"));
  const link = `${real}-link`;
  try {
    symlinkSync(real, link);
    assert.equal(sameCwd(real, link), true);
    assert.equal(sameCwd(link, real), true);
    assert.equal(sameCwd(join(real, "missing"), join(real, "missing")), true);
    assert.equal(sameCwd(join(real, "missing"), join(real, "other")), false);
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});
