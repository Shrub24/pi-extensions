# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-09-10

### Fixed

- A collector that accepts connections but never responds can no longer keep the pi process alive past the shutdown deadline. `shutdownProviders` already gave up at `PI_OTEL_SHUTDOWN_TIMEOUT_MS`, but the in-flight export request held its socket referenced until the exporter's own (possibly much longer) request timeout fired, and the exporter's retry logic chained up to five further attempts inside that window — so the process outlived pi's output by up to a minute with a long `OTEL_EXPORTER_OTLP_TIMEOUT`. Exporter request timeouts are now bounded by the shutdown budget (`boundedExportTimeout`, floor 100ms), which makes the export deadline and the shutdown deadline expire together, and at the deadline the extension destroys in-flight HTTP export sockets outright. Slow collectors keep working by raising `PI_OTEL_SHUTDOWN_TIMEOUT_MS`, which raises the export bound with it. A child-process regression test asserts the process itself exits against a hanging receiver, not merely that the shutdown promise resolves.

## [0.3.0] - 2026-09-03

### Breaking

- The default GenAI dialect is now `1.43`, the attribute set of semantic-conventions v1.43.0 (the last registry sync of the GenAI conventions before they federated to the semantic-conventions-genai repository). On the LLM span, cache and reasoning usage moves to the registry names `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, and `gen_ai.usage.reasoning.output_tokens`; `gen_ai.client.token.usage` records only the registry's `input`/`output` token types (cache and reasoning counts live in the span attributes); `gen_ai.request.stream` and `gen_ai.response.time_to_first_chunk` are recorded; and time-to-first-token ships as the registry metric `gen_ai.client.operation.time_to_first_chunk` instead of `pi.llm.time_to_first_token`. `gen_ai.usage.cache_write_1h_input_tokens` and `gen_ai.usage.cost_usd` stay as documented extension-specific attributes (no registry release defines either). Pin `PI_OTEL_SEMCONV=1.37` (or `1.36`) to keep the previous names; each dialect still emits exactly its own set.
- Node 20 support dropped: `engines.node` is now `>=22`, and CI runs on 22 and 24. Node 20 reached end of life in April 2026.
- `pi.session.id` and `pi.session.parent_id` now carry pi's canonical session UUID (from `SessionManager.getSessionId()`, falling back to the UUID extracted from the session filename) instead of the `<timestamp>_<uuid>` filename stem. Dashboards keyed on the old stem format need the UUID; a filename without a trailing UUID keeps its previous whole-stem value. Subagent-spawned children previously reported the literal id `session` from their `run-N/session.jsonl` paths; they now report their real id.
- OpenTelemetry dependencies moved to `@opentelemetry/sdk-*` 2.11.0 / experimental 0.222.0 / `api` 1.9.1 / `semantic-conventions` 1.43.0.

### Fixed

- Auto-retried runs no longer fragment the trace tree. pi re-runs the agent loop after `agent_end` when a provider error is retryable or overflow recovery compacts, without refiring `before_agent_start`; the interaction previously closed at `agent_end`, so retried turns were dropped and retry LLM spans exported as root spans on a new trace id. The interaction now closes on `agent_settled` (pi 0.80.5+), and any run pi starts without a user prompt (a retry re-run on older pi, or an extension-triggered turn on an idle session) opens an interaction tagged `pi.interaction.origin=agent` that does not count as a user prompt. The end-to-end suite replays the retry flow and asserts the single-interaction property.
- A `console` exporter no longer corrupts `pi --mode json` output. Console stripping was keyed on `hasUI` alone (true in TUI and rpc modes), but json mode reports `hasUI: false` while streaming session events as JSON lines on the same stdout the console exporter writes to. Stripping now keys on the run mode: console survives only in print mode, and a console-only configuration in a stripped mode falls back to `otlp`.
- `/otel-status`, `/otel-flush`, and `/otel-test` output goes to stderr in json mode. The headless fallback printed via `console.log`, which interleaved a non-event line with the JSON-lines event stream on stdout; print mode keeps its stdout mirror, and the no-runtime status line now carries the same `WARNING:` prefix as every other headless message.
- `service.version` now reports the running pi's real version. The previous resolution used `import.meta.resolve`, which jiti rewrites to an undefined global inside loaded extensions, so it always fell back to `unknown`.
- Session startup no longer dies in containers running an unregistered UID: `os.userInfo()` throws there (no passwd entry), which previously aborted the whole telemetry runtime; `process.owner` now resolves to `unknown` instead.
- `OTEL_EXPORTER_OTLP_HEADERS` now authenticates gRPC exports. The gRPC exporter config omits `headers` in favor of grpc `metadata`, so the extension passed headers the exporter ignored and gRPC exports failed with no diagnostic beyond the backend's 401; headers are now translated to grpc `Metadata`.
- A malformed endpoint URL no longer kills the whole runtime. The OTLP exporter constructor throws on an unparseable URL, which previously rejected `startRuntime` and left the session with no telemetry at all; each signal's exporter construction is now isolated, the failed signal records `exporter construction failed: ...` on its `/otel-status` health line, and the remaining signals keep exporting.
- Tool arguments that reference the same object more than once no longer serialize as `[circular]`. The cycle guard marked every visited object, so shared-but-acyclic references (common in structured tool args) collapsed; only objects on a true reference cycle are cut now.
- LLM failures that never produce an HTTP response (connection refused, DNS, TLS) now carry a categorized `error.type`, including a new `network_error` category, instead of shipping `exception.message` with no `error.type` for tail samplers and dashboards to key on. When an HTTP status was observed, its category still wins.
- A non-numeric `sampleRatio` in settings JSON resolves to 1 instead of propagating `NaN` into the sampler, and the `pi-otel:log` channel clamps oversized `eventName` values like every other string attribute.
- `gen_ai.input.messages` now includes context other extensions inject. Custom messages (from `before_agent_start` results and `sendCustomMessage` deliveries) flow through `message_start` like user input, but were dropped, so the captured input went incomplete exactly when other extensions added context.

### Added

- `pi.compaction.will_retry` on the compaction log record and metric attributes: overflow-recovery compactions (which retry the aborted turn) are now distinguishable from manual and threshold ones.
- `PI_OTEL_PARENT_SESSION_ID` (and the `PI_SUBAGENT_PARENT_SESSION` convention) links a subagent child session to its orchestrating session as `pi.session.parent_id` when the child starts with no `previousSessionFile`. The published value is normalized to the same shape as `pi.session.id` — bare UUID, `<timestamp>_<uuid>` stem, or full session-file path all reduce to the UUID — and `PI_OTEL_PARENT_SESSION_ID` wins when both are set.
- `pi.interaction.origin` (`user` | `agent`) on every interaction span.
- A metrics test layer covering dialect-dependent instrument naming, and tracker tests for `ensureInteraction` and the 1.43 attribute set. End-to-end replays now follow pi's real event order for overflow recovery (compaction between `agent_end` and the retry's `agent_start`) and cover an extension-triggered turn on an idle session, and `effectiveExporterTokens` is unit-tested for every run mode.

### Changed

- `BatchLogRecordProcessor` and `SimpleLogRecordProcessor` are constructed with the single options-object signature required by sdk-logs 0.220+.
- Signal-handler lifecycle tests assert per-signal listener deltas instead of a two-signal sum, so listeners owned by the OTel SDK or the host process cannot shift the baseline.
- The collector example configs pin image versions (otel/opentelemetry-collector-contrib 0.160.0, jaegertracing/all-in-one 1.76.0) instead of `latest`.

## [0.2.0] - 2026-08-18

### Breaking

- The default GenAI attribute set is now the one from semantic-conventions v1.37.0: LLM spans emit `gen_ai.provider.name` (the 2025-10 rename of `gen_ai.system`) and no longer emit `gen_ai.system` or the `gen_ai.user.message`/`gen_ai.assistant.message`/`gen_ai.tool.message`/`gen_ai.choice` events; captured content ships once via the `gen_ai.input.messages`/`gen_ai.output.messages` attributes. The `semconv` setting names the convention release whose set is emitted (`1.36` or `1.37`, default `1.37`); set `PI_OTEL_SEMCONV=1.36` to emit the pre-rename keys and events. Each dialect emits exactly its own attribute set, with no dual-write.
- Timing and tool-count metrics were renamed from the invented `gen_ai.client.time_to_first_token`, `gen_ai.client.time_to_completion`, and `gen_ai.client.tool.calls` to `pi.llm.time_to_first_token`, `pi.llm.time_to_completion`, and `pi.tool.calls`. Those GenAI names appear in no released convention set (verified against semantic-conventions v1.28 through v1.37, whose client metric set is exactly `gen_ai.client.operation.duration` and `gen_ai.client.token.usage`), so only those two keep GenAI names.

### Fixed

- A provider request that failed and then succeeded on retry no longer ends its LLM span with `error.type` and ERROR status, and no longer counts toward the session's `pi.error_count`. Attempt failures are tracked off the span and the final outcome is stamped once at span finalization, so tail-sampling policies keyed on `error.type` no longer keep every transient retry.
- `PI_OTEL_DIAG_LOG_LEVEL` (and `OTEL_LOG_LEVEL`) now route OpenTelemetry SDK diagnostics to stderr at the configured level. The configured level previously filtered messages into a no-op logger, so the knob never produced output.
- The SIGTERM/SIGHUP handlers restore default process termination when no other handler owns the signal after the flush, so the extension can no longer keep a host process alive that would otherwise exit.
- Unrecognized `captureContent` values (for example `metadata-only` or `no_tool`) now resolve to `metadata_only` instead of `full`. An unset value still defaults to `full`. `/otel-status` shows the resolved value.
- The test suite resolves `package.json` relative to the test file; a hardcoded absolute path failed the suite on every checkout except the original author's.

### Added

- Standard OTel env vars now honored: `OTEL_SDK_DISABLED`, `OTEL_EXPORTER_OTLP_TIMEOUT` (and per-signal variants), `OTEL_BSP_*` and `OTEL_BLP_*` batch queue bounds, and `OTEL_TRACES_SAMPLER` sampler selection.
- Batch queue visibility: `/otel-status` shows spans and log records accepted vs exported with an unexported hint when the queue is backed up or exports fail.
- `/otel-test` reports what actually shipped (export deltas) and surfaces export errors; it emits its log record regardless of `selfLogs`. `/otel-status` shows the active trace id.
- The `semconv` setting (env `PI_OTEL_SEMCONV`) selects the GenAI convention release; the `gen_ai.choice` event no longer embeds a duplicate of the assistant message in either dialect.
- GitHub Actions CI: `npm ci`, typecheck, and test on Node 20/22/24 for every push and pull request.
- `npm run coverage` reports per-file line/branch/function coverage using the node:test built-in reporter.

### Changed

- `tsconfig.json` typechecks `test/` alongside `src/`, so type drift in test code now fails `npm run typecheck` instead of passing unseen.

## [0.1.0] - 2026-07-12

Initial release: OTLP traces, metrics, and logs for the pi coding agent with GenAI semantic conventions, per-session SDK lifecycle, content capture modes, and `/otel-status`, `/otel-flush`, `/otel-test` commands.
