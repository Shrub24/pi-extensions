import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { installRouter } from "../src/index";
import { cacheExpiry } from "../src/policy";
import { parseConfig } from "../src/config";
import { nativeHttpError } from "./native-error";

type Outcome = "ok" | "quota" | "transient" | "partial" | "abort" | "tool" | "bad" | 401 | 403 | 429;
async function host(outcomes: Outcome[], opts: { retry?: boolean; flush?: "failed" | "absent"; maxRecoveries?: number; maxTransitions?: number; smaller?: boolean; manager?: SessionManager; packaged?: boolean; unauthedFirst?: boolean; ttl?: number; startTime?: number; clock?: { value: number }; accounts?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "native-router-"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: opts.retry ?? false, maxRetries: 3, baseDelayMs: 1 }, cacheWarming: "off" });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const dispatches: { physical: string; context: string }[] = [];
  const order: string[] = [];
  let pending = false;
  let materialized = false;
  let toolRuns = 0;
  const clock = opts.clock ?? { value: opts.startTime ?? 1000 };
  const now = () => clock.value;
  let api: ExtensionAPI;
  const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const [provider, window] of [["fake-a", 300_000], ["fake-b", opts.smaller ? 200_000 : 300_000], ["fake-c", 300_000]] as const) {
    runtime.registerProvider(provider, {
      api: "openai-completions", baseUrl: "https://unused.invalid", apiKey: opts.accounts ? undefined : opts.unauthedFirst && provider === "fake-a" ? undefined : "fake-test-key",
      models: [{ id: "model", name: provider, reasoning: false, input: ["text"], contextWindow: window, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context) {
        const stream = createAssistantMessageEventStream();
        const outcome = outcomes.shift() ?? "ok";
        dispatches.push({ physical: model.provider, context: JSON.stringify(context) });
        order.push(`dispatch:${model.provider}`);
        const errorMessage = typeof outcome === "number" ? nativeHttpError(outcome) : outcome === "quota" ? "insufficient_quota" : outcome === "transient" ? "503 overloaded" : outcome === "partial" ? "insufficient_quota" : outcome === "bad" ? "invalid request" : undefined;
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          timestamp: now(), usage,
          stopReason: outcome === "abort" ? "aborted" : errorMessage ? "error" : outcome === "tool" ? "toolUse" : "stop",
          content: outcome === "partial" ? [{ type: "text", text: "partial completed work" }] : errorMessage || outcome === "abort" ? [] : outcome === "tool" ? [{ type: "toolCall", id: "call-1", name: "owned_tool", arguments: {} }] : [{ type: "text", text: "done" }],
          ...(errorMessage ? { errorMessage } : {}),
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
          else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
          stream.end();
        });
        return stream;
      },
    });
  }
  const config = parseConfig({ flushTimeoutMs: 10, ...(opts.accounts ? { accounts: Object.fromEntries(["fake-a", "fake-b", "fake-c"].map(provider => [`acct-${provider}`, { provider, apiKeyEnv: `NATIVE_ROUTER_TEST_KEY_${provider.replace("-", "_").toUpperCase()}` }])) } : {}), routes: { worker: { candidates: ["fake-a", "fake-b", "fake-c"].map(provider => ({ provider, id: "model", ...(opts.ttl ? { cacheTtlMs: opts.ttl } : {}), ...(opts.accounts ? { account: `acct-${provider}` } : {}) })), maxRecoveries: opts.maxRecoveries ?? 2, maxTransitions: opts.maxTransitions ?? 3 } } });
  runtime.registerVirtualModel({ provider: "route", id: "worker", name: "placeholder", route: () => { throw new Error("Adapter not installed"); } });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: opts.packaged ? [fileURLToPath(new URL("../src/index.ts", import.meta.url))] : [],
    extensionFactories: [pi => {
      api = pi;
      if (opts.flush !== "absent") pi.events.on("magic-context:flush", (payload: unknown) => {
        const { sessionId } = payload as { sessionId: string };
        order.push("flush");
        // Mirrors the public MC protocol: flush sets flags, context consumes them.
        pending = true;
        pi.events.emit("magic-context:flush-result", { sessionId: "different-session", status: "success" });
        pi.events.emit("magic-context:flush-result", { sessionId, status: opts.flush === "failed" ? "failed" : "success", reason: opts.flush === "failed" ? "flush-failed" : undefined });
      });
      pi.on("context", event => {
        order.push("context");
        if (pending) { pending = false; materialized = true; order.push("materialized"); }
        return materialized ? { messages: [...event.messages, { role: "user", content: "MATERIALIZED DROP RESULT", timestamp: 1 }] } : undefined;
      });
      if (!opts.packaged) installRouter(pi, config, { now, healthPath: join(dir, "health.sqlite") });
      pi.events.on("native-router:transition", () => order.push("transition"));
    }],
  });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (opts.packaged) {
    const { pricingOverrides, ...parsedRest } = config;
    // Settings hold the raw user shape: pricing overrides live under `pricing.overrides`.
    const raw = { ...parsedRest, ...(Object.keys(pricingOverrides).length ? { pricing: { overrides: pricingOverrides } } : {}) };
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ kendex: { extensionManager: { config: { "@vanillagreen/pi-native-router": raw } } } }));
    process.env.PI_CODING_AGENT_DIR = dir;
  }
  try { await loader.reload(); }
  finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  const manager = opts.manager ?? SessionManager.inMemory(dir);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("route", "worker")!, thinkingLevel: "off", settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: ["owned_tool"], customTools: [{ name: "owned_tool", label: "Owned", description: "Count owned executions", parameters: { type: "object", properties: {} } as never, execute: async () => { toolRuns++; return { content: [{ type: "text", text: "tool finished" }], details: {} }; } }] });
  return { session, runtime, manager, dispatches, order, api: api!, clock, get toolRuns() { return toolRuns; }, close() { session.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test("initial selection skips an unconfigured native provider without flushing", async () => {
  const h = await host(["ok"], { unauthedFirst: true });
  try { await h.session.prompt("initial auth selection"); expect(h.dispatches.map(d => d.physical)).toEqual(["fake-b"]); expect(h.order).not.toContain("flush"); }
  finally { h.close(); }
});

test("native terminal recovery materializes flushed context before replacement, preserves physical accounting and stickiness", async () => {
  const h = await host(["quota", "ok", "ok"]);
  try {
    await h.session.prompt("hello");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-b"]);
    expect(h.dispatches[1].context).toContain("MATERIALIZED DROP RESULT");
    expect(h.order).toEqual(["context", "dispatch:fake-a", "flush", "transition", "context", "materialized", "dispatch:fake-b"]);
    expect(h.session.model?.provider).toBe("route");
    expect(h.session.messages.at(-1)).toMatchObject({ provider: "fake-b", model: "model" });
    await h.session.prompt("next");
    expect(h.dispatches.at(-1)?.physical).toBe("fake-b");
    expect(h.order.filter(x => x === "flush")).toHaveLength(1);
    expect(h.manager.getBranch().some(e => e.type === "context_edit" && e.replacement === null)).toBe(true);
  } finally { h.close(); }
});

for (const status of [401, 403, 429] as const) test(`native HTTP ${status} recovers through ${status === 429 ? "native retry" : "terminal settlement"} and retains fallback`, async () => {
  const h = await host([status, "ok", "ok"], { retry: status === 429 });
  let nativeRetries = 0;
  h.session.subscribe(event => { if (event.type === "auto_retry_start") nativeRetries++; });
  try {
    await h.session.prompt("native status failure");
    expect(nativeRetries).toBe(status === 429 ? 1 : 0);
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-b"]);
    expect(h.dispatches[1].context).toContain("MATERIALIZED DROP RESULT");
    expect(h.order.filter(x => x === "flush")).toHaveLength(1);
    await h.session.prompt("after recovery");
    expect(h.dispatches.at(-1)?.physical).toBe("fake-b");
  } finally { h.close(); }
});

test("same-model TTL expiry flushes materialized context once and emits only estimated invalidation", async () => {
  const h = await host(["ok", "ok"], { ttl: 100 });
  const invalidations: unknown[] = [];
  const transitions: unknown[] = [];
  h.api.events.on("native-router:estimated-cache-invalidation", event => invalidations.push(event));
  h.api.events.on("native-router:transition", event => transitions.push(event));
  try {
    await h.session.prompt("seed successful cache activity");
    expect(h.manager.getBranch().some(e => e.type === "custom" && e.customType === "@vanillagreen/pi-native-router/cache-activity")).toBe(true);
    h.clock.value += 100;
    await h.session.prompt("expired but same sticky route");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-a"]);
    expect(h.dispatches.at(-1)?.context).toContain("MATERIALIZED DROP RESULT");
    expect(h.order.filter(x => x === "flush")).toHaveLength(1);
    expect(transitions).toHaveLength(0);
    expect(invalidations).toHaveLength(1);
    expect(h.manager.getBranch().some(e => e.type === "custom" && e.customType === "@vanillagreen/pi-native-router/cache-activity" && (e.data as { consumedAt?: number }).consumedAt !== undefined)).toBe(true);
  } finally { h.close(); }
});

test("cache policy ignores aborted, direct and failed activity and honors a persisted successful epoch", async () => {
  const h = await host(["ok", "quota", "ok"], { ttl: 100 });
  try {
    await h.session.prompt("successful activity");
    h.clock.value += 99;
    const activity = () => h.manager.getBranch().filter((e): e is Extract<typeof e, { type: "custom" }> => e.type === "custom" && e.customType === "@vanillagreen/pi-native-router/cache-activity").map(e => e.data);
    const before = activity();
    await h.runtime.completeSimple(h.runtime.getModel("route", "worker")!, { messages: [{ role: "user", content: "direct", timestamp: 1 }] });
    expect(activity()).toEqual(before);
    await h.session.prompt("failed request must not stamp");
    expect(activity()).toHaveLength(2);
    expect(activity()[1]).toMatchObject({ at: 1099, physical: "fake-a/model" });
    expect(h.order).not.toContain("flush");
  } finally { h.close(); }
});

test("expiry and physical switch share one flush and only physical change increments transition", async () => {
  const h = await host(["ok", "transient", "quota", "ok"], { ttl: 100, retry: true });
  const transitions: unknown[] = [];
  const invalidations: unknown[] = [];
  h.api.events.on("native-router:transition", event => transitions.push(event));
  h.api.events.on("native-router:estimated-cache-invalidation", event => invalidations.push(event));
  try {
    await h.session.prompt("seed activity");
    h.clock.value += 100;
    await h.session.prompt("expired then fallback");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-a", "fake-a", "fake-b"]);
    expect(h.order.filter(x => x === "flush")).toHaveLength(2);
    expect(transitions).toHaveLength(1);
    expect(invalidations).toHaveLength(1);
  } finally { h.close(); }
});

test("TTL flush failure does not dispatch or consume the expired epoch", async () => {
  const h = await host(["ok", "ok"], { ttl: 100, flush: "failed" });
  try {
    await h.session.prompt("seed");
    h.clock.value += 100;
    await h.session.prompt("flush refused");
    expect(h.dispatches).toHaveLength(1);
    const entries = h.manager.getBranch().filter(e => e.type === "custom" && e.customType === "@vanillagreen/pi-native-router/cache-activity");
    const last = entries.at(-1);
    expect(last?.type === "custom" ? (last.data as { consumedAt?: number }).consumedAt : undefined).toBeUndefined();
  } finally { h.close(); }
});

test("native retry stays once, then migrates and consumes flush flags in the retry context pass", async () => {
  const h = await host(["transient", "transient", "ok"], { retry: true });
  try {
    await h.session.prompt("retry");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-a", "fake-b"]);
    expect(h.dispatches[2].context).toContain("MATERIALIZED DROP RESULT");
    expect(h.order.filter(x => x === "flush")).toHaveLength(1);
  } finally { h.close(); }
});

test("native continuation does not replay completed tools during terminal failover", async () => {
  const h = await host(["tool", "quota", "ok"]);
  try {
    h.session.setActiveToolsByName(["owned_tool"]);
    await h.session.prompt("use tool");
    expect(h.toolRuns).toBe(1);
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-a", "fake-b"]);
    expect(h.dispatches.at(-1)?.context).toContain("tool finished");
  } finally { h.close(); }
});

for (const outcome of ["partial", "abort", "bad"] as const) test(`${outcome} settles without migration`, async () => {
  const h = await host([outcome, "ok"]);
  try { await h.session.prompt("safe refusal"); expect(h.dispatches).toHaveLength(1); expect(h.order).not.toContain("flush"); }
  finally { h.close(); }
});

test("zero transition budget stops native retry migration without a flush", async () => {
  const h = await host(["transient", "transient", "ok"], { retry: true, maxTransitions: 0 });
  try { await h.session.prompt("bounded retries"); expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-a"]); expect(h.order).not.toContain("flush"); expect(h.session.isStreaming).toBe(false); }
  finally { h.close(); }
});

test("provider exhaustion and terminal recovery budget settle without loops", async () => {
  for (const maxRecoveries of [1, 2]) {
    const h = await host(["quota", "quota", "quota", "ok"], { maxRecoveries });
    try { await h.session.prompt("exhaust"); expect(h.dispatches).toHaveLength(maxRecoveries + 1); expect(h.session.isStreaming).toBe(false); }
    finally { h.close(); }
  }
});

for (const flush of ["failed", "absent"] as const) test(`flush ${flush} blocks replacement dispatch`, async () => {
  const h = await host(["quota", "ok"], { flush });
  try {
    await h.session.prompt("flush failure");
    expect(h.dispatches).toHaveLength(1);
    expect(h.session.messages.at(-1)).toMatchObject({ stopReason: "error" });
    expect(h.order).not.toContain("transition");
  } finally { h.close(); }
});

test("smaller fallback is skipped even when small request would fit", async () => {
  const h = await host(["quota", "ok"], { smaller: true });
  try { await h.session.prompt("tiny"); expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-c"]); }
  finally { h.close(); }
});

test("restored branch retains expired cache age and consumed epoch", async () => {
  const first = await host(["ok"], { ttl: 100 });
  try {
    await first.session.prompt("successful activity");
    first.clock.value += 100;
    const restored = SessionManager.inMemory(first.manager.getHeader()!.cwd!, undefined, JSON.parse(JSON.stringify([first.manager.getHeader(), ...first.manager.getBranch()])));
    const second = await host(["ok"], { manager: restored, ttl: 100, clock: first.clock });
    try {
      await second.session.prompt("restored expiry");
      expect(second.order.filter(x => x === "flush")).toHaveLength(1);
      const restoredAgain = SessionManager.inMemory(restored.getHeader()!.cwd!, undefined, JSON.parse(JSON.stringify([restored.getHeader(), ...restored.getBranch()])));
      const third = await host(["ok"], { manager: restoredAgain, ttl: 100, clock: first.clock });
      try { await third.session.prompt("consumed expiry stays consumed"); expect(third.order).not.toContain("flush"); }
      finally { third.close(); }
    } finally { second.close(); }
  } finally { first.close(); }
});

test("branch restore/fork retains fallback and capacity floor in a fresh adapter process", async () => {
  const first = await host(["quota", "ok"]);
  try {
    await first.session.prompt("parent");
    const header = first.manager.getHeader()!;
    const entries = first.manager.getBranch();
    const restored = SessionManager.inMemory(header.cwd!, undefined, JSON.parse(JSON.stringify([header, ...entries])));
    const second = await host(["ok"], { manager: restored });
    try { await second.session.prompt("restored/forked branch"); expect(second.dispatches.map(d => d.physical)).toEqual(["fake-b"]); expect(second.order).not.toContain("flush"); }
    finally { second.close(); }
  } finally { first.close(); }
});

test("native direct routing does not change branch state or trigger session flush", async () => {
  const h = await host(["ok", "ok"]);
  try {
    const before = h.manager.getBranch();
    await h.runtime.completeSimple(h.runtime.getModel("route", "worker")!, { messages: [{ role: "user", content: "auxiliary", timestamp: 1 }] });
    expect(h.manager.getBranch()).toEqual(before);
    expect(h.order).not.toContain("flush");
    await h.session.prompt("session");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-a"]);
  } finally { h.close(); }
});

test("compaction and changed physical limits preserve the branch capacity floor", async () => {
  const first = await host(["quota", "ok"]);
  try {
    await first.session.prompt("parent");
    first.manager.appendCompaction("summary", null, 10);
    const second = await host(["ok"], { manager: SessionManager.inMemory(process.cwd(), undefined, JSON.parse(JSON.stringify([first.manager.getHeader(), ...first.manager.getBranch()]))), smaller: true });
    try { await second.session.prompt("after compaction and catalog change"); expect(second.dispatches.map(d => d.physical)).toEqual(["fake-a"]); }
    finally { second.close(); }
  } finally { first.close(); }
});

test("awaitable transition subscribers gate actual native replacement dispatch", async () => {
  const h = await host(["quota", "ok"]);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entry = new Promise<void>(resolve => { entered = resolve; });
  h.api.events.on("native-router:before-transition", payload => {
    (payload as { waitUntil(promise: Promise<void>): void }).waitUntil(gate);
    entered();
  });
  try {
    const run = h.session.prompt("gate replacement");
    await entry;
    expect(h.dispatches).toHaveLength(1);
    release();
    await run;
    expect(h.dispatches).toHaveLength(2);
  } finally { release(); h.close(); }
});

test("installed extension entry registers the same native route for parent and worker sessions", async () => {
  for (const prompt of ["parent request", "worker assignment"]) {
    const h = await host(["quota", "ok"], { packaged: true });
    try { await h.session.prompt(prompt); expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-b"]); }
    finally { h.close(); }
  }
});

test("abort during transition handshake prevents replacement and settles the native host", async () => {
  const h = await host(["quota", "ok"], { flush: "absent" });
  h.api.events.on("magic-context:flush", () => { void h.session.abort(); });
  try { await h.session.prompt("abort flush"); expect(h.dispatches).toHaveLength(1); expect(h.order).not.toContain("transition"); expect(h.session.isStreaming).toBe(false); }
  finally { h.close(); }
});

test("named accounts activate their own key on fallback and the native provider still dispatches", async () => {
  const keys = { NATIVE_ROUTER_TEST_KEY_FAKE_A: "synthetic-key-a", NATIVE_ROUTER_TEST_KEY_FAKE_B: "synthetic-key-b", NATIVE_ROUTER_TEST_KEY_FAKE_C: "synthetic-key-c" };
  for (const [name, value] of Object.entries(keys)) process.env[name] = value;
  const h = await host(["quota", "ok"], { accounts: true });
  const announced: unknown[] = [];
  h.api.events.on("native-router:account-active", event => announced.push(event));
  try {
    await h.session.prompt("account fallback");
    expect(announced).toEqual([{ provider: "fake-a", account: "acct-fake-a" }, { provider: "fake-b", account: "acct-fake-b" }]);
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-b"]);
    expect((await h.runtime.getAuth("fake-b"))?.auth.apiKey).toBe("synthetic-key-b");
    expect(h.session.messages.at(-1)).toMatchObject({ provider: "fake-b", model: "model" });
  } finally { h.close(); for (const name of Object.keys(keys)) delete process.env[name]; }
});

test("a named account without its key environment variable is unavailable and never falls back to another key", async () => {
  delete process.env.NATIVE_ROUTER_TEST_KEY_FAKE_A;
  process.env.NATIVE_ROUTER_TEST_KEY_FAKE_B = "synthetic-key-b";
  process.env.NATIVE_ROUTER_TEST_KEY_FAKE_C = "synthetic-key-c";
  const h = await host(["ok"], { accounts: true });
  try {
    await h.session.prompt("missing account key");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-b"]);
    expect(await h.runtime.getAuth("fake-a")).toBeUndefined();
  } finally { h.close(); delete process.env.NATIVE_ROUTER_TEST_KEY_FAKE_B; delete process.env.NATIVE_ROUTER_TEST_KEY_FAKE_C; }
});
