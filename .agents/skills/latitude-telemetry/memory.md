# Long-term memory instrumentation

> Part of the **latitude-telemetry** skill — the memory add-on referenced from `SKILL.md`. Read `SKILL.md` first; this guide reuses that same audit → plan → implement → verify workflow and adds only the memory-specific parts. Apply it when the app has long-term memory (the gate below).

Instrument an LLM agent's **long-term memory** so Latitude can show how it evolves: every store's current contents, each record's change history and diffs, the tokens read and written per session, and the exact session behind every write.

This is an **add-on to base tracing**, not a separate pipeline. Memory operations ride the same OpenTelemetry export as the rest of the app's spans — you emit one span per memory read or write, and Latitude derives the history, diffs, and token counts from those spans. You never compute or send a diff yourself.

These are the **standard OpenTelemetry GenAI memory-operation spans**, not a Latitude-proprietary format — Latitude only ingests and interprets them. So if the app already emits them, there is nothing to install; if it does not (the common case), you add them once (see the first decision below).

## Prerequisite: base tracing must already work

Memory spans are ordinary spans. They need the same `LATITUDE_API_KEY` / `LATITUDE_PROJECT_SLUG` and exporter as everything else, and they should nest inside the `capture()` boundary that already wraps the request/agent turn so they attach to the right trace and session.

- **If the app is not tracing to Latitude yet**, finish the main `SKILL.md` workflow for base tracing first (account, config, MCP discovery, the SDK-vs-OTLP decision, the plan-and-wait contract, and the verification read-back loop all live there). Then apply this guide.
- **This guide does not repeat that machinery.** It adds only the memory-specific parts: the gate, the store/record model, where and when to emit, the memory helpers, and how to verify on the Memory page. For secret handling, MCP-assisted config, the plan/approval contract, and the MCP → CLI → API read-back order, follow `SKILL.md`.

## Does this app have long-term memory?

This is the first decision and the most important one. Long-term memory is **state the agent persists and reloads across separate interactions** — it outlives a single request or session and is read back later, sometimes by a different session or a different user. If the app has none, there is nothing to instrument for memory; base tracing already captures everything.

**This IS long-term memory (instrument it):**

- Files the agent reads and writes to remember things — a `memory/` directory, a `notes.md`, per-user JSON blobs, an append-only log the agent consults later.
- Rows in a database the agent writes facts to and queries later — a `memories` / `facts` / `preferences` / `user_profile` table it populates as it learns and selects from before answering.
- A vector store or embeddings index the agent **adds to over time and semantically searches for recall** (Pinecone, Weaviate, pgvector, Chroma, Qdrant, …).
- A key-value / Redis store keyed by user or session holding durable state across sessions.
- A managed memory provider: Mem0, Zep, Supermemory, Letta / MemGPT, LangMem, and similar.
- Anything the agent treats as "remember this for next time" on one turn and "what do I already know about X?" on a later one.

**This is NOT long-term memory (do not instrument it as memory):**

- The **conversation / message history within a single request or session** — that is the trace itself, already captured by base tracing.
- Prompt context, system prompts, and few-shot examples baked into code or config.
- A cache that exists purely for performance (memoization, dedupe) with no recall semantics.
- A **read-only reference corpus** the agent only queries and never writes — a RAG over your product docs is *retrieval*, not memory (see the grey area below).
- Ordinary application data the agent happens to touch but does not use as recall (the user's orders, an app's domain tables).

**How to identify it in the codebase:**

- Look for a **persistence boundary the agent crosses on its own initiative** — functions or methods named like `remember` / `recall` / `store` / `retrieve` / `save` / `load` / `getMemory` / `search` / `upsert`, a `memory/` module or directory, a memory-shaped table, a vector-store client the agent both writes and queries, or a provider SDK import (`mem0`, `zep`, `supermemory`, `letta`, …).
- Trace two moments: where the agent **decides to write something down for later**, and where it **pulls prior knowledge back in** before or while answering.
- If nothing persists across interactions, there is no long-term memory. Say so and stop — base tracing already covers the app.

**Grey area — retrieval vs. memory:** read-only RAG over a fixed corpus is retrieval; do not force it into memory spans. The moment the agent *writes to* that store as it learns and *searches it* for recall, it is memory — instrument both sides. When unsure, ask the user whether the store accumulates what the agent learns, or is a fixed knowledge base.

## Store and record: the two identifiers that carry the whole model

Every memory operation names a **store** and (for reads and per-record writes) a **record**. Getting these two ids right is the entire job — they are how Latitude groups, versions, and attributes everything. Think of a store as a git repo and a record as a file in it.

### Store (`gen_ai.memory.store.id`) — the scope of the memory. Always required.

A store is one isolated pool of memory, defined by **whatever scopes the memory in the app**. The agent must identify that scope and use it as the store id. The rule is simple: **two operations share a store if and only if a write by one should be visible to the other.**

- **Per-user, independent memory** — each user has their own memory that others cannot see. Each user is a **different store**: use the user id (or a `user/<id>` prefix) as the store id. A write by user A must never change what user B reads.
- **Shared memory** — several users read and write the **same** memory, and one user's edit is visible to the others. That is **one store** with a single shared store id (the latest write wins across all of them).
- **Some other scope** — if memory is scoped to a team, project, tenant, or conversation rather than a user, use that scope's id.
- **No scope at all** — a single personal agent with one global memory still needs a store id. Pick a stable constant such as `"global"` or `"memory"`.

The store id is **required and has no useful default** — leave it unset and the operation lands in an `(unattributed)` bucket you cannot browse. Keep it **stable**: the same logical store must use the same id on every call, or its history fragments into many stores.

### Record (`gen_ai.memory.record.id`) — the piece of memory. Required for reads and per-record writes.

A record is one addressable unit of memory within a store — what a write creates or updates and what a read returns. Use the store's own natural key:

- **File-backed memory** — the file's path **relative to the memory root**, e.g. `preferences/tone.md`, **not** an absolute system path like `/home/app/data/memory/preferences/tone.md`.
- **Key-value memory** — the key.
- **Database rows** — the row's stable id or natural key.
- **Provider (Mem0/Zep/…)** — the provider's own record/memory id.

Keep record ids **stable** across writes so a record's history stitches together, and note Latitude splits them on `/` to nest records into folders on the Memory page — so a path-like id gives you a browsable tree for free. (The only operations without a record id are the whole-store ones: `create_memory_store` / `delete_memory_store`, and a deliberate whole-store wipe — see Operations.)

## Writes carry the whole record, not a delta

Each mutating span is a **full snapshot** of the record as it stands *after* the write. Latitude orders versions by span end time, keeps the latest as current, and **derives** the diff, token deltas, and history by comparing consecutive snapshots — you never compute or send a diff.

So every `create` / `update` / `upsert` must include the record's **complete new body**, even for a partial edit. **If the app updates only part of a record** — one JSON field, a single line appended to a file — the instrumentation must **read back or reconstruct the full updated record** and put that in the span. Sending only the changed fragment makes Latitude read everything you omitted as a deletion.

The payoff of getting store, record, and full bodies right: the Memory page (browsable store → records → current bodies), per-record change history and diffs, and the trace/session memory summary — without your memory provider needing to support any of it. **Reads** (`search_memory`) additionally attribute the tokens returned to the records they came from, so each store's per-session read/write footprint falls out automatically.

## First decision: are memory spans already emitted?

These operations are the **OpenTelemetry GenAI memory convention** — an open standard, not Latitude-specific — so first check whether the app already emits them:

- **Already emitting OTEL memory spans?** A memory library or prior instrumentation that sets `gen_ai.operation.name` to `search_memory` / `create_memory` / … on its spans means there is **nothing to install** — those spans already reach Latitude through base tracing. Just verify they land and are attributed to the right store. This is uncommon: the convention is recommended but not required, is young, and has no auto-instrumentation, so most OTEL-emitting apps have **not** added memory spans.
- **Not emitting them yet?** (the common case) Add them by whichever path fits the stack:
  - **App already uses the Latitude SDK** (`@latitude-data/telemetry` / `latitude-telemetry`) → use the memory helper (`createMemoryTelemetry` / `create_memory_telemetry`). Least code, gets the attributes right, wraps timing and errors, and — because it emits through your `Latitude` instance's own exporter — puts memory spans on the exact same pipeline as your base traces, with no extra wiring. Prefer it whenever a `Latitude` instance exists.
  - **App traces to Latitude another way** — a generic OTLP exporter, a hand-rolled OTel setup, or a non-TS/Python runtime → emit **raw `gen_ai.memory.*` spans**, no new dependency. Here the wiring is on you: create the span on the tracer that already carries the request's other spans (see No SDK / raw OTLP).

There is no duplicate-span risk to manage here — since almost nothing emits memory spans today, you are adding instrumentation, not redirecting it.

## Workflow

Reuse the main `SKILL.md` discipline: clarify material gaps one at a time, **present a plan and wait for explicit approval** before editing code, never inline secrets, and verify against real runs rather than declaring done at compile time. The memory-specific steps:

1. **Audit the memory layer.** Find the store and its call sites for read, write, and delete. Record: what the store is (files / db / vector / kv / provider), how a logical store maps to a `store.id` (especially for per-user memory), what a record is and its stable id, and the content-capture decision — default it **on** (see attribution rules), off only for memory you cannot send to Latitude.
2. **Map operations.** Map each call site to one of the seven operations (table below).
3. **Plan, then wait.** Extend the `SKILL.md` plan template with: the store type and `store.id` scheme, the content-capture decision (recommend on; note any PII reason to keep it off), the specific call sites to instrument, and how you will verify on the Memory page. Wait for explicit approval.
4. **Implement after approval.** Add one span per operation at the store boundary, inside the existing `capture()`. On writes, pass the record's **full new body**, not a delta.
5. **Verify on the Memory page** (see Verify).

## Where and when to emit

**Principle:** instrument the **boundary between the agent and its persistent store** — the functions that read from and write to it, not the agent's reasoning. Put each span where you have both the identifiers (store, record) and the data (the query and results for a read; the full new body for a write), **inside the enclosing `capture()`** so it shares the request's trace, and on the **same tracer that carries the request's other spans** so it exports the same way (the SDK helper does this for you; for raw spans see No SDK / raw OTLP).

- **Find where the routes converge.** A store is often reachable by more than one path — an implicit "load memory into the prompt" read and an explicit recall, a tool call and an HTTP/settings route, a per-user store and a default/fallback one. Instrument the single point they all funnel through (usually the storage method itself); if there isn't one, instrument each route. Then confirm the point you chose is the one the **real** flow hits — trace it once end to end, don't infer it from reading the code.
- **Reads — prefer the search / query layer over per-item reads.** A single `search_memory` span that carries the query text and all returned records lets Latitude attribute retrieved tokens per record — richer than N bare point reads. If the code only does lookups by id, a read span per lookup is fine.
- **Writes — instrument where the store is actually mutated** (or its immediate caller), and pass the record's full new content. Use `upsert` when the code does create-or-replace without distinguishing; use `create` / `update` when it knows which.

| Store | Read → instrument at | Write → instrument at | Operations |
| --- | --- | --- | --- |
| **Files** | the search/glob over the memory dir (query + all matches) — else the file read | the file write | `search_memory` / `create`·`update`·`upsert` |
| **Database** | the `SELECT` that fetches memory (or its caller) | the `INSERT` / `UPDATE` / upsert | `search_memory` / `create`·`update`·`upsert` |
| **Vector store** | the similarity query (query text + returned docs) | the upsert of the source records | `search_memory` / `upsert_memory` |
| **Key-value / Redis** | the `GET` | the `SET` | `search_memory` (read) / `upsert_memory` |
| **Provider (Mem0/Zep/…)** | the client's `search` / `recall` | the client's `add` / `update` / `delete` | all seven |

**Deletes and resets:** `delete_memory` with a record id removes one record; `delete_memory` **without** a record id — or `delete_memory_store` — wipes the whole store (use it for a "clear my memory" / reset). Provisioning a fresh namespace maps to `create_memory_store`.

**Do not instrument** in-request working memory, message history, or a read-only reference corpus (see the gate).

## Operations

Span name equals `gen_ai.operation.name`; both are one of:

| Operation | Meaning |
| --- | --- |
| `search_memory` | Query / retrieve records (a read) |
| `create_memory` | Create new records |
| `update_memory` | Modify existing records |
| `upsert_memory` | Create or update without choosing which |
| `delete_memory` | Delete records; **without a record id, wipes the whole store** |
| `create_memory_store` | Create or initialize a store |
| `delete_memory_store` | Delete a store and everything in it |

## TypeScript

Install the latest `@latitude-data/telemetry` (the same package base tracing uses). `createMemoryTelemetry` takes the `latitude` instance you already initialized.

```ts
import { createMemoryTelemetry } from "@latitude-data/telemetry";

// `latitude` is the instance from your base tracing setup.
// storeId groups everything; set it per user for per-user memory.
// captureContent is off by default — turn it on (strongly recommended) so diffs and token deltas work.
const memory = createMemoryTelemetry({ latitude, storeId: `user/${userId}`, captureContent: true });
```

Each operation has **two forms**. Call them inside the `capture()` that already wraps the turn.

**Wrap form** — pass `execute`; the helper starts the span, runs your call inside it, records latency/errors/status, and returns the result:

```ts
// Read: one span carries the query and every record it returned.
const hits = await memory.search({
  query,
  execute: () => store.search(query),
  recordsFromResult: (rows) =>
    rows.map((r) => ({ id: r.id, content: r.text, score: r.score })),
});

// Write: pass the record's FULL new body (a snapshot, not a diff).
await memory.upsert({
  recordId: "preferences/tone",
  records: [{ id: "preferences/tone", content: "Prefers concise answers with code." }],
  execute: () => store.upsert("preferences/tone", value),
});
```

**Emit form** — omit `execute` when the read/write already happened elsewhere; the helper records a completed span from the metadata:

```ts
await memory.update({
  recordId: "preferences/tone",
  records: [{ id: "preferences/tone", content: "Prefers concise answers with code." }],
});

await memory.delete({ recordId: "preferences/tone" }); // omit recordId to wipe the whole store
```

**Capture content — strongly recommended.** Record bodies (`records`) and the search `query` are only sent when `captureContent` is enabled (shown above; set it factory-wide or per call). It is **off by default** because both are OTEL Opt-In / PII — but leaving it off strips memory observability of most of its value: you get classification and `record.count` and the fact that *something* changed, but **no diffs, no token deltas, and nothing to browse**. Turn it on unless the memory genuinely holds data you cannot send to Latitude; when only some fields are sensitive, keep it on and scrub them with the `redact` hook rather than disabling capture entirely.

## Python

Requires the same `latitude-telemetry` package as base tracing. `create_memory_telemetry` takes the `latitude` instance you already have.

```python
from latitude_telemetry import create_memory_telemetry

# capture_content is off by default — turn it on (strongly recommended) so diffs and token deltas work.
memory = create_memory_telemetry(latitude, store_id=f"user/{user_id}", capture_content=True)

# Read — execute may be sync or async.
hits = memory.search(
    query=query,
    execute=lambda: store.search(query),
    records_from_result=lambda rows: [
        {"id": r["id"], "content": r["text"], "score": r["score"]} for r in rows
    ],
)

# Write — full new body.
memory.upsert(
    record_id="preferences/tone",
    records=[{"id": "preferences/tone", "content": "Prefers concise answers with code."}],
    execute=lambda: store.upsert("preferences/tone", value),
)

# Emit form (no execute) when the write already happened; omit record_id to wipe the store.
memory.delete(record_id="preferences/tone")
```

Options are snake_case (`store_id`, `record_id`, `records`, `count`, `capture_content`, `records_from_result`). As in TypeScript, `capture_content` is off by default but **recommended on** — enable it (with the `redact` hook for sensitive fields) so diffs and token deltas work.

## No SDK / raw OTLP

If the app traces to Latitude without the Latitude SDK, emit the spans directly on its existing tracer — no new dependency. Set `gen_ai.operation.name` (and the span name) to the operation, and the `gen_ai.memory.*` attributes:

> **Emit on the tracer provider that exports the request's other spans.** The examples below use the global `trace.getTracer()`, which is correct only when the app has a **single** tracer provider. Apps that create several (common in multi-tenant or per-request setups) register just one as the global — whichever initialized first — and it may not be the one exporting *this* request's spans, so memory spans on the global can be silently dropped while the surrounding spans land. When more than one provider can exist, get the tracer from the provider that owns the request (thread it through, or if a `Latitude` instance exists use `latitude.getTracer(...)`), not blindly from the global.

| Attribute | Purpose |
| --- | --- |
| `gen_ai.operation.name` | The operation (required) |
| `gen_ai.memory.store.id` | The store; everything groups under it. Absent ⇒ the `(unattributed)` store |
| `gen_ai.memory.record.id` | The record touched (splits on `/` for folders) |
| `gen_ai.memory.record.count` | How many records were affected or returned |
| `gen_ai.memory.query.text` | The search query, on `search_memory` (opt-in / PII) |
| `gen_ai.memory.records` | JSON array of `{ content, id?, score?, metadata? }` — powers content browsing, diffs, and token counts (opt-in / PII) |

```ts
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("memory");
await tracer.startActiveSpan("update_memory", async (span) => {
  span.setAttributes({
    "gen_ai.operation.name": "update_memory",
    "gen_ai.memory.store.id": `user/${userId}`,
    "gen_ai.memory.record.id": "preferences/tone",
    "gen_ai.memory.records": JSON.stringify([
      { id: "preferences/tone", content: "Prefers concise answers with code." },
    ]),
  });
  await store.update(...);
  span.end();
});
```

```python
import json
from opentelemetry import trace

tracer = trace.get_tracer("memory")
with tracer.start_as_current_span("search_memory") as span:
    span.set_attribute("gen_ai.operation.name", "search_memory")
    span.set_attribute("gen_ai.memory.store.id", f"user/{user_id}")
    span.set_attribute("gen_ai.memory.query.text", query)
    hits = store.search(query)
    span.set_attribute("gen_ai.memory.record.count", len(hits))
    span.set_attribute(
        "gen_ai.memory.records",
        json.dumps([{"id": h["id"], "content": h["text"], "score": h["score"]} for h in hits]),
    )
```

Other runtimes (Go, Java, Ruby, .NET, …) set the identical attributes on whatever span they already export to `https://ingest.latitude.so/v1/traces` (see `SKILL.md` → Other targets → Generic OTLP). Only `gen_ai.operation.name` is required; add the rest to unlock more of the Memory page.

## Getting attribution right

Beyond the store, record, and full-body rules above, two more decide whether the data is useful:

- **Capture content — strongly recommended.** `captureContent` / `capture_content` gates both record bodies and the search query and is **off by default** because both are OTEL Opt-In / PII. Turn it on: without content, memory observability loses most of its point — you get classification and counts, but no diffs, no token deltas, and nothing to browse. Leave it off only when the memory holds data you cannot send to Latitude; when only some fields are sensitive, keep capture on and scrub them with the `redact` hook. Flag it for the user when enabling, as with any content capture.
- **Put an `id` on each record returned by `search_memory`** so reads attribute to the record they came from; id-less hits bucket together.

## Verify

Not done at compile time — only when memory operations show up correctly in Latitude.

- **Emit real operations — drive the running app, not a unit test of the emit helper.** A unit test proves the span is *shaped* right; it does not prove the span is *wired* into the path and provider production actually uses, which is where most failures are. Run the actual flow through its real store-resolution and tracing: at least one turn that **recalls** memory and one that **writes** it, so both a `search_memory` and a mutating span are produced. For short-lived scripts/jobs, `await latitude.flush()` / `latitude.shutdown()` (Python: `latitude.flush()`) before exit so spans flush.
- **Read it back**, using MCP → CLI → API in the order `SKILL.md` defines, and the product surfaces:
  - On the **Spans tab**, the operations classify (`search_memory`, `create_memory`, …) and carry the store/record attributes.
  - On the **Memory page**, the store appears under the expected id, its records show the expected current bodies, and a second write to a record produces a new version and a diff.
  - On the **trace/session detail**, the Memory summary shows tokens read / added / removed.
  - If content capture is off, verify classification and `record.count` instead of bodies.
  - Timing: the **Spans tab** reflects new spans within seconds, but the **Memory page** and the **session summary** are built when the trace finishes — poll for a short while before concluding they are empty.
- **Loop until correct.** If the memory spans are wrong once they arrive, it is usually shape: `store.id` empty (everything in `(unattributed)`); `record.id` unstable or missing (history won't stitch, reads don't attribute); content expected but `captureContent` left off; or a write sending a partial body instead of the full snapshot.
- **If base/request spans land but memory spans never appear at all, suspect wiring, not shape** — the highest-signal symptom, and almost always one of: the instrumented code path isn't the one the real flow takes (see Where and when to emit), the span was created on a different tracer/provider than the request's (see No SDK / raw OTLP), or it was emitted outside the `capture()` so it never joined the trace.

## Reference

- **`SKILL.md`** (this skill's main file) — base tracing setup, the plan-and-wait contract, and the verification read-back loop this guide builds on.
- Latitude docs: `https://docs.latitude.so` (`telemetry/*`, `observability/memory`); `llms.txt` for an index.
- SDK source: `github.com/latitude-dev/latitude-llm/packages/telemetry/*`.

Treat the operation and attribute lists here as a **snapshot** — the memory convention is young and still evolving. When something is unclear or missing, check the docs; they are the source of truth.
