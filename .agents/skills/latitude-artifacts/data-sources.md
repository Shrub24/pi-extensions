# Data sources for artifacts

Every Latitude read is one operation, exposed identically over four surfaces. Pick the surface by how the artifact will be used (see `SKILL.md` → Modalities), then map each question in the artifact to one or more operations below.

| Surface | Call shape | Auth | Best for |
| --- | --- | --- | --- |
| **MCP** | tool `queryAnalytics` | OAuth (already connected in the harness) | One-off artifacts built in the conversation |
| **CLI** | `latitude analytics query --project-slug <slug> --json '<body>' --format json` | `LATITUDE_API_KEY` in `.env` | Shell refresh scripts, cron |
| **API** | `POST https://api.latitude.so/v1/projects/<slug>/analytics/query` with `Authorization: Bearer <key>` | API key | Any language, CI |
| **SDKs** | `client.analytics.query(slug, { body })` (`@latitude-data/sdk`) / `client.analytics.query(slug, ...)` (`latitude-sdk`) | API key | Node/Python refresh scripts |

Names are the same everywhere: the MCP tool `listTools` is `latitude tools list` on the CLI, `GET /v1/projects/<slug>/tools` on the API, and `client.tools.list(...)` in the SDKs. **Always read the operation's schema before calling it** (`--schema` on the CLI, the tool's `inputSchema` on MCP, the [API reference](https://api.latitude.so/docs) otherwise). Parameter names below are current at the time of writing but the schema is the source of truth.

## Units

Normalize before rendering. Two unit systems coexist:

- **Display units** (seconds, dollars, 0–1 rates): `queryAnalytics`, `getTraceAnalytics`, `getSessionAnalytics`.
- **Wire units** (nanoseconds, microcents): everything else, including row lists (`listTraces`, `listSessions`, `listUsers`) and entity rollups (`listTools`, `getTool`, `getUser`). The field name says which: `durationNs` / `p95DurationNs` → seconds is ÷ 1e9; `costTotalMicrocents` → dollars is ÷ 100,000,000. `querySpans` rows carry `startTime`/`endTime` rather than a duration; derive it. Timestamps are ISO-8601 everywhere.

The same applies to **filter thresholds**: a `duration` filter takes nanoseconds and a `cost` filter takes microcents (`{"duration": [{"op": "gte", "value": 5000000000}]}` is "at least 5 s").

The template's formatters expect seconds, dollars, and 0–1 rates. Convert at fetch time, not in the renderer.

## `queryAnalytics`: the workhorse

One composable aggregate over a filtered stream: **metric** × optional **breakdown** × optional **time bucket**. Every KPI tile, bar chart and trend line is one call.

```jsonc
{
  "stream": "traces",                                     // see table below
  "metric": { "kind": "percentile", "field": "duration", "p": 95 },
  "breakdown": "tool",                                    // optional: one row per value
  "timeBucket": { "unit": "day" },                        // optional: hour | day | week, size defaults to 1
  "filters": { "tags": [{ "op": "in", "value": ["prod"] }] }, // optional: same DSL as listTraces
  "range": { "fromIso": "2026-08-31T00:00:00Z", "toIso": "2026-09-07T00:00:00Z" },
  "limit": 50                                             // max 500 rows (breakdown × buckets)
}
// → { "series": [{ "key"?: string, "label"?: string, "bucketStart"?: string, "value": number }] }
```

| Stream | Grain | Metrics | Breakdowns |
| --- | --- | --- | --- |
| `traces` | one request/agent run | `count`, `errorRate`, `cacheHitRate`, `sum`/`min`/`max`/`avg`/`median`/`percentile` of `duration`, `cost`, `tokens` | `model`, `provider`, `service`, `tool`, `tag`, `name`, `userId`, `status` |
| `sessions` | one conversation | same as traces | `model`, `provider`, `service`, `tool`, `tag`, `userId`, `status` |
| `spans` | one operation (LLM call, tool call, …) | same as traces | `model`, `provider`, `service`, `tool`, `tag`, `operation`, `status` |
| `scores` | one signal occurrence | `count`, `passRate`, `errorRate`, `avg`/`min`/`max`/`median` of `value` | `signalId`, `source`, `model`, `provider`, `service`, `tool`, `tag` |
| `behaviors` | one behaviour observation | `count`, `avg`/`min`/`max`/`median` of `confidence` | `cluster`, `session`, `method` |
| `moments` | one labeled conversation moment | `count`, `avg`/`min`/`max`/`median` of `confidence` or `coherence` | `kind`, `actor`, `session` |

Opaque breakdown keys (`signalId`, `cluster`) come back with a human `label`. Use it.

**Comparisons.** For "vs previous period" deltas, run the same query twice with the range shifted back by its own length and compute the delta yourself.

**Time buckets.** `bucketStart` is UTC-aligned. Fill missing buckets with `0` (or `null` for rates) so the x-axis stays continuous.

## Question → operations

Start every artifact by writing each section's question in one line, then mapping it here.

### Reliability, latency, cost (any project)

| Question | Operation |
| --- | --- |
| Volume, error rate, latency percentiles, spend, tokens, cache hit rate, by anything, over time | `queryAnalytics` |
| The default overview series the Latitude UI shows (12-hour buckets, totals + medians) | `getTraceAnalytics`, `getSessionAnalytics` (`fromIso`, `toIso`) |
| The N slowest / most expensive / failing traces (rows) | `listTraces` (`filters`, `sortBy`, `limit`) |
| Individual operations across traces: slow tool calls, failing LLM calls | `querySpans` (`filters`, `range`, `orderBy`, `limit`) |
| The conversation behind one row | `getTrace`, `getSession` (only when the artifact needs an example; see privacy note) |

### Tools

| Question | Operation |
| --- | --- |
| Which tools exist, how often each is offered vs called, per-tool error rate and latency, call trend | `listTools` (`fromIso`, `toIso`) |
| One tool's definition and usage/failure metrics | `getTool` (`toolName`, `errorsOnly`) |
| Why a tool fails (error outputs clustered) | `getToolErrors` (`toolName`, `limit`) |
| What arguments a tool is called with | `getToolParameters` |
| Which models / providers / tags use a tool | `getToolContext` |
| Which tools are called together | `getToolCoOccurrence` |
| Tool call volume over time (all tools or one) | `getToolCallHistogram` (`toolName`, `bucketSeconds`, `errorsOnly`) |
| Recent calls of one tool with payload previews | `listToolCalls` |

### Users

| Question | Operation |
| --- | --- |
| Unique / new users, identified share of traffic, activity histogram | `getUsersOverview` (`fromIso`, `toIso`) |
| Per-user traces, sessions, tokens, cost (a leaderboard) | `listUsers` (`sortBy`, `limit`, `offset`) |
| One user's lifetime profile | `getUser` |
| One user's activity over time | `getUserActivity` |
| What models / providers / tools a user hits most | `getUserUsage` (`dimension`) |
| Signals or behaviours seen on a user | `listUserSignals`, `listUserBehaviours` |
| Which memory stores a user touched | `listUserMemoryStores` |

### Memory ("how are users interacting with my agent's memory?")

| Question | Operation |
| --- | --- |
| Stores, record counts, token footprint, sessions and users per store | `listMemoryStores` (`sort`, `direction`) |
| What a store contains now, or as of a past date | `getMemoryStore` (`storeId`, `at`) |
| What changed in a store between two dates (added / updated / removed, token deltas) | `getMemoryStoreDiff` (`storeId`, `from`, `to`) |
| Who accesses a store | `listMemoryStoreUsers` |
| A record's body and version history | `getMemoryRecord` |
| A single before/after change | `getMemoryRecordChange` |
| Retrieval events for a record (query text, tokens returned, who) | `listMemoryRecordReads` |
| Who reads / writes a record | `listMemoryRecordUsers` |
| Memory read / added / removed tokens for one session or trace | `getSessionMemory`, `getTraceMemory`, `getSessionMemoryChanges`, `getTraceMemoryChanges` |

A useful memory artifact usually combines: `listMemoryStores` (the inventory), `getMemoryStoreDiff` over the window (churn), `listMemoryStoreUsers` (reach), and `listMemoryRecordReads` on the top records (what users actually retrieve), plus `queryAnalytics` on `traces` filtered to memory-heavy sessions for cost impact.

### Signals, incidents, monitors

| Question | Operation |
| --- | --- |
| Counts of ongoing / new / escalating signals and the occurrence series | `getSignalAnalytics` (`fromIso`, `toIso`) |
| The signal list with evidence, lifecycle states and window stats | `listSignals` (`lifecycleGroup` active/archived, `sortBy`, `fromIso`, `toIso`) |
| One signal's history, evidence, trend | `getSignal`, `getSignalTrend` |
| Occurrences over time broken down by signal, model, tool… | `queryAnalytics` on `scores` |
| Traces that triggered a signal | `listSignalTraces` |
| Incidents opened in the window, by severity | `listIncidents` (`fromIso`, `toIso`, `severities`) |
| Monitors and their incident history | `listMonitors`, `listMonitorIncidents` |

### Behaviours, moments, experiments, saved searches

| Question | Operation |
| --- | --- |
| Behaviour clusters and their frequency / confidence | `queryAnalytics` on `behaviors` (breakdown `cluster`) |
| Conversation fallout: where moments of a given kind pile up | `queryAnalytics` on `moments` (breakdown `kind` or `actor`) |
| Variant comparison for an experiment | `getExperiment` (`experimentSlug`), `listExperiments` |
| Traces matching a saved search the user already curates | `listSavedSearches`, `listSavedSearchTraces` |
| Annotation / score coverage | `listTraceAnnotations`, `queryAnalytics` on `scores` (breakdown `source`) |

## Filters

`filters` uses the same DSL everywhere: `{ "<field>": [{ "op": "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn" | "contains" | "notContains" | "gtePercentile", "value": ... }] }`. Conditions on one field are ANDed, and so are fields. **Unknown field names are rejected, not ignored**, and the filter fields are not the breakdown names:

- **Trace filter set** (`listTraces`, `listSessions`, `queryAnalytics` on every stream except `spans`): `status`, `name`, `traceId`, `sessionId`, `simulationId`, `userId`, `tags`, `models`, `providers`, `serviceNames`, `tools`, `definedTools`, `duration`, `ttft`, `cost`, `spanCount`, `errorCount`, `tokensInput`, `tokensOutput`, `cacheHitRate`, `startTime`, `endTime`, `score.*` (`passed`, `errored`, `value`, `source`, `signalId`, …), `metadata.<key>`. Multi-value fields (`tags`, `models`, `providers`, `tools`, …) take `in` / `notIn` with an array. One signal's occurrences: `stream: "scores"` filtered by `score.signalId`.
- **Spans** (`querySpans`, `queryAnalytics` on `spans`): `operation`, `toolName`, `model`, `provider`, `sessionId`, `traceId`, `tags`, `status` (`error` / `ok` / `unset`), `duration`, `cost`, `tokensInput`, `tokensOutput`. No `gtePercentile`.

The authoritative lists are the `filters` descriptions on `listTraces` and `querySpans` in the schema, and the [filters docs](https://docs.latitude.so/observability/filters.md).

## Privacy and payload discipline

- Aggregate first. Reach for row-level operations only for a "top N" table or a concrete example the user asked for.
- Do not embed raw conversation content (messages, tool payloads) unless the user explicitly wants examples in the artifact. Prefer ids and one-line summaries; link to Latitude instead: a trace opens at `https://console.latitude.so/projects/<slug>?tab=traces&traceId=<traceId>`, a session at `https://console.latitude.so/projects/<slug>?sessionId=<sessionId>` (self-hosted: swap the host).
- Cap every list call (`limit`) and keep the total embedded JSON small (tens of KB, not MB). An artifact is a report, not a data export.
- Never embed an API key, an OAuth token, or `.env` contents in the HTML or in a committed script.
