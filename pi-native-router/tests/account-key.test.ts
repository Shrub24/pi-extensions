import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { readAccountKey } from "../src/accounts";

const dir = () => mkdtempSync(join(tmpdir(), "native-router-key-"));

test("an account key can come from an absolute file, trimmed, read at use time", () => {
  const root = dir();
  try {
    const path = join(root, "go-a");
    writeFileSync(path, "synthetic-key-a\n");
    const config = parseConfig({ accounts: { "go-a": { provider: "opencode-go", apiKeyFile: path } } });
    expect(readAccountKey(config.accounts["go-a"])).toBe("synthetic-key-a");
    writeFileSync(path, "rotated-key\n");
    expect(readAccountKey(config.accounts["go-a"])).toBe("rotated-key");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing or empty key file is unavailable, never a fallback", () => {
  const root = dir();
  try {
    const path = join(root, "empty");
    writeFileSync(path, "  \n");
    const config = parseConfig({ accounts: { "go-a": { provider: "opencode-go", apiKeyFile: path }, "go-b": { provider: "opencode-go", apiKeyFile: join(root, "absent") } } });
    expect(readAccountKey(config.accounts["go-a"])).toBeUndefined();
    expect(readAccountKey(config.accounts["go-b"])).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exactly one key source is required and the file path must be absolute", () => {
  expect(() => parseConfig({ accounts: { a: { provider: "p" } } })).toThrow(/exactly one/);
  expect(() => parseConfig({ accounts: { a: { provider: "p", apiKeyEnv: "K", apiKeyFile: "/x" } } })).toThrow(/exactly one/);
  expect(() => parseConfig({ accounts: { a: { provider: "p", apiKeyFile: "relative/key" } } })).toThrow(/absolute path/);
});

test("an environment reference is still accepted and read from the given environment", () => {
  const config = parseConfig({ accounts: { a: { provider: "p", apiKeyEnv: "KEY_A" } } });
  expect(readAccountKey(config.accounts.a, { KEY_A: "from-env" })).toBe("from-env");
  expect(readAccountKey(config.accounts.a, {})).toBeUndefined();
});
