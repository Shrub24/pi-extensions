/**
 * Span lifecycle tracker.
 *
 * Owns the span tree. One user-driven run is one trace:
 *   pi.interaction                 (run root, trace root)
 *   ├─ pi.attempt                  (one per agent_start/agent_end pair)
 *   │  └─ pi.turn                  (per assistant response + its tool batch)
 *   │     ├─ pi.llm_request [CLIENT]  (the model call)
 *     │     └─ pi.tool.<name>        (siblings: each tool call)
 *   └─ pi.compaction               (session_before_compact → session_compact)
 *
 * A Pi session is a correlation key, not a span: session identity rides every
 * span as `pi.session.id` plus the `gen_ai.conversation.id` / `session.id`
 * aliases, so a session can outlive any number of runs without producing a
 * session-long root trace.
 *
 * Design notes:
 *  - Tool spans are siblings of the LLM span under the turn, NOT children.
 *    Tools execute after the model call returns, so parenting them to the
 *    LLM span would misrepresent the causal relationship.
 *  - Every span is closed defensively: on turn_end, on session replacement
 *    (before_switch/fork/compact/tree), on session_shutdown, and on abort.
 *    No orphaned spans survive.
 *  - Cancellation (Esc/abort) is detected via ctx.signal during a turn and
 *    marks active spans with `pi.cancelled` and ERROR status.
 *  - All handlers are best-effort: telemetry must never break pi's agent loop.
 */

import {
  type Context,
  SpanKind,
  SpanStatusCode,
  type Span,
  type SpanContext,
  type Tracer,
  context as otelContext,
  trace,
  type Attributes,
} from "@opentelemetry/api";
// Message shapes are imported structurally (see MessageShapes below) rather
// than from @earendil-works/pi-ai, which is a transitive dep of pi-coding-agent
// and not guaranteed to resolve from an extension's own node_modules.
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_CACHE_READ_TOKENS,
  ATTR_GEN_AI_CACHE_WRITE_1H_TOKENS,
  ATTR_GEN_AI_CACHE_WRITE_TOKENS,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_COST_USD,
  ATTR_GEN_AI_TOTAL_TOKENS,
  ATTR_SESSION_ID,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_INPUT_TOKENS,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_TOKENS,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REASONING_OUTPUT_TOKENS,
  ATTR_GEN_AI_REASONING_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_STREAM,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_SYSTEM_PROMPT_HASH,
  ATTR_GEN_AI_TOOL_DEFINITIONS,
  ATTR_GEN_AI_TOKEN_TYPE,
  GEN_AI_SYSTEM,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_HTTP_STATUS_CODE,
  ATTR_ERROR_TYPE,
  ATTR_EXCEPTION_MESSAGE,
  ATTR_PI_CANCELLED,
  ATTR_PI_ATTEMPT_NUMBER,
  ATTR_PI_ATTEMPT_REASON,
  ATTR_PI_CACHE_EPOCH,
  ATTR_PI_COMPACTION_FROM_EXTENSION,
  ATTR_PI_COMPACTION_REASON,
  ATTR_PI_COMPACTION_TOKENS_AFTER,
  ATTR_PI_COMPACTION_TOKENS_BEFORE,
  ATTR_PI_COMPACTION_WILL_RETRY,
  ATTR_PI_CONTEXT_PERCENT,
  ATTR_PI_CONTEXT_TOKENS,
  ATTR_PI_CONTEXT_WINDOW,
  ATTR_PI_CWD,
  ATTR_PI_RUN_KIND,
  ATTR_PI_SESSION_MODE,
  ATTR_PI_SESSION_NAME,
  ATTR_LANGFUSE_TRACE_NAME,
  ATTR_LANGFUSE_TRACE_TAGS,
  ATTR_LANGFUSE_TRACE_METADATA_PREFIX,
  ATTR_LANGFUSE_OBSERVATION_TYPE,
  ATTR_LANGFUSE_OBSERVATION_INPUT,
  ATTR_LANGFUSE_OBSERVATION_OUTPUT,
  ATTR_LATITUDE_CAPTURE_NAME,
  ATTR_LATITUDE_METADATA,
  ATTR_LATITUDE_TAGS,
  ATTR_PI_AGENT_ROLE,
  ATTR_PI_AGENT_LABEL,
  ATTR_PI_AGENT_RUN_ID,
  ATTR_PI_AGENT_OWNER_SESSION_ID,
  ATTR_PI_AGENT_WORKSPACE_ID,
  ATTR_PI_ERROR_COUNT,
  ATTR_PI_INTERACTION_ID,
  ATTR_PI_INTERACTION_ORIGIN,
  ATTR_PI_ORPHANED,
  ATTR_PI_PARENT_SPAN_ID,
  ATTR_PI_PARENT_TRACE_ID,
  ATTR_PI_PROMPT_LENGTH,
  ATTR_PI_ROUTE_PREVIOUS_MODEL,
  ATTR_PI_ROUTE_TRANSITION_REASON,
  ATTR_PI_SESSION_FILE,
  ATTR_PI_SESSION_ID,
  ATTR_PI_SESSION_PARENT_ID,
  ATTR_PI_SESSION_REASON,
  ATTR_PI_TOOL_COUNT,
  ATTR_PI_TOOL_IS_ERROR,
  ATTR_PI_TURN_COUNT,
  ATTR_PI_TURN_INDEX,
  ATTR_PI_USER_PROMPT,
  OP_NAME_CHAT,
  OP_NAME_EXECUTE_TOOL,
  OP_NAME_INVOKE_AGENT,
  clampAttr,
  EVENT_GEN_AI_ASSISTANT_MESSAGE,
  EVENT_GEN_AI_CHOICE,
  EVENT_GEN_AI_COMPLETION,
  EVENT_GEN_AI_FIRST_TOKEN,
  EVENT_GEN_AI_TOOL_MESSAGE,
  EVENT_GEN_AI_USER_MESSAGE,
  EVENT_PI_MESSAGE,
  hashPrompt,
  SPAN_ATTEMPT,
  SPAN_COMPACTION,
  SPAN_INTERACTION,
  SPAN_LLM_REQUEST,
  SPAN_TURN,
  fingerprint,
  spanToolName,
  type ContentCapture,
} from "./attrs.js";
import type { Metrics } from "./metrics.js";
import type { SemconvDialect } from "./config.js";
import {
  formatTraceparent,
  inheritedTraceparent,
  publishTraceparent,
} from "./traceparent.js";

/** Context alive at a point in time, as pi reports it (ctx.getContextUsage()). */
export interface ContextUsageShape {
  /** Estimated context tokens, or null when unknown (e.g. right after compaction). */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface TrackerOptions {
  tracer: Tracer;
  captureContent: ContentCapture;
  /** GenAI convention version. Default `1.43` (registry usage-attribute
   * names, gen_ai.request.stream, no message span events). `1.37` emits the
   * 2025-10 set, `1.36` the pre-rename set (gen_ai.system plus the message
   * events), both for backends not yet migrated. */
  semconv?: SemconvDialect;
  /** Lazy session id so the tracker doesn't need ctx at construction. */
  sessionId: () => string | undefined;
  sessionFile: () => string | undefined;
  cwd: string;
  metrics: () => Metrics | null;
  /** Lazy context usage, read when an LLM span opens and when the run closes. */
  contextUsage?: () => ContextUsageShape | undefined;
  /** Stable run/agent labels copied onto every span in the run. */
  runAttributes?: Attributes;
  /** Lazy display name for the current Pi session. */
  sessionName?: () => string | undefined;
  /** Orphan sweep interval in ms. Default 60_000. */
  orphanSweepIntervalMs?: number;
  /** Age at which an open span is considered orphaned, in ms. Default 30 * 60 * 1000. */
  orphanTtlMs?: number;
  /** Injection point for tests. Defaults to setInterval / clearInterval / Date.now. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

interface Slot {
  span: Span;
  ctx: Context;
}
interface TimedSlot extends Slot {
  /** Monotonic nanoseconds (process.hrtime.bigint) for accurate sub-ms durations. */
  startNs: bigint;
  /** Wall-clock ms (injectable now()) for orphan-sweep age checks. */
  startMs: number;
}
interface ToolSlot extends TimedSlot {
  name: string;
}

/**
 * A provider request that has not been claimed by an assistant lifecycle
 * event yet. `before_provider_request` and `after_provider_response` describe
 * candidates, not turns: cache warmers, probes, and internal summarization
 * calls also reach those hooks, and none of them is an agent generation.
 */
interface PendingLlm {
  requestModel?: string;
  providerSystem?: string;
  /** Wall-clock ms, used to backdate the span once the record is claimed. */
  startedAtMs: number;
  /** Monotonic ns, used for duration metrics so they measure the real request. */
  startedNs: bigint;
  responses: Array<{ status: number; headers: Record<string, string> }>;
  toolDefinitions?: unknown[];
}

/** Fields shared by a pending record and an open LLM span. */
interface LlmState {
  requestModel?: string;
  providerSystem?: string;
  responseModel?: string;
  toolCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  httpStatus?: number;
  attempts: number;
  /** Failed HTTP attempts seen so far (reset never; recovery clears lastError*). */
  failedAttempts: number;
  /** Category of the most recent failed attempt; cleared by a successful one. */
  lastErrorType?: string;
  /** HTTP status of the most recent failed attempt. */
  lastErrorStatus?: number;
  inputMessages: Array<Record<string, unknown>>;
  inputMessageCount: number;
  systemInstructions?: Array<Record<string, unknown>>;
  toolDefinitions?: unknown[];
  firstTokenSeen?: boolean;
  completionRecorded?: boolean;
}

/** Response headers worth keeping: request identity, throttling, and edge routing. */
const RESPONSE_HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  "x-request-id",
  "request-id",
  "anthropic-request-id",
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
  "cf-ray",
]);

/** Header values are provider metadata, not payload: keep them short. */
const MAX_HEADER_ATTR_CHARS = 1024;

function categorizeHttpError(status: number): string {
  if (status === 408) return "timeout";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth_error";
  if (status >= 500) return "server_error";
  // Only reached for unexpected 4xx statuses this extension does not name.
  return "client_error";
}

function categorizeThrownError(combined: string, errName: string): string {
  if (/timeout|abort/i.test(combined)) return "timeout";
  if (/rate.?limit/i.test(combined)) return "rate_limit";
  if (/auth|unauthorized|forbidden/i.test(combined)) return "auth_error";
  if (/context.*(length|window)|too.*(large|long)/i.test(combined)) return "request_too_large";
  if (/content.?filter|safety/i.test(combined)) return "content_filter";
  // Connection-level failures (VPN down, DNS, refused sockets) never produce
  // an HTTP response, so they surface as thrown/stream errors only.
  if (/econnrefused|enotfound|econnreset|ehostunreach|etimedout|epipe|fetch failed|network|socket hang up|dns|tls|certificate/i.test(combined)) return "network_error";
  return errName;
}

export type SessionReason = "startup" | "reload" | "new" | "resume" | "fork";

export class SpanTracker {
  private opts: TrackerOptions;
  private readonly semconv: SemconvDialect;
  /** Session correlation state; the session itself is not a span. */
  private sessionActive = false;
  private sessionReason: SessionReason | undefined;
  private sessionParentId: string | undefined;
  /** Remote parent inherited through TRACEPARENT, read once per process. */
  private readonly inheritedParent: SpanContext | undefined;
  /** Restores the previous TRACEPARENT when the current run closes. */
  private withdrawTraceparent: (() => void) | null = null;
  private interaction: (Slot) | null = null;
  private interactionSessionName: string | undefined;
  private interactionNameSnapshotTaken = false;
  private interactionOutput: string | undefined;
  private attempt: (TimedSlot & { number: number }) | null = null;
  private compaction: (TimedSlot & { reason: string }) | null = null;
  private turn: (TimedSlot & { index: number }) | null = null;
  private llm: (TimedSlot & LlmState) | null = null;
  /** Provider request awaiting an assistant lifecycle event to claim it. */
  private pendingLlm: PendingLlm | null = null;
  private tools = new Map<string, ToolSlot>();
  private systemPrompt: string | undefined;

  private interactionCount = 0;
  /** Attempts in the current interaction (reset each startInteraction). */
  private attemptCount = 0;
  /** Whether the current attempt produced a failed generation. */
  private attemptHadError = false;
  /** An attempt was compacted away and pi retried the prompt. */
  private compactedForRetry = false;
  /** The previous attempt ended in an error, so pi retried it. */
  private lastAttemptErrored = false;
  /** Completed compactions in this session; drives pi.cache.epoch. */
  private compactionCount = 0;
  /** Set by model_select, consumed by the next LLM span. */
  private routeTransition: { previousModel?: string; reason: string } | null = null;
  /** Turns in the current interaction (reset each startInteraction). */
  private interactionTurnCount = 0;
  /** Tools in the current interaction (reset each startInteraction). */
  private interactionToolCount = 0;
  /** Session-lifetime turn total (never reset until endSession). */
  private sessionTurnCount = 0;
  /** Session-lifetime tool total (never reset until endSession). */
  private sessionToolCount = 0;
  private sessionStartMs = 0;
  private orphanTimer: (() => void) | null = null;
  private readonly now: () => number;
  private readonly orphanTtlMs: number;
  private interactionStartMs = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;
  private errorCount = 0;
  /** Last error reference counted toward errorCount, for cascade dedupe. */
  private lastCountedError: unknown = undefined;

  constructor(opts: TrackerOptions) {
    this.opts = opts;
    this.semconv = opts.semconv ?? "1.43";
    this.now = opts.now ?? (() => Date.now());
    this.orphanTtlMs = opts.orphanTtlMs ?? 30 * 60 * 1000;
    this.setTimer = opts.setTimer ?? defaultSetTimer;
    this.inheritedParent = inheritedTraceparent();
  }

  private setTimer: (fn: () => void, ms: number) => () => void;

  // ---------------------------------------------------------------- sessions
  /**
   * Start session correlation. There is no session span: identity rides every
   * span's attributes, and the run roots are the traces.
   */
  startSession(reason?: SessionReason, parentId?: string): void {
    if (this.sessionActive) this.endSession();
    this.sessionStartMs = this.now();
    this.sessionActive = true;
    this.sessionReason = reason;
    this.sessionParentId = parentId;
    this.startOrphanSweep();
  }

  /**
   * Session totals, for the `pi.session.end` log record. Readable at any time:
   * the counters accumulate as the session runs, independent of open spans.
   */
  sessionSummary(): {
    turns: number;
    tools: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    errors: number;
  } {
    return {
      turns: this.sessionTurnCount,
      tools: this.sessionToolCount,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      costUsd: this.totalCostUsd,
      errors: this.errorCount,
    };
  }

  endSession(): void {
    // Defensive: close everything still open.
    this.endInteraction({ reason: "session_end" });
    if (this.sessionStartMs > 0) {
      const durSec = (this.now() - this.sessionStartMs) / 1000;
      try {
        this.opts.metrics()?.sessionDuration.record(durSec, this.commonAttrs());
      } catch { /* best-effort */ }
    }
    this.sessionActive = false;
    this.sessionReason = undefined;
    this.sessionParentId = undefined;
    this.sessionTurnCount = 0;
    this.sessionToolCount = 0;
    this.interactionTurnCount = 0;
    this.interactionToolCount = 0;
    this.compactionCount = 0;
    this.pendingLlm = null;
    this.pendingInput = [];
    this.stopOrphanSweep();
  }

  /**
   * Periodically end any span open longer than orphanTtlMs. Belt-and-suspenders
   * over the defensive closes in endInteraction: catches spans orphaned by
   * unexpected code paths or a process that skips session_shutdown.
   */
  private startOrphanSweep(): void {
    if (this.orphanTimer) return;
    const intervalMs = this.opts.orphanSweepIntervalMs ?? 60_000;
    this.orphanTimer = this.setTimer(() => this.sweepOrphans(), intervalMs);
  }

  private stopOrphanSweep(): void {
    if (this.orphanTimer) {
      this.orphanTimer();
      this.orphanTimer = null;
    }
  }

  private sweepOrphans(): void {
    const cutoff = this.now() - this.orphanTtlMs;
    // End any tool span older than the TTL.
    for (const [id, slot] of this.tools) {
      const startMs = slot.startMs;
      if (startMs < cutoff) {
        slot.span.setAttribute(ATTR_PI_ORPHANED, true);
        slot.span.end();
        this.tools.delete(id);
      }
    }
    // LLM span.
    if (this.llm && this.llm.startMs < cutoff) {
      this.llm.span.setAttribute(ATTR_PI_ORPHANED, true);
      this.applyLlmErrorState(this.llm.span);
      this.llm.span.end();
      this.llm = null;
    }
    // Turn span.
    if (this.turn && this.turn.startMs < cutoff) {
      this.turn.span.setAttribute(ATTR_PI_ORPHANED, true);
      this.turn.span.end();
      this.turn = null;
    }
    // Attempt span.
    if (this.attempt && this.attempt.startMs < cutoff) {
      this.attempt.span.setAttribute(ATTR_PI_ORPHANED, true);
      this.attempt.span.end();
      this.attempt = null;
    }
    // Compaction span.
    if (this.compaction && this.compaction.startMs < cutoff) {
      this.compaction.span.setAttribute(ATTR_PI_ORPHANED, true);
      this.compaction.span.end();
      this.compaction = null;
    }
    // Interaction (run root) span.
    if (this.interaction && this.interactionStartMs < cutoff) {
      this.interaction.span.setAttribute(ATTR_PI_ORPHANED, true);
      this.interaction.span.end();
      this.interaction = null;
      this.interactionStartMs = 0;
      this.withdrawPublishedTraceparent();
    }
  }

  // ----------------------------------------------------------- interactions
  /** A user prompt begins an interaction. */
  startInteraction(prompt: string | undefined): void {
    if (this.interaction) this.endInteraction({ reason: "superseded" });
    this.openInteraction(prompt, "user");
  }

  /**
   * Open an interaction only when none is open. Covers runs pi starts
   * without `before_agent_start`: the retry after an `agent_end` that closed
   * the interaction (pi < 0.80.5), and extension-triggered turns on an idle
   * session. Not a user prompt: no prompt metric, no prompt attributes; the
   * span is tagged `pi.interaction.origin=agent`.
   */
  ensureInteraction(): void {
    if (this.interaction) return;
    this.openInteraction(undefined, "agent");
  }

  private openInteraction(prompt: string | undefined, origin: "user" | "agent"): void {
    this.interactionCount++;
    this.interactionTurnCount = 0;
    this.interactionToolCount = 0;
    this.attemptCount = 0;
    this.attemptHadError = false;
    this.compactedForRetry = false;
    this.lastAttemptErrored = false;
    this.pendingInput = [];
    // A provider request that no assistant event claimed belongs to the run
    // that just ended, not to this one.
    this.pendingLlm = null;
    this.interactionSessionName = this.opts.sessionName?.()?.trim() || undefined;
    this.interactionNameSnapshotTaken = true;
    this.interactionOutput = undefined;
    const attrs = this.commonAttrs();
    attrs[ATTR_LANGFUSE_OBSERVATION_TYPE] = "agent";
    attrs[ATTR_PI_INTERACTION_ID] = this.interactionCount;
    attrs[ATTR_PI_INTERACTION_ORIGIN] = origin;
    attrs[ATTR_GEN_AI_OPERATION_NAME] = OP_NAME_INVOKE_AGENT;
    if (this.sessionReason !== undefined) {
      attrs[ATTR_PI_SESSION_REASON] = this.sessionReason;
    }
    if (this.sessionParentId) {
      attrs[ATTR_PI_SESSION_PARENT_ID] = this.sessionParentId;
    }
    if (typeof prompt === "string") {
      attrs[ATTR_PI_PROMPT_LENGTH] = prompt.length;
      if (this.shouldCapturePrompt()) {
        attrs[ATTR_PI_USER_PROMPT] = clampAttr(prompt);
        if (prompt.length > 0) {
          attrs[ATTR_LANGFUSE_OBSERVATION_INPUT] = clampAttr({
            messages: [{ role: "user", parts: [{ type: "text", content: prompt }] }],
          });
        }
      } else {
        Object.assign(attrs, prefixKeys("pi.user_prompt", fingerprint(prompt)));
      }
    }
    // The run root starts its own trace: no session span, and no ambient span
    // an embedding host may have made active. A process spawned by another pi
    // inherits that pi's run context through TRACEPARENT and joins its trace.
    const parent = this.runParentContext();
    if (this.inheritedParent) {
      attrs[ATTR_PI_PARENT_TRACE_ID] = this.inheritedParent.traceId;
      attrs[ATTR_PI_PARENT_SPAN_ID] = this.inheritedParent.spanId;
    }
    const sessionName = attrs[ATTR_PI_SESSION_NAME];
    const spanName = typeof sessionName === "string" ? sessionName : SPAN_INTERACTION;
    attrs[ATTR_LATITUDE_CAPTURE_NAME] = spanName;
    const span = this.opts.tracer.startSpan(spanName, { attributes: attrs }, parent);
    this.interaction = { span, ctx: trace.setSpan(parent, span) };
    this.interactionStartMs = this.now();
    this.publishRunTraceparent(span.spanContext());
    if (origin === "user") {
      try { this.opts.metrics()?.promptCount.add(1, this.commonAttrs()); } catch { /* noop */ }
    }
  }

  /** The context a run root starts from: this process's inherited parent when
   * one exists, otherwise a context with no active span of its own. */
  private runParentContext(): Context {
    const base = trace.deleteSpan(otelContext.active());
    if (!this.inheritedParent) return base;
    return trace.setSpan(base, trace.wrapSpanContext(this.inheritedParent));
  }

  /** Publish this run's context for the processes it spawns. */
  private publishRunTraceparent(ctx: SpanContext): void {
    this.withdrawPublishedTraceparent();
    const value = formatTraceparent(ctx);
    if (!value) return;
    this.withdrawTraceparent = publishTraceparent(value);
  }

  private withdrawPublishedTraceparent(): void {
    if (!this.withdrawTraceparent) return;
    try { this.withdrawTraceparent(); } catch { /* best-effort */ }
    this.withdrawTraceparent = null;
  }

  endInteraction(opts: { reason: string; cancelled?: boolean; error?: unknown } = { reason: "end" }): void {
    // Close any in-flight LLM/tool/turn first.
    this.endLlm({ reason: opts.reason, cancelled: opts.cancelled, error: opts.error });
    this.endAllTools(opts.reason);
    this.endTurn({ reason: opts.reason, cancelled: opts.cancelled, error: opts.error });
    this.closeCompactionDefensively();
    this.endAttempt({ reason: opts.reason, cancelled: opts.cancelled, error: opts.error });
    this.pendingLlm = null;
    if (this.interaction) {
      const span = this.interaction.span;
      if (opts.cancelled) {
        span.setAttribute(ATTR_PI_CANCELLED, true);
      } else if (opts.reason !== "end") {
        // Any non-normal end (superseded, session_switch/fork/tree, session_end)
        // means the interaction was abandoned mid-flight.
        span.setAttribute(ATTR_PI_ORPHANED, true);
      }
      span.setAttribute(ATTR_PI_TURN_COUNT, this.interactionTurnCount);
      span.setAttribute(ATTR_PI_TOOL_COUNT, this.interactionToolCount);
      // Context alive at the end of the run, so a run row shows both ends of
      // its context growth.
      this.applyContextUsage(span);
      if (this.shouldCapturePrompt() && this.interactionOutput) {
        span.setAttribute(ATTR_LANGFUSE_OBSERVATION_OUTPUT, this.interactionOutput);
      }
      this.setStatusFromError(span, opts.error);
      const finalAttrs = this.commonAttrs();
      span.setAttributes(finalAttrs);
      const finalName = finalAttrs[ATTR_PI_SESSION_NAME];
      if (typeof finalName === "string") span.updateName(finalName);
      span.end();
      this.interaction = null;
      this.interactionStartMs = 0;
      this.interactionSessionName = undefined;
      this.interactionNameSnapshotTaken = false;
      this.interactionOutput = undefined;
      this.systemPrompt = undefined;
      this.pendingInput = [];
    }
    this.withdrawPublishedTraceparent();
  }

  // --------------------------------------------------------------- attempts
  /**
   * Open an attempt: one agent_start/agent_end pair. Pi can run several
   * attempts inside one trace — an auto-retry after a provider error, or a
   * continued run after an overflow compaction.
   */
  startAttempt(): void {
    if (!this.interaction) return;
    if (this.attempt) this.endAttempt({ reason: "superseded" });
    this.attemptCount++;
    this.attemptHadError = false;
    const attrs = this.commonAttrs();
    attrs[ATTR_LANGFUSE_OBSERVATION_TYPE] = "span";
    attrs[ATTR_PI_ATTEMPT_NUMBER] = this.attemptCount;
    const reason = this.nextAttemptReason();
    if (reason) attrs[ATTR_PI_ATTEMPT_REASON] = reason;
    const span = this.opts.tracer.startSpan(SPAN_ATTEMPT, { attributes: attrs }, this.interaction.ctx);
    this.attempt = {
      span,
      ctx: trace.setSpan(this.interaction.ctx, span),
      number: this.attemptCount,
      startNs: process.hrtime.bigint(),
      startMs: this.now(),
    };
  }

  /** Why this attempt exists, read once from the previous attempt's outcome. */
  private nextAttemptReason(): "post_compaction" | "retry" | undefined {
    if (this.compactedForRetry) {
      this.compactedForRetry = false;
      this.lastAttemptErrored = false;
      return "post_compaction";
    }
    if (this.lastAttemptErrored) {
      this.lastAttemptErrored = false;
      return "retry";
    }
    return undefined;
  }

  endAttempt(opts: { reason: string; cancelled?: boolean; error?: unknown } = { reason: "end" }): void {
    if (!this.attempt) return;
    const span = this.attempt.span;
    if (opts.cancelled) span.setAttribute(ATTR_PI_CANCELLED, true);
    else if (opts.reason !== "end") span.setAttribute(ATTR_PI_ORPHANED, true);
    this.lastAttemptErrored = this.attemptHadError;
    this.setStatusFromError(span, opts.error);
    span.end();
    this.attempt = null;
  }

  // ------------------------------------------------------------------ turns
  startTurn(turnIndex: number): void {
    if (!this.interaction) return;
    if (this.turn) this.endTurn({ reason: "superseded" });
    this.interactionTurnCount++;
    this.sessionTurnCount++;
    const attrs = this.commonAttrs();
    attrs[ATTR_LANGFUSE_OBSERVATION_TYPE] = "chain";
    attrs[ATTR_PI_TURN_INDEX] = turnIndex;
    attrs[ATTR_GEN_AI_OPERATION_NAME] = OP_NAME_CHAT;
    const parent = this.attempt?.ctx ?? this.interaction.ctx;
    const span = this.opts.tracer.startSpan(SPAN_TURN, { attributes: attrs }, parent);
    this.turn = { span, ctx: trace.setSpan(parent, span), index: turnIndex, startNs: process.hrtime.bigint(), startMs: this.now() };
    try { this.opts.metrics()?.turnCount.add(1, this.commonAttrs()); } catch { /* noop */ }
  }

  endTurn(opts: { reason: string; cancelled?: boolean; error?: unknown } = { reason: "end" }): void {
    if (!this.turn) return;
    const span = this.turn.span;
    if (opts.cancelled) span.setAttribute(ATTR_PI_CANCELLED, true);
    else if (opts.reason === "superseded") span.setAttribute(ATTR_PI_ORPHANED, true);
    this.setStatusFromError(span, opts.error);
    span.end();
    this.turn = null;
    // The turn-cancellation metric is bumped from markCancelled so it only
    // counts aborts that actually cancelled an in-flight turn. The cancelled
    // flag here only drives the span attribute.
  }

  // ------------------------------------------------------------- llm spans
  /**
   * Record a provider request as a candidate generation. No span opens here:
   * cache warmers, probes, and internal summarization calls also reach
   * `before_provider_request`, and only an assistant lifecycle event proves
   * this request became an agent generation (see claimPendingLlm).
   */
  noteProviderRequest(
    requestModel: string | undefined,
    providerSystem: string | undefined,
    toolDefinitions?: unknown[],
  ): void {
    this.pendingLlm = {
      requestModel,
      providerSystem,
      startedAtMs: this.now(),
      startedNs: process.hrtime.bigint(),
      responses: [],
      toolDefinitions,
    };
  }

  /**
   * Claim the pending provider request for the LLM span. No-op when nothing is
   * pending or a span is already open. The span is backdated to the request
   * start, so latency and TTFT cover the real request, not the claim.
   */
  claimPendingLlm(): void {
    const pending = this.pendingLlm;
    if (!pending || this.llm) return;
    this.openLlm(pending.requestModel, pending.providerSystem, pending);
  }

  /** Open an LLM span directly (tests and the claim path). Consumes any
   * pending record so a later claim cannot open a second span for it. */
  startLlm(requestModel: string | undefined, providerSystem: string | undefined): void {
    const pending = this.pendingLlm;
    this.pendingLlm = null;
    this.openLlm(requestModel, providerSystem, pending ?? undefined);
  }

  private openLlm(
    requestModel: string | undefined,
    providerSystem: string | undefined,
    pending?: PendingLlm,
  ): void {
    if (this.llm) this.endLlm({ reason: "superseded" });
    const parent = this.turn?.ctx ?? this.attempt?.ctx ?? this.interaction?.ctx ?? this.runParentContext();
    const attrs = this.commonAttrs();
    attrs[ATTR_GEN_AI_OPERATION_NAME] = OP_NAME_CHAT;
    attrs[ATTR_LANGFUSE_OBSERVATION_TYPE] = "generation";
    const systemInstructions = this.shouldCapturePrompt() && this.systemPrompt
      ? [{ type: "text", content: this.systemPrompt }]
      : undefined;
    const toolDefinitions = this.shouldCapturePrompt() && pending?.toolDefinitions?.length
      ? pending.toolDefinitions
      : undefined;
    if (systemInstructions) {
      attrs[ATTR_GEN_AI_SYSTEM_INSTRUCTIONS] = clampAttr(systemInstructions);
    }
    if (toolDefinitions) {
      attrs[ATTR_GEN_AI_TOOL_DEFINITIONS] = clampAttr(toolDefinitions);
    }
    // Agent identity is the harness (pi). Provider identity is the dialect's
    // provider key: gen_ai.provider.name in 1.37 (the 2025-10 rename,
    // semantic-conventions v1.37.0), gen_ai.system in 1.36. Each dialect
    // emits only its own key; a dialect that also wrote the other version's
    // key would not be that version.
    attrs[ATTR_GEN_AI_AGENT_NAME] = GEN_AI_SYSTEM;
    if (providerSystem) {
      attrs[this.providerNameKey()] = providerSystem;
    }
    if (requestModel) attrs[ATTR_GEN_AI_REQUEST_MODEL] = requestModel;
    // pi always consumes assistant responses as a stream; registry-defined
    // from semantic-conventions 1.43.
    if (this.semconv === "1.43") {
      attrs[ATTR_GEN_AI_REQUEST_STREAM] = true;
    }
    // A compaction rewrites the cached prefix, so requests under different
    // epochs cannot be each other's cache hits. Read with the request's other
    // context attributes below.
    attrs[ATTR_PI_CACHE_EPOCH] = this.compactionCount;
    if (this.routeTransition) {
      attrs[ATTR_PI_ROUTE_TRANSITION_REASON] = this.routeTransition.reason;
      if (this.routeTransition.previousModel) {
        attrs[ATTR_PI_ROUTE_PREVIOUS_MODEL] = this.routeTransition.previousModel;
      }
      this.routeTransition = null;
    }
    const startedAtMs = pending?.startedAtMs ?? this.now();
    const startedNs = pending?.startedNs ?? process.hrtime.bigint();
    const span = this.opts.tracer.startSpan(
      SPAN_LLM_REQUEST,
      { kind: SpanKind.CLIENT, attributes: attrs, startTime: new Date(startedAtMs) },
      parent,
    );
    this.llm = {
      span,
      ctx: trace.setSpan(parent, span),
      startNs: startedNs,
      startMs: startedAtMs,
      requestModel,
      providerSystem,
      attempts: 0,
      failedAttempts: 0,
      inputMessages: [],
      inputMessageCount: 0,
      systemInstructions,
      toolDefinitions,
    };
    this.applyContextUsage(span);
    // Drain any user/tool messages that arrived before the LLM span opened.
    this.flushPendingInput();
    // Responses observed while the request was still pending are replayed so
    // retry and error accounting stays the same as in the direct path.
    for (const r of pending?.responses ?? []) this.applyResponseToLlm(r.status, r.headers);
  }

  noteFirstToken(message: { role?: string }): void {
    if (!this.llm || message.role !== "assistant" || this.llm.firstTokenSeen) return;
    this.llm.firstTokenSeen = true;
    const elapsedSec = Number(process.hrtime.bigint() - this.llm.startNs) / 1e9;
    const base: Attributes = this.commonAttrs();
    if (this.llm.requestModel) base[ATTR_GEN_AI_REQUEST_MODEL] = this.llm.requestModel;
    try {
      this.opts.metrics()?.timeToFirstToken.record(elapsedSec, base);
    } catch { /* best-effort */ }
    // Registry attribute (1.43, seconds) alongside the metric.
    if (this.semconv === "1.43") {
      this.llm.span.setAttribute(ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK, elapsedSec);
    }
    this.llm.span.addEvent(EVENT_GEN_AI_FIRST_TOKEN, { elapsed_s: elapsedSec } as Attributes);
  }

  noteLlmComplete(message: { role?: string }): void {
    if (message.role !== "assistant") return;
    // An assistant message ending is proof the pending request became a
    // generation, even when no message_start/update was observed.
    this.claimPendingLlm();
    if (!this.llm || this.llm.completionRecorded) return;
    this.llm.completionRecorded = true;
    const elapsedSec = Number(process.hrtime.bigint() - this.llm.startNs) / 1e9;
    const base: Attributes = this.commonAttrs();
    if (this.llm.requestModel) base[ATTR_GEN_AI_REQUEST_MODEL] = this.llm.requestModel;
    try {
      this.opts.metrics()?.timeToCompletion.record(elapsedSec, base);
    } catch { /* best-effort */ }
    this.llm.span.addEvent(EVENT_GEN_AI_COMPLETION, { elapsed_s: elapsedSec } as Attributes);
  }

  noteSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
    const hash = hashPrompt(prompt);
    if (!hash) return;
    const target = this.interaction?.span;
    if (target) target.setAttribute(ATTR_GEN_AI_SYSTEM_PROMPT_HASH, hash);
  }

  /** Buffer input until the LLM span opens, preserving custom-message provenance. */
  private pendingInput: Array<{
    role: "user" | "tool";
    text: string;
    toolCallId?: string;
    toolName?: string;
    source?: string;
    details?: unknown;
  }> = [];

  noteUserInput(text: string): void {
    this.pendingInput.push({ role: "user", text });
    this.flushPendingInput();
  }

  noteCustomInput(text: string, source: string, details?: unknown): void {
    this.pendingInput.push({ role: "user", text, source, details });
    this.flushPendingInput();
  }

  noteToolResultInput(toolCallId: string, toolName: string | undefined, text: string): void {
    this.pendingInput.push({ role: "tool", text, toolCallId, toolName });
    this.flushPendingInput();
  }

  private llmEventGenAiSystem(): Record<string, string> | undefined {
    const ps = this.llm?.providerSystem;
    return ps ? { [this.providerNameKey()]: ps } : undefined;
  }

  private writeLangfuseInput(): void {
    const llm = this.llm;
    if (!llm || !this.shouldCapturePrompt()) return;
    const input: Record<string, unknown> = {};
    if (llm.systemInstructions?.length) input.system_instructions = llm.systemInstructions;
    if (llm.inputMessages.length) input.messages = llm.inputMessages;
    if (llm.toolDefinitions?.length) input.tools = llm.toolDefinitions;
    if (Object.keys(input).length > 0) {
      llm.span.setAttribute(ATTR_LANGFUSE_OBSERVATION_INPUT, clampAttr(input));
    }
  }

  private flushPendingInput(): void {
    if (!this.llm) return;
    if (this.pendingInput.length === 0) {
      this.writeLangfuseInput();
      return;
    }
    const emitEvents = this.semconv === "1.36";
    for (const m of this.pendingInput) {
      const index = this.llm.inputMessageCount++;
      if (m.source) {
        const attrs: Attributes = {
          "pi.message.source": clampAttr(m.source),
          "pi.message.index": index,
        };
        if (this.shouldCapturePrompt() && m.details !== undefined) {
          attrs["pi.message.details"] = clampAttr(m.details);
        }
        this.llm.span.addEvent(EVENT_PI_MESSAGE, attrs);
      }
      if (m.role === "user") {
        if (!this.shouldCapturePrompt()) continue;
        if (emitEvents) {
          const attrs: Record<string, unknown> = { role: "user", ...this.llmEventGenAiSystem() };
          attrs.content = clampAttr(m.text);
          this.llm.span.addEvent(EVENT_GEN_AI_USER_MESSAGE, attrs as Attributes);
        }
        this.llm.inputMessages.push({ role: "user", parts: [{ type: "text", content: m.text }] });
      } else if (this.shouldCaptureToolContent()) {
        if (emitEvents) {
          const attrs: Record<string, unknown> = {
            role: "tool",
            ...this.llmEventGenAiSystem(),
            [ATTR_GEN_AI_TOOL_CALL_ID]: m.toolCallId ?? "",
            ...(m.toolName ? { [ATTR_GEN_AI_TOOL_NAME]: m.toolName } : {}),
            content: clampAttr(m.text),
          };
          this.llm.span.addEvent(EVENT_GEN_AI_TOOL_MESSAGE, attrs as Attributes);
        }
        this.llm.inputMessages.push({
          role: "tool",
          parts: [{ type: "tool_call_response", id: m.toolCallId, name: m.toolName, response: m.text }],
        });
      }
    }
    this.pendingInput = [];
    this.writeLangfuseInput();
  }

  /**
   * Record a provider HTTP response. Responses are buffered while the request
   * is still pending, so a claim can replay them onto the span it opens.
   * Returns true if this response was a retry within the request.
   */
  recordProviderResponse(status: number, headers: Record<string, string>): boolean {
    if (this.llm) return this.applyResponseToLlm(status, headers);
    if (this.pendingLlm) {
      this.pendingLlm.responses.push({ status, headers });
    }
    return false;
  }

  private applyResponseToLlm(status: number, headers: Record<string, string>): boolean {
    if (!this.llm) return false;
    this.llm.attempts++;
    this.llm.httpStatus = status;
    this.llm.span.setAttribute(ATTR_HTTP_STATUS_CODE, status);
    // HTTP header names are case-insensitive; normalize so mixed-case maps still match.
    const hdr = lowercaseKeys(headers);
    const respId = hdr["x-request-id"] ?? hdr["request-id"] ?? hdr["anthropic-request-id"] ?? hdr["openai-response-id"];
    if (respId) this.llm.span.setAttribute(ATTR_GEN_AI_RESPONSE_ID, respId);
    for (const [name, value] of Object.entries(hdr)) {
      if (!RESPONSE_HEADER_ALLOWLIST.has(name) || typeof value !== "string") continue;
      this.llm.span.setAttribute(`http.response.header.${name}`, value.slice(0, MAX_HEADER_ATTR_CHARS));
    }
    const retry = this.llm.attempts > 1;
    if (retry) {
      try {
        const attrs: Attributes = this.commonAttrs();
        if (this.llm.requestModel) attrs[ATTR_GEN_AI_REQUEST_MODEL] = this.llm.requestModel;
        attrs[ATTR_HTTP_STATUS_CODE] = status;
        this.opts.metrics()?.providerRetries.add(1, attrs);
      } catch { /* noop */ }
    }
    if (status >= 400) {
      // Track the failure on the slot, never on the span. Span attributes
      // cannot be removed once set (setAttribute ignores null/undefined), so
      // stamping an attempt-scoped error here would survive a successful
      // retry and misreport the request. The final outcome is applied once
      // at span finalization (applyLlmErrorState).
      this.llm.failedAttempts++;
      this.llm.lastErrorType = categorizeHttpError(status);
      this.llm.lastErrorStatus = status;
    } else if (this.llm.lastErrorType !== undefined) {
      // A retry succeeded: the request as a whole did not fail.
      this.llm.lastErrorType = undefined;
      this.llm.lastErrorStatus = undefined;
    }
    return retry;
  }

  /**
   * Stamp the final provider outcome on an LLM span. Called once at span
   * finalization (completeLlm error path, endLlm, orphan sweep): a failed
   * attempt that a retry recovered leaves no markers, while a request whose
   * final attempt failed keeps its error.type and ERROR status.
   */
  private applyLlmErrorState(span: Span): void {
    const slot = this.llm;
    if (!slot?.lastErrorType) return;
    span.setAttribute(ATTR_ERROR_TYPE, slot.lastErrorType);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: slot.lastErrorStatus !== undefined ? `HTTP ${slot.lastErrorStatus}` : "provider error",
    });
  }

  /** Finalize the LLM span from the completed AssistantMessage. */
  completeLlm(message: MessageShapes.AssistantMessage): void {
    // turn_end with an assistant message also claims a still-pending request:
    // on a path that skipped message_end the generation is still real.
    this.claimPendingLlm();
    if (!this.llm) return;
    const llm = this.llm;
    if (message.responseModel) {
      llm.responseModel = message.responseModel;
      llm.span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, message.responseModel);
    }
    if (message.responseId) llm.span.setAttribute(ATTR_GEN_AI_RESPONSE_ID, message.responseId);
    const finish = message.stopReason;
    if (finish) llm.span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [finish]);
    this.applyUsageAttrs(message);
    this.accumulateSessionUsageFromMessage(message);
    this.emitAssistantMessageEvents(message);
    llm.toolCallCount = countToolCalls(message);
    this.recordLlmMetrics();
    if (finish === "error" || finish === "aborted") {
      llm.span.setAttribute(ATTR_PI_CANCELLED, finish === "aborted");
      if (message.errorMessage) {
        llm.span.setAttribute(ATTR_EXCEPTION_MESSAGE, message.errorMessage);
      }
      // Stamp the final attempt's HTTP category (when one was seen) before
      // the status below overrides the message with the provider's own text.
      this.applyLlmErrorState(llm.span);
      if (finish === "error" && !llm.lastErrorType && message.errorMessage) {
        // No HTTP response was seen (connection refused, DNS failure, TLS
        // error): derive error.type from the message so tail-sampling and
        // dashboards keyed on it still see the failure.
        const m = /^([A-Za-z][A-Za-z0-9]*(?:Error|Exception))\s*:/.exec(message.errorMessage);
        const errName = m?.[1] ?? "unknown";
        llm.span.setAttribute(ATTR_ERROR_TYPE, categorizeThrownError(message.errorMessage, errName));
      }
      llm.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: message.errorMessage ?? finish,
      });
      if (finish === "error") {
        // One session error per failed request. Retries that recovered do
        // not count (recordProviderResponse stopped counting per attempt).
        this.errorCount++;
        // pi retries a failed attempt; the next attempt span says why.
        this.attemptHadError = true;
      }
    }
    llm.span.end();
    this.llm = null;
  }

  endLlm(opts: { reason: string; cancelled?: boolean; error?: unknown } = { reason: "end" }): void {
    if (!this.llm) return;
    const llm = this.llm;
    if (opts.cancelled) llm.span.setAttribute(ATTR_PI_CANCELLED, true);
    else if (opts.reason !== "end") llm.span.setAttribute(ATTR_PI_ORPHANED, true);
    this.setStatusFromError(llm.span, opts.error);
    this.applyLlmErrorState(llm.span);
    llm.span.end();
    this.llm = null;
  }

  /** The dialect's cache/reasoning usage attribute keys. input/output share
   * names across dialects; the 1.43 dialect adopts the registry's dotted
   * names (cache_read, cache_creation for a provider-managed write,
   * reasoning.output_tokens). */
  private usageKeys(): { cacheRead: string; cacheWrite: string; reasoning: string } {
    if (this.semconv === "1.43") {
      return {
        cacheRead: ATTR_GEN_AI_CACHE_READ_INPUT_TOKENS,
        cacheWrite: ATTR_GEN_AI_CACHE_CREATION_INPUT_TOKENS,
        reasoning: ATTR_GEN_AI_REASONING_OUTPUT_TOKENS,
      };
    }
    return {
      cacheRead: ATTR_GEN_AI_CACHE_READ_TOKENS,
      cacheWrite: ATTR_GEN_AI_CACHE_WRITE_TOKENS,
      reasoning: ATTR_GEN_AI_REASONING_TOKENS,
    };
  }

  private applyUsageAttrs(m: MessageShapes.AssistantMessage): void {
    if (!this.llm) return;
    const u = m.usage;
    if (!u) return;
    this.writeUsageAttrs(this.llm.span, u);
    this.llm.inputTokens = u.input;
    this.llm.outputTokens = u.output;
    this.llm.reasoningTokens = u.reasoning;
    this.llm.cacheReadTokens = u.cacheRead;
    this.llm.cacheWriteTokens = u.cacheWrite;
    this.llm.cacheWrite1hTokens = u.cacheWrite1h;
  }

  /** Write a Pi Usage object onto any span (llm_request or compaction): the
   * semantic-convention usage keys, the 1-hour split, and the cost total. */
  private writeUsageAttrs(span: Span, u: MessageShapes.Usage): void {
    const keys = this.usageKeys();
    const set = (k: string, v: unknown) => {
      if (typeof v === "number" && Number.isFinite(v)) span.setAttribute(k, v);
    };
    set(ATTR_GEN_AI_INPUT_TOKENS, u.input);
    set(ATTR_GEN_AI_OUTPUT_TOKENS, u.output);
    set(ATTR_GEN_AI_TOTAL_TOKENS, u.totalTokens);
    set(keys.cacheRead, u.cacheRead);
    set(keys.cacheWrite, u.cacheWrite);
    set(keys.reasoning, u.reasoning);
    // Extension-specific: no registry release defines the 1-hour cache split.
    if (typeof u.cacheWrite1h === "number") {
      set(ATTR_GEN_AI_CACHE_WRITE_1H_TOKENS, u.cacheWrite1h);
    }
    if (typeof u.cost?.total === "number") {
      set(ATTR_GEN_AI_COST_USD, u.cost.total);
    }
  }

  private recordLlmMetrics(): void {
    if (!this.llm) return;
    const m = this.opts.metrics();
    if (!m) return;
    const elapsedSec = Number(process.hrtime.bigint() - this.llm.startNs) / 1e9;
    const base: Attributes = this.commonAttrs();
    if (this.llm.requestModel) base[ATTR_GEN_AI_REQUEST_MODEL] = this.llm.requestModel;
    if (this.llm.responseModel) base[ATTR_GEN_AI_RESPONSE_MODEL] = this.llm.responseModel;
    try {
      m.opDuration.record(elapsedSec, base);
      // Input/output are always recorded when present (including zero). Cache
      // and reasoning types only when positive so every request does not emit
      // a stack of zero-valued series. The 1.43 dialect records only the
      // registry's input/output token types on this metric; the cache and
      // reasoning counts live in the span's gen_ai.usage.* attributes.
      const recordTokens = (value: number | undefined, tokenType: string, requirePositive = false) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        if (requirePositive && value <= 0) return;
        m.tokenUsage.record(value, { ...base, [ATTR_GEN_AI_TOKEN_TYPE]: tokenType });
      };
      recordTokens(this.llm.inputTokens, "input");
      recordTokens(this.llm.outputTokens, "output");
      if (this.semconv !== "1.43") {
        recordTokens(this.llm.cacheReadTokens, "cache_read", true);
        recordTokens(this.llm.cacheWriteTokens, "cache_write", true);
        recordTokens(this.llm.cacheWrite1hTokens, "cache_write_1h", true);
        recordTokens(this.llm.reasoningTokens, "reasoning", true);
      }
    } catch { /* best-effort */ }
  }

  private emitAssistantMessageEvents(m: MessageShapes.AssistantMessage): void {
    if (!this.llm) return;
    const text = extractAssistantText(m);
    const toolCalls = extractToolCalls(m, this.shouldCaptureToolContent());
    if (this.shouldCapturePrompt()) {
      // The legacy message/choice events duplicate the JSON message
      // attributes below, so the 1.37 dialect drops them: captured content
      // ships once, in the attributes current backends read.
      if (this.semconv === "1.36") {
        const asstAttrs: Record<string, unknown> = { role: "assistant", ...this.llmEventGenAiSystem() };
        if (text) asstAttrs.content = clampAttr(text);
        if (toolCalls.length) asstAttrs["tool_calls"] = clampAttr(toolCalls);
        this.llm.span.addEvent(EVENT_GEN_AI_ASSISTANT_MESSAGE, asstAttrs as Attributes);
        const finish = m.stopReason ?? "stop";
        // The choice event keeps only the decision metadata. An earlier
        // version embedded the full message JSON, a third copy of the
        // completion on the same span.
        this.llm.span.addEvent(EVENT_GEN_AI_CHOICE, {
          ...this.llmEventGenAiSystem(),
          index: 0,
          finish_reason: finish,
        });
      }
      // Aspire-style JSON message attributes (read by 9.x AI panel and others).
      if (this.llm.inputMessages.length > 0) {
        this.llm.span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, clampAttr(this.llm.inputMessages));
      }
      this.writeLangfuseInput();
      const outputParts: Array<Record<string, unknown>> = [];
      if (text) outputParts.push({ type: "text", content: text });
      for (const tc of toolCalls) {
        outputParts.push({ type: "tool_call", id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
      const outputMessages = [{ role: "assistant", parts: outputParts, finish_reason: m.stopReason ?? "stop" }];
      const output = clampAttr(outputMessages);
      this.llm.span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, output);
      this.llm.span.setAttribute(ATTR_LANGFUSE_OBSERVATION_OUTPUT, output);
      this.interactionOutput = output;
    }
  }

  // ------------------------------------------------------------ compaction
  /**
   * Open the compaction span. A compaction rewrites the conversation prefix
   * mid-run, so the span hangs off the run root, not off the attempt it
   * interrupts.
   */
  startCompaction(reason: string, preparation?: { tokensBefore?: number }): void {
    if (this.compaction) this.closeCompactionDefensively();
    const attrs = this.commonAttrs();
    attrs[ATTR_LANGFUSE_OBSERVATION_TYPE] = "span";
    attrs[ATTR_PI_COMPACTION_REASON] = reason;
    if (typeof preparation?.tokensBefore === "number") {
      attrs[ATTR_PI_COMPACTION_TOKENS_BEFORE] = preparation.tokensBefore;
    }
    const parent = this.interaction?.ctx ?? this.runParentContext();
    const span = this.opts.tracer.startSpan(SPAN_COMPACTION, { attributes: attrs }, parent);
    this.compaction = {
      span,
      ctx: trace.setSpan(parent, span),
      reason,
      startNs: process.hrtime.bigint(),
      startMs: this.now(),
    };
  }

  /**
   * Close the compaction span with what pi reported. Advances pi.cache.epoch:
   * every request after this one is a different cache generation.
   */
  endCompaction(result: {
    reason?: string;
    willRetry?: boolean;
    fromExtension?: boolean;
    tokensBefore?: number;
    tokensAfter?: number;
    usage?: MessageShapes.Usage;
    error?: unknown;
  } = {}): void {
    if (!this.compaction) return;
    const span = this.compaction.span;
    // The summarization call is a real model generation, but the claim model
    // gives it no llm span (no assistant event ever claims it). Pi reports its
    // usage on the compaction entry, so the spend lands here instead of
    // vanishing from metrics and cost rollups.
    if (result.usage) {
      this.writeUsageAttrs(span, result.usage);
      // Classify it as a model call only when pi confirms one happened:
      // extension-supplied summaries carry no usage and stay plain spans.
      span.setAttribute(ATTR_GEN_AI_OPERATION_NAME, OP_NAME_CHAT);
      this.recordCompactionUsage(result.usage);
    }
    if (result.reason !== undefined) span.setAttribute(ATTR_PI_COMPACTION_REASON, result.reason);
    if (typeof result.tokensBefore === "number") {
      span.setAttribute(ATTR_PI_COMPACTION_TOKENS_BEFORE, result.tokensBefore);
    }
    if (typeof result.tokensAfter === "number") {
      span.setAttribute(ATTR_PI_COMPACTION_TOKENS_AFTER, result.tokensAfter);
    }
    if (typeof result.willRetry === "boolean") {
      span.setAttribute(ATTR_PI_COMPACTION_WILL_RETRY, result.willRetry);
      if (result.willRetry) this.compactedForRetry = true;
    }
    if (typeof result.fromExtension === "boolean") {
      span.setAttribute(ATTR_PI_COMPACTION_FROM_EXTENSION, result.fromExtension);
    }
    this.setStatusFromError(span, result.error);
    span.end();
    this.compaction = null;
    this.compactionCount++;
    // A pending provider record at compaction close is the summarization call
    // itself; letting the next assistant event claim it would open a bogus
    // llm span backdated across the compaction.
    this.pendingLlm = null;
  }

  /** Token metrics + session totals for a model call that has no llm span of
   * its own (compaction summarization, branch summaries). Recorded against
   * the same histogram as llm requests so session-level token dashboards stay
   * whole. Model labels are omitted: pi does not report which model summarized. */
  recordCompactionUsage(u: MessageShapes.Usage): void {
    // Session totals first: they must not depend on metrics being enabled.
    if (typeof u.input === "number" && Number.isFinite(u.input)) this.totalInputTokens += u.input;
    if (typeof u.output === "number" && Number.isFinite(u.output)) this.totalOutputTokens += u.output;
    if (typeof u.cost?.total === "number" && Number.isFinite(u.cost.total)) this.totalCostUsd += u.cost.total;
    const m = this.opts.metrics();
    if (!m) return;
    const base: Attributes = this.commonAttrs();
    try {
      const record = (value: number | undefined, tokenType: string) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        m.tokenUsage.record(value, { ...base, [ATTR_GEN_AI_TOKEN_TYPE]: tokenType });
      };
      record(u.input, "input");
      record(u.output, "output");
    } catch { /* best-effort */ }
  }

  /** Close a compaction span that a run/session boundary abandoned. */
  private closeCompactionDefensively(): void {
    if (!this.compaction) return;
    const compactionReason = this.compaction.reason;
    this.compaction.span.setAttribute(ATTR_PI_ORPHANED, true);
    this.endCompaction({ reason: compactionReason });
  }

  /** Drop a provider record no assistant event will legitimately claim. */
  discardPendingLlm(): void {
    this.pendingLlm = null;
  }

  // ------------------------------------------------------------------ tools
  startTool(toolCallId: string, toolName: string, input: unknown): void {
    const parent = this.turn?.ctx ?? this.attempt?.ctx ?? this.interaction?.ctx ?? this.runParentContext();
    const attrs = this.commonAttrs();
    attrs[ATTR_GEN_AI_OPERATION_NAME] = OP_NAME_EXECUTE_TOOL;
    attrs[ATTR_LANGFUSE_OBSERVATION_TYPE] = "tool";
    attrs[ATTR_GEN_AI_TOOL_NAME] = toolName;
    attrs[ATTR_GEN_AI_TOOL_CALL_ID] = toolCallId;
    if (this.shouldCaptureToolContent() && input !== undefined) {
      const capturedInput = clampAttr(input);
      attrs[ATTR_GEN_AI_TOOL_CALL_ARGUMENTS] = capturedInput;
      attrs[ATTR_LANGFUSE_OBSERVATION_INPUT] = capturedInput;
    }
    const spanOptions: { attributes: Attributes; links?: Array<{ context: SpanContext }> } = { attributes: attrs };
    if (this.llm) {
      // Only link when the LLM span has a real span context. When traces are
      // disabled the runtime hands the tracker a no-op tracer whose span
      // contexts carry empty trace/span ids; a link to such a context is
      // invalid per the OTel spec, so skip it.
      const ctx = this.llm.span.spanContext();
      if (ctx.traceId && ctx.spanId) {
        spanOptions.links = [{ context: ctx }];
      }
    }
    const span = this.opts.tracer.startSpan(spanToolName(toolName), spanOptions, parent);
    this.tools.set(toolCallId, {
      span,
      ctx: trace.setSpan(parent, span),
      name: toolName,
      startNs: process.hrtime.bigint(),
      startMs: this.now(),
    });
    this.interactionToolCount++;
    this.sessionToolCount++;
  }

  endTool(toolCallId: string, isError: boolean, result: unknown): string | undefined {
    const slot = this.tools.get(toolCallId);
    if (!slot) return undefined;
    this.tools.delete(toolCallId);
    slot.span.setAttribute(ATTR_PI_TOOL_IS_ERROR, isError);
    if (this.shouldCaptureToolContent() && result !== undefined) {
      const capturedOutput = clampAttr(result);
      slot.span.setAttribute(ATTR_GEN_AI_TOOL_CALL_RESULT, capturedOutput);
      slot.span.setAttribute(ATTR_LANGFUSE_OBSERVATION_OUTPUT, capturedOutput);
    }
    const errorMessage = isError && this.shouldCaptureToolContent()
      ? this.toolErrorMessage(result)
      : undefined;
    const capturedError = errorMessage ? clampAttr(errorMessage) : undefined;
    const elapsedMs = Number(process.hrtime.bigint() - slot.startNs) / 1e6;
    slot.span.setAttribute("pi.tool.duration_ms", elapsedMs);
    if (isError) {
      slot.span.setAttribute(ATTR_ERROR_TYPE, "tool_error");
      if (capturedError) slot.span.setAttribute(ATTR_EXCEPTION_MESSAGE, capturedError);
      slot.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: capturedError ?? "tool execution failed",
      });
    }
    slot.span.end();
    try {
      const attrs: Attributes = this.commonAttrs();
      attrs[ATTR_GEN_AI_TOOL_NAME] = slot.name;
      if (isError) attrs[ATTR_ERROR_TYPE] = "tool_error";
      this.opts.metrics()?.toolCalls.add(1, attrs);
    } catch { /* noop */ }
    return capturedError;
  }

  private toolErrorMessage(result: unknown): string | undefined {
    if (result instanceof Error) return result.message || result.name;
    if (typeof result === "string") return result.trim() || undefined;
    if (typeof result !== "object" || result === null) return undefined;

    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const text = record.content
        .flatMap((part) => {
          if (typeof part !== "object" || part === null) return [];
          const item = part as { type?: unknown; text?: unknown };
          return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
        })
        .join("\n")
        .trim();
      if (text) return text;
    }

    if (record.error instanceof Error) return record.error.message || record.error.name;
    if (typeof record.error === "string") return record.error.trim() || undefined;
    if (typeof record.message === "string") return record.message.trim() || undefined;
    return undefined;
  }

  private endAllTools(reason: string): void {
    const markOrphaned = reason !== "end" && reason !== "session_end";
    for (const [, slot] of this.tools) {
      if (markOrphaned) slot.span.setAttribute(ATTR_PI_ORPHANED, true);
      slot.span.end();
    }
    this.tools.clear();
  }

  // --------------------------------------------------------------- helpers
  private accumulateSessionUsageFromMessage(m: MessageShapes.AssistantMessage): void {
    const u = m.usage;
    if (!u) return;
    if (typeof u.input === "number" && Number.isFinite(u.input)) this.totalInputTokens += u.input;
    if (typeof u.output === "number" && Number.isFinite(u.output)) this.totalOutputTokens += u.output;
    const cost = u.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) this.totalCostUsd += cost;
  }

  private commonAttrs(): Attributes {
    const attrs: Attributes = {
      [ATTR_PI_CWD]: this.opts.cwd,
      ...(this.opts.runAttributes ?? {}),
    };
    const sessionName = this.interactionNameSnapshotTaken
      ? this.interactionSessionName
      : this.opts.sessionName?.()?.trim();
    if (sessionName) {
      attrs[ATTR_PI_SESSION_NAME] = sessionName;
      attrs[ATTR_LANGFUSE_TRACE_NAME] = sessionName;
    }
    const tags: string[] = [];
    for (const [prefix, key] of [
      ["run-kind", ATTR_PI_RUN_KIND],
      ["mode", ATTR_PI_SESSION_MODE],
      ["role", ATTR_PI_AGENT_ROLE],
      ["agent", ATTR_PI_AGENT_LABEL],
    ] as const) {
      const value = attrs[key];
      if (typeof value === "string" && value.length > 0) {
        const tag = `${prefix}:${value}`;
        if (tag.length <= 200) tags.push(tag);
      }
    }
    if (tags.length > 0) {
      attrs[ATTR_LANGFUSE_TRACE_TAGS] = tags;
      attrs[ATTR_LATITUDE_TAGS] = JSON.stringify(tags);
    }
    for (const [key, attr] of [
      ["pi_run_kind", ATTR_PI_RUN_KIND],
      ["pi_session_mode", ATTR_PI_SESSION_MODE],
      ["pi_session_name", ATTR_PI_SESSION_NAME],
      ["pi_agent_role", ATTR_PI_AGENT_ROLE],
      ["pi_agent_label", ATTR_PI_AGENT_LABEL],
      ["pi_agent_run_id", ATTR_PI_AGENT_RUN_ID],
      ["pi_agent_owner_session_id", ATTR_PI_AGENT_OWNER_SESSION_ID],
      ["pi_agent_workspace_id", ATTR_PI_AGENT_WORKSPACE_ID],
    ] as const) {
      const value = attrs[attr];
      if (typeof value === "string" && value.length > 0) {
        attrs[`${ATTR_LANGFUSE_TRACE_METADATA_PREFIX}${key}`] = value.slice(0, 256);
      }
    }
    const latitudeMetadata: Record<string, string> = {};
    for (const key of [
      ATTR_PI_RUN_KIND,
      ATTR_PI_SESSION_MODE,
      ATTR_PI_SESSION_NAME,
      ATTR_PI_AGENT_ROLE,
      ATTR_PI_AGENT_LABEL,
      ATTR_PI_AGENT_RUN_ID,
      ATTR_PI_AGENT_OWNER_SESSION_ID,
      ATTR_PI_AGENT_WORKSPACE_ID,
    ]) {
      const value = attrs[key];
      if (typeof value === "string" && value.length > 0) {
        latitudeMetadata[key] = value.slice(0, 256);
      }
    }
    if (Object.keys(latitudeMetadata).length > 0) {
      attrs[ATTR_LATITUDE_METADATA] = JSON.stringify(latitudeMetadata);
    }
    const sid = this.opts.sessionId();
    if (sid) {
      attrs[ATTR_PI_SESSION_ID] = sid;
      // The session is a correlation key, not a span: every backend needs it
      // on the spans themselves to group related runs.
      attrs[ATTR_GEN_AI_CONVERSATION_ID] = sid;
      attrs[ATTR_SESSION_ID] = sid;
    }
    const file = this.opts.sessionFile();
    if (file) attrs[ATTR_PI_SESSION_FILE] = file;
    return attrs;
  }

  /** Context alive right now, as pi reports it. Fields pi cannot answer
   * (tokens right after a compaction) are omitted rather than sent as zero. */
  private applyContextUsage(span: Span): void {
    let usage: ContextUsageShape | undefined;
    try {
      usage = this.opts.contextUsage?.();
    } catch {
      return;
    }
    if (!usage) return;
    if (typeof usage.tokens === "number" && Number.isFinite(usage.tokens)) {
      span.setAttribute(ATTR_PI_CONTEXT_TOKENS, usage.tokens);
    }
    if (typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow)) {
      span.setAttribute(ATTR_PI_CONTEXT_WINDOW, usage.contextWindow);
    }
    if (typeof usage.percent === "number" && Number.isFinite(usage.percent)) {
      span.setAttribute(ATTR_PI_CONTEXT_PERCENT, usage.percent);
    }
  }

  /**
   * Remember a model transition; the next LLM span reports it. A route change
   * between two requests is otherwise invisible: both spans look healthy while
   * the cache they share has been invalidated.
   */
  noteModelSelect(event: {
    source: string;
    previousModel?: { provider?: string; id?: string };
  }): void {
    const prev = event.previousModel;
    this.routeTransition = {
      previousModel: prev ? `${prev.provider ?? "unknown"}/${prev.id ?? "unknown"}` : undefined,
      reason: event.source,
    };
  }

  private setStatusFromError(span: Span, error: unknown): void {
    if (!error) return;
    const errName = error instanceof Error ? error.name : "Error";
    const errMsg = error instanceof Error ? error.message : String(error);
    const combined = `${errName} ${errMsg}`;
    span.setAttribute(ATTR_ERROR_TYPE, categorizeThrownError(combined, errName));
    span.setAttribute(ATTR_EXCEPTION_MESSAGE, errMsg);
    span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
    // The end* methods pass the same error down the LLM -> turn -> interaction
    // cascade, so a single logical error reaches here up to three times.
    // Count each distinct error once toward the session's pi.error_count by
    // remembering the last reference we incremented on.
    if (this.lastCountedError !== error) {
      this.errorCount++;
      this.lastCountedError = error;
    }
  }

  /**
   * Mark all active spans as cancelled (Esc/abort).
   * Returns true when there was an in-flight turn to cancel, false otherwise
   * (e.g. the abort fired outside a turn). Callers use the return value to
   * decide whether to bump the turn-cancellation metric so it does not count
   * aborts with nothing to cancel.
   */
  markCancelled(): boolean {
    if (this.llm) this.llm.span.setAttribute(ATTR_PI_CANCELLED, true);
    for (const [, slot] of this.tools) slot.span.setAttribute(ATTR_PI_CANCELLED, true);
    const hadTurn = this.turn !== null;
    if (this.turn) this.turn.span.setAttribute(ATTR_PI_CANCELLED, true);
    if (this.attempt) this.attempt.span.setAttribute(ATTR_PI_CANCELLED, true);
    if (this.interaction) this.interaction.span.setAttribute(ATTR_PI_CANCELLED, true);
    return hadTurn;
  }

  /** Surface the active run's trace id (e.g. for UI display). */
  activeTraceId(): string | undefined {
    return this.interaction?.span.spanContext().traceId;
  }

  /** Prompt/completion text is captured in full and no_tool_content modes. */
  private shouldCapturePrompt(): boolean {
    const c = this.opts.captureContent;
    return c === "no_tool_content" || c === "full";
  }

  /** Tool args/results are captured only in full mode. */
  private shouldCaptureToolContent(): boolean {
    return this.opts.captureContent === "full";
  }

  /** The dialect's provider identity attribute key. */
  private providerNameKey(): string {
    return this.semconv === "1.36" ? ATTR_GEN_AI_SYSTEM : ATTR_GEN_AI_PROVIDER_NAME;
  }
}

// ---------------------------------------------------------------------------
// Message-shape helpers (typed against @earendil-works/pi-ai)
// ---------------------------------------------------------------------------

function extractAssistantText(m: MessageShapes.AssistantMessage): string {
  const parts: string[] = [];
  for (const p of m.content) {
    if (p.type === "text") parts.push(p.text);
  }
  return parts.join("\n");
}

function extractToolCalls(
  m: MessageShapes.AssistantMessage,
  captureToolArgs: boolean,
): Array<{
  id: string;
  type: "function";
  function: { name: string; arguments?: string };
}> {
  const out: Array<{ id: string; type: "function"; function: { name: string; arguments?: string } }> = [];
  for (const p of m.content) {
    if (p.type !== "toolCall") continue;
    const tc = p;
    const fn: { name: string; arguments?: string } = { name: tc.name };
    if (captureToolArgs) {
      fn.arguments = typeof tc.arguments === "string" ? tc.arguments : clampAttr(tc.arguments);
    }
    out.push({ id: tc.id, type: "function", function: fn });
  }
  return out;
}

function countToolCalls(m: MessageShapes.AssistantMessage): number {
  let n = 0;
  for (const p of m.content) if (p.type === "toolCall") n++;
  return n;
}

/** Flatten any message's content to text. */
export function extractMessageText(message: { content?: unknown }): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content as Array<{ type?: string; text?: string }>) {
    if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

function prefixKeys(prefix: string, obj: Record<string, number | string>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(obj)) out[`${prefix}.${k}`] = v;
  return out;
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Structural message shapes.
// These mirror @earendil-works/pi-ai's AssistantMessage / ToolCall / Usage.
// We declare them locally rather than importing from pi-ai (a transitive dep
// of pi-coding-agent that may not resolve from an extension's node_modules).
// Keeping them structural also lets us tolerate minor field additions across
// pi versions without a type error.
// ---------------------------------------------------------------------------
export namespace MessageShapes {
  export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    /** Reasoning/thinking tokens reported by some providers (e.g. OpenAI o-series). */
    reasoning?: number;
    totalTokens?: number;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  }
  export type StopReason = string; // "stop" | "end_turn" | "max_tokens" | "tool_use" | "error" | "aborted" | ...
  export interface TextPart { type: "text"; text: string }
  export interface ToolCallPart {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown> | string;
  }
  export type ContentPart = TextPart | ToolCallPart | { type: "thinking" } | { type: "other" };
  export interface AssistantMessage {
    role: "assistant";
    // `content` is a discriminated union on `type`. The last member is a
    // catch-all for parts we don't model (thinking, redacted_thought, ...).
    content: ContentPart[];
    model: string;
    responseModel?: string;
    responseId?: string;
    usage: Usage;
    stopReason: StopReason;
    errorMessage?: string;
  }
}

/** Default timer: setInterval with unref so the sweep never blocks process exit. */
function defaultSetTimer(fn: () => void, ms: number): () => void {
  const h = setInterval(fn, ms);
  h.unref?.();
  return () => clearInterval(h);
}
