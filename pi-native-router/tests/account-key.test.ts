import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readKey, useKey } from "../src/accounts";

const dir = () => mkdtempSync(join(tmpdir(), "native-router-key-"));

test("a key file is read at use time, trimmed; a single provider key has no account id", () => {
  const root = dir();
  try {
    const path = join(root, "go");
    writeFileSync(path, "synthetic-key\n");
    const config = parseConfig({ providers: { "opencode-go": { apiKeyFile: path } } });
    expect(readKey(config.providers["opencode-go"].key!)).toBe("synthetic-key");
    writeFileSync(path, "rotated-key\n");
    expect(readKey(config.providers["opencode-go"].key!)).toBe("rotated-key");
    expect(config.providers["opencode-go"].accounts).toEqual({});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing or empty key file is unavailable, never a fallback", () => {
  const root = dir();
  try {
    const path = join(root, "empty");
    writeFileSync(path, "  \n");
    const config = parseConfig({ providers: { "opencode-go": { accounts: { "go-a": { apiKeyFile: path }, "go-b": { apiKeyFile: join(root, "absent") } } } } });
    expect(readKey(config.providers["opencode-go"].accounts["go-a"])).toBeUndefined();
    expect(readKey(config.providers["opencode-go"].accounts["go-b"])).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exactly one key source is required and the file path must be absolute", () => {
  expect(() => parseConfig({ providers: { p: { accounts: { a: {} } } } })).toThrow(/exactly one/);
  expect(() => parseConfig({ providers: { p: { apiKeyEnv: "K", apiKeyFile: "/x" } } })).toThrow(/exactly one/);
  expect(() => parseConfig({ providers: { p: { apiKeyFile: "relative/key" } } })).toThrow(/absolute path/);
  expect(() => parseConfig({ providers: { p: { accounts: { a: { apiKeyFile: "relative/key" } } } } })).toThrow(/absolute path/);
});

test("an environment reference is still accepted and read from the given environment", () => {
  const config = parseConfig({ providers: { p: { apiKeyEnv: "KEY_A" } } });
  expect(readKey(config.providers.p.key!, { KEY_A: "from-env" })).toBe("from-env");
  expect(readKey(config.providers.p.key!, {})).toBeUndefined();
});

test("shared settings sit on the provider; accounts are optional and cannot sit beside a single key", () => {
  const config = parseConfig({ providers: { commandcode: { name: "Command Code", apiKeyFile: "/run/secrets/cc", quota: { source: "codexbar", provider: "commandcode", enforce: true } } } });
  expect(config.providers.commandcode).toEqual({
    name: "Command Code", key: { apiKeyFile: "/run/secrets/cc" },
    quota: { source: "codexbar", provider: "commandcode", enforce: true }, accounts: {},
  });
  expect(config.display).toEqual({ providers: { commandcode: "Command Code" } });
  expect(() => parseConfig({ providers: { commandcode: { models: { x: "X" } } } })).toThrow(/Unknown router setting: models/);
  expect(() => parseConfig({ providers: { commandcode: { apiKeyEnv: "K", accounts: { a: { apiKeyEnv: "K2" } } } } })).toThrow(/single key or accounts, not both/);
  expect(() => parseConfig({ providers: { p: { accounts: {} } } })).toThrow(/must not be empty/);
  expect(() => parseConfig({ providers: { p: { quota: { source: "codexbar", provider: "x" }, accounts: { a: { apiKeyEnv: "K" } } } } })).toThrow(/quota on each account/);
});

test("an account id names one account, so it cannot repeat across providers", () => {
  expect(() => parseConfig({ providers: { p: { accounts: { a: { apiKeyEnv: "K" } } }, q: { accounts: { a: { apiKeyEnv: "K2" } } } } })).toThrow(/must be unique/);
});

test("a candidate on a single-key provider names no account and expands to the provider", () => {
  const config = parseConfig({ providers: { commandcode: { apiKeyEnv: "K" } }, routes: { worker: { candidates: [{ provider: "commandcode", id: "m" }] } } });
  expect(config.routes.worker.candidates).toEqual([expect.objectContaining({ provider: "commandcode", id: "m" })]);
  expect(config.routes.worker.candidates[0].account).toBeUndefined();
});

function fakeContext(setRuntimeApiKey: ((provider: string, key: string) => Promise<void> | void) | undefined, effective: { key?: string }) {
  const runtime = setRuntimeApiKey ? { setRuntimeApiKey } : {};
  return { modelRegistry: { runtime, getApiKeyForProvider: async () => effective.key } } as unknown as ExtensionContext;
}

test("concurrent activations on one runtime run one at a time, each verified before the next", async () => {
  process.env.KEY_TEST_A = "synthetic-a";
  process.env.KEY_TEST_B = "synthetic-b";
  try {
    const config = parseConfig({ providers: { p: { accounts: { a: { apiKeyEnv: "KEY_TEST_A" }, b: { apiKeyEnv: "KEY_TEST_B" } } } } });
    const effective: { key?: string } = {};
    const log: string[] = [];
    const ctx = fakeContext(async (_provider, key) => {
      log.push(`start:${key}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      effective.key = key;
      log.push(`end:${key}`);
    }, effective);
    await Promise.all([useKey(ctx, "p", config.providers.p.accounts.a), useKey(ctx, "p", config.providers.p.accounts.b)]);
    expect(log).toEqual(["start:synthetic-a", "end:synthetic-a", "start:synthetic-b", "end:synthetic-b"]);
    expect(effective.key).toBe("synthetic-b");
  } finally { delete process.env.KEY_TEST_A; delete process.env.KEY_TEST_B; }
});

test("activation fails closed when the host lacks the operation, or does not take effect", async () => {
  process.env.KEY_TEST_A = "synthetic-a";
  try {
    const config = parseConfig({ providers: { p: { accounts: { a: { apiKeyEnv: "KEY_TEST_A" } } } } });
    await expect(useKey(fakeContext(undefined, {}), "p", config.providers.p.accounts.a)).rejects.toThrow(/does not expose/);
    await expect(useKey(fakeContext(() => {}, {}), "p", config.providers.p.accounts.a)).rejects.toThrow(/could not be verified/);
  } finally { delete process.env.KEY_TEST_A; }
});
