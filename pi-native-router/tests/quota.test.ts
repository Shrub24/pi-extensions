import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthStore } from "../src/health-store";
import { exhaustedUntil, parseCodexbar, refreshQuota, type QuotaSource } from "../src/quota";
import { generateCodexbarConfig, stableUuid } from "../src/codexbar-config";
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
    await refreshQuota(store, { id: "go-a", provider: "opencode-go" }, source(true), async () => goOutput, () => NOW, "h1");
    expect(store.blocked(["opencode-go#go-a"])).toBeUndefined();
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("enforced exhaustion blocks the account until its reset; unenforced exhaustion only reports", async () => {
  const root = dir();
  try {
    const store = new HealthStore(join(root, "h.sqlite"), () => NOW);
    const run = async () => goOutput.replace('"source":"local+api"', '"source":"api"');
    await refreshQuota(store, { id: "go-a", provider: "opencode-go" }, source(false), run, () => NOW, "h1");
    expect(store.blocked(["opencode-go#go-a"])).toBeUndefined();
    await refreshQuota(store, { id: "go-a", provider: "opencode-go" }, source(true), run, () => NOW, "h1");
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
    const outcome = await refreshQuota(store, { id: "go-a", provider: "opencode-go" }, source(true), async () => { throw new Error("spawn codexbar ENOENT"); }, () => NOW, "h1");
    expect(outcome.status).toBe("unavailable");
    expect(store.getSnapshot("go-a")?.body).toBeNull();
    expect(store.blocked(["opencode-go#go-a"])?.kind).toBe("auth");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a healthy snapshot clears only tracker quota, never an auth block", async () => {
  const root = dir();
  try {
    const store = new HealthStore(join(root, "h.sqlite"), () => NOW);
    await refreshQuota(store, { id: "go-a", provider: "opencode-go" }, source(true), async () => goOutput, () => NOW, "h1");
    store.mark("opencode-go#go-a", "auth", NOW + 3_600_000, "auth");
    const healthy = goOutput.replace('"usedPercent":100', '"usedPercent":40');
    await refreshQuota(store, { id: "go-a", provider: "opencode-go" }, source(true), async () => healthy, () => NOW + 1, "h1");
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
  const generated = generateCodexbarConfig(accounts, { KEY_A: "synthetic-a", KEY_B: "synthetic-b" }, 1760000000);
  const [provider] = generated.document.providers as Array<Record<string, any>>;
  expect(provider.id).toBe("opencodego");
  expect(provider.source).toBe("api");
  expect(provider.tokenAccounts.accounts.map((a: { label: string }) => a.label)).toEqual(["go-a", "go-b"]);
  expect(generated.included).toEqual(["go-a", "go-b"]);
  expect(generated.skipped).toEqual([{ account: "go-c", reason: "KEY_C is not set" }]);
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
