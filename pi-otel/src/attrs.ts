import { createHash } from "node:crypto";

/**
 * OpenTelemetry attribute constants.
 *
 * Names follow the published semantic conventions:
 *   - GenAI:      https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *     (development moved to the semantic-conventions-genai repo; the npm
 *     registry release that last synced the GenAI set is 1.43.0)
 *   - Resource:   https://opentelemetry.io/docs/specs/semconv/resource/
 *   - HTTP:       https://opentelemetry.io/docs/specs/semconv/http/
 *   - Exceptions: https://opentelemetry.io/docs/specs/semconv/exceptions/
 *
 * `pi.*` attributes are extension-specific and documented in the README.
 * `gen_ai.usage.cost_usd` and `gen_ai.usage.cache_write_1h_input_tokens` are
 * extension-specific values in the gen_ai namespace: no registry release
 * defines a cost attribute, and none splits Anthropic's 1-hour cache writes.
 */

// ---------------------------------------------------------------------------
// gen_ai.* (GenAI semantic conventions)
// ---------------------------------------------------------------------------

/**
 * Agent harness identity for `gen_ai.agent.name`.
 * Not an AI vendor; do not write this value to `gen_ai.system` (that holds the provider).
 */
export const GEN_AI_SYSTEM = "pi";

export const ATTR_GEN_AI_SYSTEM = "gen_ai.system";
/** Renamed from gen_ai.system in semantic-conventions v1.37.0 (2025-10).
 * The 1.37 dialect emits this instead of gen_ai.system; each dialect emits
 * exactly its own convention set, with no dual-write. */
export const ATTR_GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
export const ATTR_GEN_AI_AGENT_NAME = "gen_ai.agent.name";
export const ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const ATTR_GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const ATTR_GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
export const ATTR_GEN_AI_RESPONSE_ID = "gen_ai.response.id";
export const ATTR_GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";
/** Conversation/session correlation. Registry value; aliases pi.session.id for
 * backends that group by conversation rather than by a pi-specific key. */
export const ATTR_GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";
/** Backend session-grouping key. Latitude reads this before every fallback;
 * Langfuse's own Pi plugin publishes the same key. */
export const ATTR_SESSION_ID = "session.id";

// gen_ai.operation.name values. Ingest keyed on operation vocabulary ignores
// spans whose operation it does not recognize, so the run/tool/prompt classes
// each name their operation.
export const OP_NAME_CHAT = "chat";
export const OP_NAME_INVOKE_AGENT = "invoke_agent";
export const OP_NAME_EXECUTE_TOOL = "execute_tool";

// Usage. input/output carry the same name in every dialect; the cache and
// reasoning keys differ. The 1.36/1.37 names below predate the registry
// (gen_ai.usage.cache_read_input_tokens & co. exist in no released set) and
// are kept verbatim so pinned dialects keep emitting what they always did.
// The 1.43 names are the registry's (synced in semantic-conventions 1.43.0
// from the semantic-conventions-genai repo).
export const ATTR_GEN_AI_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const ATTR_GEN_AI_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const ATTR_GEN_AI_TOKEN_TYPE = "gen_ai.token.type";
// 1.36 / 1.37 dialect (historical, emitted verbatim under those dialects)
export const ATTR_GEN_AI_CACHE_READ_TOKENS = "gen_ai.usage.cache_read_input_tokens";
export const ATTR_GEN_AI_CACHE_WRITE_TOKENS = "gen_ai.usage.cache_write_input_tokens";
export const ATTR_GEN_AI_CACHE_WRITE_1H_TOKENS = "gen_ai.usage.cache_write_1h_input_tokens";
export const ATTR_GEN_AI_REASONING_TOKENS = "gen_ai.usage.reasoning_tokens";
// 1.43 dialect (registry names). cache_creation is the registry name for a
// provider-managed cache write (Anthropic's 5-minute retention bucket).
export const ATTR_GEN_AI_CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read.input_tokens";
export const ATTR_GEN_AI_CACHE_CREATION_INPUT_TOKENS = "gen_ai.usage.cache_creation.input_tokens";
export const ATTR_GEN_AI_REASONING_OUTPUT_TOKENS = "gen_ai.usage.reasoning.output_tokens";
// No registry release defines a cost attribute; extension-specific, all dialects.
export const ATTR_GEN_AI_COST_USD = "gen_ai.usage.cost_usd";
// Total tokens as pi reports them. Ingest uses it to resolve inclusive-vs-additive
// input-token arithmetic instead of guessing from the provider name.
export const ATTR_GEN_AI_TOTAL_TOKENS = "gen_ai.usage.total_tokens";
// Streaming: registry-defined from 1.43 (gen_ai.request.stream, seconds-valued
// gen_ai.response.time_to_first_chunk).
export const ATTR_GEN_AI_REQUEST_STREAM = "gen_ai.request.stream";
export const ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK = "gen_ai.response.time_to_first_chunk";

// Tools
export const ATTR_GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const ATTR_GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
export const ATTR_GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";
export const ATTR_GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result";

// Aspire 9.x and similar backends read these JSON-stringified attributes
// on the LLM span instead of (or in addition to) the gen_ai.*.message events.
export const ATTR_GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";
export const ATTR_GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";
export const ATTR_GEN_AI_SYSTEM_PROMPT_HASH = "gen_ai.system.prompt.hash";

// gen_ai.* span events (older message-pipeline convention)
export const EVENT_GEN_AI_USER_MESSAGE = "gen_ai.user.message";
export const EVENT_GEN_AI_TOOL_MESSAGE = "gen_ai.tool.message";
export const EVENT_GEN_AI_ASSISTANT_MESSAGE = "gen_ai.assistant.message";
export const EVENT_GEN_AI_CHOICE = "gen_ai.choice";
export const EVENT_GEN_AI_FIRST_TOKEN = "gen_ai.first_token";
export const EVENT_GEN_AI_COMPLETION = "gen_ai.completion";

// ---------------------------------------------------------------------------
// error / http
// ---------------------------------------------------------------------------

export const ATTR_ERROR_TYPE = "error.type";
export const ATTR_EXCEPTION_MESSAGE = "exception.message";
export const ATTR_HTTP_STATUS_CODE = "http.response.status_code";

// ---------------------------------------------------------------------------
// pi.* (extension-specific)
// ---------------------------------------------------------------------------

export const ATTR_PI_SESSION_ID = "pi.session.id";
export const ATTR_PI_SESSION_FILE = "pi.session.file";
/** Why the pi session started. Values: startup | reload | new | resume | fork. Mirrors pi's SessionStartEvent.reason. */
export const ATTR_PI_SESSION_REASON = "pi.session.reason";
/** Filename stem of the parent session, for new/resume/fork starts. Omitted on startup/reload. */
export const ATTR_PI_SESSION_PARENT_ID = "pi.session.parent_id";
export const ATTR_PI_CWD = "pi.cwd";
export const ATTR_PI_TURN_INDEX = "pi.turn.index";
export const ATTR_PI_TURN_COUNT = "pi.turn_count";
export const ATTR_PI_TOOL_COUNT = "pi.tool_count";
export const ATTR_PI_TOOL_IS_ERROR = "pi.tool.is_error";
export const ATTR_PI_PROMPT_LENGTH = "pi.user_prompt_length";
export const ATTR_PI_USER_PROMPT = "pi.user_prompt";
export const ATTR_PI_INTERACTION_ID = "pi.interaction.id";
/** What opened the interaction: `user` (a user prompt) or `agent` (a run pi
 * started without before_agent_start: an auto-retry re-run or an
 * extension-triggered turn on an idle session). */
export const ATTR_PI_INTERACTION_ORIGIN = "pi.interaction.origin";
export const ATTR_PI_CANCELLED = "pi.cancelled";
export const ATTR_PI_ORPHANED = "pi.orphaned";
export const ATTR_PI_ERROR_COUNT = "pi.error_count";
/** 1-based attempt number within the run. An attempt is one agent_start/agent_end pair. */
export const ATTR_PI_ATTEMPT_NUMBER = "pi.attempt.number";
/** Why this attempt exists: `post_compaction` (the previous attempt was compacted away) or
 * `retry` (the previous attempt errored). Omitted on a first attempt. */
export const ATTR_PI_ATTEMPT_REASON = "pi.attempt.reason";
/** Context alive when the request was built: estimated tokens, window size, percent. */
export const ATTR_PI_CONTEXT_TOKENS = "pi.context.tokens";
export const ATTR_PI_CONTEXT_WINDOW = "pi.context.window";
export const ATTR_PI_CONTEXT_PERCENT = "pi.context.percent";
/** Completed compactions so far in the session. A compaction rewrites the cached
 * prefix, so requests under different epochs are never cache hits of each other. */
export const ATTR_PI_CACHE_EPOCH = "pi.cache.epoch";
export const ATTR_PI_ROUTE_PREVIOUS_MODEL = "pi.route.previous_model";
export const ATTR_PI_ROUTE_TRANSITION_REASON = "pi.route.transition_reason";
/** Remote parent this process inherited through TRACEPARENT (a spawning pi). */
export const ATTR_PI_PARENT_TRACE_ID = "pi.parent.trace_id";
export const ATTR_PI_PARENT_SPAN_ID = "pi.parent.span_id";

// pi.compaction.* — attributes of the pi.compaction span (and its log record).
export const ATTR_PI_COMPACTION_REASON = "pi.compaction.reason";
export const ATTR_PI_COMPACTION_WILL_RETRY = "pi.compaction.will_retry";
export const ATTR_PI_COMPACTION_TOKENS_BEFORE = "pi.compaction.tokens_before";
export const ATTR_PI_COMPACTION_TOKENS_AFTER = "pi.compaction.tokens_after";
export const ATTR_PI_COMPACTION_FROM_EXTENSION = "pi.compaction.from_extension";

// ---------------------------------------------------------------------------
// Span names
// ---------------------------------------------------------------------------

export const SPAN_INTERACTION = "pi.interaction";
export const SPAN_ATTEMPT = "pi.attempt";
export const SPAN_COMPACTION = "pi.compaction";
export const SPAN_TURN = "pi.turn";
export const SPAN_LLM_REQUEST = "pi.llm_request";
export const spanToolName = (name: string): string => `pi.tool.${name}`;

// ---------------------------------------------------------------------------
// Metric names
// ---------------------------------------------------------------------------

// GenAI client metrics in released registry sets. Through v1.37 the client
// set is exactly operation.duration and token.usage. v1.43 synced the
// semantic-conventions-genai additions: time_to_first_chunk and
// time_per_output_chunk (the genai repo carries them as Development status).
export const METRIC_OP_DURATION = "gen_ai.client.operation.duration";
export const METRIC_TOKEN_USAGE = "gen_ai.client.token.usage";
export const METRIC_GEN_AI_TIME_TO_FIRST_CHUNK = "gen_ai.client.operation.time_to_first_chunk";

// pi-namespaced metrics. pi.llm.time_to_first_token is the 1.36/1.37 dialect's
// name for time-to-first-chunk (no registry metric existed in those releases);
// the 1.43 dialect records the registry name instead. time_to_completion has
// no registry equivalent in any release (time_per_output_chunk measures
// inter-chunk gaps, not request start to final token), and tool.calls stays
// custom until the genai repo cuts tagged releases with the execute_tool /
// invoke_agent metric sets.
export const METRIC_LLM_TTFT = "pi.llm.time_to_first_token";
export const METRIC_LLM_TIME_TO_COMPLETION = "pi.llm.time_to_completion";
export const METRIC_TOOL_CALLS = "pi.tool.calls";

// pi-namespaced metrics
export const METRIC_SESSION_DURATION = "pi.session.duration";
export const METRIC_PROMPT_COUNT = "pi.prompt.count";
export const METRIC_TURN_COUNT = "pi.turn.count";
export const METRIC_PROVIDER_RETRIES = "pi.provider.retries";
export const METRIC_TURN_CANCELLATIONS = "pi.turn.cancellations";
export const METRIC_COMPACTION_COUNT = "pi.compaction.count";

// ---------------------------------------------------------------------------
// Content capture
// ---------------------------------------------------------------------------

/**
 * Content capture mode.
 * - `metadata_only`: no raw prompt/completion/tool I/O; emit bytes/lines/sha256 only.
 * - `no_tool_content`: add prompt/completion text, but never tool args/results.
 * - `full`: everything (clamped per-attribute).
 *
 * `full` is the default per project requirements. Users handling secrets can
 * dial it back per-project via settings without code changes.
 */
export type ContentCapture = "metadata_only" | "no_tool_content" | "full";

// OTel collectors typically reject attributes larger than 64 KiB. Claude Code
// uses the same ceiling. Larger payloads are truncated with a suffix marker.
const MAX_ATTR_BYTES = 64 * 1024;
const TRUNC_SUFFIX = "…[truncated]";

/**
 * Clamp a value to a byte-safe string attribute. Objects are JSON-serialized
 * with a circular-reference guard. Truncation works in UTF-8 byte space so
 * it never splits a multi-byte sequence and never trusts UTF-16 code-unit
 * indices as byte offsets.
 */
export function clampAttr(value: unknown): string {
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else if (value instanceof Error) {
    s = value.stack ?? `${value.name}: ${value.message}`;
  } else {
    s = safeStringify(value);
  }
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= MAX_ATTR_BYTES) return s;
  // Work in byte space. Leave room for the truncation suffix, then shrink to
  // the largest byte offset at or below the budget that lands on a UTF-8
  // character boundary (a byte that is not a continuation byte, 0x80-0xBF).
  const buf = Buffer.from(s, "utf8");
  let end = MAX_ATTR_BYTES - Buffer.byteLength(TRUNC_SUFFIX, "utf8");
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--; // back over continuations
  return `${buf.subarray(0, end).toString("utf8")}${TRUNC_SUFFIX}`;
}

const SAFE_STRINGIFY_REPLACER = (_k: string, v: unknown): unknown => {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
  if (v instanceof Error) {
    return { name: v.name, message: v.message, stack: v.stack };
  }
  // The replacer runs once for the root with key ""; a root that sits on a
  // cycle must still serialize (its inner back-reference gets cut instead).
  if (_k !== "" && v && typeof v === "object" && cyclicObjects.has(v)) return "[circular]";
  return v;
};

/** Objects that sit on a true reference cycle. Shared-but-acyclic references
 * (the same object in two places, common in tool args) are NOT included, so
 * they serialize in full at each occurrence. */
let cyclicObjects = new Set<object>();

/** Walk the value and collect only true cycle members: an object reachable
 * from itself. Getters may throw; those subtrees are skipped and left to
 * JSON.stringify's own failure path in safeStringify. */
function collectCycles(root: unknown): Set<object> {
  const cycles = new Set<object>();
  const path = new Set<object>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (path.has(node)) {
      cycles.add(node);
      return;
    }
    path.add(node);
    try {
      if (Array.isArray(node)) {
        for (const v of node) walk(v);
      } else {
        for (const v of Object.values(node)) walk(v);
      }
    } catch {
      // exotic getter threw during the walk; skip this subtree
    }
    path.delete(node);
  };
  walk(root);
  return cycles;
}

function safeStringify(value: unknown): string {
  cyclicObjects = collectCycles(value);
  try {
    return JSON.stringify(value, SAFE_STRINGIFY_REPLACER) ?? "null";
  } catch {
    return String(value);
  }
}

/**
 * Structural fingerprint for content we are NOT capturing raw.
 * Lets you correlate/dedupe in the backend without exfiltrating the payload.
 */
/**
 * Stable short SHA-256 hex prefix for a system prompt (one-way; safe to export).
 * Returns undefined for empty or whitespace-only input.
 */
export function hashPrompt(prompt: string): string | undefined {
  const trimmed = prompt.trim();
  if (!trimmed) return undefined;
  return createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 16);
}

export function fingerprint(value: unknown): Record<string, number | string> {
  const s = typeof value === "string" ? value : safeStringify(value);
  const bytes = Buffer.byteLength(s, "utf8");
  // djb2-style non-crypto hash, hex. Cheap and avoids the node:crypto cost.
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  const lines = s.length === 0 ? 0 : s.split(/\r?\n/).length;
  return {
    bytes,
    lines,
    hash_short: (h >>> 0).toString(16).padStart(8, "0"),
  };
}
