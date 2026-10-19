import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthStore } from "../src/health-store";
import { exhaustedUntil, formatRemaining, formatUsed, parseCodexbar, QUOTA_REFRESH_GATE_MS, quotaScopeKey, refreshQuota, type QuotaSource, usageBar } from "../src/quota";
import { parseConfig } from "../src/config";
import { Health } from "../src/policy";
import { generateCodexbarConfig, stableUuid } from "../src/codexbar-config";
import { readKey } from "../src/accounts";

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
    await refreshQuota(store, { provider: "opencode-go", account: "go-a" }, source(true), run, () => NOW, "h1", { force: true });
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
  const providers = parseConfig({ providers: { "opencode-go": { accounts: {
    "go-a": { apiKeyEnv: "KEY_A", quota: { source: "codexbar", provider: "opencodego", account: "go-a", enforce: false } },
    "go-b": { apiKeyEnv: "KEY_B", quota: { source: "codexbar", provider: "opencodego", enforce: false } },
    "go-c": { apiKeyEnv: "KEY_C", quota: { source: "codexbar", provider: "opencodego", enforce: false } },
  } }, other: { apiKeyEnv: "KEY_D" } } }).providers;
  const env: Record<string, string> = { KEY_A: "synthetic-a", KEY_B: "synthetic-b" };
  const generated = generateCodexbarConfig(providers, source => readKey(source, env), 1760000000);
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

test("refresh selects the mapped CodexBar account for multi-account providers; key-only providers take none", async () => {
  const root = dir();
  try {
    const store = new HealthStore(join(root, "h.sqlite"), () => NOW);
    const seen: string[][] = [];
    const run = async (args: string[]) => { seen.push(args); return goOutput.replace('"source":"local+api"', '"source":"api"'); };
    await refreshQuota(store, { provider: "commandcode" }, { source: "codexbar", provider: "commandcode", enforce: false }, run, () => NOW, "h1");
    await refreshQuota(store, { provider: "opencode-go", account: "go-a" }, { source: "codexbar", provider: "opencodego", account: "go-a", enforce: false }, run, () => NOW, "h1");
    expect(seen[0]).not.toContain("--account");
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

test("provider-level quotas parse strictly on the provider; accounts carry their own quota", () => {
  const parsed = parseConfig({ providers: { "openai-codex": { quota: { source: "codexbar", provider: "codex", enforce: true } }, anthropic: { quota: { source: "codexbar", provider: "claude" } } } });
  expect(parsed.providers["openai-codex"].quota).toEqual({ source: "codexbar", provider: "codex", enforce: true });
  expect(parsed.providers.anthropic.quota?.enforce).toBe(false);
  expect(() => parseConfig({ providers: { codex: { quota: { source: "other", provider: "codex" } } } })).toThrow(/quota source must be codexbar/);
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
  const providers = parseConfig({ providers: {
    "opencode-go": { accounts: { "go-a": { apiKeyEnv: "GO_A", quota: { source: "codexbar", provider: "opencodego", enforce: true } } } },
    "openai-codex": { quota: { source: "codexbar", provider: "codex", enforce: true } },
  } }).providers;
  const generated = generateCodexbarConfig(providers, () => "k-go", 1760000000, existing);
  const byId = new Map((generated.document.providers as Array<{ id: string; source: string; tokenAccounts?: { accounts: unknown[] } }>).map(p => [p.id, p]));
  expect([...byId.keys()].sort()).toEqual(["claude", "codex", "opencodego"]);
  expect(byId.get("claude")).toEqual({ id: "claude", enabled: true, source: "oauth" } as never);
  expect(byId.get("codex")?.source).toBe("oauth");
  expect(byId.get("codex")?.tokenAccounts).toBeUndefined();
  expect(byId.get("opencodego")?.source).toBe("api");
  expect(byId.get("opencodego")?.tokenAccounts?.accounts).toHaveLength(1);
});

test("a single-key provider is written as a provider-level apiKey and drops stale token accounts", () => {
  const existing = { version: 1, providers: [{ id: "commandcode", enabled: true, source: "api", tokenAccounts: { version: 1, activeIndex: 0, accounts: [{ id: "old", label: "old", token: "old" }] } }] };
  const providers = parseConfig({ providers: { commandcode: { apiKeyFile: "/run/secrets/cc", quota: { source: "codexbar", provider: "commandcode", enforce: true } } } }).providers;
  const generated = generateCodexbarConfig(providers, () => "cc-key", 1760000000, existing);
  const entry = (generated.document.providers as Array<Record<string, unknown>>).find(p => p.id === "commandcode") as Record<string, unknown>;
  expect(entry).toEqual({ id: "commandcode", enabled: true, source: "api", apiKey: "cc-key" } as never);
  expect(generated.included).toEqual(["commandcode"]);
});

test("a provider key without a quota mapping is not written to CodexBar", () => {
  const generated = generateCodexbarConfig(parseConfig({ providers: { commandcode: { apiKeyEnv: "CC" } } }).providers, () => "cc-key", 1760000000);
  expect(generated.document.providers).toEqual([]);
  expect(generated.included).toEqual([]);
});

test("a second commandcode account is skipped rather than written as an unsupported token account", () => {
  const providers = parseConfig({ providers: { commandcode: { accounts: {
    "cc-a": { apiKeyEnv: "A", quota: { source: "codexbar", provider: "commandcode", enforce: false } },
    "cc-b": { apiKeyEnv: "B", quota: { source: "codexbar", provider: "commandcode", enforce: false } },
  } } } }).providers;
  const generated = generateCodexbarConfig(providers, () => "k", 1760000000);
  expect(generated.included).toEqual([]);
  expect(generated.skipped.map(s => s.account).sort()).toEqual(["cc-a", "cc-b"]);
  expect(generated.document.providers).toEqual([]);
});

test("an optional window reported as null is absent, not malformed", () => {
  const raw = JSON.stringify([{
    provider: "codex",
    source: "oauth",
    rateWindowLabels: { primary: "Session", secondary: "Weekly" },
    usage: {
      updatedAt: "2026-10-11T13:58:57Z",
      primary: { usedPercent: 57, resetsAt: "2026-10-12T04:58:40Z", windowMinutes: 300 },
      secondary: { usedPercent: 41, resetsAt: "2026-10-18T03:56:59Z", windowMinutes: 10080 },
      tertiary: null,
    },
  }]);
  const parsed = parseCodexbar(raw, "codex", "codex", Date.parse("2026-10-11T14:00:00Z"));
  expect("error" in parsed).toBe(false);
  if ("snapshot" in parsed) expect(parsed.snapshot.windows.map(w => w.slot)).toEqual(["primary", "secondary"]);
});

test("reset times render as remaining time", () => {
  const now = Date.parse("2026-10-11T14:00:00Z");
  expect(formatRemaining(now + 134 * 60_000, now)).toBe("2h 14m");
  expect(formatRemaining(now + 45 * 60_000, now)).toBe("45m");
  expect(formatRemaining(now + (3 * 24 + 4) * 3600_000, now)).toBe("3d 4h");
  expect(formatRemaining(now - 1, now)).toBe("due");
});

test("fresh valid readings are authoritative by default; estimates and local-derived sources are not", () => {
  const base = { rateWindowLabels: {}, usage: { updatedAt: "2026-10-11T13:58:57Z", primary: { usedPercent: 10 } } };
  const now = Date.parse("2026-10-11T14:00:00Z");
  const parse = (source?: string, dataConfidence?: string) => parseCodexbar(JSON.stringify([{ ...base, provider: "codex", ...(source ? { source } : {}), usage: { ...base.usage, ...(dataConfidence ? { dataConfidence } : {}) } }]), "codex", "codex", now);
  expect(parse("oauth", "exact")).toMatchObject({ snapshot: { authoritative: true } });
  expect(parse("cli")).toMatchObject({ snapshot: { authoritative: true, source: "cli" } });
  expect(parse(undefined)).toMatchObject({ snapshot: { authoritative: true, source: "unknown" } });
  expect(parse("oauth", "estimated")).toMatchObject({ snapshot: { authoritative: false } });
  expect(parse("local+api", "exact")).toMatchObject({ snapshot: { authoritative: false } });
  expect(parse("codexbar-app")).toMatchObject({ snapshot: { authoritative: false } });
});

test("a recent shared fetch is reused by every process; only a forced or stale refresh runs CodexBar", async () => {
  const root = dir();
  try {
    const store = new HealthStore(join(root, "h.sqlite"), () => NOW);
    let runs = 0;
    const run = async () => { runs++; return goOutput.replace('"source":"local+api"', '"source":"api"'); };
    const scope = { provider: "opencode-go", account: "go-a" };
    const first = await refreshQuota(store, scope, source(false), run, () => NOW, "a");
    expect(first.status).toBe("refreshed");
    const reused = await refreshQuota(store, scope, source(false), run, () => NOW + 60_000, "b");
    expect(reused.status).toBe("cached");
    expect(runs).toBe(1);
    await refreshQuota(store, scope, source(false), run, () => NOW + 60_000, "b", { force: true });
    expect(runs).toBe(2);
    await refreshQuota(store, scope, source(false), run, () => NOW + 60_000 + QUOTA_REFRESH_GATE_MS, "b");
    expect(runs).toBe(3);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed CodexBar run also waits out the gate instead of retrying every tick", async () => {
  const root = dir();
  try {
    const store = new HealthStore(join(root, "h.sqlite"), () => NOW);
    let runs = 0;
    const run = async () => { runs++; throw new Error("codexbar exited 1"); };
    const scope = { provider: "opencode-go", account: "go-a" };
    await refreshQuota(store, scope, source(false), run, () => NOW, "a");
    const again = await refreshQuota(store, scope, source(false), run, () => NOW + 60_000, "a");
    expect(again.status).toBe("cached");
    expect(runs).toBe(1);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("usage shows two decimals and a fill bar that matches the percentage", () => {
  expect(formatUsed(57.1234)).toBe("57.12%");
  expect(formatUsed(0)).toBe("0.00%");
  expect(usageBar(0, 10)).toBe("[░░░░░░░░░░]");
  expect(usageBar(100, 10)).toBe("[██████████]");
  expect(usageBar(57.1234, 10)).toBe("[██████░░░░]");
  expect(usageBar(150, 4)).toBe("[████]");
});
