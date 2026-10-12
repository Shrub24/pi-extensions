import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Suites that start the in-process Radar daemon fake. They exercise Radar
// wiring end to end through a stand-in daemon, so they run only through
// `npm run test:integration` and are not part of the authoritative gate.
export const INTEGRATION_TEST_FILES = [
  "commands",
  "completion-lifecycle",
  "control-integration",
  "controller-api",
  "controller-lifecycle",
  "extension-contract",
  "observation-refresh",
  "radar-launch",
  "recovery",
  "worker-addressing",
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
