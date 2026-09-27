# pi-otel

OpenTelemetry traces, metrics, and logs for the [pi coding agent](https://github.com/earendil-works/pi).

The extension is a pure OTLP exporter. It speaks the OpenTelemetry wire protocol and emits strict semantic conventions (`gen_ai.*`, `service.*`, `process.*`, `host.*`). Point it at a hosted platform, a collector, or a local dev backend.

## What it emits

All three signals are on by default: traces, metrics, and logs.

**Span tree** (one user-driven run = one trace):

```
pi.interaction                    run root, one per prompt, its own trace
├─ pi.attempt                     one per agent_start/agent_end pair
│  └─ pi.turn                     one per LLM call plus its tool calls
│     ├─ pi.llm_request           CLIENT span, gen_ai.* attributes
│     └─ pi.tool.<name>           one per tool call, sibling of the LLM span
└─ pi.compaction                  one per context compaction
```

A Pi session is a correlation key rather than a span. Session identity rides every
span as `pi.session.id` plus the aliases `gen_ai.conversation.id` and `session.id`, so
a session that runs for hours produces many bounded traces instead of one enormous
root span. Its totals (turns, tools, tokens, cost, errors) land on the `pi.session.end`
log record.

The LLM span is a `CLIENT` span carrying the GenAI semantic conventions. Backends that understand `gen_ai.*` render it as a model call with token usage, cost, model, and finish reason, no extra configuration on their side.

Tool spans sit as siblings of the LLM span under the turn. Tools run after the model returns, so parenting them under the LLM span would misrepresent causality. Each tool span carries a span link back to the LLM span that triggered it, so backends that render links recover the causality without distorting timing. Several other agent exporters parent tools under the model call.

When pi auto-retries a failed provider call, auto-compacts, or continues with queued follow-up messages, it re-runs the agent loop without a new user prompt. The run root stays open across those re-runs and closes on `agent_settled` (pi 0.80.5+; older pi closes at `agent_end`), so every retry lands in the same trace and each re-run gets its own `pi.attempt` span — tagged `pi.attempt.reason=retry` or `post_compaction` when pi's behavior says why. A run pi starts without a user prompt at all (an extension-triggered turn on an idle session) opens a run root tagged `pi.interaction.origin=agent` instead of counting itself as a user prompt.

**Claims generations instead of assuming them.** `before_provider_request` and `after_provider_response` describe *candidates*: responses and headers buffer against the request start, and a `pi.llm_request` span opens only when an assistant lifecycle event claims the request (`message_start`, a real streamed delta, `message_end`, or `turn_end`). The span is backdated to the request start, so latency and TTFT cover the whole request. Cache warmers, probes, and internal summarization calls reach the same hooks but never become generations, so they emit no model span and no fabricated turn.

**Metrics** split by whether a released convention actually defines the name:

`gen_ai.client.operation.duration`, `gen_ai.client.token.usage`, and (in the default 1.43 dialect) `gen_ai.client.operation.time_to_first_chunk` are registry metric names (verified against semantic-conventions releases through v1.43.0):

- `gen_ai.client.operation.duration` (histogram, seconds)
- `gen_ai.client.token.usage` (histogram, by `gen_ai.token.type`; in the 1.43 dialect the registry's `input`/`output` values only — cache and reasoning counts live in the span's `gen_ai.usage.*` attributes — while the 1.36/1.37 dialects keep their historical `cache_read`, `cache_write`, `cache_write_1h`, and `reasoning` series)
- `gen_ai.client.operation.time_to_first_chunk` (histogram, seconds; 1.43 dialect only)

The remaining instruments measure things no released convention covers, so they live under `pi.*` instead of claiming an alignment that does not exist:

- `pi.llm.time_to_first_token` (histogram, seconds; gap between request start and the first streamed assistant token; the name the 1.36/1.37 dialects use — those releases define no time-to-first-chunk metric)
- `pi.llm.time_to_completion` (histogram, seconds; gap between request start and the last streamed assistant token, sourced from the `message_end` event; no registry metric measures this — `time_per_output_chunk` measures inter-chunk gaps)
- `pi.tool.calls` (counter)

Plus the rest of the `pi.*` set: `pi.session.duration`, `pi.prompt.count`, `pi.turn.count`, `pi.provider.retries`, `pi.turn.cancellations`, `pi.compaction.count`. The GenAI semantic conventions now develop in the `semantic-conventions-genai` repository (Development status, no tagged releases yet); when it cuts tags, a dated `semconv` dialect will adopt the `gen_ai.execute_tool.duration` and `gen_ai.invoke_agent.*` sets in one move.

Token usage uses a histogram. The semconv is explicit about this. Histograms let the backend show the p50 and p95 token distribution per request, which a counter cannot.

**Logs** carry `pi.*` lifecycle events: `pi.session.start`, `pi.session.end`, `pi.session.compact`, `pi.model.changed`, `pi.user_bash`, `pi.input`, `pi.llm_request.error`, `pi.tool.error`. Each is a log record with an `event.name` attribute, a severity, and a human-readable body.

## Capabilities

**Works with every OTLP backend.** The export is standard OTLP with strict semantic conventions, so any receiver, hosted or self-hosted, consumes it and handles its own translation. Auth is the standard `OTEL_EXPORTER_OTLP_HEADERS`.

**Speaks GenAI semantic conventions natively.** LLM spans carry the full `gen_ai.*` attribute set: token usage by type, cost, request and response model, response id, finish reasons, tool call id, name, arguments, and result, plus `gen_ai.input.messages` and `gen_ai.output.messages` JSON for AI panels. Captured input includes context other extensions inject (custom messages from `before_agent_start` results and `sendCustomMessage` deliveries), so the recorded input matches what the model actually saw. `gen_ai.system` carries the real provider (`anthropic`, `openai`, `zai`, etc.) so backends group by vendor correctly. `gen_ai.agent.name` is `pi`, the agent harness. Backends that read GenAI semconv render your agent traces as model calls with no extra setup on their side.

**Captures Anthropic's 1-hour cache split.** Anthropic reports cache writes two ways: 5-minute retention and 1-hour retention, at different prices. Most agent exporters fold both into `cache_write` and lose the split, which makes cost analysis wrong. The 1.43 dialect emits the registry names `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens` (a provider-managed cache write), plus the extension-specific `gen_ai.usage.cache_write_1h_input_tokens` for the 1-hour bucket — no registry release defines that split — so your cost dashboards stay accurate. The 1.36/1.37 dialects keep their historical underscore names for backends keyed on them. `gen_ai.usage.cost_usd` is also extension-specific (no registry release defines a cost attribute).

**Runs HTTP/protobuf by default, gRPC on demand.** HTTP/protobuf is the OTel spec default, needs no native dependencies, works with every backend on port 4318, and debugs with `curl`. Flip to gRPC with `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` when you want HTTP/2 multiplexing for high telemetry volume. `OTEL_EXPORTER_OTLP_HEADERS` works in both protocols: the extension translates them to grpc metadata for the gRPC exporters, whose config does not accept plain headers.

**Survives `/reload` and session replacement.** Pi reloads extensions per session in the same process. A global provider set on the first session turns into a zombie after `/reload`, dropping every span. The tracker scopes every SDK object (provider, processor, reader, exporter) to a session: created at `session_start`, shut down at every `session_shutdown` (quit, new, resume, fork, reload). A fresh session gets a fresh SDK. The test suite asserts this property.

**Never leaks orphan spans.** Replace a session (`/new`, `/resume`, `/fork`, compaction, tree navigation) or abort a turn with Esc and the tracker closes every open span, marked `pi.orphaned` or `pi.cancelled` so you can tell abandoned spans from normal ones in the backend. A compaction span left open by a run that ends mid-compaction is closed the same way.

**Classifies every span by operation.** The run root reports `gen_ai.operation.name=invoke_agent`, turns and the LLM request report `chat`, and tool spans report `execute_tool`. Backends that roll up tokens and cost by operation vocabulary therefore count each generation once instead of lumping runs, turns, and tool calls together.

**Keeps retried runs on one trace.** pi auto-retries retryable provider errors (rate limits, overloads) and auto-compacts on context overflow, re-running the agent loop after `agent_end` without a new user prompt. The tracker keeps the run root open across those re-runs and closes it on `agent_settled`, so retried turns and their LLM spans stay inside the original trace instead of forking into rootless spans, with one attempt span per re-run. On pi older than 0.80.5 (no `agent_settled`), each re-run reopens a run root tagged `pi.interaction.origin=agent`; nothing is dropped either way. The end-to-end test replays the retry flow and asserts both attempts stay on one trace.

**Tags session origin.** Every run root carries `pi.session.reason` with the value pi reported for the start: `startup`, `reload`, `new`, `resume`, or `fork`. Filter to forks to see branched sessions apart from primary ones.

**Links sessions to their parent.** On `new`, `resume`, and `fork` starts the run root also carries `pi.session.parent_id` (the parent session's canonical UUID, matching `pi.session.id`). `pi.session.id` itself resolves through `SessionManager.getSessionId()` — pi's own session identity — falling back to the UUID extracted from the session filename, so subagent-spawned children (whose session files live at `run-N/session.jsonl` and would otherwise all report the literal id `session`) get their real id too. A backend that renders parent links reconstructs the full fork and resume tree for a working session, so you can trace where a branched conversation came from. Subagent children that start with no `previousSessionFile` link to their orchestrating session through `PI_OTEL_PARENT_SESSION_ID` (or the `PI_SUBAGENT_PARENT_SESSION` convention some orchestrators publish), tying the whole run tree together.

**Carries the run context into spawned processes.** An open run publishes its own context as W3C `TRACEPARENT` (`00-<traceid>-<spanid>-<flags>`) and withdraws it when the run closes, restoring whatever value was there before. Because pi-subagents children and instrumented programs inherit the environment, a spawned pi adopts that context as the remote parent of its own run roots and stamps `pi.parent.trace_id` / `pi.parent.span_id`, so a delegation reads as one distributed trace. The inherited value is read once per process, so a context published for children can never be mistaken for one inherited; a malformed value is ignored rather than fabricating a parent.

**Reports the cache-relevant context.** Each LLM span carries `pi.cache.epoch` (completed compactions in the session: a compaction rewrites the cached prefix, so requests under different epochs cannot be each other's cache hits), `pi.context.tokens` / `.window` / `.percent` from pi's own context accounting, `gen_ai.usage.total_tokens` alongside the input/output/cache/reasoning counts, and `pi.route.previous_model` / `pi.route.transition_reason` when a `model_select` preceded the request. Response headers are captured under `http.response.header.<name>` for an allowlist only (request ids, `retry-after`, rate-limit headers, `cf-ray`), truncated to 1 KiB, so credentials and cookies never ship.

**Shuts down on a deadline.** `forceFlush` and `shutdown` race `PI_OTEL_SHUTDOWN_TIMEOUT_MS` (default 2000ms), and each exporter's request timeout is bounded by that same budget: an export that cannot finish within the budget could never be flushed at exit, and bounding it makes a dead collector's retry chain expire together with the deadline instead of holding the process open for its own (possibly much longer) timeout. When the deadline fires, in-flight HTTP export sockets are destroyed outright, so a collector that accepts connections but never responds cannot keep the event loop alive; slow collectors get a longer budget by raising `PI_OTEL_SHUTDOWN_TIMEOUT_MS`, which raises the export bound with it. A dead collector records the failure on `health.lastShutdownError` and pi still exits. A 60s unref'd sweep ends spans open longer than 30 minutes as `pi.orphaned`, including paths that skip `session_shutdown`. SIGTERM and SIGHUP run best-effort shutdown for container stops and closed terminals, and restore default signal termination once the flush finishes when no other handler owns the signal. The extension does not hook `exit` or `beforeExit`.

**Flags provider retries, HTTP errors, and cancellations.** The tracker watches every provider response. HTTP errors land on the LLM span as a categorized `error.type`: `rate_limit`, `server_error`, `auth_error`, `timeout`, `request_too_large`, or `client_error`. Failures that never get an HTTP response (connection refused, DNS, TLS) derive `error.type` from the error message, including a `network_error` category, so tail-sampling policies keyed on `error.type` still see them; when an HTTP status was observed, its category wins. Thrown errors map to the same set plus `content_filter`. Retries within a single request bump `pi.provider.retries`, and an aborted turn marks its spans `pi.cancelled` and bumps `pi.turn.cancellations`. Spot rate-limit storms and stuck turns without reading logs.

**Toggle each signal independently.** Turn traces, metrics, or logs on or off with `PI_OTEL_TRACES`, `PI_OTEL_METRICS`, `PI_OTEL_LOGS`, or the matching `otel.traces`, `otel.metrics`, `otel.logs` keys in settings. Run traces-only to cut ingest cost, or logs-only for a lightweight audit feed.

**Picks an exporter per signal.** `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, and `OTEL_LOGS_EXPORTER` accept comma-separated `otlp` (default), `console`, and `none`. Unknown tokens drop. `none` alone disables that signal. `otlp,console` mirrors to stdout for debugging in print mode, where stdout carries only the final answer. Console strips out in every mode where stdout is a protocol channel — the TUI renderer, the rpc JSON-RPC stream, and the json-mode event stream — so telemetry JSON never interleaves with it. A console-only configuration in those modes falls back to `otlp` instead of dropping telemetry.

**Session-level summaries and prompt fingerprinting.** The `pi.session.end` log record carries the session summary: total turns, tools, input and output tokens, cost, and an error count, so one record shows the whole session's spend at a glance. Each run root carries a one-way hash of the assembled system prompt (`gen_ai.system.prompt.hash`) so backends can group sessions by prompt template and A/B iterations without the prompt text leaving the machine.

**Dial content capture per project.** `captureContent` defaults to `full` and ships prompts, completions, and tool input and output to your backend, clamped to 64 KiB per attribute to fit collector limits. Drop to `no_tool_content` to keep prompts but hash tool input and output, the surface where secrets flow. Drop to `metadata_only` to emit only byte counts, line counts, and a hash, with no raw payloads leaving the machine. The hashes still let you correlate and dedupe across sessions without exfiltrating the underlying text. Three modes, no code changes. Unrecognized values resolve to `metadata_only` so a typo cannot turn on full capture; an unset value keeps the `full` default.

**Keeps enduser attribution opt-in.** Resource attributes come from the SDK's host, process, and OS detectors plus explicit `service.*` and `pi.*` values. `process.owner` is the OS username (standard OTel process semconv). The extension never reads git config or invents `enduser.id`. Set `OTEL_RESOURCE_ATTRIBUTES="enduser.id=alice@corp.com"` when you want per-developer attribution.

**Auto-populates rich resource attributes.** The SDK's host, process, OS, and service-instance detectors fill in `host.id`, `host.name`, `process.pid`, `process.executable.*`, `process.command*`, `process.owner`, `process.runtime.*`, `os.*`, and `service.instance.id`. Your backend gets stable host and process identity for filtering and grouping with no manual config.

**Strongly typed against Pi's real event and message shapes.** `src/tracker.ts` mirrors Pi's `Usage`, `AssistantMessage`, `ToolResult`, and `ToolCall` types as structural types instead of reconstructing them with `as any`. Type errors catch drift across Pi versions at compile time, and the runtime tolerates added fields.

**Tunable head sampling.** Sampling defaults to 1.0, every span exported. Set `PI_OTEL_SAMPLE_RATIO` or `OTEL_TRACES_SAMPLER_ARG` below 1.0 to cap ingest cost on a hosted platform without losing representative traffic. `OTEL_TRACES_SAMPLER` selects the sampler: `parentbased_traceidratio` (default), `traceidratio`, `always_on`, or `always_off`.

**Speaks the current GenAI conventions, versioned.** The GenAI semantic conventions renamed `gen_ai.system` to `gen_ai.provider.name` and moved away from the message span events in semantic-conventions v1.37.0 (October 2025), and v1.43.0 (July 2026) added the registry usage-attribute names, `gen_ai.request.stream`, `gen_ai.response.time_to_first_chunk`, and the time-to-first-chunk metric. The default `1.43` dialect emits the current registry set: backends that track the conventions render model calls with no extra setup, captured content ships once per span in the JSON message attributes, and cache/reasoning usage lands under the names current backends read. Pin `semconv` to `1.37` or `1.36` (env `PI_OTEL_SEMCONV`) when a backend still reads the older keys; each dialect emits exactly its own attribute set, with no dual-write. GenAI convention development has since moved to the `semantic-conventions-genai` repository; a future dated dialect will follow its tagged releases.

**Built-in pipeline diagnostics.** `/otel-status` prints the resolved config, per-signal endpoints, the active trace id, the last export error from each signal, and accepted vs exported span and log counts (an unexported hint means the batch queue is backed up or exports are failing). `/otel-flush` force-flushes pending telemetry. `/otel-test` emits one synthetic span, metric, and log record, force-flushes, and reports what actually shipped plus any export errors, so you can verify the backend receives all three signals in one step.

**A log channel for your other extensions.** Any pi extension can route structured log records through this exporter with `pi.events.emit("pi-otel:log", ...)`. One observability pipeline for your whole setup.

## Install

```
pi install git:github.com/stnly/pi-otel
```

Then `/reload` in pi, or restart.

This package ships TypeScript source under `src/` and is loaded by pi via jiti. It is not a precompiled library API for general Node imports.

## Quick start

Point the extension at an OTLP/HTTP backend and run pi.

Local Jaeger for development (used here as a local, OTLP-native backend with a built-in trace UI; the extension works with any OTLP receiver):

```bash
docker run --rm -p 16686:16686 -p 4318:4318 \
  -e COLLECTOR_OTLP_ENABLED=true jaegertracing/all-in-one:1.76.0

export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
pi
```

Run `/otel-test` in pi. It emits one synthetic span, one metric, and one log record, then force-flushes. Open Jaeger at http://localhost:16686 and look for the `pi.otel.self_test` service. If you see it, the pipeline works. `/otel-status` shows the resolved config and the last export error if anything failed.

### Direct to a hosted platform

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.your-platform.com
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=YOUR_KEY"
pi
```

No collector required.

### Via a collector gateway

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://my-collector:4318
pi
```

Put a collector in front for batching, tail-sampling, redaction, and any platform-specific translation. See [docs/collector-getting-started.md](docs/collector-getting-started.md) for a ready-to-run docker compose setup, a tail-sampling config tuned for agent traces, and prompt-redaction examples.

### gRPC instead of HTTP

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://my-collector:4317
pi
```

## Configuration

Sources, highest precedence first:

1. `OTEL_*` and `PI_OTEL_*` environment variables
2. project `.pi/settings.json` under `otel`
3. global `~/.pi/agent/settings.json` under `otel`

### `.pi/settings.json`

```jsonc
{
  "otel": {
    "enabled": true,
    "endpoint": "https://ingest.your-platform.com",
    "protocol": "http/protobuf",
    "headers": { "x-api-key": "..." },
    "serviceName": "pi",
    "resourceAttributes": { "deployment.env": "dev" },
    "captureContent": "full",
    "semconv": "1.43",
    "sampleRatio": 1.0,
    "metricExportInterval": 10000,
    "tracesExportInterval": 5000,
    "logsExportInterval": 5000,
    "tracesExporters": ["otlp"],
    "metricsExporters": ["otlp"],
    "logsExporters": ["otlp"],
    "traces": true,
    "metrics": true,
    "logs": true,
    "selfLogs": true,
    "diagLogLevel": "none"
  }
}
```

`protocol` accepts `grpc`, `http/protobuf`, or `http/json`. `captureContent` accepts `metadata_only`, `no_tool_content`, or `full`; unrecognized values resolve to `metadata_only`, and an unset value defaults to `full`. `semconv` names the semantic-conventions release whose GenAI attribute set is emitted: `1.43` (default) writes the registry set — `gen_ai.provider.name`, the registry usage-attribute names (`gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.usage.reasoning.output_tokens`), `gen_ai.request.stream`, `gen_ai.response.time_to_first_chunk`, and the `gen_ai.client.operation.time_to_first_chunk` metric — with `gen_ai.usage.cache_write_1h_input_tokens` and `gen_ai.usage.cost_usd` as documented extension-specific extras; `1.37` writes the 2025-10 rename set with the historical underscore usage names; `1.36` writes the pre-rename `gen_ai.system` key and the message span events for backends that have not migrated. Each dialect emits exactly its own set, with no dual-write. `sampleRatio` is a float in [0, 1]; 1.0 means no sampling. `selfLogs` controls whether the extension emits its own `pi.*` lifecycle log records. `diagLogLevel` routes the OpenTelemetry SDK's internal diagnostics to stderr (default `none`).

### Environment variables

Standard OTel, honored verbatim:

`OTEL_SDK_DISABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_TIMEOUT` (and per-signal `_TRACES/_METRICS/_LOGS_TIMEOUT`; the effective request timeout is bounded by the shutdown budget, so a configured export timeout longer than `PI_OTEL_SHUTDOWN_TIMEOUT_MS` is clamped to it), `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_EXPORT_TIMEOUT`, `OTEL_BLP_SCHEDULE_DELAY`, `OTEL_BLP_MAX_QUEUE_SIZE`, `OTEL_BLP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BLP_EXPORT_TIMEOUT`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_TRACES_EXPORT_INTERVAL`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_LOGS_EXPORT_INTERVAL`, and `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`. Metric temporality defaults to `DELTA` when `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` is unset, so cumulative counters from a short-lived agent run do not mislead backends. The preference is passed to the metric exporter constructor; process.env is not mutated. Set the env var yourself to override. `OTEL_BSP_*` and `OTEL_BLP_*` bound the trace and log batch queues (schedule delay, queue size, export batch size, export timeout); the spec names win over `OTEL_TRACES_EXPORT_INTERVAL`/`OTEL_LOGS_EXPORT_INTERVAL` when both are set. `OTEL_TRACES_SAMPLER` selects `parentbased_traceidratio` (default), `traceidratio`, `always_on`, or `always_off`.

Extension-specific:

`PI_OTEL_ENABLED`, `PI_OTEL_DISABLED`, `PI_OTEL_CAPTURE_CONTENT`, `PI_OTEL_SAMPLE_RATIO`, `PI_OTEL_SEMCONV` (accepts `1.36`, `1.37`, or `1.43`), `PI_OTEL_TRACES`, `PI_OTEL_METRICS`, `PI_OTEL_LOGS`, `PI_OTEL_SELF_LOGS`, `PI_OTEL_DIAG_LOG_LEVEL`, `PI_OTEL_SHUTDOWN_TIMEOUT_MS`, `PI_OTEL_PARENT_SESSION_ID` (links a subagent child session to its orchestrating session as `pi.session.parent_id`; `PI_SUBAGENT_PARENT_SESSION` is honored as an alternate name). Per-signal exporter env vars `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, and `OTEL_LOGS_EXPORTER` accept `otlp`, `console`, and `none` (comma-separated).

Per-signal exporter tokens and the `DELTA` metric default are described above. `tracesExportInterval` and `logsExportInterval` set each signal's batch processor `scheduledDelayMillis`. `metricExportInterval` sets the metric reader's export interval.

## Commands

| Command | What it does |
|---|---|
| `/otel-status` | Print the resolved config and export health: per-signal exporter lists, shutdown timeout, the active trace id, last error from each signal, last shutdown error, spans accepted vs exported (with an unexported hint when the batch queue is backed up), metric export batches, and log records accepted vs exported. |
| `/otel-flush` | Force-flush pending telemetry to the backend. |
| `/otel-test` | Emit one synthetic span, metric, and log record, flush, then report what actually shipped (export deltas) and surface any export errors. Use it to verify the pipeline end to end. |

Command output goes through `ctx.ui.notify` in the TUI and rpc modes, prints to stdout in print mode, and writes to stderr in json mode so it never interleaves with the JSON-lines event stream on stdout.

## Cross-extension log channel

Other pi extensions can route structured log records through this exporter:

```ts
pi.events.emit("pi-otel:log", {
  eventName: "my-extension.something",
  severity: "info",
  body: "human-readable message",
  attributes: { "key": "value" },
});
```

`eventName` lands as the `event.name` attribute. `severity` accepts `trace`, `debug`, `info`, `warn`, `error`, or `fatal`. The call is a no-op when logs are disabled or the runtime is not up.

## Resource attributes

Populated by the SDK detectors plus explicit values:

- `service.name`, `service.version` (the installed pi version), `service.instance.id`
- `host.name`, `host.id` (machine-id on Linux, hostname elsewhere)
- `process.pid`, `process.executable.name`, `process.executable.path`, `process.command`, `process.command_line`, `process.owner`, `process.runtime.name`, `process.runtime.version`
- `os.type`, `os.version`, and friends from the OS detector
- `pi.cwd`, `pi.extension.name`, `pi.extension.version`

Anything you put in `OTEL_RESOURCE_ATTRIBUTES` overrides or extends these.

## Tests

```
npm test
```

Tests span seven layers: config resolution, attribute helpers, the span tracker, metric instrument naming, the SDK lifecycle, the `/otel-status` command, and an end-to-end run over a loopback OTLP/HTTP sink. The end-to-end test replays a full session — including a provider-error auto-retry re-run — through a fake `ExtensionAPI` and asserts that traces, metrics, and logs all arrive over HTTP with the documented span names and that retried runs stay inside one interaction. `npm run typecheck` covers `src/` and `test/`; `npm run coverage` prints a per-file coverage report. CI runs both on Node 22 and 24. Requires Node 22+.

## License

MIT
