// Runs the unit suites (`unit`, the default) or the Radar-daemon integration
// suites (`integration`) through Node's test runner with the module-mock loader.
import { spawn } from "node:child_process";
import { INTEGRATION_TEST_FILES, unitTestFiles } from "./test-selection.mjs";

const mode = process.argv[2] ?? "unit";
if (mode !== "unit" && mode !== "integration") {
  console.error(`run-tests: unknown mode ${mode}`);
  process.exit(2);
}

const files = mode === "integration" ? INTEGRATION_TEST_FILES : unitTestFiles();
const timeout = mode === "integration" ? 60_000 : 10_000;
const child = spawn(
  process.execPath,
  [
    "--experimental-test-module-mocks",
    "--import=./scripts/test-env.mjs",
    "--test",
    `--test-timeout=${timeout}`,
    ...files,
  ],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
