import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Legacy composed suites still being migrated away from daemon-shaped fixtures.
// Keep their failures visible through `test:integration`; passing the unit group
// alone does not validate the Radar adoption. Owned-contract suites move into
// the default gate once their fixtures use the current boundary.
export const INTEGRATION_TEST_FILES = [
  "commands",
  "controller-api",
  "controller-lifecycle",
  "extension-contract",
  "observation-refresh",
  "recovery",
].map((name) => `extension/${name}.test.ts`);

// Every other test file, discovered rather than listed, so a new unit suite is
// gated without touching this module.
export function unitTestFiles() {
  const extensionDir = resolve(
    fileURLToPath(import.meta.url),
    "..",
    "..",
    "extension",
  );
  const integration = new Set(INTEGRATION_TEST_FILES);
  return readdirSync(extensionDir)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `extension/${name}`)
    .filter((file) => !integration.has(file))
    .sort();
}
