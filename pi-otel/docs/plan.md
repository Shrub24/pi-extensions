# Pi OTLP observability — architecture plan

Fork base: `stnly/pi-otel` @ `398d40a` (release 0.3.1), `upstream` remote in this repo.
Status: baseline implemented in this fork; later phases listed in §6.

Guiding principle:

> Pi owns the semantic truth. OTLP is the durable interchange format. Backends are replaceable consumers.

## 1. Reference decisions

| Source | What we take |
|---|---|
| `stnly/pi-otel` | The substrate: session-scoped SDK lifecycle (no global providers, survives `/reload`), `gen_ai.*` semconv with versioned dialects (1.36/1.37/1.43), traces+metrics+logs, `captureContent` tiers, orphan/cancel hygiene, exporter health commands, test harness. |
| `narumiruna/pi-extensions` (`packages/pi-langfuse`) | The lifecycle model: attempt layer between run and turn; pending-generation claim (provider hooks are candidates, not spans); root stays open across retries until `agent_settled`; compaction as a real span parented on the run, not the attempt; response-header allowlist with truncation; recovered-error vs failed-attempt accounting. |
| `langfuse/pi-observability-plugin` | One trace per user interaction with `session.id` grouping; parent-context publication through `process.env` keyed on the **run root** (not tool spans — one variable cannot serve parallel tool calls); bounded `forceFlush` discipline. |
| `grafana/agento11y` (`plugins/pi`) | Conformance philosophy: a live run and the same session JSONL imported later must yield equivalent telemetry. Tool *call* (model output) vs tool *execution* (our runtime) stay distinct. The generation-export protocol is Grafana-specific and is not adopted. |
| `latitude-dev/latitude-llm` | Ingest contract for the A/B (§4.1): required attributes, operation vocabulary, session grouping key, token arithmetic, exactly-once emission. |

Rejected: Langfuse-branded span names and `LANGFUSE_*` env vars; Grafana's generation
export schema; any backend-specific attribute inside the canonical model. Backend
compat shims live downstream (collector transforms) or behind config, never in the
semantic layer.

## 2. Canonical model

### 2.1 Trace and session boundaries

- A Pi session is a **correlation key, not a span**. Session identity rides every span
  as `pi.session.id` plus the grouping aliases `gen_ai.conversation.id` and `session.id`.
- One user-driven run — `before_agent_start` through `agent_settled` — is **one OTel trace**.
  The run root is the existing `pi.interaction` span, now started with no parent context.
  Retries, overflow recovery, and queued continuations stay inside that trace until
  `agent_settled` closes it (same rule as before; only the parent changed).
- The session-long `pi.session` span is removed. Its summary (turn/tool counts, token
  totals, cost, error count) moves to the `pi.session.end` log record; the session
  metrics are unchanged. Backends whose unit of display is the trace (Langfuse,
  Latitude, Jaeger) never see a multi-hour root span again.

```text
trace = one run
pi.interaction                    run root (was: child of pi.session)
├── pi.attempt                    one per agent_start/agent_end pair
│   ├── pi.turn                   one per assistant response + its tool batch
│   │   ├── pi.llm_request        CLIENT; gen_ai.*; claimed from pending
│   │   └── pi.tool.<name>        sibling of llm_request, linked to it
│   └── pi.attempt …              retries, post-compaction re-runs
├── pi.compaction                 session_before_compact → session_compact
└── (next pi.attempt)
```

Attempts are real lifecycle boundaries (`agent_start` / `agent_end`), not decoration;
no further wrapper spans are introduced.

### 2.2 Pending-generation claim

`before_provider_request` / `after_provider_response` are *candidates*: responses and
headers accumulate on a pending record with the request start time. A `pi.llm_request`
span opens only when an assistant lifecycle event claims the record
(`message_start`/real `message_update` delta/`message_end`/`turn_end` with an assistant
message); accumulated statuses replay onto it then. Unclaimed records are discarded at
the next run boundary — cache warmers and probes never appear as model turns.

### 2.3 Attributes added in this pass

| Attribute | Where | Meaning |
|---|---|---|
| `gen_ai.conversation.id`, `session.id` | every span | Backend grouping aliases; same value as `pi.session.id`. |
| `gen_ai.usage.total_tokens` | `pi.llm_request` | Pi's `usage.totalTokens`; lets ingest resolve inclusive-vs-additive token arithmetic (§4.1.3). |
| `gen_ai.operation.name` | run root `invoke_agent`, tool spans `execute_tool` | Operation vocabulary ingest keys on; without it spans classify as `unspecified`. |
| `pi.attempt.number`, `pi.attempt.reason` | `pi.attempt` | 1-based per run; reason only when derivable (`post_compaction`, `retry`). |
| `pi.interaction.*` | run root | Already present (`id`, `origin`); now also carries `pi.session.reason`, `pi.session.parent_id`. |
| `pi.context.tokens`, `pi.context.window`, `pi.context.percent` | `pi.llm_request` (at claim), run root at close | Context alive when the request was built. |
| `pi.compaction.*` | `pi.compaction` | `reason`, `will_retry`, `tokens_before`, `tokens_after`, `from_extension` — present fields only. |
| `gen_ai.usage.*`, `gen_ai.operation.name=chat`, `gen_ai.usage.cost_usd` | `pi.compaction` when pi reports `CompactionEntry.usage`; session totals/metrics on `session_tree` when pi reports `BranchSummaryEntry.usage` | Compaction and branch-summary model calls are real generations the claim model never claims (no assistant event), so their spend lands on the compaction span or the session totals instead of disappearing. Extension-supplied summaries carry no usage and stay plain spans. |
| `pi.cache.epoch` | `pi.llm_request` | Count of compactions so far in the session: a compaction breaks the cached prefix, so consecutive requests with different epochs are never cache-hits of each other. |
| `pi.route.previous_model`, `pi.route.transition_reason` | `pi.llm_request` after a `model_select` | Route/model transitions (also stays on the existing `pi.model.changed` log). |
| `http.response.header.<name>` | `pi.llm_request` | Allowlisted headers only: `x-request-id`/`request-id`/`anthropic-request-id`, `retry-after`, `x-ratelimit-*`, `anthropic-ratelimit-*`, `cf-ray`; values truncated (1 KiB). |

Not added: `pi.agent.role/depth/run_id`, `pi.attempt` cost fields, cache TTLs.
Session-published context (`pi.agent.depth`) arrives with exact delegation-span
propagation in §6; provider cache TTLs are not observable — cache analysis works from
timestamps, context size, epochs, and token counts instead.

### 2.4 Usage authority

`AssistantMessage.usage` stays authoritative: `input`, `output`, `cacheRead`,
`cacheWrite`, `cacheWrite1h`, `reasoning` (already included in `output` — never added
again), `cost.*`, `totalTokens`. No re-derivation from provider payloads.

### 2.5 Cross-process propagation

Parent side: on run-root open, publish `TRACEPARENT` (`00-<traceid>-<spanid>-<flags>`)
into `process.env`; withdraw on run close and session shutdown. The published context
is the **run root**, so parallel subagent children and bash-spawned processes all
attach to the same span without ambiguity; children spawned by `pi-subagents` inherit
it automatically because that package spreads `process.env` into the child runner.

Child side: read inherited `TRACEPARENT` **once per process**, use it as a remote
parent for this process's run roots (the child's work joins the delegation trace, as
in the conceptual model), and stamp `pi.parent.trace_id` / `pi.parent.span_id`.
`PI_OTEL_PARENT_SESSION_ID` / `PI_SUBAGENT_PARENT_SESSION` keep linking session
identity as today.

Scope note: this is run-level context, identical to the Langfuse plugin's choice.
Exact per-delegation span contexts for parallel children require a spawn-time hook in
`pi-subagents` (§6).

## 3. What the fork keeps unchanged

Exporter plumbing (endpoints, protocols, sampling, resource detection, socket reaper,
shutdown deadlines, health counters, `/otel-*` commands), content-capture tiers,
semconv dialects, metric names, the cross-extension `pi-otel:log` channel, and the
tool-span-sibling-of-LLM topology with its backlink.

## 4. Backend compatibility (A/B)

### 4.1 Latitude ingest requirements

1. **Project scoping**: `X-Latitude-Project` header (via `OTEL_EXPORTER_OTLP_HEADERS`)
   or a `latitude.project` resource attribute. Without it every span is rejected.
2. **Session grouping**: `session.id` is the primary key (`gen_ai.conversation.id` is
   only a late fallback) — hence the alias in §2.3.
3. **Token arithmetic**: `gen_ai.usage.input_tokens` is *assumed inclusive* of cache
   except for Anthropic/Bedrock/Vertex providers, unless `gen_ai.usage.total_tokens`
   arithmetic proves otherwise. Pi reports additively on all providers
   (`totalTokens = input + output + cacheRead + cacheWrite`), so we always emit the
   total; ingest then resolves the convention instead of guessing.
4. **Operation vocabulary**: unrecognized operations land in `unspecified` and are
   excluded from token/cost rollups — hence `invoke_agent` / `execute_tool` /
   `chat` on the three span classes.
5. **Types**: token/cost attributes must be numeric; `gen_ai.response.finish_reasons`
   must be a string array (already correct); re-sending a span inflates additive
   materialized views, so emission stays exactly-once per `(traceId, spanId)` — one
   batch processor, no retries that reassign ids.

TTFT: our semconv name (`gen_ai.response.time_to_first_chunk`) is not in Latitude's
candidate list. Handle as a collector transform in the A/B harness config, not in the
exporter (§6, A/B harness).

### 4.2 Langfuse

Same canonical telemetry; grouping via `session.id` + one trace per interaction matches
the official plugin's model. Observation-type hints (`agent` / `generation` / `tool`)
are a downstream transform if the OTLP ingest needs them — not emitted here.

### 4.3 A/B harness

```text
pi-otel ──OTLP──▶ OpenTelemetry Collector ──▶ Langfuse OTLP endpoint   (auth header)
                        │                  └──▶ Latitude ingest          (X-Latitude-Project)
                        └──▶ later: VictoriaMetrics / VictoriaLogs / VictoriaTraces
```

One collector fans the identical stream to both services; per-destination headers and
any compat transforms live in collector config. Fairness then means one exporter and
one wire format, with backend-side differences visible as such. Collector config
examples go under `docs/collector-configs/` alongside the existing ones.

## 5. Baseline scope (this pass)

1. Run-per-trace topology; session span removed, summary to `pi.session.end` log.
2. Attempt layer with number/reason; `agent_settled` closes the run.
3. Pending-generation claim (cache probes emit no span).
4. Compaction span with `pi.compaction.*`.
5. Attribute additions from §2.3.
6. `TRACEPARENT` publication/consumption (run-level).
7. Response-header allowlist.
8. Route-transition attributes after `model_select`.
9. Tests: updated topology assertions plus new coverage for 1–6; `npm run typecheck`
   and `npm test` green in `pi-otel/`.

## 6. Later phases

- **Exact delegation contexts**: spawn-time hook in `pi-subagents` publishing the
  per-child delegation span (we own both packages); adds `pi.agent.depth` and
  parent-links parallel children individually.
- **A/B harness config**: collector fan-out to Langfuse + Latitude, compat transforms
  (TTFT alias, observation-type hints), run both services on identical streams.
- **Conformance tests**: replay session JSONL fixtures through a fake `ExtensionAPI`
  and assert equivalence with live captures (Agento11y's contract, our names).
- **History import**: session JSONL → canonical telemetry for pre-instrumented sessions.
- **Durable stack**: VictoriaMetrics/VictoriaLogs/VictoriaTraces + Grafana behind the
  collector; cache-economics dashboards from `pi.cache.*` + timestamps.
- Reserved, unimplemented: `pi.agent.role`, `pi.route.tier`, externally supplied
  `pi.cache.epoch` from a routing layer.

## 7. Non-goals

- The canonical identity model remains standard `session.id` plus portable `pi.*` fields. Additive `langfuse.*` and `latitude.*` attributes are explicit UI-compatibility mappings, not replacements for those canonical fields.
- No re-derivation of known usage/cost from provider payloads.
- No wrapper spans added for tree aesthetics; no session-long trace.
