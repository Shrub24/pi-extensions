import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthStore } from "../src/health-store";
import { exhaustedUntil, parseCodexbar, quotaScopeKey, refreshQuota, type QuotaSource } from "../src/quota";
import { parseConfig } from "../src/config";
import { Health } from "../src/policy";
import { generateCodexbarConfig, stableUuid } from "../src/codexbar-config";
import { readAccountKey } from "../src/accounts";
import type { Account } from "../src/config";

// Shape captured from `codexbar usage --provider opencodego --format json` (CodexBar 0.73.0), identity fields removed.
const NOW = Date.parse("2026-10-11T08:30:00Z");
const goOutput = JSON.stringify([{
  provider: "opencodego",
  rateWindowLabels: { primary: "5-hour", secondary: "Weekly", tertiary: "Monthly" },
  source: "local+api",
  usage: {
    primary: { resetsAt: "2026-10-11T13:26:18Z", usedPercent: 0, windowMinutes: 300 },
    secondary: { resetsAt: "2026-10-11T23:59:56Z", usedPercent: 11, windowMinutes: 10080 },
    tertiary: { resetsAt: "2026-10-22T12:36:25Z", usedPercent: 100, windowMinutes: 43200 },
    updatedAt: "2026-10-11T08:26:18Z",
  },
}]);
const source = (enforce: boolean): QuotaSource => ({ source: "codexbar", provider: "opencodego", account: "go-a", enforce });
const dir = () => mkdtempSync(join(tmpdir(), "native-router-quota-"));

test("the captured OpenCode Go output parses into labelled windows with resets", () => {
  const parsed = parseCodexbar(goOutput, "go-a", "opencodego", NOW);
  if (!("snapshot" in parsed)) throw new Error(parsed.error);
  expect(parsed.snapshot.windows.map(w => [w.label, w.usedPercent])).toEqual([["5-hour", 0], ["Weekly", 11], ["Monthly", 100]]);
  expect(parsed.snapshot.observedAt).toBe(Date.parse("2026-10-11T08:26:18Z"));
  expect(exhaustedUntil(parsed.snapshot, NOW)).toBe(Date.parse("2026-10-22T12:36:25Z"));
});

test("malformed, missing and out-of-range tracker output is unknown, never capacity", () => {
  expect("error" in parseCodexbar("not json", "go-a", "opencodego", NOW)).toBe(true);
  expect("error" in parseCodexbar("[]", "go-a", "opencodego", NOW)).toBe(true);
  expect("error" in parseCodexbar(goOutput.replace('"usedPercent":11', '"usedPercent":150'), "go-a", "opencodego", NOW)).toBe(true);
  expect("error" in parseCodexbar(goOutput.replace('"updatedAt":"2026-10-11T08:26:18Z"', '"updatedAt":"2030-01-01T00:00:00Z"'), "go-a", "opencodego", NOW)).toBe(true);
});

test("an exhausted window without a usable reset gets the bounded backoff", () => {
  const parsed = parseCodexbar(goOutput.replace('"resetsAt":"2026-10-22T12:36:25Z"', '"resetsAt":"nonsense"'), "go-a", "opencodego", NOW);
  if (!("snapshot" in parsed)) throw new Error(parsed.error);
  expect(exhaustedUntil(parsed.snapshot, NOW)).toBe(NOW + 5 * 60_000);
});

test("a local-and-API blend never enforces, even when it reports exhaustion", async () => {
  const root = dir();
  try {
    const store = new HealthStore(join(root, "h.sqlite"), () => NOW);
    await refreshQuota(store, { provider: "opencode-go", account: "go-a" }, source(true), async () => goOutput, () => NOW, "h1");
    expect(store.blocked(["opencode-go#go-a"])).toBeUndefined();
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("enforced exhaustion blocks the account until its reset; unenforced exhaustion only reports", async () => {
  const root = dir();
  try {
    const store = new HealthStore(join(root, "h.sqlite"), () => NOW);
    const run = async () => goOutput.replace('"source":"local+api"', '"source":"api"');
    await refreshQuota(store, { provider: "opencode-go", account: "go-a" }, source(false), run, () => NOW, "h1");
    expect(store.blocked(["opencode-go#go-a"])).toBeUndefined();
    await refreshQuota(store, { provider: "opencode-go", account: "go-a" }, source(true), run, () => NOW, "h1");
    expect(store.blocked(["opencode-go#go-a"])?.kind).toBe("tracker-quota");
    expect(store.blocked(["opencode-go#go-b"])).toBeUndefined();
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unavailable tracker records unknown and does not block or clear health", async () => {
  const root = dir();
  try {
    const store = new HealthStore(join(root, "h.sqlite"), () => NOW);
    store.mark("opencode-go#go-a", "auth", NOW + 60_000, "auth");
    const outcome = await refreshQuota(store, { provider: "opencode-go", account: "go-a" }, source(true), async () => { throw new Error("spawn codexbar ENOENT"); }, () => NOW, "h1");
    expect(outcome.status).toBe("unavailable");
    expect(store.getSnapshot("opencode-go#go-a")?.body).toBeNull();
    expect(store.blocked(["opencode-go#go-a"])?.kind).toBe("auth");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a healthy snapshot clears only tracker quota, never an auth block", async () => {
  const root = dir();
  try {
    const store = new HealthStore(join(root, "h.sqlite"), () => NOW);
    await refreshQuota(store, { provider: "opencode-go", account: "go-a" }, source(true), async () => goOutput, () => NOW, "h1");
    store.mark("opencode-go#go-a", "auth", NOW + 3_600_000, "auth");
    const healthy = goOutput.replace('"usedPercent":100', '"usedPercent":40');
    await refreshQuota(store, { provider: "opencode-go", account: "go-a" }, source(true), async () => healthy, () => NOW + 1, "h1");
    expect(store.blocked(["opencode-go#go-a"])?.kind).toBe("auth");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a concurrent refresh is refused while another holder has the lease", () => {
  const root = dir();
  try {
    const path = join(root, "h.sqlite");
    const a = new HealthStore(path, () => NOW);
    const b = new HealthStore(path, () => NOW);
    expect(a.acquireLease("quota:go-a", "holder-a", 10_000)).toBe(true);
    expect(b.acquireLease("quota:go-a", "holder-b", 10_000)).toBe(false);
    a.releaseLease("quota:go-a", "holder-a");
    expect(b.acquireLease("quota:go-a", "holder-b", 10_000)).toBe(true);
    a.close(); b.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("generated CodexBar config maps each quota-mapped account to a labelled token and skips unset keys", () => {
  const accounts: Record<string, Account> = {
    "go-a": { provider: "opencode-go", apiKeyEnv: "KEY_A", quota: { source: "codexbar", provider: "opencodego", account: "go-a", enforce: false } },
    "go-b": { provider: "opencode-go", apiKeyEnv: "KEY_B", quota: { source: "codexbar", provider: "opencodego", enforce: false } },
    "go-c": { provider: "opencode-go", apiKeyEnv: "KEY_C", quota: { source: "codexbar", provider: "opencodego", enforce: false } },
    "plain": { provider: "other", apiKeyEnv: "KEY_D" },
  };
  const env: Record<string, string> = { KEY_A: "synthetic-a", KEY_B: "synthetic-b" };
  const generated = generateCodexbarConfig(accounts, {}, account => readAccountKey(account, env), 1760000000);
  const [provider] = generated.document.providers as Array<Record<string, any>>;
  expect(provider.id).toBe("opencodego");
  expect(provider.source).toBe("api");
  expect(provider.tokenAccounts.accounts.map((a: { label: string }) => a.label)).toEqual(["go-a", "go-b"]);
  expect(generated.included).toEqual(["go-a", "go-b"]);
  expect(generated.skipped).toEqual([{ account: "go-c", reason: "KEY_C is not available" }]);
  expect(stableUuid("go-a")).toBe(stableUuid("go-a"));
  expect(stableUuid("go-a")).not.toBe(stableUuid("go-b"));
  expect(stableUuid("go-a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("generated config is written 0600 and never overwrites without an explicit replace", async () => {
  const { writeCodexbarConfig } = await import("../src/codexbar-config");
  const { statSync, readFileSync } = await import("node:fs");
  const root = dir();
  try {
    const path = join(root, "nested", "config.json");
    writeCodexbarConfig(path, { version: 1, providers: [] }, false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeCodexbarConfig(path, { version: 1, providers: [{ id: "x" }] }, false)).toThrow(/--replace/);
    expect(readFileSync(path, "utf8")).not.toContain('"x"');
    writeCodexbarConfig(path, { version: 1, providers: [{ id: "x" }] }, true);
    expect(readFileSync(path, "utf8")).toContain('"x"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refresh always selects the mapped CodexBar account, defaulting to the router account id", async () => {
  const root = dir();
  try {
    const store = new HealthStore(join(root, "h.sqlite"), () => NOW);
    const seen: string[][] = [];
    const run = async (args: string[]) => { seen.push(args); return goOutput.replace('"source":"local+api"', '"source":"api"'); };
    await refreshQuota(store, { provider: "commandcode", account: "commandcode-a" }, { source: "codexbar", provider: "commandcode", enforce: false }, run, () => NOW, "h1");
    await refreshQuota(store, { provider: "opencode-go", account: "go-a" }, { source: "codexbar", provider: "opencodego", account: "go-a", enforce: false }, run, () => NOW, "h1");
    expect(seen[0]).toEqual(expect.arrayContaining(["--provider", "commandcode", "--account", "commandcode-a"]));
    expect(seen[1]).toEqual(expect.arrayContaining(["--provider", "opencodego", "--account", "go-a"]));
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a default-auth provider quota queries CodexBar's own account and blocks every model on that provider", async () => {
  const root = dir();
  try {
    const store = new HealthStore(join(root, "h.sqlite"), () => NOW);
    const seen: string[][] = [];
    const run = async (args: string[]) => { seen.push(args); return goOutput.replace('"source":"local+api"', '"source":"api"').replace('"provider":"opencodego"', '"provider":"codex"'); };
    const outcome = await refreshQuota(store, { provider: "openai-codex" }, { source: "codexbar", provider: "codex", enforce: true }, run, () => NOW, "h1");
    expect(outcome.status).toBe("refreshed");
    expect(seen[0]).not.toContain("--account");
    expect(store.blocked([quotaScopeKey("openai-codex")])?.kind).toBe("tracker-quota");
    const health = new Health(() => NOW, store);
    expect(health.eligible({ provider: "openai-codex", id: "gpt-a" })).toBe(false);
    expect(health.eligible({ provider: "openai-codex", id: "gpt-b" })).toBe(false);
    expect(health.eligible({ provider: "anthropic", id: "opus" })).toBe(true);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("provider-level quotas parse strictly and cannot overlap named accounts of the same provider", () => {
  const parsed = parseConfig({ quotas: { "openai-codex": { source: "codexbar", provider: "codex", enforce: true }, anthropic: { source: "codexbar", provider: "claude" } } });
  expect(parsed.quotas["openai-codex"]).toEqual({ source: "codexbar", provider: "codex", enforce: true });
  expect(parsed.quotas.anthropic.enforce).toBe(false);
  expect(() => parseConfig({ accounts: { "go-a": { provider: "opencode-go", apiKeyEnv: "K", quota: { source: "codexbar", provider: "opencodego" } } }, quotas: { "opencode-go": { source: "codexbar", provider: "opencodego" } } })).toThrow(/conflicts with named accounts/);
  expect(() => parseConfig({ quotas: { codex: { source: "other", provider: "codex" } } })).toThrow(/quota source must be codexbar/);
});

test("regenerating CodexBar config merges router providers and keeps providers it does not own", () => {
  const existing = {
    version: 1,
    providers: [
      { id: "codex", enabled: true, source: "oauth" },
      { id: "claude", enabled: true, source: "oauth" },
      { id: "opencodego", enabled: true, source: "api", tokenAccounts: { version: 1, activeIndex: 0, accounts: [{ id: "old", label: "stale", token: "old" }] } },
    ],
  };
  const accounts = {
    "go-a": { provider: "opencode-go", apiKeyEnv: "GO_A", quota: { source: "codexbar", provider: "opencodego", enforce: true } },
  } as Record<string, Account>;
  const quotas = { "openai-codex": { source: "codexbar", provider: "codex", enforce: true } } as Record<string, QuotaSource>;
  const generated = generateCodexbarConfig(accounts, quotas, () => "k-go", 1760000000, existing);
  const byId = new Map((generated.document.providers as Array<{ id: string; source: string; tokenAccounts?: { accounts: unknown[] } }>).map(p => [p.id, p]));
  expect([...byId.keys()].sort()).toEqual(["claude", "codex", "opencodego"]);
  expect(byId.get("claude")).toEqual({ id: "claude", enabled: true, source: "oauth" } as never);
  expect(byId.get("codex")?.source).toBe("oauth");
  expect(byId.get("codex")?.tokenAccounts).toBeUndefined();
  expect(byId.get("opencodego")?.source).toBe("api");
  expect(byId.get("opencodego")?.tokenAccounts?.accounts).toHaveLength(1);
});
