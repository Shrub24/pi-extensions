import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readAccountKey, useAccount } from "../src/accounts";

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

function fakeContext(setRuntimeApiKey: ((provider: string, key: string) => Promise<void> | void) | undefined, effective: { key?: string }) {
  const runtime = setRuntimeApiKey ? { setRuntimeApiKey } : {};
  return { modelRegistry: { runtime, getApiKeyForProvider: async () => effective.key } } as unknown as ExtensionContext;
}

test("concurrent activations on one runtime run one at a time, each verified before the next", async () => {
  process.env.KEY_TEST_A = "synthetic-a";
  process.env.KEY_TEST_B = "synthetic-b";
  try {
    const config = parseConfig({ accounts: { a: { provider: "p", apiKeyEnv: "KEY_TEST_A" }, b: { provider: "p", apiKeyEnv: "KEY_TEST_B" } } });
    const effective: { key?: string } = {};
    const log: string[] = [];
    const ctx = fakeContext(async (_provider, key) => {
      log.push(`start:${key}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      effective.key = key;
      log.push(`end:${key}`);
    }, effective);
    await Promise.all([useAccount(ctx, "p", config.accounts.a), useAccount(ctx, "p", config.accounts.b)]);
    expect(log).toEqual(["start:synthetic-a", "end:synthetic-a", "start:synthetic-b", "end:synthetic-b"]);
    expect(effective.key).toBe("synthetic-b");
  } finally { delete process.env.KEY_TEST_A; delete process.env.KEY_TEST_B; }
});

test("activation fails closed when the host lacks the operation, or does not take effect", async () => {
  process.env.KEY_TEST_A = "synthetic-a";
  try {
    const config = parseConfig({ accounts: { a: { provider: "p", apiKeyEnv: "KEY_TEST_A" } } });
    await expect(useAccount(fakeContext(undefined, {}), "p", config.accounts.a)).rejects.toThrow(/does not expose/);
    await expect(useAccount(fakeContext(() => {}, {}), "p", config.accounts.a)).rejects.toThrow(/could not be verified/);
  } finally { delete process.env.KEY_TEST_A; }
});
