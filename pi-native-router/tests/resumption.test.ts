import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../src/config";
import { HealthStore, type ResumeRecord } from "../src/health-store";
import { classify, Health, type Resolved } from "../src/policy";
import { installResumption, parseResume, RESUME_MESSAGE, RESUME_STATUS, type Schedule } from "../src/resumption";

function fixture(tracker = false) {
  const dir = mkdtempSync(join(tmpdir(), "router-resume-")), path = join(dir, "health.sqlite");
  let at = 1_800_000_000_000, idle = true, pending = false;
  const config = parseConfig({ providers: tracker ? { a: { quota: { source: "codexbar", provider: "a", enforce: true } } } : {}, routes: { work: { candidates: [{ provider: "a", id: "m" }] } } });
  const candidate = config.routes.work.candidates[0];
  const resolved = { candidate, model: { provider: "a", id: "m", api: "openai-completions", contextWindow: 300_000, maxTokens: 16_384 } } as Resolved;
  const store = new HealthStore(path, () => at), health = new Health(() => at, store);
  const handlers = new Map<string, Array<(e: any, c: ExtensionContext) => any>>();
  const commands = new Map<string, any>(), notices: string[] = [], statuses = new Map<string, string | undefined>();
  const branch: any[] = [];
  const sent: any[] = [], jobs = new Set<{ run: () => void; at: number }>();
  let terminalInput: ((data: string) => unknown) | undefined, refresh: () => Promise<unknown> = async () => {};
  const schedule: Schedule = (run, delay) => { const job = { run, at: at + delay }; jobs.add(job); return () => { jobs.delete(job); }; };
  const ctx = { hasUI: true, model: { provider: "route", id: "work" }, sessionManager: {
    getSessionId: () => "session", getLeafId: () => branch.at(-1)?.id ?? null, getBranch: () => branch,
  }, getContextUsage: () => ({ tokens: 20 }), isIdle: () => idle, hasPendingMessages: () => pending,
    ui: { notify: (s: string) => notices.push(s), setStatus: (k: string, s: string | undefined) => statuses.set(k, s), onTerminalInput: (cb: (data: string) => unknown) => { terminalInput = cb; return () => { terminalInput = undefined; }; } },
  } as unknown as ExtensionContext;
  const pi = { on: (name: string, fn: any) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", id: String(branch.length), customType, data }), sendMessage: (m: unknown) => sent.push(m),
  } as unknown as ExtensionAPI;
  const controller = installResumption(pi, { config, store, health, now: () => at, schedule, candidates: () => [resolved], pin: () => "a/m", refresh: () => refresh() });
  const emit = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  const cmd = async (args: string) => commands.get("route-resume").handler(args, ctx);
  const status = async () => { await cmd("status"); return notices.at(-1)!; };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const advance = async (ms: number) => { at += ms; for (const job of [...jobs]) if (job.at <= at) { jobs.delete(job); job.run(); } await flush(); };
  const failure = (errorMessage = "insufficient_quota", content: any[] = []) => ({ role: "assistant", provider: "a", model: "m", stopReason: "error", content, errorMessage, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, timestamp: at });
  async function settle(errorMessage = "insufficient_quota", content: any[] = [], delay = 1000, preceding: any[] = []) {
    const message = failure(errorMessage, content);
    const f = classify(message as never, at);
    health.mark(resolved.model, { ...f, delayMs: delay });
    branch.push({ id: String(branch.length), type: "message", message });
    await emit("agent_before_settle", { outcome: "error", context: { llmMessages: [...preceding, message] } });
    await emit("agent_settled", { aborted: false });
  }
  const snapshot = (used: number[], options: { authoritative?: boolean; observedAt?: number; revision?: number } = {}) => store.putSnapshot("a", at, {
    provider: "a", account: "a", source: "provider API", authoritative: options.authoritative ?? true, observedAt: options.observedAt ?? at, healthRevision: options.revision ?? store.revision(),
    windows: used.map((usedPercent, i) => ({ slot: i ? "secondary" : "primary", label: i ? "weekly" : "short", usedPercent, resetsAt: at + (i ? 86_400_000 : 1000) })),
  }, null);
  return { config, store, path, health, ctx, controller, emit, cmd, status, advance, settle, snapshot, sent, jobs, notices, statuses, branch,
    now: () => at, resolved, setRefresh(fn: () => Promise<unknown>) { refresh = fn; }, input(data: string) { return terminalInput?.(data); }, setIdle(v: boolean) { idle = v; }, setPending(v: boolean) { pending = v; },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("scope parser uses route by default, snapshots pins, and rejects invented accounts and invalid flags", () => {
  const route = parseConfig({ providers: { a: { accounts: { one: { apiKeyEnv: "TEST_ONLY" }, two: { apiKeyEnv: "TEST_ONLY" } } } }, routes: { r: { candidates: [{ provider: "a", id: "m", account: "one" }, { provider: "a", id: "m", account: "two" }, { provider: "b", id: "m" }] } } }).routes.r;
  expect(parseResume("once", route, "a/m#one", 1000)).toMatchObject({ scope: { kind: "route" }, deadline: 86_401_000 });
  expect(parseResume("on --scope pin", route, "a/m#one", 1000).scope).toEqual({ kind: "target", target: "a/m#one" });
  expect(parseResume("on --scope provider:a#two", route, null, 1000).scope).toEqual({ kind: "provider", provider: "a", account: "two" });
  for (const args of ["once --scope provider:b#fiction", "once --scope target:a/m", "once --scope pin", "once --scope provider:unknown", "once --until 2000", "once --until 1970-01-01T00:00:00Z", "once --scope route --scope route", "off --scope route", "once --bogus yes", "on trailing"]) expect(() => parseResume(args, route, null, 1000)).toThrow();
});

test("first user prompt preserves pre-armed permission; later actual user input cancels waiting", async () => {
  const h = fixture();
  try {
    await h.cmd("once"); await h.emit("input", { source: "interactive" }); await h.emit("before_agent_start", { messageType: "user" });
    await h.settle(); expect(await h.status()).toContain("waiting once route");
    expect(h.statuses.get(RESUME_STATUS)).toContain("waiting");
    const stale = [...h.jobs][0].run;
    await h.emit("input", { source: "rpc" });
    stale(); await h.advance(2000);
    expect(h.sent).toHaveLength(0); expect(h.jobs.size).toBe(0);
    expect(h.statuses.get(RESUME_STATUS)).toBeUndefined();
  } finally { h.close(); }
});

test("quota waiting uses Pi's context usage rather than inflating fit from transcript length", async () => {
  const h = fixture();
  try {
    await h.cmd("once");
    await h.settle("insufficient_quota", [], 1000, [{ role: "user", content: "x".repeat(1_300_000), timestamp: h.now() }]);
    expect(await h.status()).toContain("waiting once route");
    await h.advance(1001);
    expect(h.sent).toHaveLength(1);
  } finally { h.close(); }
});

test("all quota windows and provenance govern readiness; duplicate rechecks create one claim", async () => {
  const h = fixture(true);
  try {
    h.snapshot([100, 100]);
    await h.cmd("on"); await h.settle();
    await h.advance(1001); h.snapshot([10, 100]);
    await h.controller.recheck(); expect(h.sent).toHaveLength(0);
    expect(await h.status()).toContain("weekly 100%");
    h.snapshot([10, 10], { authoritative: false }); await h.controller.recheck(); expect(h.sent).toHaveLength(0);
    h.snapshot([10, 10], { observedAt: h.now() - 300_001 }); await h.controller.recheck(); expect(h.sent).toHaveLength(0);
    h.snapshot([10, 10]);
    await Promise.all([h.controller.recheck(), h.controller.recheck(), h.controller.recheck()]);
    expect(h.sent).toHaveLength(1); expect(h.jobs.size).toBe(0);
  } finally { h.close(); }
});

test("manual clear followed by tracker failure never proves quota restored", async () => {
  const h = fixture(true);
  try {
    h.snapshot([100]); h.store.reconcileTrackerQuota("a", h.now() + 1000, h.store.revision(), "tracker");
    await h.cmd("once"); await h.settle();
    h.store.resetProvider("a"); h.health.forget(() => true);
    h.store.putSnapshot("a", h.now(), null, "unavailable");
    await h.advance(2000); await h.controller.recheck();
    expect(h.sent).toHaveLength(0); expect(await h.status()).toContain("quota unknown");
  } finally { h.close(); }
});

test("new authoritative restoration clears only older quota, never newer quota or auth", async () => {
  const h = fixture(true);
  try {
    await h.cmd("on"); await h.settle("insufficient_quota", [], 86_400_000);
    const revision = h.store.revision();
    h.snapshot([10], { revision });
    h.health.mark(h.resolved.model, { kind: "quota", scope: "provider", delayMs: 86_400_000 });
    await h.controller.recheck(); expect(h.sent).toHaveLength(0);
    h.snapshot([10]);
    h.store.mark("a/m", "auth", h.now() + 1000, "auth");
    await h.controller.recheck(); expect(h.sent).toHaveLength(0);
    await h.advance(1001); await h.controller.recheck(); expect(h.sent).toHaveLength(1);
  } finally { h.close(); }
});

for (const change of ["model_select", "session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_shutdown"])
  test(`${change} fences late refresh and timer callbacks`, async () => {
    const h = fixture();
    try {
      await h.cmd("once"); await h.settle();
      let resolve!: () => void;
      h.setRefresh(() => new Promise<void>(r => { resolve = r; }));
      await h.advance(1001); expect(resolve).toBeDefined();
      await h.emit(change); resolve(); await h.advance(1000);
      expect(h.sent).toHaveLength(0); expect(h.jobs.size).toBe(0);
    } finally { h.close(); }
  });

test("terminal abort listener observes keys without consuming them; run abort cancels too", async () => {
  const h = fixture();
  try {
    for (const key of ["\x1b", "\x03"]) {
      await h.cmd("once"); await h.settle();
      expect(h.input(key)).toBeUndefined(); await h.advance(2000);
      expect(h.sent).toHaveLength(0); expect(h.jobs.size).toBe(0);
    }
    h.health.mark(h.resolved.model, { kind: "quota", scope: "provider", delayMs: 1000 });
    await h.cmd("on"); await h.settle(); await h.emit("agent_settled", { aborted: true });
    expect(await h.status()).toContain("run aborted");
  } finally { h.close(); }
});

test("idle/pending guards postpone delivery, deadline stops without passive model calls", async () => {
  const h = fixture();
  try {
    await h.cmd(`once --until ${new Date(h.now() + 10_000).toISOString()}`); await h.settle();
    h.setIdle(false); await h.advance(1001); expect(h.sent).toHaveLength(0);
    h.setIdle(true); h.setPending(true); await h.controller.recheck(); expect(h.sent).toHaveLength(0);
    await h.advance(10_000); expect(h.sent).toHaveLength(0); expect(await h.status()).toContain("deadline reached");
  } finally { h.close(); }
});

test("generation dispatch fence rejects an already queued wake after off and replacement authorization", async () => {
  const h = fixture();
  try {
    await h.cmd("once"); await h.settle(); await h.advance(1001);
    const wake = h.sent[0]; expect(wake.customType).toBe(RESUME_MESSAGE);
    await h.cmd("off"); await h.cmd("on");
    await h.emit("before_agent_start", { messageType: "custom", message: wake });
    const fence = h.controller.fence(h.ctx);
    expect(fence).toThrow("stale router resumption");
  } finally { h.close(); }
});

test("three unsuccessful actual wakes stop; polling never replenishes attempts", async () => {
  const h = fixture();
  try {
    await h.cmd("on"); await h.settle();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.advance(1001); expect(h.sent).toHaveLength(attempt);
      await h.emit("before_agent_start", { messageType: "custom", message: h.sent.at(-1) });
      await h.settle();
      for (let poll = 0; poll < 3; poll++) await h.controller.recheck();
    }
    expect(await h.status()).toContain("three unsuccessful wakes"); expect(h.jobs.size).toBe(0);
    await h.advance(500_000); expect(h.sent).toHaveLength(3);
  } finally { h.close(); }
});

for (const error of ["partial", "auth", "bad", "generic rate", "unresolved tool"])
  test(`${error} cannot create a capacity wait`, async () => {
    const h = fixture();
    try {
      await h.cmd("once");
      await h.settle(error === "auth" ? "401 unauthorized" : error === "bad" ? "invalid request" : error === "generic rate" ? "429 too many requests" : "insufficient_quota",
        error === "partial" ? [{ type: "text", text: "partial output" }] : [], 1000,
        error === "unresolved tool" ? [{ role: "assistant", content: [{ type: "toolCall", id: "pending", name: "tool", arguments: {} }] }] : []);
      expect(h.jobs.size).toBe(0); await h.advance(2000); expect(h.sent).toHaveLength(0);
    } finally { h.close(); }
  });

test("reset-bound rate permits waiting; once consumes successful progress while standing survives another pause", async () => {
  const h = fixture();
  try {
    await h.cmd("once"); await h.settle(JSON.stringify({ status: 429, retryAfterSeconds: 1 }));
    await h.advance(1001); expect(h.sent).toHaveLength(1);
    await h.emit("before_agent_start", { messageType: "custom", message: h.sent.at(-1) });
    await h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse" } });
    await h.settle(); expect(await h.status()).toContain("once permission consumed"); expect(h.jobs.size).toBe(0);
    await h.cmd("on"); await h.advance(1001);
    await h.emit("before_agent_start", { messageType: "custom", message: h.sent.at(-1) });
    await h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse" } });
    await h.settle(); expect(await h.status()).toContain("waiting on route"); expect(await h.status()).toContain("wakes: 0/3");
  } finally { h.close(); }
});

test("restore shows suspended permission, store errors suspend, ordinary candidate discovery remains available", async () => {
  const h = fixture();
  try {
    await h.cmd("once"); await h.settle();
    await h.emit("session_start"); expect(await h.status()).toContain("suspended");
    await h.advance(2000); expect(h.sent).toHaveLength(0);
    h.health.mark(h.resolved.model, { kind: "quota", scope: "provider", delayMs: 1000 });
    await h.cmd("on");
    const original = h.store.getResume.bind(h.store);
    h.store.getResume = () => { throw new Error("disk unavailable"); };
    await h.advance(1001); await h.controller.recheck();
    expect(await h.status()).toContain("suspended");
    expect(h.controller.candidates(h.config.routes.work, h.ctx)).toHaveLength(1);
    h.store.getResume = original;
  } finally { h.close(); }
});

test("atomic store claims fence a second connection and superseded generations; retention is bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-claims-")), path = join(dir, "health.sqlite");
  let at = 1_800_000_000_000;
  const a = new HealthStore(path, () => at), b = new HealthStore(path, () => at);
  const row = (id: string, session = "s"): ResumeRecord => ({ id, session, branch: "head", owner: "owner", generation: id, status: "waiting", deadline: at + 86_400_000, updated: at, body: "{}" });
  try {
    const first = row("first"); a.armResume(first);
    const claimed = { ...first, status: "waking" };
    expect(a.updateResume(claimed, "waiting")).toBe(true);
    expect(b.updateResume({ ...claimed, owner: "other" }, "waiting")).toBe(false);
    expect(b.updateResume(claimed, "waiting")).toBe(false);
    expect(a.resumeClaimValid(claimed)).toBe(true);
    at += 60_001; expect(a.resumeClaimValid(claimed)).toBe(false);
    a.armResume(row("new"));
    expect(b.updateResume({ ...claimed, status: "running" }, "waking")).toBe(false);
    for (let i = 0; i < 110; i++) {
      const next = row(`terminal-${i}`, `session-${i}`); a.armResume(next);
      expect(a.updateResume({ ...next, status: "stopped" }, "waiting")).toBe(true);
    }
    const db = new DatabaseSync(path);
    expect((db.prepare("SELECT COUNT(*) AS n FROM resume_intents WHERE status = 'stopped'").get() as { n: number }).n).toBe(100);
    at += 8 * 86_400_000;
    a.armResume(row("prune"));
    expect((db.prepare("SELECT COUNT(*) AS n FROM resume_intents WHERE status = 'stopped' AND updated < ?").get(at - 7 * 86_400_000) as { n: number }).n).toBe(0);
    db.close();
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("pin preference entries preserve the wait but a changed conversation head cancels it", async () => {
  const h = fixture();
  try {
    await h.cmd("once --scope pin"); await h.settle();
    h.branch.push({ type: "custom", id: "new-pin", customType: "physical-pin", data: { identity: "elsewhere/model" } });
    expect(await h.status()).toContain("target:a/m");
    await h.controller.recheck(); expect(await h.status()).toContain("waiting");
    h.branch.push({ type: "message", id: "new-message", message: { role: "user", content: "new task" } });
    await h.advance(1001); expect(h.sent).toHaveLength(0);
    expect(await h.status()).toContain("branch or owner changed");
  } finally { h.close(); }
});

test("off revokes suspended restored ownership, invalid input does not arm, and status never authorizes", async () => {
  const h = fixture();
  try {
    await h.cmd("once --scope provider:a#fiction"); expect(h.jobs.size).toBe(0);
    expect(await h.status()).toContain("off");
    await h.cmd("once"); await h.settle();
    const id = h.branch.find(e => e.customType?.endsWith("/resumption")).data.id;
    await h.emit("session_start"); expect(await h.status()).toContain("suspended");
    await h.cmd("off"); expect(h.store.getResume(id)?.status).toBe("stopped");
    await h.advance(1001); expect(h.sent).toHaveLength(0);
  } finally { h.close(); }
});

test("once progress keeps its execution scope and deadlines grant start permission without mid-run cancellation", async () => {
  const h = fixture();
  try {
    await h.cmd(`once --scope provider:a --until ${new Date(h.now() + 2000).toISOString()}`);
    await h.settle(); await h.advance(1001);
    await h.emit("before_agent_start", { messageType: "custom", message: h.sent.at(-1) });
    const fence = h.controller.fence(h.ctx); expect(fence).not.toThrow();
    await h.advance(5000); expect(fence).not.toThrow();
    await h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    expect(h.controller.automatic()).toBe(true);
    await h.emit("agent_settled", { aborted: false });
    expect(await h.status()).toContain("once permission consumed"); expect(h.controller.automatic()).toBe(false);
  } finally { h.close(); }
});

test("re-arming while an old refresh is unresolved cannot strand the new wait", async () => {
  const h = fixture();
  try {
    await h.cmd("once"); await h.settle();
    let resolve!: () => void;
    h.setRefresh(() => new Promise<void>(r => { resolve = r; }));
    await h.advance(1001);
    h.health.mark(h.resolved.model, { kind: "quota", scope: "provider", delayMs: 1000 });
    await h.cmd("on");
    h.setRefresh(async () => {});
    await h.advance(1001);
    expect(h.sent).toHaveLength(1);
    resolve(); await h.advance(1000);
    expect(h.sent).toHaveLength(1); expect(await h.status()).toContain("waking on route");
  } finally { h.close(); }
});

test("manual health reset alone cannot shorten a remembered physical failure deadline", async () => {
  const h = fixture();
  try {
    await h.cmd("once"); await h.settle("insufficient_quota", [], 10_000);
    h.store.resetProvider("a"); h.health.forget(() => true);
    await h.controller.recheck(); expect(h.sent).toHaveLength(0);
    await h.advance(10_001); expect(h.sent).toHaveLength(1);
  } finally { h.close(); }
});

test("explicit re-arm on a restored empty route error derives waiting from scoped health facts", async () => {
  const h = fixture(true);
  try {
    h.snapshot([100]); h.store.reconcileTrackerQuota("a", h.now() + 1000, h.store.revision(), "tracker");
    h.branch.push({ type: "message", id: "route-error", message: { role: "assistant", provider: "route", model: "work", stopReason: "error", content: [], errorMessage: "unparsed native diagnostic" } });
    await h.emit("session_start"); await h.cmd("once");
    expect(await h.status()).toContain("waiting once route"); expect(h.jobs.size).toBe(1);
    expect(h.sent).toHaveLength(0);
  } finally { h.close(); }
});
