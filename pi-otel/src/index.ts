/**
 * pi-otel — OpenTelemetry traces, metrics, and logs for the pi coding agent.
 *
 * A pure, standards-compliant OTLP exporter. Emits strict OTel semantic
 * conventions (gen_ai.*, service.*, process.*, host.*) so a downstream
 * collector or hosted platform can translate as needed.
 *
 * Span tree (one user-driven run = one trace):
 *   pi.interaction                  (run root, per prompt)
 *   ├─ pi.attempt                   (per agent_start/agent_end pair)
 *   │  └─ pi.turn                   (per LLM call + tools)
 *   │     ├─ pi.llm_request [CLIENT]
 *   │     └─ pi.tool.<name>
 *   └─ pi.compaction                (context compaction)
 *
 * A session is a correlation key rather than a span: `pi.session.id`, the
 * `gen_ai.conversation.id` / `session.id` aliases, and the `pi.session.end`
 * log record carry it, so a long-lived session never becomes one giant trace.
 *
 * All telemetry is on by default. Config in `.pi/settings.json` -> `otel`
 * or via standard OTEL_* / PI_OTEL_* env vars. See README for the full schema.
 *
 * Other pi extensions can route structured logs through this exporter:
 *   pi.events.emit("pi-otel:log", {
 *     eventName: "my.event", severity: "info",
 *     body: "...", attributes: { k: "v" },
 *   });
 */

import { basename } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { MessageShapes } from "./tracker.js";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { resolveConfig } from "./config.js";
import { registerCommands } from "./commands.js";
import { emitLog } from "./logging.js";
import { type TelemetryRuntime, piAtLeast, startRuntime } from "./sdk.js";
import { clampAttr } from "./attrs.js";
import {
  ATTR_GEN_AI_COST_USD,
  ATTR_GEN_AI_INPUT_TOKENS,
  ATTR_GEN_AI_OUTPUT_TOKENS,
  ATTR_PI_COMPACTION_FROM_EXTENSION,
  ATTR_PI_COMPACTION_REASON,
  ATTR_PI_COMPACTION_TOKENS_AFTER,
  ATTR_PI_COMPACTION_TOKENS_BEFORE,
  ATTR_PI_COMPACTION_WILL_RETRY,
  ATTR_PI_ERROR_COUNT,
  ATTR_PI_TOOL_COUNT,
  ATTR_PI_TURN_COUNT,
} from "./attrs.js";
import { extractMessageText, SpanTracker, type SessionReason } from "./tracker.js";

/** Normalized shape of a pi-otel:log payload from another extension. */
interface LogChannelPayload {
  eventName: string;
  severity: string;
  body: string;
  attributes: Record<string, string | number | boolean>;
}

const ALLOWED_SEVERITIES = new Set(["trace", "debug", "info", "warn", "warning", "error", "fatal"]);

/**
 * Validate and normalize a pi-otel:log payload from an untrusted extension.
 * Returns null when the payload is not usable. Primitive attribute values are
 * kept; nested objects and arrays are dropped (the OTLP log model only
 * accepts scalar attribute values). Strings are clamped to the attribute
 * ceiling so a misbehaving extension cannot push oversized records.
 */
export function normalizeLogPayload(data: unknown): LogChannelPayload | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const eventName = typeof d.eventName === "string" ? clampAttr(d.eventName) : null;
  if (!eventName) return null;
  const severity =
    typeof d.severity === "string" && ALLOWED_SEVERITIES.has(d.severity.toLowerCase())
      ? d.severity.toLowerCase()
      : "info";
  const body = typeof d.body === "string" ? clampAttr(d.body) : "";
  const rawAttrs = (d.attributes ?? null) as unknown;
  const attributes: Record<string, string | number | boolean> = {};
  if (rawAttrs && typeof rawAttrs === "object" && !Array.isArray(rawAttrs)) {
    for (const [k, v] of Object.entries(rawAttrs as Record<string, unknown>)) {
      if (typeof v === "string") attributes[k] = clampAttr(v);
      else if (typeof v === "number" || typeof v === "boolean") attributes[k] = v;
      // objects, arrays, null, undefined, etc. are dropped
    }
  }
  return { eventName, severity, body, attributes };
}

/**
 * Extract the plain-UUID session id from a session-file basename.
 *
 * pi names interactive session files `<timestamp>_<uuid>.jsonl`, while
 * `SessionManager.getSessionId()` reports the bare UUID. Emitting the same
 * UUID everywhere keeps `pi.session.id` and `pi.session.parent_id` on one
 * format so join queries work uniformly. A stem without a trailing
 * canonical UUID keeps its previous whole-stem value.
 */
export function extractSessionId(stem: string): string {
  const m = stem.match(/(?:^|_)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m?.[1] ?? stem;
}

/** Normalize an orchestrator-published parent reference to the same shape as
 * pi.session.id: a bare UUID or file path both reduce to the UUID; a value
 * with no trailing UUID is kept verbatim so custom ids still join. Returns
 * undefined for empty or unset values. */
export function normalizeParentRef(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return extractSessionId(basename(trimmed, ".jsonl"));
}

export default function (pi: ExtensionAPI): void {
  // Commands are registered up front so /otel-status works even before
  // a session starts (e.g. to debug why nothing is exporting).
  let runtime: TelemetryRuntime | null = null;
  let tracker: SpanTracker | null = null;
  let cfg = resolveConfig(process.cwd());
  /** pi >= 0.80.5 emits agent_settled once per prompt run, after every
   * automatic retry and queued continuation. Older pi ends the interaction
   * at agent_end instead (which fragments retried runs; see agent_start). */
  const supportsAgentSettled = piAtLeast("0.80.5");
  /** Abort listener registered for the active turn; removed on turn_end. */
  let abortCleanup: (() => void) | null = null;
  /** True once we have logged an HTTP-level LLM error for the open request. */
  let llmHttpErrorLogged = false;
  /** Serializes session start/stop so concurrent session_start cannot double-build a runtime. */
  let lifecycle: Promise<void> = Promise.resolve();

  registerCommands(pi, () => runtime, () => tracker);

  // pi-otel:log — cross-extension log channel. Best-effort; no-op when logs
  // are disabled or the runtime isn't up yet. Payloads are untrusted and get
  // validated before they reach the OTLP logger.
  pi.events.on("pi-otel:log", (data: unknown) => {
    const payload = normalizeLogPayload(data);
    if (!payload) return;
    emitLog(
      runtime?.logger,
      payload.eventName,
      payload.severity,
      payload.body,
      payload.attributes,
    );
  });

  // Keep ctx around for handlers that don't receive it.
  let lastCtx: ExtensionContext | undefined;

  const sessionFile = () => {
    try {
      const f = lastCtx?.sessionManager?.getSessionFile?.();
      return f ?? undefined;
    } catch {
      return undefined;
    }
  };
  const sessionId = () => {
    try {
      // SessionManager.getSessionId() is the canonical source. Prefer it:
      // subagent-spawned children keep session files at
      // .../<runId>/run-N/session.jsonl, so a bare basename would yield the
      // literal string "session" for every child run.
      const id = lastCtx?.sessionManager?.getSessionId?.();
      if (id) return id;
    } catch { /* fall through to file-based derivation */ }
    const f = sessionFile();
    if (!f) return undefined;
    return extractSessionId(basename(f, ".jsonl"));
  };

  const clearAbortListener = (): void => {
    if (abortCleanup) {
      abortCleanup();
      abortCleanup = null;
    }
  };

  const start = async (ctx: ExtensionContext, reason?: SessionReason, parentId?: string): Promise<void> => {
    // Chain on the lifecycle queue so two concurrent session_start events
    // cannot both pass a null runtime check and build two SDKs.
    const run = lifecycle.then(async () => {
      if (runtime) return; // idempotent once the prior start finished
      // Re-resolve config with the session's cwd so project settings win.
      cfg = resolveConfig(ctx.cwd);
      if (!cfg.enabled) return;
      const next = await startRuntime(cfg, { hasUI: ctx.hasUI, mode: ctx.mode });
      runtime = next;
      tracker = new SpanTracker({
        tracer: next.tracer,
        captureContent: cfg.captureContent,
        semconv: cfg.semconv,
        sessionId,
        sessionFile,
        cwd: ctx.cwd,
        metrics: () => next.metrics,
        contextUsage: () => lastCtx?.getContextUsage?.(),
      });
      tracker.startSession(reason, parentId);
    });
    lifecycle = run.catch(() => {});
    await run;
  };

  const stop = async (_reason: string): Promise<void> => {
    const run = lifecycle.then(async () => {
      clearAbortListener();
      try {
        tracker?.endSession();
      } catch { /* best-effort */ }
      tracker = null;
      if (runtime) {
        // Always shut down: batch processors and metric readers keep ticking
        // after a bare flush. The next session_start builds a fresh runtime.
        // removeProcessHooks runs inside shutdown; call it first so a slow
        // shutdown cannot leave signal handlers stacked if start() races.
        runtime.removeProcessHooks();
        await runtime.shutdown();
      }
      runtime = null;
      llmHttpErrorLogged = false;
    });
    lifecycle = run.catch(() => {});
    await run;
  };

  // ----------------------------------------------------------------- events
  pi.on("session_start", async (event, ctx) => {
    lastCtx = ctx;
    const parentId = event.previousSessionFile
      ? extractSessionId(basename(event.previousSessionFile, ".jsonl"))
      : // Subagent-spawned children start with reason=startup and no
        // previousSessionFile. Orchestrators that publish the convention set
        // an env var; consume it here so pi.session.parent_id links the tree.
        // The value is normalized through the same basename/UUID extraction
        // as previousSessionFile so parent ids join against pi.session.id
        // whatever shape the orchestrator publishes (bare UUID, stem, or
        // full path).
        normalizeParentRef(process.env.PI_OTEL_PARENT_SESSION_ID) ??
        normalizeParentRef(process.env.PI_SUBAGENT_PARENT_SESSION);
    await start(ctx, event.reason, parentId);
    if (cfg.selfLogs && runtime) {
      emitLog(
        runtime.logger,
        "pi.session.start",
        SeverityNumber.INFO,
        `pi session ${sessionId() ?? "(ephemeral)"} started`,
        { "pi.cwd": ctx.cwd },
      );
    }
  });

  pi.on("session_shutdown", async (event, _ctx) => {
    const sid = sessionId();
    const logger = runtime?.logger;
    const selfLogs = cfg.selfLogs;
    // Emit pi.session.end before tearing the runtime down: once shutdown runs,
    // the logger provider is gone and the record would never flush. Session
    // totals live here now that the session is a correlation key, not a span.
    if (selfLogs) {
      const summary = tracker?.sessionSummary();
      const attrs: Record<string, string | number> = { "pi.session.reason": event.reason };
      if (summary) {
        if (summary.turns > 0) attrs[ATTR_PI_TURN_COUNT] = summary.turns;
        if (summary.tools > 0) attrs[ATTR_PI_TOOL_COUNT] = summary.tools;
        if (summary.inputTokens > 0) attrs[ATTR_GEN_AI_INPUT_TOKENS] = summary.inputTokens;
        if (summary.outputTokens > 0) attrs[ATTR_GEN_AI_OUTPUT_TOKENS] = summary.outputTokens;
        if (summary.costUsd > 0) attrs[ATTR_GEN_AI_COST_USD] = summary.costUsd;
        if (summary.errors > 0) attrs[ATTR_PI_ERROR_COUNT] = summary.errors;
      }
      emitLog(
        logger,
        "pi.session.end",
        SeverityNumber.INFO,
        `pi session ${sid ?? "(ephemeral)"} ended (${event.reason})`,
        attrs,
      );
    }
    await stop(event.reason);
  });

  // Defensive cleanup on every session-replacement flow so no spans orphan.
  pi.on("session_before_switch", async () => {
    tracker?.endInteraction({ reason: "session_switch" });
  });
  pi.on("session_before_fork", async () => {
    tracker?.endInteraction({ reason: "session_fork" });
  });
  pi.on("session_before_compact", async (event) => {
    // Don't end the interaction — compaction happens mid-interaction. The
    // span opens here and closes on session_compact, bracketing the
    // summarization call the compaction triggers.
    tracker?.startCompaction(event.reason, event.preparation);
  });
  pi.on("session_before_tree", async () => {
    tracker?.endInteraction({ reason: "session_tree" });
  });
  pi.on("session_tree", async (event) => {
    // A branch summary is a model call outside the agent loop: like compaction,
    // no assistant event claims its provider record, and pi reports its usage
    // on the summary entry. Discard the record so a later claim cannot open a
    // bogus llm span, and record the spend against session totals/metrics.
    tracker?.discardPendingLlm();
    const usage = (event.summaryEntry as { usage?: MessageShapes.Usage } | undefined)?.usage;
    if (usage) tracker?.recordCompactionUsage(usage);
  });

  pi.on("session_compact", async (event, _ctx) => {
    const entry = event.compactionEntry as
      | { tokensBefore?: number; estimatedTokensAfter?: number; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; reasoning?: number; totalTokens?: number; cost?: { total?: number } } }
      | undefined;
    const attrs: Record<string, string | number | boolean> = {
      [ATTR_PI_COMPACTION_FROM_EXTENSION]: Boolean(event.fromExtension),
      [ATTR_PI_COMPACTION_REASON]: event.reason,
    };
    if (typeof entry?.tokensBefore === "number") {
      attrs[ATTR_PI_COMPACTION_TOKENS_BEFORE] = entry.tokensBefore;
    }
    if (typeof entry?.estimatedTokensAfter === "number") {
      attrs[ATTR_PI_COMPACTION_TOKENS_AFTER] = entry.estimatedTokensAfter;
    }
    // Overflow recovery retries the aborted turn after compacting; threshold
    // and manual compactions do not. Guarded so older pi without the field
    // still emits the rest of the record.
    if (typeof event.willRetry === "boolean") {
      attrs[ATTR_PI_COMPACTION_WILL_RETRY] = event.willRetry;
    }
    tracker?.endCompaction({
      reason: event.reason,
      willRetry: event.willRetry,
      fromExtension: event.fromExtension,
      tokensBefore: entry?.tokensBefore,
      tokensAfter: entry?.estimatedTokensAfter,
      usage: entry?.usage,
    });
    runtime && cfg.selfLogs && emitLog(
      runtime.logger,
      "pi.session.compact",
      SeverityNumber.INFO,
      `session compacted (${event.reason})`,
      attrs,
    );
    try {
      runtime?.metrics?.compactionCount.add(1, attrs);
    } catch { /* noop */ }
  });

  // ----------------------------------------------------------- agent flow
  pi.on("before_agent_start", async (event, ctx) => {
    lastCtx = ctx;
    tracker?.startInteraction(event.prompt);
    tracker?.noteSystemPrompt(event.systemPrompt);
  });

  pi.on("turn_start", async (event, ctx) => {
    lastCtx = ctx;
    clearAbortListener();
    tracker?.startTurn(event.turnIndex);
    // Wire abort -> cancellation marking on the active turn. Remove on turn_end
    // so multi-turn sessions do not stack listeners on a shared AbortSignal.
    const signal = ctx.signal;
    if (signal && !signal.aborted) {
      const onAbort = () => {
        // Only count aborts that actually cancelled an in-flight turn, so
        // mashing Esc outside a turn does not inflate the counter.
        const cancelled = tracker?.markCancelled() ?? false;
        if (cancelled) {
          try { runtime?.metrics?.turnCancellations.add(1); } catch { /* noop */ }
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => signal.removeEventListener("abort", onAbort);
    }
  });

  pi.on("turn_end", async (event, _ctx) => {
    clearAbortListener();
    const msg = event.message;
    if (msg && msg.role === "assistant") {
      // The LLM span is opened in before_provider_request and finalized here
      // once usage/finish are known.
      tracker?.completeLlm(msg as MessageShapes.AssistantMessage);
      const finish = (msg as MessageShapes.AssistantMessage).stopReason;
      const errMsg = (msg as MessageShapes.AssistantMessage).errorMessage;
      // Skip a second log when after_provider_response already recorded the
      // HTTP failure for this request.
      if (cfg.selfLogs && (finish === "error" || finish === "aborted") && !llmHttpErrorLogged) {
        emitLog(
          runtime?.logger,
          "pi.llm_request.error",
          finish === "aborted" ? SeverityNumber.WARN : SeverityNumber.ERROR,
          errMsg ?? `llm request ${finish}`,
          { "gen_ai.response.finish_reasons": finish ?? "error" },
        );
      }
    }
    llmHttpErrorLogged = false;
    tracker?.endTurn({ reason: "end" });
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    llmHttpErrorLogged = false;
    const model = ctx.model;
    // A candidate generation, not a turn: cache warmers and probes reach this
    // hook too. The span opens only when an assistant event claims it.
    tracker?.noteProviderRequest(model?.id, model?.provider);
  });

  pi.on("after_provider_response", async (event, _ctx) => {
    tracker?.recordProviderResponse(event.status, event.headers ?? {});
    if (event.status >= 400 && cfg.selfLogs) {
      llmHttpErrorLogged = true;
      emitLog(
        runtime?.logger,
        "pi.llm_request.error",
        SeverityNumber.ERROR,
        `provider response HTTP ${event.status}`,
        { "http.response.status_code": event.status },
      );
    }
  });

  pi.on("message_update", async (event, _ctx) => {
    // A real streamed delta is proof the request became an agent generation.
    const delta = (event.assistantMessageEvent as { delta?: unknown } | undefined)?.delta;
    if (typeof delta === "string" && delta.length > 0) tracker?.claimPendingLlm();
    tracker?.noteFirstToken(event.message);
  });

  pi.on("message_end", async (event, _ctx) => {
    tracker?.noteLlmComplete(event.message);
  });

  // Capture input messages for the gen_ai.input.messages attribute.
  pi.on("message_start", async (event, _ctx) => {
    const msg = event.message;
    if (!msg) return;
    if (msg.role === "user") {
      tracker?.noteUserInput(extractMessageText(msg));
    } else if (msg.role === "assistant") {
      // The assistant message claims the pending provider request, so a
      // request that never produced one stays unclaimed and emits no span.
      tracker?.claimPendingLlm();
    } else if (msg.role === "custom") {
      // Extension-injected context (before_agent_start result messages and
      // sendCustomMessage deliveries) is part of the next LLM call's input;
      // without this branch it never reached gen_ai.input.messages.
      tracker?.noteUserInput(extractMessageText(msg));
    } else if (msg.role === "toolResult") {
      const tr = msg as { toolCallId: string; toolName: string };
      tracker?.noteToolResultInput(tr.toolCallId, tr.toolName, extractMessageText(msg));
    }
  });

  pi.on("agent_end", async (_event, _ctx) => {
    // One attempt ends with the agent loop. Pi may start another attempt on
    // the same run (auto-retry, post-compaction recovery) without a new user
    // prompt, so the interaction stays open until agent_settled — or ends
    // here on a pi too old to emit it.
    tracker?.endAttempt({ reason: "end" });
    if (!supportsAgentSettled) {
      tracker?.endInteraction({ reason: "end" });
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    lastCtx = ctx;
    // A run pi started without before_agent_start: the auto-retry after an
    // agent_end that closed the interaction, or an extension-triggered turn
    // on an idle session. No-op when an interaction is already open.
    tracker?.ensureInteraction();
    tracker?.startAttempt();
  });

  if (supportsAgentSettled) {
    // Fires exactly once per prompt run, after every retry, auto-compaction,
    // and queued follow-up finished (pi >= 0.80.5).
    pi.on("agent_settled", async () => {
      tracker?.endInteraction({ reason: "end" });
    });
  }

  // ----------------------------------------------------------- tool events
  pi.on("tool_execution_start", async (event, _ctx) => {
    tracker?.startTool(event.toolCallId, event.toolName, event.args);
  });

  pi.on("tool_execution_end", async (event, _ctx) => {
    tracker?.endTool(event.toolCallId, event.isError, event.result);
    if (event.isError && cfg.selfLogs) {
      emitLog(
        runtime?.logger,
        "pi.tool.error",
        SeverityNumber.ERROR,
        `tool ${event.toolName} failed`,
        { "gen_ai.tool.name": event.toolName, "gen_ai.tool.call.id": event.toolCallId },
      );
    }
  });

  // ----------------------------------------------------------- model changes
  pi.on("model_select", async (event, _ctx) => {
    // A model transition invalidates the prompt cache the next request would
    // otherwise have hit, so the next LLM span reports it.
    tracker?.noteModelSelect({
      source: event.source,
      previousModel: event.previousModel
        ? { provider: event.previousModel.provider, id: event.previousModel.id }
        : undefined,
    });
    const attrs: Record<string, string> = {
      "pi.model.source": event.source,
    };
    if (event.previousModel) {
      attrs["pi.model.previous"] = `${event.previousModel.provider}/${event.previousModel.id}`;
    }
    attrs["pi.model.current"] = `${event.model.provider}/${event.model.id}`;
    runtime && cfg.selfLogs && emitLog(
      runtime.logger,
      "pi.model.changed",
      SeverityNumber.INFO,
      `model changed: ${attrs["pi.model.current"]}`,
      attrs,
    );
  });

  // ------------------------------------------------------------- user bash
  pi.on("user_bash", async (event, _ctx) => {
    runtime && cfg.selfLogs && emitLog(
      runtime.logger,
      "pi.user_bash",
      SeverityNumber.INFO,
      `user bash: ${event.command.slice(0, 120)}`,
      { "pi.user_bash.cwd": event.cwd, "pi.user_bash.exclude_from_context": event.excludeFromContext },
    );
  });

  pi.on("input", async (event, _ctx) => {
    if (event.source !== "interactive") return;
    runtime && cfg.selfLogs && emitLog(
      runtime.logger,
      "pi.input",
      SeverityNumber.INFO,
      `user input (${event.source})`,
      { "pi.input.image_count": event.images?.length ?? 0 },
    );
  });
}
