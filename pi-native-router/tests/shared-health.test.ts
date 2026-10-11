import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HealthStore } from "../src/health-store";
import { Health, classify } from "../src/policy";
import { nativeHttpError } from "./native-error";

const child = fileURLToPath(new URL("./fixtures/health-child.ts", import.meta.url));
const dir = () => mkdtempSync(join(tmpdir(), "native-router-health-"));
async function run(path: string, command: string, args: unknown[]): Promise<unknown> {
  const proc = Bun.spawn([process.execPath, child, path, command, JSON.stringify(args)], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`child ${command} failed: ${await new Response(proc.stderr).text()}`);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

test("a quota cause written in one store is seen after reopening, and an account reset leaves the other account", () => {
  const root = dir();
  try {
    const path = join(root, "health.sqlite");
    let now = 1000;
    const first = new HealthStore(path, () => now);
    first.mark("opencode-go/m#go-a", "quota", now + 60_000, "quota");
    first.close();
    const restarted = new HealthStore(path, () => now);
    expect(restarted.blocked(["opencode-go#go-a", "opencode-go/m#go-a"])?.key).toBe("opencode-go/m#go-a");
    expect(restarted.blocked(["opencode-go#go-b", "opencode-go/m#go-b"])).toBeUndefined();
    restarted.resetAccount("go-a");
    expect(restarted.blocked(["opencode-go/m#go-a"])).toBeUndefined();
    restarted.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a successful request admitted before a newer block cannot clear it", () => {
  const root = dir();
  try {
    let now = 1000;
    const store = new HealthStore(join(root, "h.sqlite"), () => now);
    store.mark("opencode-go#go-a", "quota", now + 10_000, "quota");
    now += 10_001;
    const admittedAt = store.revision();
    store.mark("opencode-go#go-a", "quota", now + 60_000, "quota");
    store.recordSuccess(["opencode-go#go-a"], admittedAt);
    expect(store.blocked(["opencode-go#go-a"])?.kind).toBe("quota");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only one probe holder wins an expired scope; a crashed holder's lease expires and a late settle cannot clear newer health", () => {
  const root = dir();
  try {
    let now = 1000;
    const path = join(root, "h.sqlite");
    const a = new HealthStore(path, () => now, 5_000);
    const b = new HealthStore(path, () => now, 5_000);
    a.mark("opencode-go#go-a", "quota", now + 1_000, "quota");
    now += 1_001;
    expect(a.admitProbe(["opencode-go#go-a"], "holder-a")?.length).toBe(1);
    expect(b.admitProbe(["opencode-go#go-a"], "holder-b")).toBeUndefined();
    now += 5_001;
    expect(b.admitProbe(["opencode-go#go-a"], "holder-b")?.length).toBe(1);
    a.mark("opencode-go#go-a", "quota", now + 60_000, "quota");
    b.settleProbe("holder-b", true);
    expect(a.blocked(["opencode-go#go-a"])?.revision).toBeGreaterThan(0);
    a.settleProbe("holder-a", true);
    expect(a.blocked(["opencode-go#go-a"])).toBeDefined();
    a.close(); b.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an operator reset fences a probe that was in flight", () => {
  const root = dir();
  try {
    let now = 1000;
    const store = new HealthStore(join(root, "h.sqlite"), () => now);
    store.mark("opencode-go#go-a", "quota", now + 1_000, "quota");
    now += 1_001;
    expect(store.admitProbe(["opencode-go#go-a"], "probe")?.length).toBe(1);
    store.resetAccount("go-a");
    store.mark("opencode-go#go-a", "quota", now + 60_000, "quota");
    store.settleProbe("probe", true);
    expect(store.blocked(["opencode-go#go-a"])).toBeDefined();
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("when the shared store fails, routing keeps local health and reports one degradation", () => {
  const broken = { blocked() { throw new Error("database is locked"); }, mark() { throw new Error("database is locked"); } } as unknown as HealthStore;
  const reports: unknown[] = [];
  const health = new Health(() => 1000, broken, error => reports.push(error));
  const model = { provider: "opencode-go", id: "m" };
  expect(health.eligible(model, "go-a")).toBe(true);
  health.mark(model, classify({ stopReason: "error", content: [], errorMessage: "insufficient_quota" } as never, 1000), "go-a");
  expect(health.eligible(model, "go-a")).toBe(false);
  expect(health.eligible(model, "go-b")).toBe(true);
  expect(reports.length).toBeGreaterThan(0);
});

test("two real processes share a block, and simultaneous expiry yields one probe", async () => {
  const root = dir();
  try {
    const path = join(root, "h.sqlite");
    await run(path, "mark", ["opencode-go#go-a", Date.now() + 400]);
    expect(await run(path, "blocked", ["opencode-go#go-a"])).toBe("opencode-go#go-a");
    expect(await run(path, "blocked", ["opencode-go#go-b"])).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 500));
    const results = await Promise.all(["one", "two", "three"].map(holder => run(path, "admit", [["opencode-go#go-a"], holder])));
    expect(results.filter(r => r === "granted")).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("model-access 403 stays narrow and a dead key blocks the account", () => {
  const forbiddenModel = classify({ stopReason: "error", content: [], errorMessage: "403: model access not allowed for this key" } as never, 1000);
  expect(forbiddenModel).toMatchObject({ kind: "auth", scope: "model" });
  const deadKey = classify({ stopReason: "error", content: [], errorMessage: nativeHttpError(401) } as never, 1000);
  expect(deadKey).toMatchObject({ kind: "auth", scope: "provider" });
});

test("a seven-day account reset deadline is kept, not truncated to the transient cap", () => {
  const now = 1_700_000_000_000;
  const week = 7 * 24 * 3_600_000;
  const failure = classify({ stopReason: "error", content: [], errorMessage: JSON.stringify({ status: 429, scope: "provider", resetAt: now + week, message: "insufficient_quota" }) } as never, now);
  expect(failure).toMatchObject({ kind: "quota", scope: "provider" });
  expect(failure.delayMs).toBeGreaterThanOrEqual(week - 1000);
});
