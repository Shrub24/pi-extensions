import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * End-to-end integration test over real OTLP/HTTP in the JSON protocol.
 *
 * Spins up a loopback OTLP sink that parses every request body, loads the
 * real index.ts extension against a fake ExtensionAPI pointed at that sink,
 * replays a realistic session's event sequence, and asserts on the decoded
 * OTLP payloads: span names, kinds, parent links, gen_ai.* attributes,
 * metric names, and log event names. JSON (not protobuf) so assertions read
 * real values instead of substring-scraping a binary blob.
 *
 * This is the highest-fidelity test short of running pi itself: it exercises
 * config -> sdk -> exporter -> HTTP -> parse -> assertions, end to end.
 */

const SINK_PORT = 14318; // avoid 4318 in case the user has jaeger running
const ENDPOINT = `http://127.0.0.1:${SINK_PORT}`;

let server: Server;
const received = {
  traces: [] as unknown[],
  metrics: [] as unknown[],
  logs: [] as unknown[],
};
const savedEnv: Record<string, string | undefined> = {};
const E2E_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "PI_OTEL_DISABLED",
  "PI_OTEL_SEMCONV",
  "PI_OTEL_PARENT_SESSION_ID",
  "PI_SUBAGENT_PARENT_SESSION",
] as const;

before(async () => {
  for (const k of E2E_ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  // JSON protocol for every e2e run so payloads parse into assertable values.
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";
      let parsed: unknown = { __parseError: body.slice(0, 200) };
      try {
        parsed = JSON.parse(body);
      } catch {
        // keep the marker; assertions below will fail loudly on it
      }
      if (url.endsWith("/v1/traces")) received.traces.push(parsed);
      else if (url.endsWith("/v1/metrics")) received.metrics.push(parsed);
      else if (url.endsWith("/v1/logs")) received.logs.push(parsed);
      // Connection: close forces the exporter's keep-alive agent to release the
      // socket after each export, so server.close() in after() can complete
      // instead of waiting on idle keep-alive connections forever.
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(SINK_PORT, "127.0.0.1", resolve));
});

after(async () => {
  // closeAllConnections drops any lingering keep-alive sockets before close().
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const k of E2E_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function resetReceived() {
  received.traces = []; received.metrics = []; received.logs = [];
}

// --- OTLP/JSON decoding helpers ----------------------------------------------

interface OtlpAttribute { key: string; value: Record<string, unknown> }

function attrValue(v: Record<string, unknown>): unknown {
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return typeof v.intValue === "string" ? Number.parseInt(v.intValue, 10) : v.intValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) {
    const values = (v.arrayValue as { values?: Array<Record<string, unknown>> }).values ?? [];
    return values.map((x) => attrValue(x));
  }
  if ("kvlistValue" in v) {
    const values = (v.kvlistValue as { values?: OtlpAttribute[] }).values ?? [];
    return attrsToRecord(values);
  }
  return undefined;
}

function attrsToRecord(attrs: OtlpAttribute[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) out[a.key] = attrValue(a.value);
  return out;
}

interface DecodedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes?: OtlpAttribute[];
  events?: Array<{ name: string; attributes?: OtlpAttribute[] }>;
  links?: Array<{ traceId: string; spanId: string }>;
  status?: { code?: number };
}

/** Flatten every received trace payload into spans. */
function allSpans(): DecodedSpan[] {
  const spans: DecodedSpan[] = [];
  for (const payload of received.traces) {
    const rs = (payload as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: DecodedSpan[] }> }> }).resourceSpans ?? [];
    for (const r of rs) for (const s of r.scopeSpans ?? []) spans.push(...(s.spans ?? []));
  }
  return spans;
}

/** All log records across received payloads. */
function allLogRecords(): Array<{ body?: { stringValue?: string }; severityText?: string; attributes?: OtlpAttribute[] }> {
  const records: Array<{ body?: { stringValue?: string }; severityText?: string; attributes?: OtlpAttribute[] }> = [];
  for (const payload of received.logs) {
    const rl = (payload as { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: unknown[] }> }> }).resourceLogs ?? [];
    for (const r of rl) for (const s of r.scopeLogs ?? []) records.push(...((s.logRecords ?? []) as Array<{ body?: { stringValue?: string }; severityText?: string; attributes?: OtlpAttribute[] }>));
  }
  return records;
}

/** All metric names across received payloads. */
function allMetricNames(): string[] {
  const names: string[] = [];
  for (const payload of received.metrics) {
    const rm = (payload as { resourceMetrics?: Array<{ scopeMetrics?: Array<{ metrics?: Array<{ name: string }> }> }> }).resourceMetrics ?? [];
    for (const r of rm) for (const s of r.scopeMetrics ?? []) for (const m of s.metrics ?? []) names.push(m.name);
  }
  return names;
}

/** Raw joined JSON of all trace payloads, for coarse substring checks. */
function traceBlob(): string {
  return received.traces.map((t) => JSON.stringify(t)).join("");
}

// --- fake ExtensionAPI ------------------------------------------------------

/** Drive one minimal run: prompt → one turn → settle. */
async function emitRun(
  emit: (event: string, payload?: any) => Promise<void>,
  prompt = "run",
): Promise<void> {
  await emit("before_agent_start", { prompt, systemPrompt: "" });
  await emit("agent_start", {});
  await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
  await emit("before_provider_request", { payload: {} });
  await emit("after_provider_response", { status: 200, headers: {} });
  await emit("turn_end", {
    turnIndex: 0,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
    },
    toolResults: [],
  });
  await emit("agent_end", { messages: [] });
  await emit("agent_settled", {});
}

function fakePi(sessionManager: Record<string, unknown> = {}) {
  const handlers = new Map<string, (e: any, ctx: any) => any>();
  const commands = new Map<string, { handler: (a: string, c: any) => any }>();
  const eventListeners = new Map<string, Array<(d: unknown) => void>>();
  const ctx = {
    cwd: "/e2e",
    hasUI: false,
    model: { id: "test-model", provider: "test" },
    signal: undefined as AbortSignal | undefined,
    sessionManager: { getSessionFile: () => "/tmp/e2e.jsonl", ...sessionManager },
    ui: { notify: () => {}, setStatus: () => {} },
  };
  const pi = {
    on(event: string, h: (e: any, c: any) => any) { handlers.set(event, h); },
    registerCommand(name: string, opts: { handler: (a: string, c: any) => any }) { commands.set(name, opts); },
    registerTool() {}, registerShortcut() {}, registerFlag() {},
    events: {
      on(ch: string, fn: (d: unknown) => void) { (eventListeners.get(ch) ?? eventListeners.set(ch, []).get(ch)!).push(fn); },
      emit(ch: string, d: unknown) { for (const fn of eventListeners.get(ch) ?? []) fn(d); },
    },
    getThinkingLevel: () => "off",
    getActiveTools: () => ["test-tool"],
    getAllTools: () => [{
      name: "test-tool",
      description: "A fixture tool",
      parameters: { type: "object", properties: {} },
    }],
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands, ctx };
}

describe("end-to-end over real HTTP OTLP (JSON protocol)", () => {
  test("a full prompt with a tool call exports traces, metrics, and logs", async () => {
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "500";
    const { pi, handlers, ctx } = fakePi();
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    await emit("session_start", { reason: "startup" });
    await emit("before_agent_start", { prompt: "read the file", systemPrompt: "" });
    await emit("agent_start", {});
    // Turn 0: the model returns a tool call; pi executes the tool inside the
    // turn (before turn_end), so the LLM span is still open and linkable.
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("message_start", { message: { role: "user", content: "read the file" } });
    await emit("message_start", { message: { role: "custom", customType: "notes", content: [{ type: "text", text: "extension context" }] } });
    await emit("after_provider_response", { status: 200, headers: {} });
    // The assistant stream opens before pi runs the tools the response asked
    // for, so the LLM span is open (and linkable) while they execute.
    await emit("message_start", { message: { role: "assistant", content: [], model: "test-model" } });
    await emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "/x" } });
    await emit("tool_execution_end", { toolCallId: "t1", toolName: "read", result: { out: "contents" }, isError: false });
    await emit("turn_end", {
      turnIndex: 0,
      message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } }], model: "test-model", usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, cost: { total: 0.001 } }, stopReason: "tool_use" },
      toolResults: [],
    });
    // Turn 1: plain completion.
    await emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 200, headers: {} });
    await emit("turn_end", {
      turnIndex: 1,
      message: { role: "assistant", content: [{ type: "text", text: "done" }], model: "test-model", usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } }, stopReason: "stop" },
      toolResults: [],
    });
    await emit("agent_end", { messages: [] });
    await emit("agent_settled", {});
    await emit("session_shutdown", { reason: "quit" });

    assert.ok(received.traces.length > 0, "traces exported");
    assert.ok(received.logs.length > 0, "logs exported");
    assert.ok(received.metrics.length > 0, "metrics exported");

    const spans = allSpans();
    const byName = (name: string) => spans.filter((s) => s.name === name);
    assert.equal(byName("pi.session").length, 0, "a session is a correlation key, not a span");
    assert.ok(byName("pi.interaction").length >= 1, "pi.interaction span");
    assert.ok(byName("pi.attempt").length >= 1, "pi.attempt span");
    assert.ok(byName("pi.turn").length >= 2, "pi.turn spans");
    assert.ok(byName("pi.llm_request").length >= 2, "pi.llm_request spans");
    assert.ok(byName("pi.tool.read").length === 1, "pi.tool.read span");

    // Structure: the LLM span is a CLIENT span parented under the turn.
    const llm = byName("pi.llm_request")[0]!;
    assert.equal(llm.kind, 3, "llm_request is SpanKind.CLIENT (OTLP wire enum: 3) ");
    const turns = byName("pi.turn");
    assert.ok(
      turns.some((t) => t.spanId === llm.parentSpanId),
      "llm_request parented under a turn",
    );
    const interaction = byName("pi.interaction")[0]!;
    assert.equal(interaction.parentSpanId, undefined, "the run root starts its own trace");
    const attempt = byName("pi.attempt")[0]!;
    assert.equal(attempt.parentSpanId, interaction.spanId, "attempt parented under the run root");
    assert.ok(
      turns.every((t) => t.parentSpanId === attempt.spanId),
      "turns parented under the attempt",
    );
    const interactionAttrsForTrace = attrsToRecord(interaction.attributes);
    assert.equal(interactionAttrsForTrace["gen_ai.operation.name"], "invoke_agent");
    assert.equal(interactionAttrsForTrace["gen_ai.conversation.id"], "e2e", "conversation alias present");

    // gen_ai attributes on the LLM span, by value. Default dialect is 1.43:
    // the registry provider key and usage-attribute names; no pre-registry keys.
    const llmAttrs = attrsToRecord(llm.attributes);
    assert.equal(llmAttrs["gen_ai.provider.name"], "test");
    assert.equal(llmAttrs["gen_ai.system"], undefined, "1.43 does not write the pre-rename key");
    assert.equal(llmAttrs["gen_ai.request.model"], "test-model");
    assert.equal(llmAttrs["gen_ai.request.stream"], true, "1.43 records gen_ai.request.stream");
    assert.deepEqual(JSON.parse(String(llmAttrs["gen_ai.tool.definitions"])), [{
      type: "function",
      name: "test-tool",
      description: "A fixture tool",
      parameters: { type: "object", properties: {} },
    }], "active tool definitions are attached to the model request span");
    assert.equal(llmAttrs["gen_ai.usage.input_tokens"], 10);
    assert.equal(llmAttrs["gen_ai.usage.output_tokens"], 5);
    assert.equal(llmAttrs["gen_ai.usage.cache_read.input_tokens"], 3);
    assert.equal(llmAttrs["gen_ai.usage.cache_read_input_tokens"], undefined, "1.43 does not write the pre-registry cache key");
    assert.deepEqual(llmAttrs["gen_ai.response.finish_reasons"], ["tool_use"]);
    // Extension-injected custom messages are part of the captured input.
    const inputMessages = JSON.parse(String(llmAttrs["gen_ai.input.messages"])) as Array<{ parts: Array<{ content: string }> }>;
    assert.ok(inputMessages.some((m) => m.parts.some((p) => p.content === "extension context")), "custom message captured as input");

    // The tool span links back to the LLM span that requested it.
    const tool = byName("pi.tool.read")[0]!;
    const toolAttrs = attrsToRecord(tool.attributes);
    assert.equal(toolAttrs["gen_ai.tool.name"], "read");
    assert.equal(toolAttrs["gen_ai.tool.call.id"], "t1");
    assert.ok(
      (tool.links ?? []).some((l) => l.spanId === llm.spanId),
      "tool span links to the triggering LLM span",
    );

    // Session totals land on the pi.session.end log record.
    const sessionEnd = allLogRecords().find(
      (r) => attrsToRecord(r.attributes)["event.name"] === "pi.session.end",
    );
    const sessionEndAttrs = attrsToRecord(sessionEnd?.attributes);
    assert.equal(sessionEndAttrs["gen_ai.usage.input_tokens"], 30, "session sums input tokens");
    assert.equal(sessionEndAttrs["gen_ai.usage.cost_usd"] as number, 0.003, "session sums cost");
    assert.equal(sessionEndAttrs["pi.turn_count"], 2, "session sums turns");

    // Logs carry the lifecycle event with an event.name attribute.
    const logRecords = allLogRecords();
    const eventNames = logRecords.map((r) => attrsToRecord(r.attributes)["event.name"]);
    assert.ok(eventNames.includes("pi.session.start"), "pi.session.start log");
    assert.ok(eventNames.includes("pi.session.end"), "pi.session.end log");

    // Metrics arrive with the spec-true semconv names plus the pi.* set.
    const metricNames = allMetricNames();
    assert.ok(metricNames.includes("gen_ai.client.operation.duration"), "operation duration metric");
    assert.ok(metricNames.includes("pi.turn.count"), "turn count metric");
    assert.ok(metricNames.includes("gen_ai.client.token.usage"), "token usage metric");
    assert.ok(metricNames.includes("pi.tool.calls"), "tool calls metric");
    assert.ok(!metricNames.some((n) => n.startsWith("gen_ai.client.") && ![
      "gen_ai.client.operation.duration",
      "gen_ai.client.token.usage",
      "gen_ai.client.operation.time_to_first_chunk",
    ].includes(n)), "no invented gen_ai.client.* metric names");
  });

  test("an auto-retried run stays inside one trace with two attempts", async () => {
    // pi's retry flow: agent.prompt() ends in a retryable error (agent_end,
    // no agent_settled yet), then agent.continue() re-emits agent_start with
    // no before_agent_start. The retry's turns and LLM spans must stay in the
    // same run trace, one attempt each, and both turns count.
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const { pi, handlers, ctx } = fakePi();
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    await emit("session_start", { reason: "startup" });
    await emit("before_agent_start", { prompt: "retry me", systemPrompt: "" });
    await emit("agent_start", {});
    // Turn 0: provider error, retryable.
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 503, headers: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: { role: "assistant", content: [], model: "test-model", usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "error", errorMessage: "overloaded" },
      toolResults: [],
    });
    // Run 1 ends in a retryable error. No agent_settled yet: pi is about to
    // retry, and the interaction must survive this agent_end.
    await emit("agent_end", { messages: [] });
    // Retry: agent_start again, NO before_agent_start.
    await emit("agent_start", {});
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 200, headers: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: { role: "assistant", content: [{ type: "text", text: "recovered" }], model: "test-model", usage: { input: 6, output: 2, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" },
      toolResults: [],
    });
    await emit("agent_end", { messages: [] });
    await emit("agent_settled", {});
    await emit("session_shutdown", { reason: "quit" });

    const spans = allSpans();
    const interactions = spans.filter((s) => s.name === "pi.interaction");
    assert.equal(interactions.length, 1, "retry does not open a second interaction");
    const attempts = spans.filter((s) => s.name === "pi.attempt");
    assert.equal(attempts.length, 2, "each run is one attempt");
    const attemptAttrs = attempts.map((a) => attrsToRecord(a.attributes));
    assert.deepEqual(
      attemptAttrs.map((a) => a["pi.attempt.number"]),
      [1, 2],
      "attempts are numbered in order",
    );
    assert.equal(attemptAttrs[0]!["pi.attempt.reason"], undefined, "first attempt needs no reason");
    assert.equal(attemptAttrs[1]!["pi.attempt.reason"], "retry", "the re-run names its reason");
    assert.equal(
      spans.filter((s) => s.name === "pi.turn").length, 2,
      "both runs' turn spans recorded",
    );
    assert.equal(
      spans.filter((s) => s.name === "pi.llm_request").length, 2,
      "both runs' llm spans recorded",
    );
    const traceId = interactions[0]!.traceId;
    for (const s of spans) {
      assert.equal(s.traceId, traceId, `${s.name} stays on the run trace`);
    }
    const interactionAttrs = attrsToRecord(interactions[0]!.attributes);
    assert.equal(interactionAttrs["pi.interaction.origin"], "user");
    assert.equal(interactionAttrs["pi.turn_count"], 2, "interaction counts both runs' turns");
  });

  test("a warm request never claimed by an assistant event emits no model span", async () => {
    // Cache warmers and probes reach before_provider_request/after_provider_response
    // too. Without an assistant lifecycle event they must not appear as turns.
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const priorTraceparent = process.env.TRACEPARENT;
    delete process.env.TRACEPARENT;
    try {
      const { pi, handlers, ctx } = fakePi();
      const mod = await import("../src/index.ts");
      mod.default(pi);
      const emit = async (event: string, payload: any) => {
        const h = handlers.get(event);
        if (h) await h({ type: event, ...payload }, ctx);
      };

      await emit("session_start", { reason: "startup" });
      await emitRun(emit, "a real run");
      // Warm the prompt cache after the run: provider hooks, no assistant event.
      await emit("before_provider_request", { payload: {} });
      await emit("after_provider_response", { status: 200, headers: { "x-request-id": "warm-1" } });
      await emit("session_shutdown", { reason: "quit" });

      const spans = allSpans();
      assert.equal(
        spans.filter((s) => s.name === "pi.llm_request").length,
        1,
        "only the real run's generation is exported",
      );
      assert.equal(process.env.TRACEPARENT, undefined, "the run withdrew its published context");
    } finally {
      if (priorTraceparent === undefined) delete process.env.TRACEPARENT;
      else process.env.TRACEPARENT = priorTraceparent;
    }
  });

  test("a run publishes TRACEPARENT while it is open", async () => {
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const priorTraceparent = process.env.TRACEPARENT;
    delete process.env.TRACEPARENT;
    try {
      const { pi, handlers, ctx } = fakePi();
      const mod = await import("../src/index.ts");
      mod.default(pi);
      const emit = async (event: string, payload: any) => {
        const h = handlers.get(event);
        if (h) await h({ type: event, ...payload }, ctx);
      };

      await emit("session_start", { reason: "startup" });
      await emit("before_agent_start", { prompt: "spawn something", systemPrompt: "" });
      const published = process.env.TRACEPARENT ?? "";
      assert.match(published, /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/, "run context published");
      await emitRun(emit, "spawn something");
      await emit("session_shutdown", { reason: "quit" });
      assert.equal(process.env.TRACEPARENT, undefined, "withdrawn at shutdown");

      const interaction = allSpans().find((s) => s.name === "pi.interaction")!;
      assert.equal(published.split("-")[1], interaction.traceId, "published trace is the run's trace");
      assert.equal(published.split("-")[2], interaction.spanId, "published span is the run root");
    } finally {
      if (priorTraceparent === undefined) delete process.env.TRACEPARENT;
      else process.env.TRACEPARENT = priorTraceparent;
    }
  });

  test("semconv=1.36 restores the pre-rename attribute set and events", async () => {
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    process.env.PI_OTEL_SEMCONV = "1.36";
    try {
      const { pi, handlers, ctx } = fakePi();
      const mod = await import("../src/index.ts");
      mod.default(pi);
      const emit = async (event: string, payload: any) => {
        const h = handlers.get(event);
        if (h) await h({ type: event, ...payload }, ctx);
      };

      await emit("session_start", { reason: "startup" });
      await emit("before_agent_start", { prompt: "dialect check", systemPrompt: "" });
      await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
      await emit("before_provider_request", { payload: {} });
      await emit("message_start", { message: { role: "user", content: "dialect check" } });
      await emit("after_provider_response", { status: 200, headers: {} });
      await emit("turn_end", {
        turnIndex: 0,
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "test-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" },
        toolResults: [],
      });
      await emit("agent_end", { messages: [] });
      await emit("agent_settled", {});
      await emit("session_shutdown", { reason: "quit" });

      const llm = allSpans().find((s) => s.name === "pi.llm_request")!;
      assert.ok(llm, "llm span present");
      const attrs = attrsToRecord(llm.attributes);
      assert.equal(attrs["gen_ai.system"], "test", "pre-rename key present");
      assert.equal(attrs["gen_ai.provider.name"], undefined, "renamed key absent in 1.36");
      const eventNames = new Set((llm.events ?? []).map((e) => e.name));
      assert.ok(eventNames.has("gen_ai.user.message"), "legacy user message event");
      assert.ok(eventNames.has("gen_ai.assistant.message"), "legacy assistant message event");
      assert.ok(eventNames.has("gen_ai.choice"), "legacy choice event");
      assert.ok(attrs["gen_ai.input.messages"], "JSON input messages still present");
    } finally {
      delete process.env.PI_OTEL_SEMCONV;
    }
  });

  test("session replacement does not error and still exports on shutdown", async () => {
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const { pi, handlers, ctx } = fakePi();
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    await emit("session_start", { reason: "startup" });
    await emit("before_agent_start", { prompt: "p1", systemPrompt: "" });
    await emit("turn_start", { turnIndex: 0, timestamp: 0 });
    await emit("before_provider_request", { payload: {} });
    // session replaced mid-flight
    await emit("session_before_switch", { reason: "new" });
    await emit("session_shutdown", { reason: "new" });

    assert.ok(received.traces.length > 0, "traces exported despite mid-flight replacement");
    // No throw is the implicit pass condition above.
  });

  test("sequential non-quit sessions each export; first runtime is fully shut down", async () => {
    // Locks the always-shutdown path: after session_shutdown(reason=new) the
    // previous providers must not keep exporting. A second session starts a
    // fresh runtime and its own exports land independently.
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const { pi, handlers, ctx } = fakePi();
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    // Session A: one span tree, shut down with non-quit reason.
    await emit("session_start", { reason: "startup" });
    await emit("before_agent_start", { prompt: "session-a", systemPrompt: "" });
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 200, headers: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "a" }],
        model: "test-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    });
    await emit("agent_end", { messages: [] });
    await emit("agent_settled", {});
    await emit("session_shutdown", { reason: "new" });
    const afterA = received.traces.length;
    assert.ok(afterA > 0, "session A exported traces on non-quit shutdown");
    assert.ok(traceBlob().includes("session-a"), "session A payload present");

    // After A is shut down, no further spontaneous exports should arrive.
    const mid = received.traces.length;
    await new Promise(r => setTimeout(r, 50));
    assert.equal(received.traces.length, mid, "no zombie exports after session A shutdown");

    // Session B: fresh runtime, independent export.
    await emit("session_start", { reason: "new" });
    await emit("before_agent_start", { prompt: "session-b", systemPrompt: "" });
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 200, headers: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "b" }],
        model: "test-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    });
    await emit("agent_end", { messages: [] });
    await emit("agent_settled", {});
    await emit("session_shutdown", { reason: "quit" });
    assert.ok(received.traces.length > afterA, "session B exported additional traces");
  });

  test("disabled via PI_OTEL_DISABLED=1 exports nothing", async () => {
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    process.env.PI_OTEL_DISABLED = "1";
    try {
      const { pi, handlers, ctx } = fakePi();
      const mod = await import("../src/index.ts");
      mod.default(pi);
      const emit = async (event: string, payload: any) => {
        const h = handlers.get(event);
        if (h) await h({ type: event, ...payload }, ctx);
      };
      await emit("session_start", { reason: "startup" });
      await emit("before_agent_start", { prompt: "x", systemPrompt: "" });
      await emit("agent_end", { messages: [] });
      await emit("agent_settled", {});
      await emit("session_shutdown", { reason: "quit" });
      assert.equal(received.traces.length, 0, "no traces when disabled");
      assert.equal(received.logs.length, 0, "no logs when disabled");
      assert.equal(received.metrics.length, 0, "no metrics when disabled");
    } finally {
      delete process.env.PI_OTEL_DISABLED;
    }
  });

  test("lifecycle log events include session end, llm error, and tool error", async () => {
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const { pi, handlers, ctx } = fakePi();
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    await emit("session_start", { reason: "startup" });
    await emit("before_agent_start", { prompt: "do a thing", systemPrompt: "" });
    await emit("agent_start", {});
    // Real loop order: the tool executes inside the turn that requested it.
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 500, headers: {} });
    await emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: {} });
    const toolErrorMessage = "ENOENT: no such file or directory";
    await emit("tool_execution_end", {
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: toolErrorMessage }], isError: true },
      isError: true,
    });
    await emit("turn_end", {
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
        model: "m",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "tool_use",
      },
    });
    await emit("agent_end", { messages: [] });
    // Overflow recovery, in pi's real order: compaction runs between the
    // failed run's agent_end and the retry's agent_start (then, in this
    // replay, the retry succeeds and the run settles).
    await emit("session_before_compact", {
      reason: "overflow",
      willRetry: true,
      preparation: { tokensBefore: 12345 },
      branchEntries: [],
    });
    await emit("session_compact", {
      reason: "overflow",
      fromExtension: false,
      willRetry: true,
      compactionEntry: { tokensBefore: 12345, estimatedTokensAfter: 4000 },
    });
    await emit("agent_start", {});
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 200, headers: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        model: "test-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
      },
      toolResults: [],
    });
    await emit("agent_end", { messages: [] });
    await emit("agent_settled", {});
    await emit("session_shutdown", { reason: "quit" });

    assert.ok(received.logs.length > 0, "logs exported");
    const eventNames = allLogRecords().map((r) => attrsToRecord(r.attributes)["event.name"]);
    assert.ok(eventNames.includes("pi.session.start"), "pi.session.start");
    assert.ok(eventNames.includes("pi.session.end"), "pi.session.end emitted on shutdown");
    const compact = allLogRecords().find((r) => attrsToRecord(r.attributes)["event.name"] === "pi.session.compact");
    assert.ok(compact, "pi.session.compact log");
    const compactAttrs = attrsToRecord(compact!.attributes);
    assert.equal(compactAttrs["pi.compaction.will_retry"], true, "willRetry recorded");
    assert.equal(compactAttrs["pi.compaction.reason"], "overflow");
    assert.ok(eventNames.includes("pi.llm_request.error"), "pi.llm_request.error on HTTP >=400");
    assert.ok(eventNames.includes("pi.tool.error"), "pi.tool.error on failed tool");
    const toolError = allLogRecords().find((r) => attrsToRecord(r.attributes)["event.name"] === "pi.tool.error");
    assert.equal(toolError?.body?.stringValue, `tool bash failed: ${toolErrorMessage}`);
    assert.equal(attrsToRecord(toolError?.attributes)["exception.message"], toolErrorMessage);

    // The compaction is a span on the run trace, and the retry that follows
    // is tagged post_compaction (pi only retries after an overflow).
    const spans = allSpans();
    const compaction = spans.filter((s) => s.name === "pi.compaction");
    assert.equal(compaction.length, 1, "one compaction span");
    const compactionAttrs = attrsToRecord(compaction[0]!.attributes);
    assert.equal(compactionAttrs["pi.compaction.reason"], "overflow");
    assert.equal(compactionAttrs["pi.compaction.tokens_before"], 12345);
    assert.equal(compactionAttrs["pi.compaction.tokens_after"], 4000);
    assert.equal(compactionAttrs["pi.compaction.will_retry"], true);
    const interaction = spans.find((s) => s.name === "pi.interaction")!;
    assert.equal(compaction[0]!.parentSpanId, interaction.spanId, "compaction hangs off the run root");
    const attempts = spans
      .filter((s) => s.name === "pi.attempt")
      .map((a) => attrsToRecord(a.attributes));
    assert.deepEqual(attempts.map((a) => a["pi.attempt.number"]), [1, 2]);
    assert.equal(attempts[1]!["pi.attempt.reason"], "post_compaction");
  });

  test("an extension-triggered turn on an idle session opens an agent-origin interaction", async () => {
    // sendCustomMessage({triggerTurn: true}) calls _runAgentPrompt directly:
    // agent_start with no before_agent_start and no user prompt. The run must
    // get an interaction span (agent origin), full span tree, and no prompt count.
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const { pi, handlers, ctx } = fakePi();
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    await emit("session_start", { reason: "startup" });
    // Idle session: an extension fires a custom message with triggerTurn.
    await emit("agent_start", {});
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 200, headers: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "extension drove this" }],
        model: "test-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
      },
      toolResults: [],
    });
    await emit("agent_end", { messages: [] });
    await emit("agent_settled", {});
    await emit("session_shutdown", { reason: "quit" });

    const spans = allSpans();
    const interactions = spans.filter((s) => s.name === "pi.interaction");
    assert.equal(interactions.length, 1, "one interaction for the extension-driven run");
    const ia = attrsToRecord(interactions[0]!.attributes);
    assert.equal(ia["pi.interaction.origin"], "agent", "agent origin, not a user prompt");
    const traceId = interactions[0]!.traceId;
    assert.ok(spans.some((s) => s.name === "pi.turn" && s.traceId === traceId), "turn on the run trace");
    assert.ok(spans.some((s) => s.name === "pi.llm_request" && s.traceId === traceId), "llm on the run trace");
    const metricNames = allMetricNames();
    assert.ok(metricNames.includes("pi.turn.count"), "turn counted");
    assert.ok(!metricNames.includes("pi.prompt.count"), "agent-origin run is not counted as a user prompt");
  });

  test("a branch summary's spend lands on session totals, not on an llm span", async () => {
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const { pi, handlers, ctx } = fakePi();
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    await emit("session_start", { reason: "startup" });
    await emit("before_agent_start", { prompt: "first", systemPrompt: "" });
    await emit("agent_start", {});
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "test-model",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
      toolResults: [],
    });
    await emit("agent_end", { messages: [] });
    await emit("agent_settled", {});
    // Branch navigation: the summary is a model call outside the agent loop.
    // Its provider request reaches the hook with no assistant event to claim it.
    await emit("session_before_tree", { newLeafId: "leaf", oldLeafId: "trunk" });
    await emit("before_provider_request", { payload: {} });
    await emit("session_tree", {
      newLeafId: "leaf",
      oldLeafId: "trunk",
      summaryEntry: {
        type: "branch_summary",
        usage: { input: 700, output: 90, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } },
        fromExtension: false,
      },
    });
    await emit("session_shutdown", { reason: "quit" });

    const spans = allSpans();
    assert.equal(
      spans.filter((s) => s.name === "pi.llm_request").length,
      1,
      "the branch-summary request never becomes an llm span",
    );
    const endRecord = allLogRecords().find(
      (r) => attrsToRecord(r.attributes)["event.name"] === "pi.session.end",
    );
    assert.ok(endRecord, "pi.session.end log");
    const endAttrs = attrsToRecord(endRecord!.attributes);
    assert.equal(endAttrs["gen_ai.usage.input_tokens"], 10 + 700, "session input totals include the branch summary");
    assert.equal(endAttrs["gen_ai.usage.output_tokens"], 5 + 90, "session output totals include the branch summary");
  });

  test("session ids resolve to the canonical UUID, and parent ids match", async () => {
    // SessionManager.getSessionId() is pi's canonical session identity; the
    // filename stem carries a timestamp prefix, and subagent children would
    // derive the literal "session" from their run-N/session.jsonl path.
    const uuid = "019123ab-c1d0-7ef4-9a4b-1c2d3e4f5a6b";
    const parentUuid = "019123ab-c1d0-7ef4-9a4b-aaaaaaaaaaaa";
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    const { pi, handlers, ctx } = fakePi({
      getSessionId: () => uuid,
      getSessionFile: () => `/tmp/${Date.now()}_${uuid}.jsonl`,
    });
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const emit = async (event: string, payload: any) => {
      const h = handlers.get(event);
      if (h) await h({ type: event, ...payload }, ctx);
    };

    await emit("session_start", {
      reason: "resume",
      previousSessionFile: `/tmp/1728000000000_${parentUuid}.jsonl`,
    });
    await emit("before_agent_start", { prompt: "id check", systemPrompt: "" });
    await emit("agent_start", {});
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("before_provider_request", { payload: {} });
    await emit("after_provider_response", { status: 200, headers: {} });
    await emit("turn_end", {
      turnIndex: 0,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "test-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" },
      toolResults: [],
    });
    await emit("agent_end", { messages: [] });
    await emit("agent_settled", {});
    await emit("session_shutdown", { reason: "quit" });

    const spans = allSpans();
    const interaction = spans.find((s) => s.name === "pi.interaction")!;
    assert.ok(interaction, "run root span");
    const sa = attrsToRecord(interaction.attributes);
    assert.equal(sa["pi.session.id"], uuid, "canonical UUID, not the filename stem");
    assert.equal(sa["pi.session.parent_id"], parentUuid, "parent id normalized to the bare UUID");
    const llm = spans.find((s) => s.name === "pi.llm_request")!;
    assert.equal(attrsToRecord(llm.attributes)["pi.session.id"], uuid, "session id consistent across spans");
  });

  test("subagent children link to their parent via the env fallback", async () => {
    // A subagent-spawned child starts with reason=startup and no
    // previousSessionFile; the orchestrator publishes the parent session id
    // through PI_OTEL_PARENT_SESSION_ID (or PI_SUBAGENT_PARENT_SESSION).
    const childUuid = "019123ab-c1d0-7ef4-9a4b-bbbbbbbbbbbb";
    const parentUuid = "019123ab-c1d0-7ef4-9a4b-aaaaaaaaaaaa";
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    process.env.PI_OTEL_PARENT_SESSION_ID = parentUuid;
    try {
      const { pi, handlers, ctx } = fakePi({
        getSessionId: () => childUuid,
        getSessionFile: () => "/tmp/runs/42/run-3/session.jsonl",
      });
      const mod = await import("../src/index.ts");
      mod.default(pi);
      const emit = async (event: string, payload: any) => {
        const h = handlers.get(event);
        if (h) await h({ type: event, ...payload }, ctx);
      };

      await emit("session_start", { reason: "startup" });
      await emitRun(emit);
      await emit("session_shutdown", { reason: "quit" });

      const interaction = allSpans().find((s) => s.name === "pi.interaction")!;
      assert.ok(interaction, "run root span");
      const sa = attrsToRecord(interaction.attributes);
      assert.equal(sa["pi.session.id"], childUuid, "child id from getSessionId, not the literal 'session' basename");
      assert.equal(sa["pi.session.parent_id"], parentUuid, "parent linked through the env fallback");
    } finally {
      delete process.env.PI_OTEL_PARENT_SESSION_ID;
    }
  });

  test("env fallback normalizes the published shape and honors precedence", async () => {
    // The alternate env var may carry a stem or full path; parent_id must
    // reduce to the bare UUID to join against pi.session.id, and
    // PI_OTEL_PARENT_SESSION_ID wins when both are set.
    const childUuid = "019123ab-c1d0-7ef4-9a4b-cccccccccccc";
    const parentUuid = "019123ab-c1d0-7ef4-9a4b-aaaaaaaaaaaa";
    const otherParent = "019123ab-c1d0-7ef4-9a4b-dddddddddddd";
    resetReceived();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
    // Stem form through the alternate variable.
    process.env.PI_SUBAGENT_PARENT_SESSION = `1728000000000_${parentUuid}`;
    let spans: DecodedSpan[];
    try {
      const { pi, handlers, ctx } = fakePi({
        getSessionId: () => childUuid,
        getSessionFile: () => "/tmp/runs/42/run-4/session.jsonl",
      });
      const mod = await import("../src/index.ts");
      mod.default(pi);
      const emit = async (event: string, payload: any) => {
        const h = handlers.get(event);
        if (h) await h({ type: event, ...payload }, ctx);
      };
      await emit("session_start", { reason: "startup" });
      await emitRun(emit);
      await emit("session_shutdown", { reason: "quit" });
      spans = allSpans();
      let sa = attrsToRecord(spans.find((s) => s.name === "pi.interaction")!.attributes);
      assert.equal(sa["pi.session.parent_id"], parentUuid, "stem-form alternate env value reduced to the UUID");

      // Both set: PI_OTEL_PARENT_SESSION_ID takes precedence.
      resetReceived();
      process.env.PI_OTEL_PARENT_SESSION_ID = otherParent;
      const { pi: pi2, handlers: handlers2, ctx: ctx2 } = fakePi({
        getSessionId: () => childUuid,
        getSessionFile: () => "/tmp/runs/42/run-5/session.jsonl",
      });
      const mod2 = await import("../src/index.ts");
      mod2.default(pi2);
      await handlers2.get("session_start")!({ type: "session_start", reason: "startup" }, ctx2);
      const emit2 = async (event: string, payload: any) => {
        const h = handlers2.get(event);
        if (h) await h({ type: event, ...payload }, ctx2);
      };
      await emitRun(emit2);
      await handlers2.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx2);
      sa = attrsToRecord(allSpans().find((s) => s.name === "pi.interaction")!.attributes);
      assert.equal(sa["pi.session.parent_id"], otherParent, "PI_OTEL_PARENT_SESSION_ID wins over the alternate");
    } finally {
      delete process.env.PI_SUBAGENT_PARENT_SESSION;
      delete process.env.PI_OTEL_PARENT_SESSION_ID;
    }
  });
});
