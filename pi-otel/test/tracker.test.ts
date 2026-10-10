import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  ATTR_GEN_AI_INPUT_TOKENS,
  ATTR_GEN_AI_OUTPUT_TOKENS,
  ATTR_GEN_AI_TOTAL_TOKENS,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_SESSION_ID,
  ATTR_GEN_AI_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_REASONING_OUTPUT_TOKENS,
  ATTR_GEN_AI_CACHE_WRITE_1H_TOKENS,
  ATTR_GEN_AI_COST_USD,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_SYSTEM_PROMPT_HASH,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_DEFINITIONS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_HTTP_STATUS_CODE,
  ATTR_PI_SESSION_ID,
  ATTR_PI_SESSION_REASON,
  ATTR_PI_SESSION_PARENT_ID,
  ATTR_PI_TURN_INDEX,
  ATTR_PI_RUN_KIND,
  ATTR_PI_SESSION_MODE,
  ATTR_PI_SESSION_NAME,
  ATTR_PI_AGENT_ROLE,
  ATTR_PI_AGENT_LABEL,
  ATTR_PI_AGENT_RUN_ID,
  ATTR_PI_AGENT_OWNER_SESSION_ID,
  ATTR_PI_AGENT_WORKSPACE_ID,
  ATTR_PI_TOOL_IS_ERROR,
  ATTR_PI_CANCELLED,
  ATTR_PI_ORPHANED,
  ATTR_PI_INTERACTION_ID,
  ATTR_PI_INTERACTION_ORIGIN,
  ATTR_PI_PROMPT_LENGTH,
  ATTR_PI_ERROR_COUNT,
  ATTR_PI_ATTEMPT_NUMBER,
  ATTR_PI_ATTEMPT_REASON,
  ATTR_PI_CACHE_EPOCH,
  ATTR_PI_COMPACTION_REASON,
  ATTR_PI_COMPACTION_TOKENS_BEFORE,
  ATTR_PI_COMPACTION_TOKENS_AFTER,
  ATTR_PI_COMPACTION_WILL_RETRY,
  ATTR_PI_COMPACTION_FROM_EXTENSION,
  ATTR_PI_CONTEXT_PERCENT,
  ATTR_PI_CONTEXT_TOKENS,
  ATTR_PI_CONTEXT_WINDOW,
  ATTR_PI_PARENT_SPAN_ID,
  ATTR_PI_PARENT_TRACE_ID,
  ATTR_PI_ROUTE_PREVIOUS_MODEL,
  ATTR_PI_ROUTE_TRANSITION_REASON,
  ATTR_PI_TURN_COUNT,
  ATTR_PI_TOOL_COUNT,
  hashPrompt,
  SPAN_ATTEMPT,
  SPAN_COMPACTION,
  SPAN_INTERACTION,
  SPAN_TURN,
  SPAN_LLM_REQUEST,
  EVENT_PI_MESSAGE,
} from "../src/attrs.ts";
import { BasicTracerProvider, BatchSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SpanTracker } from "../src/tracker.ts";
import { resetInheritedTraceparent } from "../src/traceparent.ts";
import { makeHarness, asstMsg, recordingMetricsOf, RecordingMetrics, type Harness } from "./helpers.ts";

/**
 * SpanTracker lifecycle tests.
 *
 * Strategy: drive the tracker through synthetic event sequences (the same
 * sequence Pi would fire) and assert on the spans that land in the in-memory
 * exporter. Each test gets a fresh harness.
 */

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(async () => {
  await h.flush();
});

// A canonical "happy path" interaction: one prompt, one turn, one LLM call,
// one tool call, then clean completion.
function runHappyPath(h: Harness, opts: { tool?: boolean } = {}): void {
  h.tracker.startSession();
  h.tracker.startInteraction("hello pi");
  h.tracker.startTurn(0);
  h.tracker.startLlm("claude-4", "anthropic");
  h.tracker.noteUserInput("hello pi");
  h.tracker.recordProviderResponse(200, {});
  if (opts.tool) {
    // Tool runs after the LLM response with the tool call.
    h.tracker.startTool("call_1", "bash", { command: "ls" });
    h.tracker.endTool("call_1", false, { output: "file.txt" });
  }
  h.tracker.completeLlm(asstMsg({ text: "hi", stopReason: opts.tool ? "tool_use" : "stop" }));
  h.tracker.endTurn();
  h.tracker.endInteraction();
  h.tracker.endSession();
}

describe("span tree shape", () => {
  test("happy path emits interaction, turn, llm_request spans", async () => {
    runHappyPath(h);
    await h.flush();
    const names = Object.keys(h.spansByName());
    assert.ok(names.includes(SPAN_INTERACTION));
    assert.ok(names.includes(SPAN_TURN));
    assert.ok(names.includes(SPAN_LLM_REQUEST));
  });

  test("llm_request is a CLIENT span (gen_ai convention)", async () => {
    runHappyPath(h);
    await h.flush();
    assert.equal(h.span(SPAN_LLM_REQUEST).kind, SpanKind.CLIENT);
  });

  test("interaction/turn/attempt/compaction are INTERNAL kind", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startAttempt();
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "anthropic");
    h.tracker.completeLlm(asstMsg({ text: "hi" }));
    h.tracker.endTurn();
    h.tracker.startCompaction("threshold", { tokensBefore: 100 });
    h.tracker.endCompaction({ reason: "threshold" });
    h.tracker.endAttempt();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    assert.equal(h.span(SPAN_INTERACTION).kind, SpanKind.INTERNAL);
    assert.equal(h.span(SPAN_TURN).kind, SpanKind.INTERNAL);
    assert.equal(h.span(SPAN_ATTEMPT).kind, SpanKind.INTERNAL);
    assert.equal(h.span(SPAN_COMPACTION).kind, SpanKind.INTERNAL);
  });

  test("the interaction is a trace root; turn hangs from it; attempts sit in between", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("hello");
    h.tracker.startAttempt();
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "anthropic");
    h.tracker.completeLlm(asstMsg({ text: "hi" }));
    h.tracker.endTurn();
    h.tracker.endAttempt();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const interaction = h.span(SPAN_INTERACTION);
    const attempt = h.span(SPAN_ATTEMPT);
    const turn = h.span(SPAN_TURN);
    assert.equal(interaction.parentSpanContext, undefined, "run root has no parent span");
    assert.equal(attempt.parentSpanContext?.spanId, interaction.spanContext().spanId);
    assert.equal(turn.parentSpanContext?.spanId, attempt.spanContext().spanId);
    assert.equal(turn.spanContext().traceId, interaction.spanContext().traceId);
  });

  test("two runs produce two traces", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("first");
    h.tracker.endInteraction();
    h.tracker.startInteraction("second");
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const interactions = h.spanExporter.getFinishedSpans().filter((s) => s.name === SPAN_INTERACTION);
    assert.equal(interactions.length, 2);
    assert.notEqual(
      interactions[0]!.spanContext().traceId,
      interactions[1]!.spanContext().traceId,
      "each run is its own trace",
    );
  });

  test("tool span is a child of turn (sibling of llm_request, not child of it)", async () => {
    runHappyPath(h, { tool: true });
    await h.flush();
    const spans = h.spansByName();
    const tool = h.span("pi.tool.bash");
    const turn = h.span(SPAN_TURN);
    const llm = h.span(SPAN_LLM_REQUEST);
    assert.ok(tool, "tool span present");
    assert.equal(tool.parentSpanContext?.spanId, turn.spanContext().spanId, "tool parented under turn");
    assert.notEqual(tool.parentSpanContext?.spanId, llm.spanContext().spanId, "tool NOT parented under llm");
  });
});

describe("common attributes", () => {
  test("llm_request has gen_ai.provider.name from provider; the run root omits it", async () => {
    runHappyPath(h);
    await h.flush();
    assert.equal(h.span(SPAN_LLM_REQUEST).attributes["gen_ai.provider.name"], "anthropic");
    assert.equal("gen_ai.provider.name" in h.span(SPAN_INTERACTION).attributes, false);
  });

  test("every span carries pi.session.id and the conversation aliases", async () => {
    runHappyPath(h);
    await h.flush();
    for (const span of Object.values(h.spansByName())) {
      assert.equal(span.attributes[ATTR_PI_SESSION_ID], "test-session", `${span.name} missing pi.session.id`);
      assert.equal(span.attributes[ATTR_GEN_AI_CONVERSATION_ID], "test-session", `${span.name} missing gen_ai.conversation.id`);
      assert.equal(span.attributes[ATTR_SESSION_ID], "test-session", `${span.name} missing session.id`);
    }
  });

  test("turn carries turn.index", async () => {
    runHappyPath(h);
    await h.flush();
    assert.equal(h.span(SPAN_TURN).attributes[ATTR_PI_TURN_INDEX], 0);
  });

  test("interaction carries interaction.id", async () => {
    runHappyPath(h);
    await h.flush();
    assert.equal(h.span(SPAN_INTERACTION).attributes[ATTR_PI_INTERACTION_ID], 1);
  });

  test("operation names classify run, turn, and tool spans", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "anthropic");
    h.tracker.startTool("t1", "bash", { command: "ls" });
    h.tracker.endTool("t1", false, {});
    h.tracker.completeLlm(asstMsg({ text: "ok" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    assert.equal(h.span(SPAN_INTERACTION).attributes[ATTR_GEN_AI_OPERATION_NAME], "invoke_agent");
    assert.equal(h.span(SPAN_TURN).attributes[ATTR_GEN_AI_OPERATION_NAME], "chat");
    assert.equal(h.span(SPAN_LLM_REQUEST).attributes[ATTR_GEN_AI_OPERATION_NAME], "chat");
    assert.equal(h.span("pi.tool.bash").attributes[ATTR_GEN_AI_OPERATION_NAME], "execute_tool");
  });
});

describe("session start reason", () => {
  // Session identity is a correlation key on every span, not a span of its own.
  test("startSession(fork) stamps pi.session.reason on the run root", async () => {
    h.tracker.startSession("fork");
    h.tracker.startInteraction("p");
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    assert.equal(h.span(SPAN_INTERACTION).attributes[ATTR_PI_SESSION_REASON], "fork");
  });

  test("startSession() with no reason omits pi.session.reason", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const attrs = h.span(SPAN_INTERACTION).attributes;
    assert.equal(ATTR_PI_SESSION_REASON in attrs, false);
  });

  test("startSession(fork, parent-abc) stamps pi.session.parent_id on the run root", async () => {
    h.tracker.startSession("fork", "parent-abc");
    h.tracker.startInteraction("p");
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    assert.equal(h.span(SPAN_INTERACTION).attributes[ATTR_PI_SESSION_PARENT_ID], "parent-abc");
  });

  test("startSession() with no parentId omits pi.session.parent_id", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const attrs = h.span(SPAN_INTERACTION).attributes;
    assert.equal(ATTR_PI_SESSION_PARENT_ID in attrs, false);
  });
});

// ---------------------------------------------------------------------------
// Semconv usage attribution — the most important correctness property.
// ---------------------------------------------------------------------------

describe("llm usage attribution", () => {
  test("records all token type attributes including cache_write_1h", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.completeLlm(asstMsg({
      input: 100, output: 50, cacheRead: 30, cacheWrite: 20, cacheWrite1h: 5, cost: 0.012,
      stopReason: "stop",
    }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const a = h.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(a[ATTR_GEN_AI_INPUT_TOKENS], 100);
    assert.equal(a[ATTR_GEN_AI_OUTPUT_TOKENS], 50);
    // Default dialect 1.43: registry usage-attribute names.
    assert.equal(a[ATTR_GEN_AI_CACHE_READ_INPUT_TOKENS], 30);
    assert.equal(a[ATTR_GEN_AI_CACHE_CREATION_INPUT_TOKENS], 20);
    assert.equal(a[ATTR_GEN_AI_CACHE_WRITE_1H_TOKENS], 5, "cache_write_1h must be captured (Anthropic 1h split)");
    assert.equal(a[ATTR_GEN_AI_COST_USD], 0.012);
  });

  test("omits cache_write_1h attribute when not reported", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.completeLlm(asstMsg({ cacheWrite: 10, stopReason: "stop" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const a = h.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(ATTR_GEN_AI_CACHE_WRITE_1H_TOKENS in a, false, "must not set 1h attr when undefined");
    assert.equal(a[ATTR_GEN_AI_CACHE_CREATION_INPUT_TOKENS], 10);
  });

  test("records reasoning tokens when reported", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("o-series", "openai");
    h.tracker.completeLlm(asstMsg({ input: 10, output: 5, reasoning: 42, stopReason: "stop" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const a = h.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(a[ATTR_GEN_AI_REASONING_OUTPUT_TOKENS], 42, "reasoning tokens captured");
  });

  test("omits reasoning tokens attribute when not reported", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.completeLlm(asstMsg({ input: 10, output: 5, stopReason: "stop" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const a = h.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(ATTR_GEN_AI_REASONING_OUTPUT_TOKENS in a, false, "must not set reasoning attr when undefined");
  });

  test("records request and response model", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4-sonnet", "anthropic");
    h.tracker.completeLlm(asstMsg({ responseModel: "claude-4-sonnet-20250514", stopReason: "stop" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const a = h.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(a[ATTR_GEN_AI_REQUEST_MODEL], "claude-4-sonnet");
    assert.equal(a[ATTR_GEN_AI_RESPONSE_MODEL], "claude-4-sonnet-20250514");
  });

  test("captures finish reason as an array per semconv", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.completeLlm(asstMsg({ stopReason: "end_turn" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    assert.deepEqual(h.span(SPAN_LLM_REQUEST).attributes[ATTR_GEN_AI_RESPONSE_FINISH_REASONS], ["end_turn"]);
  });

  test("sets ERROR status on finishReason=error and records message", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.completeLlm(asstMsg({ stopReason: "error", errorMessage: "rate limited" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const span = h.span(SPAN_LLM_REQUEST);
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.status.message, "rate limited");
  });

  test("captures response.id from message, not headers", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(200, { "x-request-id": "from-header" });
    h.tracker.completeLlm(asstMsg({ responseId: "from-message", stopReason: "stop" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    // message.responseId (set in completeLlm) overwrites the header-derived value.
    assert.equal(h.span(SPAN_LLM_REQUEST).attributes[ATTR_GEN_AI_RESPONSE_ID], "from-message");
  });

  test("response.id from mixed-case header names", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(200, { "X-Request-Id": "mixed-case-id" });
    h.tracker.completeLlm(asstMsg({ stopReason: "stop" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    assert.equal(h.span(SPAN_LLM_REQUEST).attributes[ATTR_GEN_AI_RESPONSE_ID], "mixed-case-id");
  });

  test("records http.response.status_code from provider response", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(429, {});
    h.tracker.completeLlm(asstMsg({ stopReason: "error" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const a = h.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(a[ATTR_HTTP_STATUS_CODE], 429);
  });

  test("sets error.type and ERROR status on HTTP >= 400", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(500, {});
    h.tracker.completeLlm(asstMsg({ stopReason: "error" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const span = h.span(SPAN_LLM_REQUEST);
    assert.equal(span.attributes["error.type"], "server_error");
    assert.equal(span.status.code, SpanStatusCode.ERROR);
  });

  test("derives error.type from the message when no HTTP response was seen", async () => {
    // Connection-refused style failure: after_provider_response never fires,
    // so no HTTP category exists. Tail-sampling keyed on error.type must
    // still see the failure.
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.completeLlm(asstMsg({
      stopReason: "error",
      errorMessage: "TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:443",
    }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const span = h.span(SPAN_LLM_REQUEST);
    assert.equal(span.attributes["error.type"], "network_error");
    assert.equal(span.attributes["exception.message"], "TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:443");
    assert.equal(span.status.code, SpanStatusCode.ERROR);
  });

  test("HTTP category wins over the message-derived error.type", async () => {
    // A 429 was observed on the wire and then the stream died with a network
    // message: the final attempt's HTTP category is the more specific signal.
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(429, {});
    h.tracker.completeLlm(asstMsg({
      stopReason: "error",
      errorMessage: "TypeError: fetch failed: socket hang up",
    }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const span = h.span(SPAN_LLM_REQUEST);
    assert.equal(span.attributes["error.type"], "rate_limit");
  });

  test("message without a network pattern falls back to the exception name", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.completeLlm(asstMsg({
      stopReason: "error",
      errorMessage: "SyntaxError: unexpected token in response",
    }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const span = h.span(SPAN_LLM_REQUEST);
    assert.equal(span.attributes["error.type"], "SyntaxError");
  });
});

describe("llm metrics", () => {
  test("records op duration, input tokens, output tokens", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.completeLlm(asstMsg({ input: 100, output: 50, stopReason: "stop" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    assert.ok(h.metrics.histograms["op"]?.length === 1, "op duration recorded");
    const tokenRecs = h.metrics.histograms["tokens"] ?? [];
    assert.equal(tokenRecs.length, 2, "one input + one output record");
    const byType = Object.fromEntries(tokenRecs.map(r => [r.attrs["gen_ai.token.type"], r.value]));
    assert.equal(byType.input, 100);
    assert.equal(byType.output, 50);
  });

  test("usage histogram carries only input/output in 1.43; cache and reasoning live in span attrs", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.completeLlm(asstMsg({
      input: 10,
      output: 5,
      cacheRead: 30,
      cacheWrite: 20,
      cacheWrite1h: 4,
      reasoning: 7,
      stopReason: "stop",
    }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const byType = Object.fromEntries(
      (h.metrics.histograms["tokens"] ?? []).map(r => [r.attrs["gen_ai.token.type"], r.value]),
    );
    assert.equal(byType.input, 10);
    assert.equal(byType.output, 5);
    assert.deepEqual(Object.keys(byType).sort(), ["input", "output"], "registry token types only");
    const a = h.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(a[ATTR_GEN_AI_CACHE_READ_INPUT_TOKENS], 30, "cache read still on the span");
    assert.equal(a[ATTR_GEN_AI_CACHE_CREATION_INPUT_TOKENS], 20, "cache write still on the span");
    assert.equal(a[ATTR_GEN_AI_REASONING_OUTPUT_TOKENS], 7, "reasoning still on the span");
  });

  test("records provider retry on second response event", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(429, {}); // attempt 1
    h.tracker.recordProviderResponse(200, {}); // attempt 2 -> retry
    h.tracker.completeLlm(asstMsg({ stopReason: "stop" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    assert.equal(h.metrics.counters["retries"]?.length, 1, "one retry counted");
  });

  test("a retry that succeeds leaves no error markers on the span", async () => {
    // Regression: a 429 followed by a 200 used to stamp error.type and ERROR
    // status at the failed attempt and never clear them, so a request that
    // succeeded on retry exported as a failure and counted a session error.
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(429, {});
    h.tracker.recordProviderResponse(200, {});
    h.tracker.completeLlm(asstMsg({ text: "ok", stopReason: "stop" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const llm = h.span(SPAN_LLM_REQUEST);
    assert.equal(llm.attributes["error.type"], undefined, "no error.type after recovery");
    assert.equal(llm.status.code, SpanStatusCode.UNSET, "status stays UNSET after recovery");
    assert.equal(
      h.tracker.sessionSummary().errors,
      0,
      "no session error counted",
    );
  });

  test("a request whose final attempt fails marks error.type once and counts one error", async () => {
    // Two failed attempts (429 then 500) then a hard error message: the span
    // keeps the final attempt's category and the session counts one error,
    // not one per failed attempt.
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(429, {});
    h.tracker.recordProviderResponse(500, {});
    h.tracker.completeLlm(asstMsg({ stopReason: "error", errorMessage: "HTTP 500" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const llm = h.span(SPAN_LLM_REQUEST);
    assert.equal(llm.attributes["error.type"], "server_error", "final attempt's category wins");
    assert.equal(llm.status.code, SpanStatusCode.ERROR);
    assert.equal(h.tracker.sessionSummary().errors, 1);
  });

  test("a defensively closed failed request keeps its error markers", async () => {
    // endLlm path (session replaced mid-request): the final failed attempt
    // still surfaces on the span even though completeLlm never ran.
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(503, {});
    h.tracker.endInteraction({ reason: "session_switch" });
    h.tracker.endSession();
    await h.flush();
    const llm = h.span(SPAN_LLM_REQUEST);
    assert.equal(llm.attributes["error.type"], "server_error");
    assert.equal(llm.status.code, SpanStatusCode.ERROR);
  });
});

// ---------------------------------------------------------------------------
// Tool spans
// ---------------------------------------------------------------------------

describe("tool spans", () => {
  test("carry gen_ai.tool.name, call.id, and is_error", async () => {
    runHappyPath(h, { tool: true });
    await h.flush();
    const a = h.span("pi.tool.bash").attributes;
    assert.equal(a[ATTR_GEN_AI_TOOL_NAME], "bash");
    assert.equal(a[ATTR_GEN_AI_TOOL_CALL_ID], "call_1");
    assert.equal(a[ATTR_PI_TOOL_IS_ERROR], false);
  });

  test("failed tool spans preserve the actual error message", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startTool("t1", "bash", { command: "bad" });
    h.tracker.endTool("t1", true, {
      content: [{ type: "text", text: "ENOENT: no such file or directory" }],
      isError: true,
    });
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    const span = h.span("pi.tool.bash");
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.status.message, "ENOENT: no such file or directory");
    assert.equal(span.attributes["exception.message"], "ENOENT: no such file or directory");
    assert.equal(span.attributes["error.type"], "tool_error");
  });

  test("tool error details follow the configured content-capture mode", async () => {
    const restricted = makeHarness({ captureContent: "metadata_only" });
    restricted.tracker.startSession();
    restricted.tracker.startTool("t1", "bash", {});
    restricted.tracker.endTool("t1", true, {
      content: [{ type: "text", text: "sensitive failure detail" }],
      isError: true,
    });
    restricted.tracker.endSession();
    await restricted.flush();
    const span = restricted.span("pi.tool.bash");
    assert.equal(span.status.message, "tool execution failed");
    assert.equal(span.attributes["exception.message"], undefined);
    assert.equal(span.attributes[ATTR_GEN_AI_TOOL_CALL_RESULT], undefined);
  });

  test("increments tool.calls counter per tool", async () => {
    runHappyPath(h, { tool: true });
    const recs = h.metrics.counters["toolcalls"] ?? [];
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.attrs[ATTR_GEN_AI_TOOL_NAME], "bash");
  });

  test("unknown toolCallId on endTool is a safe no-op", async () => {
    h.tracker.startSession();
    h.tracker.startTool("real", "bash", {});
    h.tracker.endTool("nonexistent", false, {}); // should not throw
    h.tracker.endSession();
    await h.flush();
    assert.ok(h.span("pi.tool.bash"), "real tool span still present");
  });

  test("tool span links to open llm_request span", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.startTool("call_1", "bash", { command: "ls" });
    h.tracker.endTool("call_1", false, { output: "file.txt" });
    h.tracker.completeLlm(asstMsg({ stopReason: "tool_use" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const spans = h.spansByName();
    const tool = h.span("pi.tool.bash");
    const llm = h.span(SPAN_LLM_REQUEST);
    assert.ok(tool, "tool span present");
    assert.ok(llm, "llm span present");
    assert.equal(tool.links.length, 1);
    assert.equal(tool.links[0]!.context.traceId, llm.spanContext().traceId);
    assert.equal(tool.links[0]!.context.spanId, llm.spanContext().spanId);
  });

  test("tool span has no links when llm_request is not open", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startTool("t1", "bash", { command: "bad" });
    h.tracker.endTool("t1", false, {});
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const tool = h.span("pi.tool.bash");
    assert.ok(tool, "tool span present");
    assert.equal(tool.links.length, 0);
  });

  test("tool span has no link when the LLM span context is empty (traces disabled)", async () => {
    // When traces are disabled the runtime hands the tracker a no-op tracer
    // whose span contexts carry empty trace/span ids. A link to such a
    // context is invalid per the OTel spec, so the tracker must omit it.
    const emptyCtx = { traceId: "", spanId: "", traceFlags: 0, isRemote: false };
    const noopSpan = {
      spanContext: () => emptyCtx,
      setAttribute() {}, setAttributes() {}, addEvent() {},
      setStatus() {}, recordException() {}, end() {},
    };
    const noopTracer = { startSpan: () => noopSpan } as unknown as import("@opentelemetry/api").Tracer;
    const rec = new RecordingMetrics();
    const tracker = new SpanTracker({
      tracer: noopTracer,
      captureContent: "full",
      sessionId: () => "s",
      sessionFile: () => "/tmp/s.jsonl",
      cwd: "/test",
      metrics: () => recordingMetricsOf(rec),
    });
    // No assertion on spans (the noop tracer records nothing); the contract
    // under test is that startTool does not throw and does not try to build a
    // link from an empty context. The guard is exercised by startTool's
    // traceId/spanId check on the LLM spanContext.
    tracker.startSession();
    tracker.startInteraction("p");
    tracker.startTurn(0);
    tracker.startLlm("m", "p");
    tracker.startTool("t1", "bash", { command: "ls" }); // must not throw
    tracker.endTool("t1", false, {});
    tracker.completeLlm(asstMsg({ stopReason: "tool_use" }));
    tracker.endTurn();
    tracker.endInteraction();
    tracker.endSession();
    // Reaching here without throwing is the pass condition.
    assert.ok(true, "startTool handled an empty LLM span context without linking");
  });
});

// ---------------------------------------------------------------------------
// Cancellation (Esc / abort)
// ---------------------------------------------------------------------------

describe("cancellation", () => {
  test("markCancelled sets pi.cancelled on active spans", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.startTool("t1", "bash", {});
    h.tracker.markCancelled();
    h.tracker.endTool("t1", false, {});
    h.tracker.endLlm({ reason: "cancel" });
    h.tracker.endTurn({ reason: "cancel", cancelled: true });
    h.tracker.endInteraction({ reason: "cancel", cancelled: true });
    h.tracker.endSession();
    await h.flush();
    const spans = h.spansByName();
    assert.equal(h.span(SPAN_LLM_REQUEST).attributes[ATTR_PI_CANCELLED], true);
    assert.equal(h.span("pi.tool.bash").attributes[ATTR_PI_CANCELLED], true);
    assert.equal(h.span(SPAN_TURN).attributes[ATTR_PI_CANCELLED], true);
  });

  test("markCancelled returns true and the abort path is what bumps turn.cancellations", async () => {
    // The cancellation counter is driven by markCancelled's return value so
    // it only counts aborts that actually cancelled an in-flight turn. Ending
    // a turn with cancelled:true sets the attribute but does not double-count.
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    const cancelled = h.tracker.markCancelled();
    assert.equal(cancelled, true, "markCancelled reports an in-flight turn");
    h.tracker.endTurn({ reason: "cancel", cancelled: true });
    h.tracker.endInteraction();
    h.tracker.endSession();
    // Tracker does not bump the metric itself; the index.ts abort listener
    // would add 1 here based on the return value. Simulate that:
    if (cancelled) h.metrics.counter("cancels").add(1);
    assert.equal(h.metrics.counters["cancels"]?.length, 1);
  });

  test("markCancelled returns false and skips the metric when no turn is active", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    // No startTurn: an abort outside a turn.
    const cancelled = h.tracker.markCancelled();
    assert.equal(cancelled, false, "no in-flight turn to cancel");
    h.tracker.endInteraction();
    h.tracker.endSession();
    if (cancelled) h.metrics.counter("cancels").add(1);
    assert.equal(h.metrics.counters["cancels"], undefined, "abort with no turn does not bump the counter");
  });

  test("finishReason=aborted marks llm span cancelled", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.completeLlm(asstMsg({ stopReason: "aborted" }));
    h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession();
    await h.flush();
    assert.equal(h.span(SPAN_LLM_REQUEST).attributes[ATTR_PI_CANCELLED], true);
    assert.equal(h.span(SPAN_LLM_REQUEST).status.code, SpanStatusCode.ERROR);
  });
});

// ---------------------------------------------------------------------------
// Orphan hygiene — the bug class that affects session replacement flows.
// ---------------------------------------------------------------------------

describe("orphan hygiene", () => {
  test("endInteraction closes any open llm/tool/turn spans", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.startTool("t1", "bash", {});
    // Abandon mid-flight — endInteraction must close everything.
    h.tracker.endInteraction({ reason: "session_switch" });
    h.tracker.endSession();
    await h.flush();
    const spans = h.spansByName();
    assert.equal(h.span(SPAN_LLM_REQUEST).ended, true);
    assert.equal(h.span("pi.tool.bash").ended, true);
    assert.equal(h.span(SPAN_TURN).ended, true);
  });

  test("ending an interaction mid-flight marks it orphaned", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.endInteraction({ reason: "session_switch" });
    h.tracker.endSession();
    await h.flush();
    // The orphaned interaction/turn/llm spans get the pi.orphaned marker.
    const interaction = h.span(SPAN_INTERACTION);
    assert.equal(interaction.attributes[ATTR_PI_ORPHANED], true, "interaction marked orphaned");
  });

  test("starting a new interaction closes the previous one", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("first");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    // Second prompt arrives without clean closure of the first.
    h.tracker.startInteraction("second");
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    // Both interactions must be ended (no leak).
    const interactionSpans = h.spanExporter.getFinishedSpans().filter(s => s.name === SPAN_INTERACTION);
    assert.equal(interactionSpans.length, 2);
    assert.ok(interactionSpans.every(s => s.ended));
  });

  test("endSession closes any still-open spans", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.startTool("t1", "bash", {});
    // Quit mid-flight.
    h.tracker.endSession();
    await h.flush();
    for (const span of h.spanExporter.getFinishedSpans()) {
      assert.equal(span.ended, true, `${span.name} not ended`);
    }
  });

  test("metrics: prompt.count increments on each interaction", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("a");
    h.tracker.endInteraction();
    h.tracker.startInteraction("b");
    h.tracker.endInteraction();
    h.tracker.endSession();
    assert.equal(h.metrics.counters["prompts"]?.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Content capture modes
// ---------------------------------------------------------------------------

describe("content capture modes", () => {
  test("metadata_only emits no raw user prompt", async () => {
    const h2 = makeHarness({ captureContent: "metadata_only" });
    h2.tracker.startSession();
    h2.tracker.startInteraction("secret-prompt-content");
    h2.tracker.endInteraction();
    h2.tracker.endSession();
    await h2.flush();
    const attrs = h2.span(SPAN_INTERACTION).attributes;
    assert.equal("pi.user_prompt" in attrs, false, "no raw prompt");
    // fingerprint present instead
    assert.ok("pi.user_prompt.bytes" in attrs, "fingerprint bytes present");
  });

  test("metadata_only emits no raw text on LLM span attributes or events", async () => {
    // The interaction prompt is fingerprinted, but the LLM span has its own
    // surfaces for input/output text: the gen_ai.*.message events and the
    // gen_ai.input.messages / gen_ai.output.messages JSON attributes. All of
    // these must omit raw text in metadata_only mode; otherwise the promise
    // of "no raw payloads leaving the machine" is broken on the LLM span.
    const h2 = makeHarness({ captureContent: "metadata_only" });
    h2.tracker.startSession();
    h2.tracker.startInteraction("the-prompt-secret");
    h2.tracker.startTurn(0);
    h2.tracker.startLlm("m", "anthropic");
    h2.tracker.noteUserInput("the-prompt-secret");
    h2.tracker.noteToolResultInput("call_1", "bash", "the-tool-output-secret");
    h2.tracker.noteCustomInput("the-wake-secret", "pi-herdsman-agent-attention", { message: "the-wake-secret" });
    h2.tracker.completeLlm(asstMsg({ text: "the-completion-secret" }));
    h2.tracker.endTurn();
    h2.tracker.endInteraction();
    h2.tracker.endSession();
    await h2.flush();
    const llm = h2.span(SPAN_LLM_REQUEST);
    assert.ok(llm, "llm span present");
    // No JSON message attributes carrying raw content.
    assert.equal(ATTR_GEN_AI_INPUT_MESSAGES in llm.attributes, false, "no raw gen_ai.input.messages");
    assert.equal(ATTR_GEN_AI_OUTPUT_MESSAGES in llm.attributes, false, "no raw gen_ai.output.messages");
    // No message events carrying raw content.
    const eventNames = new Set(llm.events.map(e => e.name));
    assert.equal(eventNames.has("gen_ai.user.message"), false, "no gen_ai.user.message event");
    assert.equal(eventNames.has("gen_ai.tool.message"), false, "no gen_ai.tool.message event");
    assert.equal(eventNames.has("gen_ai.assistant.message"), false, "no gen_ai.assistant.message event");
    assert.equal(eventNames.has("gen_ai.choice"), false, "no gen_ai.choice event");
    // Nothing on the span (attributes or events) contains the secrets.
    const provenanceEvent = llm.events.find((e) => e.name === EVENT_PI_MESSAGE);
    assert.equal(provenanceEvent?.attributes?.["pi.message.source"], "pi-herdsman-agent-attention");
    assert.equal(provenanceEvent?.attributes?.["pi.message.details"], undefined);
    const secrets = ["the-prompt-secret", "the-tool-output-secret", "the-wake-secret", "the-completion-secret"];
    const attrBlob = JSON.stringify(llm.attributes);
    const eventBlob = JSON.stringify(llm.events);
    for (const s of secrets) {
      assert.ok(!attrBlob.includes(s), `no raw secret ${s} in llm attributes`);
      assert.ok(!eventBlob.includes(s), `no raw secret ${s} in llm events`);
    }
  });

  test("full emits raw user prompt", async () => {
    const h2 = makeHarness({ captureContent: "full" });
    h2.tracker.startSession();
    h2.tracker.startInteraction("secret-prompt-content");
    h2.tracker.endInteraction();
    h2.tracker.endSession();
    await h2.flush();
    assert.equal(h2.span(SPAN_INTERACTION).attributes["pi.user_prompt"], "secret-prompt-content");
  });

  test("no_tool_content emits prompt but not tool args", async () => {
    const h2 = makeHarness({ captureContent: "no_tool_content" });
    h2.tracker.startSession();
    h2.tracker.startInteraction("the-prompt");
    h2.tracker.startTurn(0);
    h2.tracker.startLlm("m", "p");
    h2.tracker.startTool("t1", "bash", { command: "secret-cmd" });
    h2.tracker.endTool("t1", false, { out: "secret-out" });
    h2.tracker.completeLlm(asstMsg({ text: "the-completion" }));
    h2.tracker.endTurn(); h2.tracker.endInteraction(); h2.tracker.endSession();
    await h2.flush();
    const spans = h2.spansByName();
    // prompt captured
    assert.equal(h2.span(SPAN_INTERACTION).attributes["pi.user_prompt"], "the-prompt");
    // tool args/result NOT captured
    assert.equal(ATTR_GEN_AI_TOOL_CALL_ARGUMENTS in h2.span("pi.tool.bash").attributes, false);
    assert.equal(ATTR_GEN_AI_TOOL_CALL_RESULT in h2.span("pi.tool.bash").attributes, false);
  });

  test("no_tool_content emits raw prompt/completion on LLM span but no tool args", async () => {
    // no_tool_content captures prompt and completion text, but never tool
    // arguments or results. The LLM span's gen_ai.*.message events and the
    // gen_ai.input/output.messages JSON attributes carry the prompt and the
    // assistant text raw; tool-call arguments embedded in the assistant
    // message must be omitted.
    const h2 = makeHarness({ captureContent: "no_tool_content" });
    h2.tracker.startSession();
    h2.tracker.startInteraction("the-prompt");
    h2.tracker.startTurn(0);
    h2.tracker.startLlm("m", "anthropic");
    h2.tracker.noteUserInput("the-prompt");
    h2.tracker.noteToolResultInput("call_1", "bash", "the-tool-output-secret");
    h2.tracker.completeLlm(asstMsg({
      text: "the-completion",
      toolCalls: [{ id: "call_1", name: "bash", arguments: { command: "secret-cmd" } }],
    }));
    h2.tracker.endTurn(); h2.tracker.endInteraction(); h2.tracker.endSession();
    await h2.flush();
    const llm = h2.span(SPAN_LLM_REQUEST);
    // Prompt and completion are captured raw.
    const attrBlob = JSON.stringify(llm.attributes);
    const eventBlob = JSON.stringify(llm.events);
    assert.ok(attrBlob.includes("the-prompt") || eventBlob.includes("the-prompt"), "raw prompt captured");
    assert.ok(attrBlob.includes("the-completion") || eventBlob.includes("the-completion"), "raw completion captured");
    // Tool arguments and results are never captured.
    assert.ok(!attrBlob.includes("secret-cmd"), "no tool arg secret in llm attributes");
    assert.ok(!eventBlob.includes("secret-cmd"), "no tool arg secret in llm events");
    assert.ok(!attrBlob.includes("the-tool-output-secret"), "no tool result secret in llm attributes");
    assert.ok(!eventBlob.includes("the-tool-output-secret"), "no tool result secret in llm events");
    // The tool.message event (which carries tool result text) is not emitted.
    assert.equal(llm.events.some(e => e.name === "gen_ai.tool.message"), false, "no gen_ai.tool.message event");
  });

  test("full captures tool args and result", async () => {
    const h2 = makeHarness({ captureContent: "full" });
    h2.tracker.startSession();
    h2.tracker.startInteraction("p");
    h2.tracker.startTurn(0);
    h2.tracker.startLlm("m", "p");
    h2.tracker.startTool("t1", "bash", { command: "ls" });
    h2.tracker.endTool("t1", false, { out: "x" });
    h2.tracker.completeLlm(asstMsg({}));
    h2.tracker.endTurn(); h2.tracker.endInteraction(); h2.tracker.endSession();
    await h2.flush();
    const a = h2.span("pi.tool.bash").attributes;
    assert.ok(a[ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]);
    assert.ok(a[ATTR_GEN_AI_TOOL_CALL_RESULT]);
  });
});

// ---------------------------------------------------------------------------
// Idempotency / defensive behavior
// ---------------------------------------------------------------------------

describe("defensive behavior", () => {
  test("endSession is idempotent (calling twice does not throw or duplicate)", async () => {
    h.tracker.startSession();
    h.tracker.endSession();
    h.tracker.endSession(); // second call must not throw
    await h.flush();
    const sessionSpans = h.spanExporter.getFinishedSpans().filter(s => s.name === "pi.session");
    assert.equal(sessionSpans.length, 0, "a session is a correlation key, never a span");
  });

  test("completeLlm without a started llm span is a no-op", async () => {
    h.tracker.startSession();
    h.tracker.completeLlm(asstMsg({ text: "x" })); // no active llm
    h.tracker.endSession();
    await h.flush();
    assert.equal(h.spanExporter.getFinishedSpans().some(s => s.name === SPAN_LLM_REQUEST), false);
  });

  test("metrics failures never throw (best-effort)", async () => {
    const spanExporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "pi-test" }),
      spanProcessors: [new BatchSpanProcessor(spanExporter)],
    });
    const throwingMetrics = {
      ...recordingMetricsOf(new RecordingMetrics()),
      toolCalls: { add: () => { throw new Error("metric boom"); } },
    } as ReturnType<typeof recordingMetricsOf>;
    const tracker = new SpanTracker({
      tracer: provider.getTracer("pi-otel-test", "0.0.0"),
      captureContent: "full",
      sessionId: () => "test-session",
      sessionFile: () => "/tmp/test.jsonl",
      cwd: "/test",
      metrics: () => throwingMetrics,
    });
    tracker.startSession();
    tracker.startInteraction("p");
    tracker.startTurn(0);
    tracker.startTool("t1", "bash", {});
    assert.doesNotThrow(() => tracker.endTool("t1", false, {}));
    tracker.endTurn(); tracker.endInteraction(); tracker.endSession();
    await provider.forceFlush();
    assert.ok(spanExporter.getFinishedSpans().some(s => s.name === "pi.tool.bash"));
  });
});

describe("gen_ai.system provider", () => {
  test("LLM span sets gen_ai.provider.name from provider and gen_ai.agent.name to pi", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "anthropic");
    h.tracker.completeLlm(asstMsg({ stopReason: "stop" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const a = h.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(a["gen_ai.provider.name"], "anthropic");
    assert.equal(a[ATTR_GEN_AI_SYSTEM], undefined, "pre-rename key not written in 1.37");
    assert.equal(a["gen_ai.agent.name"], "pi");
    assert.equal(ATTR_GEN_AI_SYSTEM in h.span(SPAN_INTERACTION).attributes, false);
  });
});

describe("pending input flush", () => {
  test("user input recorded before startLlm lands on the LLM span", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    // message_start can fire before before_provider_request.
    h.tracker.noteUserInput("queued-before-llm");
    h.tracker.startLlm("m", "anthropic");
    h.tracker.completeLlm(asstMsg({ text: "ok", stopReason: "stop" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const llm = h.span(SPAN_LLM_REQUEST);
    const eventBlob = JSON.stringify(llm.events);
    const attrBlob = JSON.stringify(llm.attributes);
    assert.ok(
      eventBlob.includes("queued-before-llm") || attrBlob.includes("queued-before-llm"),
      "pending user input flushed when LLM span opens",
    );
  });
});

describe("session summary attributes", () => {
  test("session span sums tokens, cost, and error count", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(429, {});
    h.tracker.completeLlm(asstMsg({ input: 10, output: 5, cost: 0.01, stopReason: "error" }));
    h.tracker.startTurn(1);
    h.tracker.startLlm("m", "p");
    h.tracker.completeLlm(asstMsg({ input: 20, output: 15, cost: 0.02, stopReason: "stop" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const summary = h.tracker.sessionSummary();
    assert.equal(summary.inputTokens, 30);
    assert.equal(summary.outputTokens, 20);
    assert.equal(summary.costUsd, 0.03);
    assert.equal(summary.errors, 1);
  });

  test("session turn_count and tool_count sum across interactions", async () => {
    h.tracker.startSession();
    // Interaction 1: two turns, one tool.
    h.tracker.startInteraction("a");
    h.tracker.startTurn(0);
    h.tracker.startTool("t1", "bash", {});
    h.tracker.endTool("t1", false, {});
    h.tracker.endTurn();
    h.tracker.startTurn(1);
    h.tracker.endTurn();
    h.tracker.endInteraction();
    // Interaction 2: one turn, two tools.
    h.tracker.startInteraction("b");
    h.tracker.startTurn(0);
    h.tracker.startTool("t2", "read", {});
    h.tracker.endTool("t2", false, {});
    h.tracker.startTool("t3", "write", {});
    h.tracker.endTool("t3", false, {});
    h.tracker.endTurn();
    h.tracker.endInteraction();
    // Session totals are read while the session is live: the end-of-session
    // log record (and any later straggler) sees them before the counters reset.
    const summary = h.tracker.sessionSummary();
    h.tracker.endSession();
    await h.flush();
    assert.equal(summary.turns, 3, "session totals turns across interactions");
    assert.equal(summary.tools, 3, "session totals tools across interactions");
    // Per-interaction totals remain scoped to that interaction.
    const interactions = h.spanExporter.getFinishedSpans().filter(s => s.name === SPAN_INTERACTION);
    assert.equal(interactions.length, 2);
    assert.equal(interactions[0]!.attributes[ATTR_PI_TURN_COUNT], 2);
    assert.equal(interactions[0]!.attributes[ATTR_PI_TOOL_COUNT], 1);
    assert.equal(interactions[1]!.attributes[ATTR_PI_TURN_COUNT], 1);
    assert.equal(interactions[1]!.attributes[ATTR_PI_TOOL_COUNT], 2);
  });

  test("session with no LLM activity reports an empty summary", async () => {
    h.tracker.startSession();
    h.tracker.endSession();
    await h.flush();
    assert.deepEqual(h.tracker.sessionSummary(), {
      turns: 0,
      tools: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      errors: 0,
    });
  });

  test("a turn-level error passed through endInteraction counts once", async () => {
    // endInteraction propagates its error down the LLM -> turn -> interaction
    // cascade, calling setStatusFromError three times with the same reference.
    // pi.error_count must reflect one session error, not three.
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    const err = new Error("boom");
    h.tracker.endInteraction({ reason: "end", error: err });
    h.tracker.endSession();
    await h.flush();
    assert.equal(h.tracker.sessionSummary().errors, 1, "cascade counts the error once");
  });

  test("distinct errors each count toward pi.error_count", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.endInteraction({ reason: "end", error: new Error("first") });
    h.tracker.startInteraction("p2");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.endInteraction({ reason: "end", error: new Error("second") });
    h.tracker.endSession();
    await h.flush();
    assert.equal(h.tracker.sessionSummary().errors, 2);
  });
});

describe("time to completion", () => {
  test("noteLlmComplete records completion event and histogram once", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.noteLlmComplete({ role: "assistant" });
    h.tracker.noteLlmComplete({ role: "assistant" });
    h.tracker.completeLlm(asstMsg({ stopReason: "stop" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const llm = h.span(SPAN_LLM_REQUEST);
    assert.ok(llm);
    const completionEvents = llm.events.filter(e => e.name === "gen_ai.completion");
    assert.equal(completionEvents.length, 1);
    assert.ok(h.metrics.histograms["completion"]?.length === 1);
  });

  test("noteLlmComplete with user role is a no-op", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.noteLlmComplete({ role: "user" });
    h.tracker.completeLlm(asstMsg({ stopReason: "stop" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const llm = h.span(SPAN_LLM_REQUEST);
    assert.ok(llm);
    assert.equal(llm.events.filter(e => e.name === "gen_ai.completion").length, 0);
    assert.equal(h.metrics.histograms["completion"]?.length ?? 0, 0);
  });
});

describe("time to first token", () => {
  test("first assistant message_update records TTFT event and histogram once", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("claude-4", "anthropic");
    h.tracker.noteFirstToken({ role: "assistant" });
    h.tracker.noteFirstToken({ role: "assistant" });
    h.tracker.completeLlm(asstMsg({ stopReason: "stop" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const llm = h.span(SPAN_LLM_REQUEST);
    assert.ok(llm);
    const firstTokenEvents = llm.events.filter(e => e.name === "gen_ai.first_token");
    assert.equal(firstTokenEvents.length, 1);
    assert.ok(h.metrics.histograms["ttft"]?.length === 1);
  });
});

describe("system prompt hash and capture", () => {
  test("captured LLM span includes full system instructions and active tool definitions", async () => {
    const prompt = "Follow the local system instructions.";
    const definitions = [{
      type: "function",
      name: "search",
      description: "Search the repository",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    }];
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.noteSystemPrompt(prompt);
    h.tracker.startTurn(0);
    h.tracker.noteProviderRequest("m", "anthropic", definitions);
    h.tracker.claimPendingLlm();
    h.tracker.completeLlm(asstMsg({ text: "done" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();

    const llm = h.span(SPAN_LLM_REQUEST);
    assert.deepEqual(JSON.parse(String(llm.attributes[ATTR_GEN_AI_SYSTEM_INSTRUCTIONS])), [
      { type: "text", content: prompt },
    ]);
    assert.deepEqual(JSON.parse(String(llm.attributes[ATTR_GEN_AI_TOOL_DEFINITIONS])), definitions);
    assert.equal(h.span(SPAN_INTERACTION).attributes[ATTR_GEN_AI_SYSTEM_PROMPT_HASH], hashPrompt(prompt));
  });

  test("system instructions and tool definitions follow prompt capture mode", async () => {
    const h2 = makeHarness({ captureContent: "metadata_only" });
    h2.tracker.startSession();
    h2.tracker.startInteraction("p");
    h2.tracker.noteSystemPrompt("private system prompt");
    h2.tracker.startTurn(0);
    h2.tracker.noteProviderRequest("m", "anthropic", [{ type: "function", name: "secret-tool" }]);
    h2.tracker.claimPendingLlm();
    h2.tracker.completeLlm(asstMsg({ text: "done" }));
    h2.tracker.endTurn();
    h2.tracker.endInteraction();
    h2.tracker.endSession();
    await h2.flush();

    const llm = h2.span(SPAN_LLM_REQUEST);
    assert.equal(ATTR_GEN_AI_SYSTEM_INSTRUCTIONS in llm.attributes, false);
    assert.equal(ATTR_GEN_AI_TOOL_DEFINITIONS in llm.attributes, false);
    assert.ok(ATTR_GEN_AI_SYSTEM_PROMPT_HASH in h2.span(SPAN_INTERACTION).attributes);
  });

  test("run and session labels are copied onto all spans", async () => {
    const h2 = makeHarness({
      runAttributes: {
        [ATTR_PI_RUN_KIND]: "herdsman_worker",
        [ATTR_PI_SESSION_MODE]: "print",
        [ATTR_PI_AGENT_ROLE]: "worker",
        [ATTR_PI_AGENT_LABEL]: "review-1",
        [ATTR_PI_AGENT_RUN_ID]: "run-1",
        [ATTR_PI_AGENT_OWNER_SESSION_ID]: "parent-1",
        [ATTR_PI_AGENT_WORKSPACE_ID]: "workspace-1",
      },
      sessionName: () => "review pass",
    });
    h2.tracker.startSession();
    h2.tracker.startInteraction("p");
    h2.tracker.startTurn(0);
    h2.tracker.startLlm("m", "anthropic");
    h2.tracker.completeLlm(asstMsg({ text: "done" }));
    h2.tracker.endTurn();
    h2.tracker.endInteraction();
    h2.tracker.endSession();
    await h2.flush();

    for (const span of [h2.span(SPAN_INTERACTION), h2.span(SPAN_TURN), h2.span(SPAN_LLM_REQUEST)]) {
      assert.equal(span.attributes[ATTR_PI_RUN_KIND], "herdsman_worker");
      assert.equal(span.attributes[ATTR_PI_SESSION_MODE], "print");
      assert.equal(span.attributes[ATTR_PI_SESSION_NAME], "review pass");
      assert.equal(span.attributes[ATTR_PI_AGENT_ROLE], "worker");
      assert.equal(span.attributes[ATTR_PI_AGENT_LABEL], "review-1");
      assert.equal(span.attributes[ATTR_PI_AGENT_RUN_ID], "run-1");
      assert.equal(span.attributes[ATTR_PI_AGENT_OWNER_SESSION_ID], "parent-1");
      assert.equal(span.attributes[ATTR_PI_AGENT_WORKSPACE_ID], "workspace-1");
    }
  });

  test("noteSystemPrompt sets hash on interaction span", async () => {
    const prompt = "You are a helpful assistant.";
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.noteSystemPrompt(prompt);
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const expected = hashPrompt(prompt);
    assert.equal(h.span(SPAN_INTERACTION).attributes[ATTR_GEN_AI_SYSTEM_PROMPT_HASH], expected);
  });

  test("empty or whitespace prompt does not set hash", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.noteSystemPrompt("   ");
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    assert.equal(ATTR_GEN_AI_SYSTEM_PROMPT_HASH in h.span(SPAN_INTERACTION).attributes, false);
  });
});

describe("error categorization", () => {
  async function httpErrorType(status: number): Promise<string | undefined> {
    h.reset();
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "p");
    h.tracker.recordProviderResponse(status, {});
    h.tracker.completeLlm(asstMsg({ stopReason: "error" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    return h.span(SPAN_LLM_REQUEST).attributes["error.type"] as string | undefined;
  }

  test("recordProviderResponse maps HTTP statuses to error.type", async () => {
    assert.equal(await httpErrorType(429), "rate_limit");
    assert.equal(await httpErrorType(500), "server_error");
    assert.equal(await httpErrorType(401), "auth_error");
    assert.equal(await httpErrorType(403), "auth_error");
    assert.equal(await httpErrorType(408), "timeout");
    assert.equal(await httpErrorType(413), "request_too_large");
    assert.equal(await httpErrorType(400), "client_error");
  });
});

describe("orphan sweep", () => {
  // The sweep is belt-and-suspenders over the defensive closes in endInteraction.
  // It ends any span open longer than orphanTtlMs, marked pi.orphaned. We drive
  // it with a controllable fake clock and a manual timer so the test is instant
  // and deterministic.
  function makeSweepHarness(ttlMs: number) {
    // Start the fake clock high enough that it exceeds the monotonic hrtime
    // epoch in ms. The orphan sweep compares span start times (stamped from
    // this clock) against its cutoff; an earlier implementation compared
    // hrtime-derived ms against this wall-clock value, and a small fake clock
    // hid the bug because hrtime-ms was larger than the cutoff. A clock near
    // Date.now()'s magnitude reproduces the real-world drift.
    let now = 1_700_000_000_000;
    let tick: () => void = () => {};
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "pi-test" }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("pi-otel-test", "0.0.0");
    const rec = new RecordingMetrics();
    const tracker = new SpanTracker({
      tracer,
      captureContent: "full",
      sessionId: () => "sweep-test",
      sessionFile: () => "/tmp/sweep.jsonl",
      cwd: "/test",
      metrics: () => recordingMetricsOf(rec),
      orphanTtlMs: ttlMs,
      orphanSweepIntervalMs: ttlMs,
      now: () => now,
      setTimer: (fn) => {
        tick = fn;
        return () => {};
      },
    });
    return {
      tracker,
      exporter,
      tick: () => tick(),
      advance(ms: number) {
        now += ms;
      },
      async flush() {
        await provider.forceFlush();
      },
    };
  }

  test("ends a tool span left open past the TTL, marked orphaned", async () => {
    const ttl = 5_000;
    const { tracker, exporter, tick, advance, flush } = makeSweepHarness(ttl);
    tracker.startSession();
    tracker.startInteraction("p");
    tracker.startTurn(0);
    tracker.startTool("t1", "bash", { command: "x" });
    advance(ttl + 1);
    tick();
    tracker.endSession();
    await flush();
    const tool = exporter.getFinishedSpans().find(s => s.name === "pi.tool.bash");
    assert.ok(tool, "tool span ended by the sweep");
    assert.equal(tool!.attributes[ATTR_PI_ORPHANED], true);
  });

  test("does not end a span younger than the TTL", async () => {
    const ttl = 5_000;
    const { tracker, exporter, tick, advance, flush } = makeSweepHarness(ttl);
    tracker.startSession();
    tracker.startInteraction("p");
    tracker.startTurn(0);
    tracker.startTool("t1", "bash", { command: "x" });
    advance(1_000);
    tick();
    tracker.endSession();
    await flush();
    const tool = exporter.getFinishedSpans().find(s => s.name === "pi.tool.bash");
    assert.ok(tool, "tool span present (ended by endSession, not by sweep)");
    assert.notEqual(tool!.attributes[ATTR_PI_ORPHANED], true, "not orphaned: closed before TTL");
  });

  test("does not end a young LLM or turn span (wall-clock vs hrtime clock base)", async () => {
    // The sweep must compare span age against the same clock used to stamp
    // startMs. An earlier implementation compared hrtime-derived ms against a
    // wall-clock cutoff; since hrtime-ms is far smaller than Date.now()-ms,
    // every in-flight LLM/turn span looked older than the TTL and was ended
    // on the first sweep. This fake clock starts high to expose that drift.
    const ttl = 5_000;
    const { tracker, exporter, tick, advance, flush } = makeSweepHarness(ttl);
    tracker.startSession();
    tracker.startInteraction("p");
    tracker.startTurn(0);
    tracker.startLlm("test-model", "test");
    advance(1_000); // well under TTL
    tick();
    const live = exporter.getFinishedSpans().find(s => s.name === "pi.llm_request");
    assert.equal(live, undefined, "young LLM span must survive the sweep");
    tracker.endLlm({ reason: "end" });
    tracker.endTurn({ reason: "end" });
    tracker.endSession();
    await flush();
    const llm = exporter.getFinishedSpans().find(s => s.name === "pi.llm_request");
    assert.ok(llm, "LLM span ended normally, not by the sweep");
    assert.notEqual(llm!.attributes[ATTR_PI_ORPHANED], true, "LLM not orphaned: closed before TTL");
  });

  test("ends an LLM span left open past the TTL, marked orphaned", async () => {
    const ttl = 5_000;
    const { tracker, exporter, tick, advance, flush } = makeSweepHarness(ttl);
    tracker.startSession();
    tracker.startInteraction("p");
    tracker.startTurn(0);
    tracker.startLlm("test-model", "test");
    advance(ttl + 1);
    tick();
    tracker.endSession();
    await flush();
    const llm = exporter.getFinishedSpans().find(s => s.name === "pi.llm_request");
    assert.ok(llm, "LLM span ended by the sweep");
    assert.equal(llm!.attributes[ATTR_PI_ORPHANED], true);
  });
});

// --- interaction auto-open (agent_start without before_agent_start) ---------

describe("ensureInteraction", () => {
  test("opens an agent-origin interaction when none is open, and turns attach to it", async () => {
    const hx = makeHarness();
    hx.tracker.startSession();
    // A run pi started without before_agent_start (retry re-run on older pi,
    // or an extension-triggered turn on an idle session).
    hx.tracker.ensureInteraction();
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.completeLlm(asstMsg({ text: "t" }));
    hx.tracker.endTurn();
    hx.tracker.endInteraction({ reason: "end" });
    hx.tracker.endSession();
    await hx.flush();
    const interaction = hx.span(SPAN_INTERACTION);
    const turn = hx.span(SPAN_TURN);
    const llm = hx.span(SPAN_LLM_REQUEST);
    assert.equal(interaction.attributes[ATTR_PI_INTERACTION_ORIGIN], "agent", "origin is agent, not user");
    assert.equal(interaction.attributes[ATTR_PI_PROMPT_LENGTH], undefined, "no prompt attributes");
    assert.equal(
      interaction.parentSpanContext, undefined,
      "a run pi starts without a prompt is still its own trace root",
    );
    assert.equal(turn.spanContext().traceId, interaction.spanContext().traceId, "turn on the run's trace");
    assert.equal(llm.spanContext().traceId, interaction.spanContext().traceId, "llm on the run's trace");
    assert.equal(hx.metrics.counters["prompts"]?.length ?? 0, 0, "agent-origin interactions do not count as user prompts");
  });

  test("captures extension-injected custom messages as LLM input", async () => {
    // Extension custom messages retain their customType/details as provenance
    // events while their content remains in the standard input-message list.
    const hx = makeHarness();
    hx.tracker.startSession();
    hx.tracker.startInteraction("user prompt");
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.noteUserInput("user prompt");
    hx.tracker.noteCustomInput("herdsman wake", "pi-herdsman-agent-attention", { reason: "idle" });
    hx.tracker.noteCustomInput("intercom message", "intercom_message", { from: { sessionId: "source-session" } });
    hx.tracker.completeLlm(asstMsg({ text: "t" }));
    hx.tracker.endTurn();
    hx.tracker.endInteraction();
    hx.tracker.endSession();
    await hx.flush();
    const a = hx.span(SPAN_LLM_REQUEST).attributes;
    const parsed = JSON.parse(String(a[ATTR_GEN_AI_INPUT_MESSAGES])) as Array<{ role: string; parts: Array<{ content: string }> }>;
    assert.equal(parsed.length, 3, "user and custom inputs captured");
    assert.deepEqual(parsed.map((m) => m.parts[0]?.content), ["user prompt", "herdsman wake", "intercom message"]);
    const provenance = hx.span(SPAN_LLM_REQUEST).events.filter((e) => e.name === EVENT_PI_MESSAGE);
    assert.deepEqual(provenance.map((e) => e.attributes?.["pi.message.source"]), [
      "pi-herdsman-agent-attention",
      "intercom_message",
    ]);
    assert.deepEqual(JSON.parse(String(provenance[0]?.attributes?.["pi.message.details"])), { reason: "idle" });
    assert.deepEqual(JSON.parse(String(provenance[1]?.attributes?.["pi.message.details"])), { from: { sessionId: "source-session" } });
  });

  test("no-op when an interaction is already open", async () => {
    const hx = makeHarness();
    hx.tracker.startSession();
    hx.tracker.startInteraction("user prompt");
    hx.tracker.ensureInteraction(); // agent_start after before_agent_start
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.completeLlm(asstMsg({ text: "t" }));
    hx.tracker.endTurn();
    hx.tracker.endInteraction({ reason: "end" });
    hx.tracker.endSession();
    await hx.flush();
    const interactions = hx.spanExporter.getFinishedSpans().filter((s) => s.name === SPAN_INTERACTION);
    assert.equal(interactions.length, 1, "agent_start does not supersede the user interaction");
    assert.equal(interactions[0]!.attributes[ATTR_PI_INTERACTION_ORIGIN], "user");
    assert.equal(interactions[0]!.attributes[ATTR_PI_PROMPT_LENGTH], "user prompt".length);
    assert.equal(hx.metrics.counters["prompts"]?.length, 1, "the user prompt still counts once");
  });

  test("a retried run (end, reopen, end) produces one interaction per pi run on the fallback path", async () => {
    // Old-pi fallback: agent_end closes the interaction, the retry's
    // agent_start reopens one (agent origin). No turns are dropped.
    const hx = makeHarness();
    hx.tracker.startSession();
    hx.tracker.startInteraction("p");
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.completeLlm(asstMsg({ stopReason: "error", errorMessage: "overloaded" }));
    hx.tracker.endTurn();
    hx.tracker.endInteraction({ reason: "end" }); // agent_end (no agent_settled)
    hx.tracker.ensureInteraction(); // agent_start re-run
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.completeLlm(asstMsg({ text: "recovered" }));
    hx.tracker.endTurn();
    hx.tracker.endInteraction({ reason: "end" });
    hx.tracker.endSession();
    await hx.flush();
    const spans = hx.spanExporter.getFinishedSpans();
    const interactions = spans.filter((s) => s.name === SPAN_INTERACTION);
    assert.equal(spans.filter((s) => s.name === SPAN_TURN).length, 2, "both turns recorded");
    for (const s of spans) {
      // Each run is its own trace: the retry after agent_end is a new one.
      const owning = interactions.find((i) => i.spanContext().traceId === s.spanContext().traceId);
      assert.ok(owning, `${s.name} belongs to one of the run traces`);
    }
  });
});

// --- semconv dialect ----------------------------------------------------------

describe("semconv dialect", () => {
  function runCaptured(semconv: "1.36" | "1.37" | "1.43") {
    const hx = makeHarness({ captureContent: "full", semconv });
    hx.tracker.startSession();
    hx.tracker.startInteraction("dialect-prompt");
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.noteUserInput("dialect-prompt");
    hx.tracker.completeLlm(asstMsg({ text: "dialect-completion", toolCalls: [{ id: "tc1", name: "read", arguments: { path: "/x" } }], stopReason: "tool_use" }));
    hx.tracker.endTurn(); hx.tracker.endInteraction(); hx.tracker.endSession();
    return hx;
  }

  test("1.37 writes gen_ai.provider.name and not gen_ai.system", async () => {
    const hx = runCaptured("1.37");
    await hx.flush();
    const a = hx.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(a["gen_ai.provider.name"], "anthropic", "renamed attribute present");
    assert.equal(a[ATTR_GEN_AI_SYSTEM], undefined, "old key not written: each dialect emits only its own set");
  });

  test("1.37 drops the legacy message and choice events but keeps JSON attrs", async () => {
    const hx = runCaptured("1.37");
    await hx.flush();
    const llm = hx.span(SPAN_LLM_REQUEST);
    const names = new Set(llm.events.map((e) => e.name));
    assert.equal(names.has("gen_ai.user.message"), false, "no user message event");
    assert.equal(names.has("gen_ai.assistant.message"), false, "no assistant message event");
    assert.equal(names.has("gen_ai.choice"), false, "no choice event");
    assert.ok(llm.attributes[ATTR_GEN_AI_INPUT_MESSAGES], "input JSON attr remains");
    assert.ok(llm.attributes[ATTR_GEN_AI_OUTPUT_MESSAGES], "output JSON attr remains");
    assert.ok(String(llm.attributes[ATTR_GEN_AI_INPUT_MESSAGES]).includes("dialect-prompt"), "content carried once");
  });

  test("1.36 keeps the old key and the events", async () => {
    const hx = runCaptured("1.36");
    await hx.flush();
    const llm = hx.span(SPAN_LLM_REQUEST);
    assert.equal(llm.attributes[ATTR_GEN_AI_SYSTEM], "anthropic", "pre-rename key");
    assert.equal(llm.attributes["gen_ai.provider.name"], undefined, "no rename key in 1.36");
    const names = new Set(llm.events.map((e) => e.name));
    assert.ok(names.has("gen_ai.user.message"));
    assert.ok(names.has("gen_ai.assistant.message"));
    assert.ok(names.has("gen_ai.choice"));
  });

  test("1.36 choice event carries no message payload", async () => {
    // The completion used to ship three times (assistant event, choice
    // message payload, output JSON). The choice payload was pure duplication.
    const hx = runCaptured("1.36");
    await hx.flush();
    const choice = hx.span(SPAN_LLM_REQUEST).events.find((e) => e.name === "gen_ai.choice");
    assert.ok(choice);
    assert.equal("message" in (choice?.attributes ?? {}), false, "choice carries no message payload");
    assert.equal(choice?.attributes?.["finish_reason"], "tool_use");
  });

  test("default is 1.43 when no semconv is passed", async () => {
    const hx = makeHarness({ captureContent: "full" });
    hx.tracker.startSession();
    hx.tracker.startInteraction("p");
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.completeLlm(asstMsg({ text: "t", stopReason: "stop" }));
    hx.tracker.endTurn(); hx.tracker.endInteraction(); hx.tracker.endSession();
    await hx.flush();
    const a = hx.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(a["gen_ai.provider.name"], "anthropic", "1.43 keeps the renamed provider key");
    assert.equal(a[ATTR_GEN_AI_SYSTEM], undefined);
    assert.equal(a["gen_ai.request.stream"], true, "1.43 records gen_ai.request.stream");
  });

  test("1.43 writes the registry usage-attribute names and not the pre-registry ones", async () => {
    const hx = makeHarness({ captureContent: "full", semconv: "1.43" });
    hx.tracker.startSession();
    hx.tracker.startInteraction("p");
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.completeLlm(
      asstMsg({ text: "t", stopReason: "stop", input: 100, output: 20, cacheRead: 5, cacheWrite: 3, cacheWrite1h: 2, reasoning: 7 }),
    );
    hx.tracker.endTurn(); hx.tracker.endInteraction(); hx.tracker.endSession();
    await hx.flush();
    const a = hx.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(a["gen_ai.usage.input_tokens"], 100);
    assert.equal(a["gen_ai.usage.output_tokens"], 20);
    assert.equal(a["gen_ai.usage.cache_read.input_tokens"], 5, "registry cache-read name");
    assert.equal(a["gen_ai.usage.cache_creation.input_tokens"], 3, "registry cache-write name");
    assert.equal(a["gen_ai.usage.reasoning.output_tokens"], 7, "registry reasoning name");
    assert.equal(a["gen_ai.usage.cache_write_1h_input_tokens"], 2, "extension-specific 1h split is kept");
    assert.equal(a["gen_ai.usage.cache_read_input_tokens"], undefined, "no pre-registry cache-read key");
    assert.equal(a["gen_ai.usage.cache_write_input_tokens"], undefined, "no pre-registry cache-write key");
    assert.equal(a["gen_ai.usage.reasoning_tokens"], undefined, "no pre-registry reasoning key");
  });

  test("1.43 records only input/output token.type series on the usage metric", async () => {
    const hx = makeHarness({ captureContent: "full", semconv: "1.43" });
    hx.tracker.startSession();
    hx.tracker.startInteraction("p");
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.completeLlm(
      asstMsg({ text: "t", stopReason: "stop", input: 100, output: 20, cacheRead: 5, cacheWrite: 3, reasoning: 7 }),
    );
    hx.tracker.endTurn(); hx.tracker.endInteraction(); hx.tracker.endSession();
    await hx.flush();
    const types = (hx.metrics.histograms["tokens"] ?? []).map((p) => p.attrs["gen_ai.token.type"]);
    assert.deepEqual([...types].sort(), ["input", "output"], "registry token types only; cache/reasoning live in span attrs");
  });

  test("1.43 keeps the pre-registry token.type series for pinned older dialects", async () => {
    const hx = makeHarness({ captureContent: "full", semconv: "1.37" });
    hx.tracker.startSession();
    hx.tracker.startInteraction("p");
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.completeLlm(
      asstMsg({ text: "t", stopReason: "stop", input: 100, output: 20, cacheRead: 5, cacheWrite: 3, cacheWrite1h: 1, reasoning: 7 }),
    );
    hx.tracker.endTurn(); hx.tracker.endInteraction(); hx.tracker.endSession();
    await hx.flush();
    const byType = Object.fromEntries(
      (hx.metrics.histograms["tokens"] ?? []).map((p) => [p.attrs["gen_ai.token.type"], p.value]),
    );
    for (const t of ["input", "output", "cache_read", "cache_write", "cache_write_1h", "reasoning"]) {
      assert.ok(t in byType, `1.37 keeps the ${t} series`);
    }
    const a = hx.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(a["gen_ai.usage.cache_read_input_tokens"], 5, "1.37 keeps its historical attribute names");
    assert.equal(a["gen_ai.usage.cache_write_input_tokens"], 3);
    assert.equal(a["gen_ai.usage.reasoning_tokens"], 7);
  });

  test("1.43 records gen_ai.response.time_to_first_chunk on first token", async () => {
    const hx = makeHarness({ captureContent: "full", semconv: "1.43" });
    hx.tracker.startSession();
    hx.tracker.startInteraction("p");
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.noteFirstToken({ role: "assistant" });
    hx.tracker.completeLlm(asstMsg({ text: "t", stopReason: "stop" }));
    hx.tracker.endTurn(); hx.tracker.endInteraction(); hx.tracker.endSession();
    await hx.flush();
    const a = hx.span(SPAN_LLM_REQUEST).attributes;
    const ttfc = a["gen_ai.response.time_to_first_chunk"];
    assert.equal(typeof ttfc, "number", "registry attribute present");
    assert.ok((ttfc as number) >= 0 && (ttfc as number) < 60, "seconds-scaled value");
    // The registry metric point is recorded through the same path; the
    // instrument name selection is covered in metrics.test.ts.
    assert.equal(hx.metrics.histograms["ttft"]?.length, 1, "ttft metric point recorded");
  });
});

// ---------------------------------------------------------------------------
// Attempts — one per agent_start/agent_end pair inside a run.
// ---------------------------------------------------------------------------

describe("attempts", () => {
  test("numbers attempts per run and closes them in order", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startAttempt();
    h.tracker.startTurn(0);
    h.tracker.endTurn();
    h.tracker.endAttempt();
    h.tracker.startAttempt();
    h.tracker.endAttempt();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const attempts = h.spanExporter.getFinishedSpans().filter((s) => s.name === SPAN_ATTEMPT);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((a) => a.attributes[ATTR_PI_ATTEMPT_NUMBER]), [1, 2]);
    assert.equal(attempts[0]!.attributes[ATTR_PI_ATTEMPT_REASON], undefined, "a first attempt has no reason");
    assert.equal(attempts[1]!.attributes[ATTR_PI_ATTEMPT_REASON], undefined, "a clean re-run has no reason");
    assert.ok(attempts.every((a) => a.ended));
  });

  test("a re-run after a failed attempt is tagged retry", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startAttempt();
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "anthropic");
    h.tracker.completeLlm(asstMsg({ stopReason: "error", errorMessage: "overloaded" }));
    h.tracker.endTurn();
    h.tracker.endAttempt();
    // pi retries the prompt without a new user prompt.
    h.tracker.startAttempt();
    h.tracker.endAttempt();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const attempts = h.spanExporter.getFinishedSpans().filter((s) => s.name === SPAN_ATTEMPT);
    assert.equal(attempts[1]!.attributes[ATTR_PI_ATTEMPT_REASON], "retry");
  });

  test("a run continued after a compaction is tagged post_compaction", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startAttempt();
    h.tracker.startCompaction("overflow", { tokensBefore: 150_000 });
    h.tracker.endCompaction({ reason: "overflow", willRetry: true });
    h.tracker.endAttempt();
    h.tracker.startAttempt();
    h.tracker.endAttempt();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const attempts = h.spanExporter.getFinishedSpans().filter((s) => s.name === SPAN_ATTEMPT);
    assert.equal(attempts[1]!.attributes[ATTR_PI_ATTEMPT_REASON], "post_compaction");
  });

  test("a turn with no attempt open falls back to the run root", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "anthropic");
    h.tracker.completeLlm(asstMsg({ text: "ok" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const interaction = h.span(SPAN_INTERACTION);
    assert.equal(
      h.span(SPAN_TURN).parentSpanContext?.spanId,
      interaction.spanContext().spanId,
      "no attempt to parent under, so the run root takes the turn",
    );
    assert.equal(
      h.spanExporter.getFinishedSpans().some((s) => s.name === SPAN_ATTEMPT),
      false,
      "no attempt span is invented",
    );
  });
});

// ---------------------------------------------------------------------------
// Pending generation claim — provider hooks describe candidates, not turns.
// ---------------------------------------------------------------------------

describe("pending generation claim", () => {
  test("an unclaimed request emits no LLM span (cache warmers are not turns)", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    // A cache warmer reaches the provider hooks but never becomes an
    // assistant generation.
    h.tracker.noteProviderRequest("m", "anthropic");
    h.tracker.recordProviderResponse(200, { "x-request-id": "warm-1" });
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    assert.equal(
      h.spanExporter.getFinishedSpans().some((s) => s.name === SPAN_LLM_REQUEST),
      false,
      "no span for an unclaimed request",
    );
  });

  test("an assistant message claims the request and replays its responses", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.noteProviderRequest("m", "anthropic");
    h.tracker.recordProviderResponse(429, { "x-request-id": "req-1" });
    h.tracker.recordProviderResponse(200, { "x-request-id": "req-1", "cf-ray": "abc123" });
    h.tracker.claimPendingLlm();
    h.tracker.completeLlm(asstMsg({ text: "ok" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const llm = h.span(SPAN_LLM_REQUEST);
    assert.equal(llm.attributes[ATTR_HTTP_STATUS_CODE], 200, "last attempt's status");
    assert.equal(llm.attributes[ATTR_GEN_AI_RESPONSE_ID], "req-1", "response id from buffered headers");
    assert.equal(llm.attributes["http.response.header.cf-ray"], "abc123");
    assert.equal(h.metrics.counters["retries"]?.length, 1, "the 429 counted as a retry");
    assert.equal(llm.status.code, SpanStatusCode.UNSET, "a recovered request is not an error");
  });

  test("the claimed span starts when the request started, not when it was claimed", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    let now = 1_700_000_000_000;
    const tracker = new SpanTracker({
      tracer: provider.getTracer("pi-otel-test", "0.0.0"),
      captureContent: "full",
      sessionId: () => "test-session",
      sessionFile: () => undefined,
      cwd: "/test",
      metrics: () => null,
      now: () => now,
    });
    tracker.startSession();
    tracker.startInteraction("p");
    tracker.startTurn(0);
    tracker.noteProviderRequest("m", "anthropic");
    // The generation is claimed five seconds into the request.
    now += 5_000;
    tracker.claimPendingLlm();
    tracker.completeLlm(asstMsg({ text: "ok" }));
    tracker.endTurn();
    tracker.endInteraction();
    tracker.endSession();
    await provider.forceFlush();
    const llm = exporter.getFinishedSpans().find((s) => s.name === SPAN_LLM_REQUEST)!;
    const startedAtMs = llm.startTime[0] * 1000 + Math.floor(llm.startTime[1] / 1e6);
    assert.equal(startedAtMs, 1_700_000_000_000, "span is backdated to the request start");
  });

  test("an unclaimed request is discarded at the next run boundary", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("first");
    h.tracker.noteProviderRequest("m", "anthropic");
    h.tracker.endInteraction();
    // The next run must not inherit the previous run's candidate request.
    h.tracker.startInteraction("second");
    h.tracker.claimPendingLlm();
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    assert.equal(
      h.spanExporter.getFinishedSpans().some((s) => s.name === SPAN_LLM_REQUEST),
      false,
      "the abandoned candidate never becomes a span",
    );
  });
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

describe("compaction span", () => {
  test("carries what pi reported and hangs off the run root, not the attempt", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startAttempt();
    h.tracker.startCompaction("overflow", { tokensBefore: 150_000 });
    h.tracker.endCompaction({
      reason: "overflow",
      willRetry: true,
      fromExtension: false,
      tokensBefore: 150_000,
      tokensAfter: 32_000,
    });
    h.tracker.endAttempt();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const compaction = h.span(SPAN_COMPACTION);
    const attrs = compaction.attributes;
    assert.equal(attrs[ATTR_PI_COMPACTION_REASON], "overflow");
    assert.equal(attrs[ATTR_PI_COMPACTION_TOKENS_BEFORE], 150_000);
    assert.equal(attrs[ATTR_PI_COMPACTION_TOKENS_AFTER], 32_000);
    assert.equal(attrs[ATTR_PI_COMPACTION_WILL_RETRY], true);
    assert.equal(attrs[ATTR_PI_COMPACTION_FROM_EXTENSION], false);
    assert.equal(
      compaction.parentSpanContext?.spanId,
      h.span(SPAN_INTERACTION).spanContext().spanId,
      "parented on the run root",
    );
  });

  test("advances pi.cache.epoch for requests after it", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "anthropic");
    h.tracker.completeLlm(asstMsg({ text: "before" }));
    h.tracker.endTurn();
    h.tracker.startCompaction("threshold", { tokensBefore: 150_000 });
    h.tracker.endCompaction({ reason: "threshold" });
    h.tracker.startTurn(1);
    h.tracker.noteProviderRequest("m", "anthropic");
    h.tracker.claimPendingLlm();
    h.tracker.completeLlm(asstMsg({ text: "after" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const llmSpans = h.spanExporter.getFinishedSpans().filter((s) => s.name === SPAN_LLM_REQUEST);
    assert.deepEqual(
      llmSpans.map((s) => s.attributes[ATTR_PI_CACHE_EPOCH]),
      [0, 1],
      "a compaction starts a new cache generation",
    );
  });

  test("records the summarization call's usage when pi reports it", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startCompaction("threshold", { tokensBefore: 150_000 });
    h.tracker.endCompaction({
      reason: "threshold",
      fromExtension: false,
      usage: { input: 4_000, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 4_300, cost: { total: 0.01 } },
    });
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const compaction = h.span(SPAN_COMPACTION);
    // The claim model gives the summarization call no llm span, so its spend
    // must land on the compaction span and the session totals.
    assert.equal(compaction.attributes[ATTR_GEN_AI_OPERATION_NAME], "chat");
    assert.equal(compaction.attributes[ATTR_GEN_AI_INPUT_TOKENS], 4_000);
    assert.equal(compaction.attributes[ATTR_GEN_AI_OUTPUT_TOKENS], 300);
    assert.equal(compaction.attributes[ATTR_GEN_AI_TOTAL_TOKENS], 4_300);
    assert.equal(compaction.attributes[ATTR_GEN_AI_COST_USD], 0.01);
    const tokens = (h.metrics as RecordingMetrics).histograms["tokens"] ?? [];
    assert.equal(tokens.filter((r) => r.attrs["gen_ai.token.type"] === "input").some((r) => r.value === 4_000), true);
    const summary = h.tracker.sessionSummary();
    assert.equal(summary.inputTokens, 4_000);
    assert.equal(summary.outputTokens, 300);
    assert.equal(summary.costUsd, 0.01);
  });

  test("an extension-supplied summary with no usage carries no operation name", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startCompaction("manual");
    h.tracker.endCompaction({ reason: "manual", fromExtension: true });
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const compaction = h.span(SPAN_COMPACTION);
    assert.equal(compaction.attributes[ATTR_GEN_AI_OPERATION_NAME], undefined);
    assert.equal(compaction.attributes[ATTR_GEN_AI_INPUT_TOKENS], undefined);
  });

  test("a pending provider record at compaction close is discarded, not claimed", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.noteProviderRequest("m", "anthropic");
    h.tracker.startCompaction("overflow", { tokensBefore: 200_000 });
    h.tracker.endCompaction({ reason: "overflow" });
    // The next assistant event must not backdate an llm span across the
    // compaction using the summarization call's pending record.
    h.tracker.claimPendingLlm();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const llmSpans = h.spanExporter.getFinishedSpans().filter((s) => s.name === SPAN_LLM_REQUEST);
    assert.equal(llmSpans.length, 0);
  });

  test("closes defensively (orphaned) when a run ends mid-compaction", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startCompaction("manual");
    h.tracker.endInteraction({ reason: "session_switch" });
    h.tracker.endSession();
    await h.flush();
    const compaction = h.span(SPAN_COMPACTION);
    assert.equal(compaction.ended, true);
    assert.equal(compaction.attributes[ATTR_PI_ORPHANED], true);
  });
});

// ---------------------------------------------------------------------------
// Response header allowlist
// ---------------------------------------------------------------------------

describe("response header allowlist", () => {
  test("keeps allowlisted headers and drops everything else", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "anthropic");
    h.tracker.recordProviderResponse(200, {
      "Retry-After": "30",
      "CF-Ray": "abc123",
      "X-RateLimit-Remaining-Tokens": "1500",
      "Set-Cookie": "session=secret",
      Authorization: "Bearer secret",
    });
    h.tracker.completeLlm(asstMsg({ text: "ok" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const attrs = h.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(attrs["http.response.header.retry-after"], "30", "mixed-case names normalize");
    assert.equal(attrs["http.response.header.cf-ray"], "abc123");
    assert.equal(attrs["http.response.header.x-ratelimit-remaining-tokens"], "1500");
    assert.equal(attrs["http.response.header.set-cookie"], undefined, "unlisted header dropped");
    assert.equal(attrs["http.response.header.authorization"], undefined, "credentials never captured");
  });

  test("truncates a long header value", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "anthropic");
    h.tracker.recordProviderResponse(200, { "cf-ray": "x".repeat(5_000) });
    h.tracker.completeLlm(asstMsg({ text: "ok" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const value = h.span(SPAN_LLM_REQUEST).attributes["http.response.header.cf-ray"] as string;
    assert.equal(value.length, 1024);
  });
});

// ---------------------------------------------------------------------------
// Context, route, and usage additions
// ---------------------------------------------------------------------------

describe("context and route attributes", () => {
  test("the LLM span reports context usage at claim; the run root reports it at close", async () => {
    let usage = { tokens: 40_000, contextWindow: 200_000, percent: 20 };
    const hx = makeHarness({ contextUsage: () => usage });
    hx.tracker.startSession();
    hx.tracker.startInteraction("p");
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.completeLlm(asstMsg({ text: "ok" }));
    hx.tracker.endTurn();
    usage = { tokens: 55_000, contextWindow: 200_000, percent: 27.5 };
    hx.tracker.endInteraction();
    hx.tracker.endSession();
    await hx.flush();
    const llm = hx.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(llm[ATTR_PI_CONTEXT_TOKENS], 40_000, "context at request time");
    assert.equal(llm[ATTR_PI_CONTEXT_WINDOW], 200_000);
    assert.equal(llm[ATTR_PI_CONTEXT_PERCENT], 20);
    const root = hx.span(SPAN_INTERACTION).attributes;
    assert.equal(root[ATTR_PI_CONTEXT_TOKENS], 55_000, "context at run close");
    assert.equal(root[ATTR_PI_CONTEXT_PERCENT], 27.5);
  });

  test("unknown context usage is omitted rather than sent as zero", async () => {
    const hx = makeHarness({
      contextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
    });
    hx.tracker.startSession();
    hx.tracker.startInteraction("p");
    hx.tracker.startTurn(0);
    hx.tracker.startLlm("m", "anthropic");
    hx.tracker.completeLlm(asstMsg({ text: "ok" }));
    hx.tracker.endTurn();
    hx.tracker.endInteraction();
    hx.tracker.endSession();
    await hx.flush();
    const attrs = hx.span(SPAN_LLM_REQUEST).attributes;
    assert.equal(ATTR_PI_CONTEXT_TOKENS in attrs, false);
    assert.equal(ATTR_PI_CONTEXT_PERCENT in attrs, false);
    assert.equal(attrs[ATTR_PI_CONTEXT_WINDOW], 200_000);
  });

  test("the request after a model transition reports the route change", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "anthropic");
    h.tracker.completeLlm(asstMsg({ text: "before" }));
    h.tracker.endTurn();
    h.tracker.noteModelSelect({
      source: "cycle",
      previousModel: { provider: "anthropic", id: "claude-4" },
    });
    h.tracker.startTurn(1);
    h.tracker.startLlm("m2", "openai");
    h.tracker.completeLlm(asstMsg({ text: "after" }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    const llmSpans = h.spanExporter.getFinishedSpans().filter((s) => s.name === SPAN_LLM_REQUEST);
    const after = llmSpans[1]!.attributes;
    assert.equal(after[ATTR_PI_ROUTE_TRANSITION_REASON], "cycle");
    assert.equal(after[ATTR_PI_ROUTE_PREVIOUS_MODEL], "anthropic/claude-4");
    assert.equal(
      llmSpans[0]!.attributes[ATTR_PI_ROUTE_TRANSITION_REASON],
      undefined,
      "the transition is reported once, by the next request",
    );
  });

  test("records gen_ai.usage.total_tokens when pi reports it", async () => {
    h.tracker.startSession();
    h.tracker.startInteraction("p");
    h.tracker.startTurn(0);
    h.tracker.startLlm("m", "anthropic");
    h.tracker.completeLlm(asstMsg({ input: 10, output: 5, cacheRead: 100, totalTokens: 115 }));
    h.tracker.endTurn();
    h.tracker.endInteraction();
    h.tracker.endSession();
    await h.flush();
    assert.equal(h.span(SPAN_LLM_REQUEST).attributes[ATTR_GEN_AI_TOTAL_TOKENS], 115);
  });
});

// ---------------------------------------------------------------------------
// TRACEPARENT publication and inheritance
// ---------------------------------------------------------------------------

describe("traceparent propagation", () => {
  test("publishes the run context for children and restores the previous value", async () => {
    const prior = process.env.TRACEPARENT;
    try {
      h.tracker.startSession();
      h.tracker.startInteraction("p");
      const published = process.env.TRACEPARENT ?? "";
      assert.match(published, /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
      assert.equal(published.split("-")[1], h.tracker.activeTraceId(), "published trace is the run's");
      h.tracker.endInteraction();
      assert.equal(process.env.TRACEPARENT, undefined, "withdrawn when the run closes");
    } finally {
      if (prior === undefined) delete process.env.TRACEPARENT;
      else process.env.TRACEPARENT = prior;
    }
  });

  test("withdrawal restores a value this run did not install", async () => {
    const prior = process.env.TRACEPARENT;
    try {
      process.env.TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01";
      h.tracker.startSession();
      h.tracker.startInteraction("p");
      h.tracker.endInteraction();
      assert.equal(
        process.env.TRACEPARENT,
        "00-11111111111111111111111111111111-2222222222222222-01",
        "the outer context survives the run",
      );
    } finally {
      if (prior === undefined) delete process.env.TRACEPARENT;
      else process.env.TRACEPARENT = prior;
    }
  });

  test("adopts an inherited context as a remote parent for run roots", async () => {
    const prior = process.env.TRACEPARENT;
    try {
      resetInheritedTraceparent();
      process.env.TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      const hx = makeHarness();
      hx.tracker.startSession();
      hx.tracker.startInteraction("child work");
      hx.tracker.endInteraction();
      hx.tracker.endSession();
      await hx.flush();
      const interaction = hx.span(SPAN_INTERACTION);
      assert.equal(
        interaction.spanContext().traceId,
        "4bf92f3577b34da6a3ce929d0e0e4736",
        "the run joins the spawning process's trace",
      );
      assert.equal(interaction.parentSpanContext?.spanId, "00f067aa0ba902b7");
      assert.equal(interaction.attributes[ATTR_PI_PARENT_TRACE_ID], "4bf92f3577b34da6a3ce929d0e0e4736");
      assert.equal(interaction.attributes[ATTR_PI_PARENT_SPAN_ID], "00f067aa0ba902b7");
    } finally {
      if (prior === undefined) delete process.env.TRACEPARENT;
      else process.env.TRACEPARENT = prior;
      resetInheritedTraceparent();
    }
  });

  test("a malformed inherited value does not fabricate a parent", async () => {
    const prior = process.env.TRACEPARENT;
    try {
      resetInheritedTraceparent();
      process.env.TRACEPARENT = "not-a-traceparent";
      const hx = makeHarness();
      hx.tracker.startSession();
      hx.tracker.startInteraction("p");
      hx.tracker.endInteraction();
      hx.tracker.endSession();
      await hx.flush();
      const interaction = hx.span(SPAN_INTERACTION);
      assert.equal(interaction.parentSpanContext, undefined);
      assert.notEqual("4bf92f3577b34da6a3ce929d0e0e4736", interaction.spanContext().traceId);
    } finally {
      if (prior === undefined) delete process.env.TRACEPARENT;
      else process.env.TRACEPARENT = prior;
      resetInheritedTraceparent();
    }
  });
});
