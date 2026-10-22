import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { admissionKeys, cacheExpiry } from "../src/policy";
import { HealthStore } from "../src/health-store";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { installRouter } from "../src/index";
import { FOOTER_KEYS, PIN_FALLBACK_GLYPH, PIN_GLYPH } from "../src/footer";
import { parseConfig } from "../src/config";
import { nativeHttpError } from "./native-error";

type Routing = { accounts: string[]; candidates: Array<{ provider: string; account?: string }> };
/** Synthetic env name for a test account; keys are set by each test and never printed. */
const accountEnv = (id: string) => `NATIVE_ROUTER_TEST_KEY_${id.replace(/-/g, "_").toUpperCase()}`;
type Outcome = "ok" | "quota" | "transient" | "stream-ended" | "partial" | "abort" | "tool" | "bad" | 401 | 403 | 429;
async function host(outcomes: Outcome[], opts: { reasoning?: boolean; candidateThinking?: "off" | "low" | "medium" | "high"; retry?: boolean; flush?: "failed" | "absent"; maxRecoveries?: number; maxTransitions?: number; smaller?: number; manager?: SessionManager; packaged?: boolean; unauthedFirst?: boolean; ttl?: number; startTime?: number; clock?: { value: number }; accounts?: boolean; providerKeys?: boolean; healthPath?: string; decisionLogPath?: string; heldProbe?: boolean; routing?: Routing; runtimeKeys?: "absent" | "inert"; wide?: boolean; contextWindow?: number; maxTokens?: number; strategy?: "prefer-b" | "missing" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "native-router-"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: opts.retry ?? false, maxRetries: 3, baseDelayMs: 1 }, cacheWarming: "off" });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  // Simulates a host without runtime key activation ("absent") or one whose activation does not take effect ("inert").
  if (opts.runtimeKeys) Object.defineProperty(runtime, "setRuntimeApiKey", { value: opts.runtimeKeys === "absent" ? undefined : () => {}, configurable: true });
  const dispatches: { physical: string; context: string; thinking?: string }[] = [];
  const order: string[] = [];
  let pending = false;
  let materialized = false;
  let toolRuns = 0;
  const clock = opts.clock ?? { value: opts.startTime ?? 1000 };
  const now = () => clock.value;
  let api: ExtensionAPI;
  const commands = new Map<string, unknown>();
  const shortcuts = new Map<string, unknown>();
  // Event handlers, so a test can drive Pi events (model_select, message_end) with a UI context.
  const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
  const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  // `fake-d/wide` is registered but belongs to no route: it stands in for a model from another route.
  const providers = [["fake-a", opts.contextWindow ?? 300_000], ["fake-b", opts.smaller ?? 300_000], ["fake-c", 300_000], ...(opts.wide ? [["fake-d", 1_000_000] as const] : [])] as const;
  for (const [provider, window] of providers) {
    runtime.registerProvider(provider, {
      api: "openai-completions", baseUrl: "https://unused.invalid", apiKey: opts.routing ? (opts.routing.candidates.some(c => c.provider === provider && c.account === undefined) ? "fake-test-key" : undefined) : opts.accounts || opts.providerKeys ? undefined : opts.unauthedFirst && provider === "fake-a" ? undefined : "fake-test-key",
      models: [{ id: opts.wide && provider === "fake-d" ? "wide" : "model", name: provider, reasoning: opts.reasoning ?? false, input: ["text"], contextWindow: window, maxTokens: opts.maxTokens ?? 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context, streamOptions) {
        const stream = createAssistantMessageEventStream();
        const outcome = outcomes.shift() ?? "ok";
        dispatches.push({ physical: model.provider, context: JSON.stringify(context), thinking: (streamOptions as { reasoning?: string } | undefined)?.reasoning });
        order.push(`dispatch:${model.provider}`);
        const errorMessage = typeof outcome === "number" ? nativeHttpError(outcome) : outcome === "quota" ? "insufficient_quota" : outcome === "transient" ? "503 overloaded" : outcome === "stream-ended" ? "Stream ended without finish_reason" : outcome === "partial" ? "insufficient_quota" : outcome === "bad" ? "invalid request" : undefined;
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
  const routed = opts.routing;
  // Shared provider settings: one key per provider, or named accounts when the host routes several keys.
  const sharedProviders: Record<string, { apiKeyEnv?: string; accounts?: Record<string, { apiKeyEnv: string }> }> = {};
  if (opts.providerKeys) for (const provider of ["fake-a", "fake-b", "fake-c"]) sharedProviders[provider] = { apiKeyEnv: accountEnv(provider) };
  if (routed) for (const id of routed.accounts) {
    const provider = routed.candidates.find(c => c.account === id)!.provider;
    sharedProviders[provider] = { accounts: { ...sharedProviders[provider]?.accounts, [id]: { apiKeyEnv: accountEnv(id) } } };
  }
  else if (opts.accounts) for (const provider of ["fake-a", "fake-b", "fake-c"]) sharedProviders[provider] = { accounts: { [`acct-${provider}`]: { apiKeyEnv: `NATIVE_ROUTER_TEST_KEY_${provider.replace("-", "_").toUpperCase()}` } } };
  const healthPath = opts.healthPath ?? join(dir, "health.sqlite");
  if (opts.heldProbe) {
    const seeded = new HealthStore(healthPath, now);
    const keys = admissionKeys({ provider: "fake-b", id: "model" });
    seeded.mark(keys[0], "quota", now(), "fixture-expired-quota");
    expect(seeded.admitProbe(keys, "another-process")).toBeDefined();
    seeded.close();
  }
  const strategyPath = opts.strategy ? join(dir, "strategy.ts") : undefined;
  if (strategyPath && opts.strategy === "prefer-b") writeFileSync(strategyPath, 'export default { version: 1, choose: (context: { currentTargetId?: string; eligibleTargetIds: string[]; excludedTargetIds: string[]; targets: { account?: string; pricing: { status: string }; switchingCost: { status: string }; targetId: string }[] }) => { if (!Object.isFrozen(context) || Object.keys(context).some(key => /message|credential|apiKey|secret/i.test(key)) || context.targets.length !== 3 || context.targets.some(t => (t.account !== undefined && !t.targetId.endsWith(`#${t.account}`)) || t.pricing.status === "complete" || t.switchingCost.status !== (t.targetId === context.currentTargetId ? "same-target" : "unknown") || Object.keys(t).some(key => /key|secret|credential/i.test(key)))) throw new Error("unsafe or fabricated snapshot"); const target = context.currentTargetId?.startsWith("fake-b/") || context.excludedTargetIds.some(id => id.startsWith("fake-b/")) ? "fake-c/" : "fake-b/"; return { targetId: context.eligibleTargetIds.find(id => id.startsWith(target))!, reason: `test strategy selects ${target}` }; } };');
  const raw = { flushTimeoutMs: 10, providers: sharedProviders, routes: { worker: { ...(strategyPath ? { strategy: { module: strategyPath, options: {} } } : {}), candidates: routed ? routed.candidates.map(c => ({ provider: c.provider, id: "model", thinkingLevel: opts.candidateThinking ?? "off", ...(opts.ttl ? { cacheTtlMs: opts.ttl } : {}), ...(c.account ? { account: c.account } : {}) })) : ["fake-a", "fake-b", "fake-c"].map(provider => ({ provider, id: "model", thinkingLevel: opts.candidateThinking ?? "off", ...(opts.ttl ? { cacheTtlMs: opts.ttl } : {}), ...(opts.accounts ? { account: `acct-${provider}` } : {}) })), maxRecoveries: opts.maxRecoveries ?? 2, maxTransitions: opts.maxTransitions ?? 3 } } };
  const config = parseConfig(raw);
  const decisionLogPath = opts.decisionLogPath ?? join(dir, "decisions.jsonl");
  runtime.registerVirtualModel({ provider: "route", id: "worker", name: "placeholder", route: () => { throw new Error("Adapter not installed"); } });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: opts.packaged ? [fileURLToPath(new URL("../src/index.ts", import.meta.url))] : [],
    extensionFactories: [pi => {
      api = pi;
      const instrumented = new Proxy(pi, { get(target, property) {
        if (property === "registerCommand") return (name: string, command: unknown) => {
          commands.set(name, command);
          return (Reflect.get(target, property, target) as (...args: unknown[]) => unknown).call(target, name, command);
        };
        if (property === "on") return (event: string, handler: (event: never, ctx: never) => unknown) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
          return (Reflect.get(target, property, target) as (...args: unknown[]) => unknown).call(target, event, handler);
        };
        if (property === "registerShortcut") return (key: string, shortcut: unknown) => {
          shortcuts.set(key, shortcut);
          return (Reflect.get(target, property, target) as (...args: unknown[]) => unknown).call(target, key, shortcut);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
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
      if (!opts.packaged) installRouter(instrumented, config, { now, healthPath, decisionLogPath });
      pi.events.on("native-router:transition", () => order.push("transition"));
    }],
  });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (opts.packaged) {
    // Settings hold the raw user shape, exactly as the packaged entry will read it.
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ "pi-native-router": raw }));
    process.env.PI_CODING_AGENT_DIR = dir;
  }
  try { await loader.reload(); }
  finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  const manager = opts.manager ?? SessionManager.inMemory(dir);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("route", "worker")!, thinkingLevel: "off", settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: ["owned_tool"], customTools: [{ name: "owned_tool", label: "Owned", description: "Count owned executions", parameters: { type: "object", properties: {} } as never, execute: async () => { toolRuns++; return { content: [{ type: "text", text: "tool finished" }], details: {} }; } }] });
  return { session, runtime, manager, dispatches, order, api: api!, commands, shortcuts, handlers, clock, decisionLogPath, get toolRuns() { return toolRuns; }, close() { session.dispose(); rmSync(dir, { recursive: true, force: true }); } };
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

test("empty premature streams retry safely once then migrate through the native fallback path", async () => {
  const h = await host(["stream-ended", "stream-ended", "ok"], { retry: true });
  try {
    await h.session.prompt("provider ended the stream before finish_reason");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-a", "fake-b"]);
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

for (const outcome of ["partial", "abort", "bad"] as const) test(`${outcome} settles without migration${outcome === "partial" ? " under a custom strategy" : ""}`, async () => {
  const h = await host([outcome, "ok"], { strategy: outcome === "partial" ? "prefer-b" : undefined });
  try {
    await h.session.prompt("safe refusal");
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0].physical).toBe(outcome === "partial" ? "fake-b" : "fake-a");
    expect(h.order).not.toContain("flush");
  } finally { h.close(); }
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

test("a model from another route does not change this route's capacity requirement", async () => {
  const h = await host(["ok"], { wide: true });
  try {
    // The conversation's latest successful response came from a 1M-window model that is not a worker candidate.
    h.manager.appendMessage({
      role: "assistant", api: "openai-completions", provider: "fake-d", model: "wide", timestamp: 2,
      content: [{ type: "text", text: "answer from the other route" }], stopReason: "stop",
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } as never);
    await h.session.prompt("switched back to the worker route");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a"]);
  } finally { h.close(); }
});

test("routed fit uses Pi's usage-aware context count and the route's output reserve", async () => {
  const h = await host(["ok"], { contextWindow: 272_000, maxTokens: 128_000, wide: true });
  try {
    // The chars/4 estimate is 228,946, but Pi's latest provider usage (and footer context count) is 158k.
    // With the route's 8k reserve, the 272k candidate fits; its 128k maximum output is not a required reserve.
    h.manager.appendMessage({
      role: "assistant", api: "openai-completions", provider: "fake-d", model: "wide", timestamp: 2,
      content: [{ type: "text", text: "x".repeat(915_784) }], stopReason: "stop",
      usage: { input: 158_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 158_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } as never);
    await h.session.prompt("continue");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a"]);
  } finally { h.close(); }
});

test("a fallback that still honours the route's declared capacity is used", async () => {
  const h = await host(["quota", "ok"], { smaller: 200_000 });
  try { await h.session.prompt("tiny"); expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-b"]); }
  finally { h.close(); }
});

test("a candidate below the route's declared capacity is never selected", async () => {
  const h = await host(["quota", "ok"], { smaller: 100_000 });
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

test("branch restore/fork retains the fallback selection in a fresh adapter process", async () => {
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

test("native direct routing uses the strategy without changing branch state or triggering a session flush", async () => {
  const h = await host(["ok", "ok"], { strategy: "prefer-b" });
  try {
    const before = h.manager.getBranch();
    await h.runtime.completeSimple(h.runtime.getModel("route", "worker")!, { messages: [{ role: "user", content: "auxiliary", timestamp: 1 }] });
    expect(h.manager.getBranch()).toEqual(before);
    expect(h.order).not.toContain("flush");
    await h.session.prompt("session");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-b", "fake-b"]);
  } finally { h.close(); }
});

test("compaction and a changed provider window keep the route capacity requirement", async () => {
  const first = await host(["quota", "ok"]);
  try {
    await first.session.prompt("parent");
    first.manager.appendCompaction("summary", null, 10);
    const second = await host(["ok"], { manager: SessionManager.inMemory(process.cwd(), undefined, JSON.parse(JSON.stringify([first.manager.getHeader(), ...first.manager.getBranch()]))), smaller: 100_000 });
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

test("rotating between two accounts of one provider is a same-model account change: one flush, one counted transition, and cache activity for the account that answered", async () => {
  process.env.NATIVE_ROUTER_TEST_KEY_POOL_ONE = "synthetic-pool-one";
  process.env.NATIVE_ROUTER_TEST_KEY_POOL_TWO = "synthetic-pool-two";
  const routing = { accounts: ["pool-one", "pool-two"], candidates: [{ provider: "fake-a", account: "pool-one" }, { provider: "fake-a", account: "pool-two" }] };
  const h = await host(["quota", "ok"], { routing });
  const transitions: unknown[] = [];
  h.api.events.on("native-router:transition", event => transitions.push(event));
  try {
    await h.session.prompt("account rotation");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-a"]);
    expect(h.order.filter(step => step === "flush")).toHaveLength(1);
    expect(transitions).toEqual([expect.objectContaining({ from: "fake-a/model#pool-one", to: "fake-a/model#pool-two" })]);
    expect((await h.runtime.getAuth("fake-a"))?.auth.apiKey).toBe("synthetic-pool-two");
    const model = h.runtime.getModel("fake-a", "model")!;
    expect(model).toMatchObject({ api: "openai-completions", baseUrl: "https://unused.invalid" });
    const activity = h.manager.getBranch().filter(e => e.type === "custom" && e.customType === "@vanillagreen/pi-native-router/cache-activity").map(e => (e as { data: { physical: string } }).data.physical);
    expect(activity.at(-1)).toBe("fake-a/model#pool-two");
  } finally { h.close(); delete process.env.NATIVE_ROUTER_TEST_KEY_POOL_ONE; delete process.env.NATIVE_ROUTER_TEST_KEY_POOL_TWO; }
});

test("a failed flush blocks the same-model account change: the second account never dispatches", async () => {
  process.env.NATIVE_ROUTER_TEST_KEY_POOL_ONE = "synthetic-pool-one";
  process.env.NATIVE_ROUTER_TEST_KEY_POOL_TWO = "synthetic-pool-two";
  const routing = { accounts: ["pool-one", "pool-two"], candidates: [{ provider: "fake-a", account: "pool-one" }, { provider: "fake-a", account: "pool-two" }] };
  const h = await host(["quota", "ok"], { routing, flush: "failed" });
  try {
    await h.session.prompt("blocked rotation");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a"]);
    expect((await h.runtime.getAuth("fake-a"))?.auth.apiKey).toBe("synthetic-pool-one");
  } finally { h.close(); delete process.env.NATIVE_ROUTER_TEST_KEY_POOL_ONE; delete process.env.NATIVE_ROUTER_TEST_KEY_POOL_TWO; }
});

test("a host without runtime key activation never dispatches a named account and keeps the default-auth candidate usable", async () => {
  process.env.NATIVE_ROUTER_TEST_KEY_NAMED = "synthetic-named";
  const routing = { accounts: ["named"], candidates: [{ provider: "fake-a", account: "named" }, { provider: "fake-b" }] };
  const h = await host(["ok"], { routing, runtimeKeys: "absent" });
  const unavailable: unknown[] = [];
  h.api.events.on("native-router:account-unavailable", event => unavailable.push(event));
  try {
    await h.session.prompt("default fallback");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-b"]);
    expect(unavailable).toEqual([]);
  } finally { h.close(); delete process.env.NATIVE_ROUTER_TEST_KEY_NAMED; }
});

test("when activation cannot be verified the route fails closed before any dispatch with the account unavailable", async () => {
  process.env.NATIVE_ROUTER_TEST_KEY_NAMED = "synthetic-named";
  const routing = { accounts: ["named"], candidates: [{ provider: "fake-a", account: "named" }] };
  const h = await host(["ok"], { routing, runtimeKeys: "inert" });
  const unavailable: unknown[] = [];
  h.api.events.on("native-router:account-unavailable", event => unavailable.push(event));
  try {
    await h.session.prompt("verification failure");
    expect(h.dispatches).toEqual([]);
    expect(unavailable).toEqual([expect.objectContaining({ provider: "fake-a", account: "named" })]);
    expect((h.session.messages.at(-1) as { errorMessage?: string }).errorMessage).toContain("could not be verified");
  } finally { h.close(); delete process.env.NATIVE_ROUTER_TEST_KEY_NAMED; }
});

test("a named-only route on a host without key activation fails with an actionable error and no dispatch", async () => {
  process.env.NATIVE_ROUTER_TEST_KEY_NAMED = "synthetic-named";
  const routing = { accounts: ["named"], candidates: [{ provider: "fake-a", account: "named" }] };
  const h = await host(["ok"], { routing, runtimeKeys: "absent" });
  try {
    await h.session.prompt("named only");
    expect(h.dispatches).toEqual([]);
    expect((h.session.messages.at(-1) as { errorMessage?: string }).errorMessage).toMatch(/does not expose runtime key activation/);
  } finally { h.close(); delete process.env.NATIVE_ROUTER_TEST_KEY_NAMED; }
});

test("a quota block recorded by one session steers another on the shared store, survives a restart, and then admits one recovery probe", async () => {
  const shared = mkdtempSync(join(tmpdir(), "native-router-shared-"));
  const healthPath = join(shared, "health.sqlite");
  const clock = { value: 1000 };
  try {
    const first = await host(["quota", "ok"], { healthPath, clock });
    try {
      await first.session.prompt("first session discovers the quota block");
      expect(first.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-b"]);
    } finally { first.close(); }

    const second = await host(["ok"], { healthPath, clock });
    try {
      await second.session.prompt("second session skips the blocked account");
      expect(second.dispatches.map(d => d.physical)).toEqual(["fake-b"]);
    } finally { second.close(); }

    clock.value += 60_000;
    const restarted = await host(["ok"], { healthPath, clock });
    try {
      await restarted.session.prompt("restarted session still skips it before the reset deadline");
      expect(restarted.dispatches.map(d => d.physical)).toEqual(["fake-b"]);
    } finally { restarted.close(); }

    clock.value += 300_000;
    const probing = await host(["ok"], { healthPath, clock });
    try {
      await probing.session.prompt("after the deadline one session probes the recovered account");
      expect(probing.dispatches.map(d => d.physical)).toEqual(["fake-a"]);
    } finally { probing.close(); }
    const store = new HealthStore(healthPath, () => clock.value);
    expect(store.blocked(["fake-a"])).toBeUndefined();
    store.close();
  } finally { rmSync(shared, { recursive: true, force: true }); }
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

test("a provider key activates at dispatch like a named account, without an account id on the candidate", async () => {
  const keys = { NATIVE_ROUTER_TEST_KEY_FAKE_A: "synthetic-key-a", NATIVE_ROUTER_TEST_KEY_FAKE_B: "synthetic-key-b", NATIVE_ROUTER_TEST_KEY_FAKE_C: "synthetic-key-c" };
  for (const [name, value] of Object.entries(keys)) process.env[name] = value;
  const h = await host(["quota", "ok"], { providerKeys: true });
  const announced: unknown[] = [];
  h.api.events.on("native-router:account-active", event => announced.push(event));
  try {
    await h.session.prompt("provider key fallback");
    expect(announced).toEqual([{ provider: "fake-a", account: undefined }, { provider: "fake-b", account: undefined }]);
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-b"]);
    expect((await h.runtime.getAuth("fake-b"))?.auth.apiKey).toBe("synthetic-key-b");
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

test("a Shift+Tab thinking choice on a route applies to the next request; the candidate default is the fallback", async () => {
  const h = await host(["ok", "ok"], { reasoning: true, candidateThinking: "low" });
  try {
    await h.session.prompt("default thinking");
    expect(h.dispatches.at(-1)?.thinking).toBe("low");
    h.session.setThinkingLevel("high");
    await h.session.prompt("user chose high");
    expect(h.dispatches.at(-1)?.thinking).toBe("high");
  } finally { h.close(); }
});

test("a model switch into a route does not turn the physical model's thinking level into a route choice", async () => {
  const h = await host(["ok", "ok"], { reasoning: true, candidateThinking: "low" });
  try {
    await h.session.setModel(h.runtime.getModel("fake-a", "model")!);
    h.session.setThinkingLevel("high");
    await h.session.setModel(h.runtime.getModel("route", "worker")!);
    await h.session.prompt("after switching into the route");
    expect(h.dispatches.at(-1)?.thinking).toBe("low");
  } finally { h.close(); }
});

test("the configured TS strategy chooses and explains the actual physical dispatch target", async () => {
  const keys = { NATIVE_ROUTER_TEST_KEY_FAKE_A: "synthetic-key-a", NATIVE_ROUTER_TEST_KEY_FAKE_B: "synthetic-key-b", NATIVE_ROUTER_TEST_KEY_FAKE_C: "synthetic-key-c" };
  for (const [name, value] of Object.entries(keys)) process.env[name] = value;
  const h = await host(["ok"], { strategy: "prefer-b", accounts: true });
  try {
    await h.session.prompt("strategy-selected target");
    await h.session.prompt("strategy may override stickiness");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-b", "fake-c"]);
    expect(h.order.indexOf("flush")).toBeLessThan(h.order.indexOf("dispatch:fake-c"));
    expect(h.order.indexOf("transition")).toBeLessThan(h.order.indexOf("dispatch:fake-c"));
    expect(readFileSync(h.decisionLogPath, "utf8")).toContain('"selectionOrigin":"strategy"');
    expect(readFileSync(h.decisionLogPath, "utf8")).toContain("test strategy selects fake-b/");
    expect(readFileSync(h.decisionLogPath, "utf8")).toContain("test strategy selects fake-c/");
  } finally { h.close(); for (const name of Object.keys(keys)) delete process.env[name]; }
});

test("a strategy chooses the target for terminal recovery and keeps its explanation through dispatch", async () => {
  const keys = { NATIVE_ROUTER_TEST_KEY_FAKE_A: "synthetic-key-a", NATIVE_ROUTER_TEST_KEY_FAKE_B: "synthetic-key-b", NATIVE_ROUTER_TEST_KEY_FAKE_C: "synthetic-key-c" };
  for (const [name, value] of Object.entries(keys)) process.env[name] = value;
  const h = await host([401, "ok"], { strategy: "prefer-b", accounts: true });
  try {
    await h.session.prompt("recover through the strategy");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-b", "fake-c"]);
    expect(readFileSync(h.decisionLogPath, "utf8")).toContain('"selectionOrigin":"strategy"');
    expect(readFileSync(h.decisionLogPath, "utf8")).toContain("test strategy selects fake-c/");
  } finally { h.close(); for (const name of Object.keys(keys)) delete process.env[name]; }
});

test("a denied shared recovery lease is passed as an exclusion before strategy reselection", async () => {
  const h = await host(["ok"], { strategy: "prefer-b", heldProbe: true });
  try {
    await h.session.prompt("probe lease belongs to another process");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-c"]);
  } finally { h.close(); }
});

test("a new pin or cycle overrides incumbent stickiness once, then the selected model stays sticky", async () => {
  const h = await host(["ok", "ok", "ok", "ok"]);
  const statuses = new Map<string, string | undefined>();
  const ui = { select: async () => undefined, notify: () => {}, setStatus: (key: string, value: string | undefined) => statuses.set(key, value) };
  const ctx = { hasUI: true, model: h.runtime.getModel("route", "worker"), modelRegistry: {
    find: (provider: string, id: string) => h.runtime.getModel(provider, id), hasConfiguredAuth: () => true, runtime: h.runtime,
  }, sessionManager: h.manager, getContextUsage: () => ({ tokens: 0 }), thinkingLevel: "off", ui } as never;
  try {
    await h.session.prompt("initial automatic target");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a"]);

    const pin = h.commands.get("route-pin") as { handler: (args: string, context: never) => Promise<void> };
    await pin.handler("fake-b/model", ctx);
    expect(statuses.get(FOOTER_KEYS.model)).toContain("fake-b");
    expect(statuses.get(FOOTER_KEYS.model)).toContain(PIN_GLYPH);
    await h.session.prompt("explicit pin should switch away from the healthy incumbent");
    await h.session.prompt("the selected target should now stay sticky");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-b", "fake-b"]);

    const cycle = h.shortcuts.get("ctrl+shift+m") as { handler: (context: never) => Promise<void> };
    await cycle.handler(ctx);
    await h.session.prompt("cycling is another explicit one-shot override");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a", "fake-b", "fake-b", "fake-c"]);
  } finally { h.close(); }
});

test("a pin on a blocked target is tried once; a failed attempt falls back and the pin stays stored", async () => {
  const h = await host(["ok", 429, "ok", "quota", "ok"]);
  const statuses = new Map<string, string | undefined>();
  const ui = { select: async () => undefined, notify: () => {}, setStatus: (key: string, value: string | undefined) => statuses.set(key, value) };
  const ctx = { hasUI: true, model: h.runtime.getModel("route", "worker"), modelRegistry: {
    find: (provider: string, id: string) => h.runtime.getModel(provider, id), hasConfiguredAuth: () => true, runtime: h.runtime,
  }, sessionManager: h.manager, getContextUsage: () => ({ tokens: 0 }), thinkingLevel: "off", ui } as never;
  try {
    const pin = h.commands.get("route-pin") as { handler: (args: string, context: never) => Promise<void> };
    await pin.handler("fake-b/model", ctx);
    await h.session.prompt("pinned target succeeds");
    await h.session.prompt("pinned target rate-limited; fallback selected");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-b", "fake-b", "fake-a"]);

    // Re-pinning the blocked target: the footer previews the target the next request will try.
    await pin.handler("fake-b/model", ctx);
    expect(statuses.get(FOOTER_KEYS.model)).toContain(PIN_GLYPH);
    expect(statuses.get(FOOTER_KEYS.model)).not.toContain(PIN_FALLBACK_GLYPH);

    await h.session.prompt("explicit try of the blocked pin fails; fallback serves");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-b", "fake-b", "fake-a", "fake-b", "fake-a"]);
    expect(h.manager.getBranch().some(entry => entry.type === "custom" && entry.customType === "@vanillagreen/pi-native-router/physical-pin" &&
      (entry.data as { identity?: string | null }).identity === "fake-b/model")).toBe(true);
  } finally { h.close(); }
});

test("the /route-pin picker marks a candidate that is cooling down", async () => {
  const h = await host(["ok", 429, "ok"]);
  const options: string[][] = [];
  const ui = { select: async (_title: string, opts: string[]) => { options.push(opts); return undefined; }, notify: () => {}, setStatus: () => {} };
  const ctx = { hasUI: true, model: h.runtime.getModel("route", "worker"), modelRegistry: {
    find: (provider: string, id: string) => h.runtime.getModel(provider, id), hasConfiguredAuth: () => true, runtime: h.runtime,
  }, sessionManager: h.manager, getContextUsage: () => ({ tokens: 0 }), thinkingLevel: "off", ui } as never;
  try {
    await h.session.prompt("first request");
    await h.session.prompt("429 on the first candidate; fallback serves");
    const pin = h.commands.get("route-pin") as { handler: (args: string, context: never) => Promise<void> };
    await pin.handler("", ctx);
    expect(options.at(-1)?.some(option => option.includes("\u26a0"))).toBe(true);
  } finally { h.close(); }
});

test("a successful explicit try of a blocked pin clears the block in the shared store", async () => {
  const shared = mkdtempSync(join(tmpdir(), "native-router-pin-clear-"));
  const healthPath = join(shared, "health.sqlite");
  const clock = { value: 1000 };
  const h = await host(["ok", 429, "ok", "ok"], { healthPath, clock });
  const ctx = { hasUI: true, model: h.runtime.getModel("route", "worker"), modelRegistry: {
    find: (provider: string, id: string) => h.runtime.getModel(provider, id), hasConfiguredAuth: () => true, runtime: h.runtime,
  }, sessionManager: h.manager, getContextUsage: () => ({ tokens: 0 }), thinkingLevel: "off", ui: { select: async () => undefined, notify: () => {}, setStatus: () => {} } } as never;
  try {
    const pin = h.commands.get("route-pin") as { handler: (args: string, context: never) => Promise<void> };
    await pin.handler("fake-b/model", ctx);
    await h.session.prompt("pinned target succeeds");
    await h.session.prompt("pinned target rate-limited; fallback selected");
    const before = new HealthStore(healthPath, () => clock.value);
    expect(before.blocked(["fake-b/model"])).toBeDefined();
    before.close();

    await pin.handler("fake-b/model", ctx);
    await h.session.prompt("explicit try of the blocked pin succeeds");
    expect(h.dispatches.at(-1)?.physical).toBe("fake-b");
    const after = new HealthStore(healthPath, () => clock.value);
    expect(after.blocked(["fake-b/model"])).toBeUndefined();
    after.close();
  } finally { h.close(); rmSync(shared, { recursive: true, force: true }); }
});

test("a stored pin does not pull the footer back to the pinned model once a fallback has served", async () => {
  const h = await host(["ok", 429, "ok"]);
  const statuses = new Map<string, string | undefined>();
  const ui = { select: async () => undefined, notify: () => {}, setStatus: (key: string, value: string | undefined) => statuses.set(key, value) };
  const ctx = { hasUI: true, model: h.runtime.getModel("route", "worker"), modelRegistry: {
    find: (provider: string, id: string) => h.runtime.getModel(provider, id), hasConfiguredAuth: () => true, runtime: h.runtime,
  }, sessionManager: h.manager, getContextUsage: () => ({ tokens: 0 }), thinkingLevel: "off", ui } as never;
  try {
    const pin = h.commands.get("route-pin") as { handler: (args: string, context: never) => Promise<void> };
    await pin.handler("fake-b/model", ctx);
    await h.session.prompt("pinned target succeeds");
    await h.session.prompt("pinned target rate-limited; fallback serves");
    expect(h.dispatches.at(-1)?.physical).toBe("fake-a");
    // Any later preview (model_select, pin change) must keep the serving fallback on screen, not the stored pin.
    for (const handler of h.handlers.get("model_select") ?? []) await handler({ model: (ctx as unknown as { model: unknown }).model } as never, ctx);
    expect(statuses.get(FOOTER_KEYS.model)).toContain("fake-a");
    expect(statuses.get(FOOTER_KEYS.model)).toContain(PIN_FALLBACK_GLYPH);
    expect(statuses.get(FOOTER_KEYS.model)).not.toContain(PIN_GLYPH);
  } finally { h.close(); }
});

test("route-pin preview normalizes a redundant strategy choice to auto and cycling follows configured order", async () => {
  const h = await host(["ok"], { strategy: "prefer-b" });
  const statuses = new Map<string, string | undefined>();
  const notices: string[] = [];
  const ui = {
    select: async (_prompt: string, choices: string[]) => { expect(choices).toEqual(["auto", "fake-a/model", "fake-b/model", "fake-c/model"]); return "fake-b/model"; },
    notify: (message: string) => notices.push(message),
    setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
  };
  const ctx = { hasUI: true, model: h.runtime.getModel("route", "worker"), modelRegistry: { find: (provider: string, id: string) => h.runtime.getModel(provider, id), hasConfiguredAuth: () => true, runtime: h.runtime },
    sessionManager: h.manager, getContextUsage: () => ({ tokens: 0 }), thinkingLevel: "off", ui } as never;
  try {
    const pin = h.commands.get("route-pin") as { handler: (args: string, context: never) => Promise<void> };
    await pin.handler("", ctx);
    expect(h.manager.getBranch().some(entry => entry.type === "custom" && entry.customType === "@vanillagreen/pi-native-router/physical-pin" &&
      (entry.data as { role?: string; identity?: string | null }).identity === null)).toBe(true);
    expect(notices.some(message => message.includes("pin cleared"))).toBe(true);
    expect(statuses.has(FOOTER_KEYS.model)).toBe(true);

    const cycle = h.shortcuts.get("ctrl+shift+m") as { handler: (context: never) => Promise<void> };
    await cycle.handler(ctx);
    expect(h.manager.getBranch().some(entry => entry.type === "custom" && entry.customType === "@vanillagreen/pi-native-router/physical-pin" &&
      (entry.data as { identity?: string | null }).identity === "fake-c/model")).toBe(true);
    expect(h.order).not.toContain("flush");
  } finally { h.close(); }
});

test("a missing configured strategy falls back to ordered dispatch without disabling the route", async () => {
  const h = await host(["ok"], { strategy: "missing" });
  try {
    await h.session.prompt("strategy module missing");
    expect(h.dispatches.map(d => d.physical)).toEqual(["fake-a"]);
    expect(readFileSync(h.decisionLogPath, "utf8")).toContain('"fallback":"strategy module could not be loaded"');
  } finally { h.close(); }
});
