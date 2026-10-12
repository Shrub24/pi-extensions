---
name: latitude-telemetry
description: Add or review Latitude Telemetry for LLM apps and agent harnesses. Use for Latitude tracing, LLM observability, missing traces, OpenTelemetry/OTLP integration in TypeScript, Python, and other runtimes, any documented provider or framework (OpenAI, Anthropic, Bedrock, Vertex, LangChain, LlamaIndex, Vercel AI SDK, Pydantic AI, Mastra, and more), and harness plugins for Claude Code, Hermes, OpenClaw, Pi, and Prime Intellect. Covers instrumenting a new project under an existing Latitude account (invoked directly) as well as the latitude-setup hand-off, discovering config via the Latitude MCP, and verifying that real traces land via the Latitude MCP, CLI, or API.
---

# Latitude Telemetry

Add or review Latitude Telemetry without disrupting existing observability. Latitude is OpenTelemetry-based, so compose with the app's current OTel/Sentry/Datadog setup instead of replacing it.

## Entry points

Two ways in; both do the same audit → instrument → verify work:

- **Invoked directly** — the common case. The user **already has a Latitude account and API key** and wants to instrument an app: their first project under that account, or an additional one. They may already know the project slug, or you infer it from the repo or discover it via the Latitude MCP/CLI. Source config as described below; do **not** run the zero-account bootstrap.
- **Delegated from `latitude-setup`** — the from-scratch, no-account path. That skill has already provisioned a temporary account and written `LATITUDE_API_KEY`/`LATITUDE_PROJECT_SLUG` to `.env`, so config is in place — skip the MCP discovery detour and go straight to audit → instrument.

Either way, the work isn't done until you have **verified that real traces land in Latitude** (workflow step 6).

## First decision: redirect existing OTLP, or add the SDK?

Before installing anything, determine how the app already emits telemetry — the simplest correct integration is often **no new dependency**:

- **The app already exports OpenTelemetry traces** — a generic OTLP exporter, or a GenAI instrumentation like Vercel AI SDK telemetry (`experimental_telemetry`), OpenInference, Traceloop/OpenLLMetry, or hand-rolled OTel spans? **Prefer repointing that exporter at Latitude** rather than installing the SDK. It's a config-only change — set the OTLP traces endpoint to `https://ingest.latitude.so/v1/traces` and add the auth + project headers (see "Other targets → Generic OTLP" below). It preserves the app's existing span conventions and adds **zero** new instrumentation. Installing the Latitude SDK on top would re-instrument the same model calls and can **duplicate or clobber** those spans — so don't, unless the redirect can't carry something you need.
- **The app has no LLM telemetry yet** (or only vendor SDKs with no OTLP export)? Use the Latitude SDK (TypeScript / Python sections below), or attach a `LatitudeSpanProcessor` to an existing OTel provider.

For an app that already produces spans, the OTLP-redirect path is the lower-risk default. Confirm which case applies during the audit and state the chosen approach in the plan.

## Workflow

1. **Audit first**
   - Identify languages, package managers, entry points, runtimes, deployment config, and env conventions.
   - Check the package registry for the latest Latitude SDK for the target language; use the current alpha if it is the latest release, and do not copy versions from examples.
   - Check for `LATITUDE_API_KEY` and either `LATITUDE_PROJECT_SLUG` or per-capture project routing. Look in env files, secret-manager references, deployment config, CI, and the harness's own config for harness targets. **If the key is missing, do not ask the user for it.** A missing key means one of two things, and only the user knows which: they have an account and can hand you the key, or they have no account and `latitude-setup` should create a temporary one right now (no signup, claim later). Ask that as one question with the temporary account as the default (see "No account yet?" below), then continue. A project slug, an enabled plugin or a dependency without a key next to it is a placeholder or a leftover, not evidence of an account.
   - Find existing telemetry: `@opentelemetry/*`, `opentelemetry-*`, `dd-trace`, `@sentry/*`, `sentry-sdk`, `newrelic`, Honeycomb, Jaeger/Tempo/OTLP exporters, LangSmith/Langfuse/Helicone/Phoenix/Traceloop, custom span processors, and `OTEL_*` env vars. **If the app already exports OTLP, prefer redirecting it over installing the SDK** (see "First decision" above). Otherwise existing SDKs usually initialize first; Latitude initializes second or attaches a `LatitudeSpanProcessor` to the existing provider.
   - Find LLM call sites: OpenAI chat/responses, Anthropic messages, Bedrock, Cohere, Together, Vertex/Google AI, Azure OpenAI, Vercel AI SDK `generateText`/`streamText`, LangChain, LlamaIndex, OpenAI Agents, LiteLLM, CrewAI, etc. Trace from route/job/CLI/agent entry points to the actual model calls. Note streaming paths; consume streams inside the capture boundary.
   - Note whether the app keeps **long-term memory** — state it persists and reloads across separate interactions (files, a database, a vector store, a key-value store, or a provider like Mem0/Zep/Supermemory), as distinct from within-request conversation history. If it does, memory observability is a strongly recommended add-on — see "Long-term memory?" below.
   - If the request is not clearly covered here, consult the Latitude docs (`https://docs.latitude.so/llms.txt`, especially `telemetry/*`) and/or the telemetry package implementation in `github.com/latitude-dev/latitude-llm/packages/telemetry/*`.

2. **Group use cases**
   - Group related prompts, tools, retrieval, and model calls by final goal, not by file.
   - For each group, record: entry point, LLM calls, available user/session IDs, useful tags/metadata, streaming behavior, and project routing.
   - Prefer one `capture()` around the request, job, or agent turn. Add nested captures only for meaningful sub-boundaries.

3. **Clarify gaps before planning**
   - Ask only material questions the codebase cannot answer: where traces should appear in Latitude, who owns missing secrets/config, whether existing observability must stay unchanged, ambiguous use-case boundaries, or approval for broad refactors.
   - Assume no Latitude SDK or OpenTelemetry knowledge. Do not ask the user to choose between SDKs, processors, exporters, env-var schemes, instrumentation keys, or OTLP wiring unless they have shown that expertise.
   - When a technical choice is needed, infer the best option from the codebase, explain the user-visible outcome and tradeoff in plain language, and ask for confirmation. Keep implementation details for the plan.
   - Ask one question at a time, in priority order, and stop until answered. Never combine an unresolved material question with a request for approval.
   - State low-risk assumptions in the plan instead of asking.

4. **Plan, then wait**
   After material clarifications are resolved, including the preliminary Latitude MCP install/connect question when MCP is unavailable, present a concise plan and wait for explicit approval before installing packages, editing files, or changing configuration. Explain each change in plain language. Approval must be unambiguous (`yes`, `approved`, `go ahead`). If the user requests changes or answers a missed clarification, revise the plan and ask again. Do not include unresolved clarification questions or optional MCP setup offers inside the plan; ask and resolve them before this step.

   ```text
   Plan
   - What Latitude will add: capture LLM requests/responses, token/model details, errors, latency, and user/session context where available.
   - Decisions/assumptions: ... (resolved clarifications, defaults chosen, and why they are safe)
   - Existing telemetry: ... (what is already present and whether it will be preserved)
   - LLM integrations found: ... (which model calls will be traced)
   - Capture boundaries: ... (which request/job/agent turn becomes one trace, and why)
   - Integration approach: ... (SDK bootstrap / existing OTel processor / generic OTLP, explained in plain language)
   - Env/config needed: ... (which values are needed, what they do, where to find them, and where placeholders/docs will be added)
   - Files to change: ... (what each file change accomplishes)
   - Verification: ... (which real flow will be run to emit traces, and how they'll be confirmed in Latitude — MCP, CLI, or API)

   Reply `go ahead` to approve this plan.
   ```

5. **Implement only after approval**
   - Do not act on implied approval or silence; ask when intent is unclear.
   - Follow existing patterns for config validation, module layout, logging, tests, and package management. Let the lockfile capture the resolved SDK version.
   - Keep changes targeted to telemetry: packages, Latitude initialization, capture boundaries, provider telemetry, and env examples/docs. Get separate explicit permission for broad refactors such as changing module type, switching build systems, reorganizing app structure, replacing telemetry vendors, changing framework/runtime config, or rewriting LLM abstractions.
   - Never inline real secrets. Use env vars or the project's secret manager. If Latitude MCP tools are available, use them to confirm/create project or key metadata; otherwise ask where missing secrets should be managed.
   - Initialize Latitude once at startup/module scope, before the first LLM call when possible. Avoid per-request SDK instances.
   - Preserve current observability; do not remove span processors/exporters unless the user explicitly approves.
   - When a config or env value you need may already be set (OTLP endpoint/headers, `LATITUDE_*`, etc.), **update the existing entry in place** — don't append a duplicate that leaves a stale value shadowing yours.
   - Run formatter/typecheck/lint/tests, then verify that real traces actually land in Latitude (step 6). The change is not done until they do.

6. **Verify the instrumentation works**
   Instrumentation is not finished when the code compiles — only when real spans are confirmed in the Latitude project. Do your best to close this loop automatically rather than asking the user to check the UI. If credentials and a safe path exist:
   - **Emit real traces.** Run the user's *actual* LLM flow — one representative run per use-case group — so genuine spans are produced, not a synthetic test span. Let the process finish or shut down gracefully so buffered spans flush; for short-lived scripts/jobs, `await latitude.flush()`/`latitude.shutdown()` (Python: `latitude.flush()`) before exit. A hard kill can drop spans.
   - **Read the traces back with the best tool available**, in this order:
     1. **Latitude MCP**, if connected and authenticated — use its trace/search tools to fetch the project's recent traces.
     2. **Latitude CLI**, if installed and authenticated — `latitude traces list --project-slug <slug> --format json` (see `latitude-cli`).
     3. **Latitude API directly**, as a fallback — `GET` the traces endpoint under `https://api.latitude.so` with `Authorization: Bearer <LATITUDE_API_KEY>`. Discover the exact path/params from the docs or by inspecting the CLI's underlying request (`latitude traces list --schema`, or `--debug` / `--format http`).
   - Spans export on a batch interval, so they may take a moment to arrive — **poll** rather than expecting them instantly.
   - **Confirm quality, not just presence:** the expected span per use-case group, correct model and token counts, captured messages, sensible span boundaries, and `userId`/`sessionId`/tags/metadata where set. If spans are missing or wrong, fix and re-run — **loop until the traces are correct.** Common causes of missing/incorrect traces: wrong env values or project routing, initialization after the first LLM call, unregistered instrumentation, smart filtering, streams consumed outside `capture()`, or the process exiting before flush.
   - **Do not destructively "clean up" a real project.** These verification runs leave real traces in the user's project — that is expected. The delete-and-recreate cleanup of noisy iteration traces belongs **only** to the zero-account flow in `latitude-setup` (a throwaway project); never delete/recreate a project the user already owns. Keep verification runs minimal instead.

## No account yet? Zero-account CLI bootstrap

If no working `LATITUDE_API_KEY` exists anywhere, ask exactly one question and act on the answer; never end a turn by asking for the key:

```text
Do you already have a Latitude account?
  (a) No, create a temporary one for me now, no signup, I'll claim it later   (default)
  (b) Yes, I'll give you its API key and project slug
```

On (a), no answer, or "just do it", hand off to the **`latitude-setup`** skill before instrumenting. It uses the `latitude` CLI to bootstrap a temporary account with no signup — returning an API key, one project slug, and a browser link to claim ownership — writes `LATITUDE_API_KEY` and `LATITUDE_PROJECT_SLUG` into `.env` (or the harness's config), then returns here to instrument against that `projectSlug`, and it finishes with a first Artifact. On (b), wait for the values and continue with the direct path.

The bootstrap `projectSlug` is **stable** across `latitude-setup`'s delete-and-recreate trace-cleanup step (same project name → same slug), so write `LATITUDE_PROJECT_SLUG` **once**; it never needs re-editing for cleanup.

This is a third way to source configuration values, alongside "already present in the app" and "discovered via the Latitude MCP" (below). Prefer whichever already applies, in order: existing values → Latitude MCP discovery (the user already has an account) → CLI bootstrap via `latitude-setup` (no account yet).

## Latitude MCP-assisted configuration

Use this section when adding Latitude telemetry and configuration values are missing or ambiguous. The Latitude MCP is a remote OAuth-authenticated MCP server at `https://api.latitude.so/v1/mcp` that can expose Latitude workspace data and actions to the agent. It is not required for telemetry, but when it is connected it should be used to reduce user back-and-forth.

- **Check MCP availability first.** Before asking the user for Latitude project/API-key details, inspect the connected MCP tools/servers available in the current agent harness. If a Latitude MCP server is available and authenticated, use it to discover organization/project metadata and to help prepare telemetry configuration.
- **Offer MCP installation as a preliminary clarification, before the plan.** If the Latitude MCP is not connected, stop before presenting the implementation plan and ask whether the user wants to install/connect it so the agent can automatically discover projects and help fill configurable telemetry variables. Briefly explain that the Latitude MCP gives the agent OAuth-scoped access to their Latitude workspace, including projects, keys, traces, annotations, scores, searches, issues, datasets, and other Latitude resources; connected agents can be revoked under **Settings → Keys → OAuth Keys**. Do not install or configure the MCP without explicit approval. Do not bundle this MCP question into the implementation plan or approval request. If the user declines, continue with the normal manual configuration flow and then present the implementation plan.
- **Use MCP to fill non-secret config.** Prefer MCP-provided project data to identify the correct `LATITUDE_PROJECT_SLUG` when the user has already indicated, or the repo clearly implies, which Latitude project should receive traces. If multiple plausible projects exist, present the options and ask the user to choose one.
- **Use MCP for secret creation/metadata only when safe.** If the Latitude MCP exposes API-key management, use it only after user approval and only to create or identify the needed key metadata. Do not print real API key values in chat. Put secrets directly into the project's existing secret manager only when the harness/tooling supports doing so safely; otherwise add placeholders to env examples/docs and tell the user where to store the real value.
- **Do not ask for values the MCP can answer.** If the MCP can list projects, infer slugs, or confirm existing key names, do that before asking the user. Ask only for decisions MCP cannot know, such as which project should receive traces when ambiguous, whether to create a new API key, or where secrets should be stored.
- **Keep MCP separate from app telemetry.** MCP helps configure Latitude; it does not trace the target app's LLM calls. The app still needs the telemetry SDK or OTLP exporter configured with `LATITUDE_API_KEY` and `LATITUDE_PROJECT_SLUG` or equivalent OTLP headers.

## Configuration values

When asking the user to provide config, explain what each value is and where to find it:

- `LATITUDE_API_KEY`: authenticates uploads to Latitude. An existing account finds or creates it under **Settings → API Keys**; `latitude-setup` creates one for a new temporary account. Explain this only when the user chose to provide their own key; do not ask for it otherwise.
- `LATITUDE_PROJECT_SLUG`: chooses which Latitude project receives traces. In the Latitude app, open the project; the slug appears in the sidebar title section. It is the short project identifier, not the display name.
- Generic OTLP setups encode the same values as an OTLP **traces endpoint** of `https://ingest.latitude.so/v1/traces` plus **headers** `Authorization=Bearer <api-key>` and `X-Latitude-Project=<project-slug>`. Set them through whatever mechanism the app already uses — the variable names vary by app/framework (OTel's convention is `OTEL_EXPORTER_OTLP_[TRACES_]ENDPOINT` / `…_HEADERS`, but apps may use different names or configure the exporter in code), so match the app rather than assuming a fixed name.
- **Quote any `.env` value that contains spaces.** The Latitude CLI reads `LATITUDE_API_KEY` from `.env` with a strict parser that **stops at the first unquoted spaced value** — so an unquoted header/token value (e.g. one containing `Bearer `) prevents the CLI from ever reading the key. Wrap such values in double quotes; the quotes are stripped by Node's `--env-file` and other loaders, so one quoted `.env` works everywhere. Details in `latitude-cli` → Authentication.

Never ask for real secret values in chat if the project has an existing secret manager. Ask where the user wants them stored, and add placeholders only to env examples/docs.

## Which integration applies?

Match the app's stack to one row before writing code. The Latitude docs page for the row is the source of truth for the exact snippet (`https://docs.latitude.so/telemetry/<path>.md` returns the readable version); the mechanism column tells you which section of this skill to follow. **The set grows over time, so treat this table as a snapshot and check `https://docs.latitude.so/llms.txt` for pages it does not list.**

| Target | TypeScript | Python | Docs page |
| --- | --- | --- | --- |
| OpenAI, Azure OpenAI | `createOpenAIInstrumentation(OpenAI)` (Azure reuses it) | `{"openai": openai}` | `providers/openai`, `providers/azure` |
| OpenAI Agents SDK | `createOpenAIAgentsInstrumentation(OpenAIAgentsSDK)` | `{"openai-agents": agents}` (the only hyphenated Python key) | `frameworks/openai-agents` |
| Anthropic | `createAnthropicInstrumentation(AnthropicSDK)` | `{"anthropic": anthropic}` | `providers/anthropic` |
| Amazon Bedrock | `createBedrockInstrumentation(BedrockSDK)` | `{"bedrock": boto3}` | `providers/amazon-bedrock` |
| Amazon SageMaker | OTLP exporter | `{"sagemaker": boto3}` | `providers/sagemaker` |
| Cohere | `createCohereInstrumentation(CohereSDK)` | `{"cohere": cohere}` | `providers/cohere` |
| Together AI | `createTogetherAIInstrumentation(TogetherSDK)` | `{"togetherai": together}` | `providers/together-ai` |
| Vertex AI | `createVertexAIInstrumentation(VertexAISDK)` | `{"vertexai": vertexai}` | `providers/vertex-ai` |
| Google AI Platform | `createAIPlatformInstrumentation(AIPlatformSDK)` | `{"aiplatform": aiplatform}` | `providers/google-ai-platform` |
| Google Gemini (`google-genai`) | OTLP exporter | `{"google_generativeai": genai}` | `providers/gemini` |
| Groq, Mistral, Ollama, Replicate, watsonx, Aleph Alpha, Transformers | OTLP exporter | `{"groq": groq}`, `{"mistralai": mistralai}`, `{"ollama": ollama}`, `{"replicate": replicate}`, `{"watsonx": ibm_watsonx_ai}`, `{"aleph_alpha": aleph_alpha_client}`, `{"transformers": transformers}` | `providers/<name>` |
| LangChain | `createLangChainInstrumentation(CallbackManagerModule)` with `@langchain/core/callbacks/manager` | `{"langchain": langchain_core}` | `frameworks/langchain` |
| LlamaIndex | `createLlamaIndexInstrumentation(LlamaIndex)` | `{"llamaindex": llama_index}` | `frameworks/llamaindex` |
| Google ADK, CrewAI, Haystack, LiteLLM | not available | `{"google_adk": google.adk}`, `{"crewai": crewai}`, `{"haystack": haystack}`, `{"litellm": litellm}` | `frameworks/<name>` |
| DSPy | not available | instrument LiteLLM: `{"litellm": litellm}` (no `dspy` key) | `frameworks/dspy` |
| Pydantic AI | not available | `Latitude(...)` with no instrumentations, then `Agent.instrument_all()` | `frameworks/pydantic-ai` |
| Strands Agents | not available | env-var OTLP: base URL `https://ingest.latitude.so` (no `/v1/traces`), headers, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf`, `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` | `frameworks/strands` |
| Vercel AI SDK v6 | `Latitude` without instrumentations + per-call `experimental_telemetry: { isEnabled: true, tracer: latitude.getTracer("vercelai") }` | not available | `frameworks/vercel-ai-sdk` |
| Vercel AI SDK v7 | `Latitude` without instrumentations + `registerTelemetry(new OpenTelemetry())` from `@ai-sdk/otel` (opt-out, no per-call flag); pass the system prompt via top-level `instructions`, not a `system` message | not available | `frameworks/vercel-ai-sdk-v7` |
| Cloudflare Think | `experimental_telemetry` from `beforeTurn()` with `latitude.getTracer("cloudflare-think", context)`; helpers in `@latitude-data/telemetry/cloudflare`; never `capture.start()` on Workers, never `new Latitude()` inside `beforeTurn()` | not available | `frameworks/cloudflare-think` |
| Cloudflare AI Gateway | OTLP configured in the gateway dashboard (endpoint + `Authorization` + `x-latitude-project` headers), no SDK | same | `frameworks/cloudflare-ai-gateway` |
| Mastra | `@mastra/otel-exporter` pointed at `https://ingest.latitude.so/v1/traces` with the two headers, no Latitude SDK | not available | `frameworks/mastra` |
| Eve | `@vercel/otel` `registerOTel` + `OTLPTraceExporter` to the ingest URL with the two headers, no Latitude SDK | not available | `frameworks/eve` |
| Flue | `Latitude` without instrumentations + `observe(createOpenTelemetryObserver())` from `@flue/opentelemetry`; content is opt-in via `exportContent()` | not available | `frameworks/flue` |
| LiveKit Agents | `LatitudeSpanProcessor` attached to LiveKit's own tracer provider (not the `Latitude` class); `disableSmartFilter: true` to keep STT/TTS/VAD spans | same with `LatitudeSpanProcessorOptions(disable_smart_filter=True)` | `frameworks/livekit` |
| ElevenLabs Agents | instrument your own OpenAI-compatible LLM proxy with the OpenAI instrumentation; STT/TTS are not observable | same | `frameworks/elevenlabs` |
| Anything else that speaks OTLP (Go, Java, Ruby, .NET, hand-rolled spans) | OTLP exporter | OTLP exporter | `otel-exporter` |

"OTLP exporter" means the app's own OpenTelemetry exporter pointed at `https://ingest.latitude.so/v1/traces` with `Authorization: Bearer <key>` and `X-Latitude-Project: <slug>` (see "Other targets"). Where a row says "not available" for a language, that language uses the OTLP exporter.

## TypeScript

Install the latest `@latitude-data/telemetry` with the project's package manager. Initialize existing Sentry/Datadog/New Relic/Honeycomb/custom OTel first, then Latitude.

**`instrumentations` is an array of instances created by per-integration factories, each imported from its own subpath.** The older object-map form (`instrumentations: { openai: OpenAI }`) was removed in v4 and makes `latitude.ready` reject with a migration error; do not write it, and migrate it if you find it in the app.

```ts
import OpenAI from "openai";
import { Latitude } from "@latitude-data/telemetry";
import { createOpenAIInstrumentation } from "@latitude-data/telemetry/instrumentations/openai";

const latitude = new Latitude({
  apiKey: process.env.LATITUDE_API_KEY!,
  project: process.env.LATITUDE_PROJECT_SLUG!,
  instrumentations: [createOpenAIInstrumentation(OpenAI)],
});

await latitude.ready; // await before creating the LLM client when first-call coverage matters
```

Use the project's real env validation; the snippet only shows the SDK shape.

Available factories, one subpath each under `@latitude-data/telemetry/instrumentations/`: `openai`, `openai-agents`, `anthropic`, `bedrock`, `cohere`, `langchain`, `llamaindex`, `togetherai`, `vertexai`, `aiplatform` (factory names are `create<Name>Instrumentation`; see the table above). Pass the same SDK module object the app imports: for namespace packages use `import * as AnthropicSDK from "@anthropic-ai/sdk"`, and for LangChain pass the `@langchain/core/callbacks/manager` module, not the `langchain` package. Providers with no TypeScript factory (Gemini, Groq, Mistral, Ollama, Replicate, SageMaker, watsonx, Aleph Alpha, Transformers) go through the OTLP exporter in TypeScript.

Special cases (details per row in the table): Vercel AI SDK, Cloudflare Think, Flue and LiveKit initialize Latitude **without** `instrumentations` and wire telemetry through the framework's own hook; Mastra, Eve and Cloudflare AI Gateway need no Latitude SDK at all.

**Custom existing OTel provider:** add `new LatitudeSpanProcessor(apiKey, project)` beside the existing processors and register the factories against that provider:

```ts
import { LatitudeSpanProcessor, registerLatitudeInstrumentations } from "@latitude-data/telemetry";
import { createOpenAIInstrumentation } from "@latitude-data/telemetry/instrumentations/openai";

await registerLatitudeInstrumentations({
  instrumentations: [createOpenAIInstrumentation(OpenAI)],
  tracerProvider: sdk.getTracerProvider(),
});
```

Use `capture(name, async () => { ... }, { userId, sessionId, tags, metadata, project })` at use-case boundaries. `project` overrides the constructor default for multi-project routing. `capture()` adds context to instrumented spans; it does not create LLM spans by itself. Do not use `capture.start()` / `scope.end()` on Cloudflare Workers.

For short-lived scripts/jobs, call `await latitude.flush()` or `await latitude.shutdown()` before exit. Do not call `shutdown()` per request in long-lived servers.

## Python

Requires Python 3.11 or newer. Install the latest `latitude-telemetry` with the project's package manager.

```python
import os
import openai
from latitude_telemetry import Latitude

latitude = Latitude(
    api_key=os.environ["LATITUDE_API_KEY"],
    project=os.environ["LATITUDE_PROJECT_SLUG"],
    instrumentations={"openai": openai},
)
```

If an OpenTelemetry provider is already registered, `Latitude(...)` attaches to it. For custom setups, add `LatitudeSpanProcessor` to the existing provider and call `register_latitude_instrumentations(instrumentations={...}, tracer_provider=provider)`.

Python keeps the dictionary form: key → the imported module object (never a string). Keys at time of writing: `openai`, `openai-agents` (module `agents`), `anthropic`, `bedrock` and `sagemaker` (both `boto3`), `cohere`, `togetherai` (module `together`), `vertexai` and `aiplatform` (both from `google-cloud-aiplatform`), `google_generativeai` (module `genai` from `google-genai`), `google_adk` (`google.adk`), `langchain` (`langchain_core`), `llamaindex` (`llama_index`), `crewai`, `haystack` (from `haystack-ai`), `litellm` (also the key for DSPy), `groq`, `mistralai`, `ollama`, `replicate`, `watsonx` (`ibm_watsonx_ai`), `aleph_alpha` (`aleph_alpha_client`), `transformers`. Several keys differ from the package name; copy the exact pair from the table or the docs page. Pydantic AI and Strands do not use a key (see the table).

Use `capture()` as a wrapper with snake_case options, especially when context is per request:

```python
from latitude_telemetry import capture

def run_agent(user_id: str, session_id: str):
    return capture(
        "support-agent-run",
        lambda: agent.run(),
        {"user_id": user_id, "session_id": session_id, "tags": ["support"]},
    )
```

For short-lived processes, call `latitude.flush()` or `latitude.shutdown()` before exit. Do not call `shutdown()` per request in long-lived services.

## Other targets

- **Generic OTLP / other languages:** send traces to `https://ingest.latitude.so/v1/traces` with `Authorization: Bearer <LATITUDE_API_KEY>` and `X-Latitude-Project: <LATITUDE_PROJECT_SLUG>` (`application/json` or `application/x-protobuf`; a `202` means accepted). With the SDK-agnostic env vars that is `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` plus `OTEL_EXPORTER_OTLP_TRACES_HEADERS`; some frameworks (Pydantic AI, Strands) take the **base** URL `https://ingest.latitude.so` in `OTEL_EXPORTER_OTLP_ENDPOINT` and append the path themselves. For full model/token/message details, LLM spans must follow OpenTelemetry GenAI semantic conventions (`gen_ai.*` attributes); the `otel-exporter` docs page has curl, Go, Java, Ruby and .NET examples and the optional `latitude.*`, `session.id`, `user.id` attributes.
- **Coding-agent / harness telemetry:** this traces an *agent harness's own* prompts, responses and tool I/O, not an app's LLM calls. Keep the two separate, and **ask before installing** any hook or plugin, since content is sent to Latitude; offer the structural-only mode where one exists. Each harness reads the key and project from its own place, so follow its docs page (`telemetry/<name>`), not `.env` conventions. New harnesses are added over time; at time of writing:
  - **Claude Code:** `npx -y @latitude-data/claude-code-telemetry@latest install` (non-interactive: `--api-key=… --project=<slug> --yes`). Writes an `env` block and Stop/SessionEnd hooks into `~/.claude/settings.json`; reads `LATITUDE_PROJECT` only. Full content only; redact with `LATITUDE_REDACT_ATTRIBUTES`.
  - **Hermes:** install `latitude-telemetry-hermes` into the Python that runs Hermes (official installer: `~/.hermes/bin/uv pip install --python ~/.hermes/hermes-agent/venv/bin/python latitude-telemetry-hermes`). Enable by adding `latitude` to `plugins.enabled` in `~/.hermes/config.yaml` (not `hermes plugins enable`) and set `plugins.stream_reasoning_deltas: true` for time-to-first-token. Credentials go in `~/.hermes/.env` as `LATITUDE_API_KEY` and `LATITUDE_PROJECT` (or `LATITUDE_PROJECT_SLUG`). Structural-only: `LATITUDE_NO_CONTENT=true`. Restart Hermes (and its gateway) afterwards.
  - **OpenClaw:** `npx -y @latitude-data/openclaw-telemetry-cli@latest install` (non-interactive: `--api-key=… --project=<slug> --yes --restart`; structural-only: `--no-content`). Needs OpenClaw 2026.8.1+. Installs the `@latitude-data/openclaw-telemetry` plugin with `--accept-capabilities`, writes `plugins.entries["@latitude-data/openclaw-telemetry"]` in `~/.openclaw/openclaw.json` with both `config.allowConversationAccess` and `hooks.allowConversationAccess` (the second is OpenClaw's own gate; without it no traces are exported at all), validates the config and restarts the gateway. Verify with `grep latitude-openclaw /tmp/openclaw/openclaw-*.log` after setting `config.debug` to `true`. OpenClaw's bundled `@openclaw/diagnostics-otel` exporter also reaches Latitude but scrubs session, run and user ids and exports no system prompt, tool definitions or memory, so Sessions, Users, Tools and Memory stay empty; do not run both, the same model call would be counted twice.
  - **Pi:** `npx -y @latitude-data/pi-telemetry install` (non-interactive: `--api-key=… --project=<slug> --yes`; structural-only: `--no-content`). Writes `~/.pi/agent/settings.json` and `~/.pi/agent/latitude-telemetry.json`; reads `LATITUDE_PROJECT` or `LATITUDE_PROJECT_SLUG`.
  - **Prime Intellect (Verifiers):** `pip install latitude-telemetry-prime-intellect` into the eval's environment, `LATITUDE_API_KEY` + `LATITUDE_PROJECT` (or `LATITUDE_PROJECT_SLUG`) in the env; export via `make_on_complete(...)` / `export_episodes(...)` or post-hoc with `latitude-prime-intellect-export export <run-dir>`. Rewards land as custom scores. Structural-only: `LATITUDE_NO_CONTENT=true`.
- **Historical traces from another platform:** Langfuse, LangSmith and Braintrust history is not instrumented, it is **imported**: Project settings → Imports in the UI, or the `createImport` operation over the MCP, CLI or API (`getImport` / `retryImport` / `cancelImport` to follow it). Imports are cloud-only, newest-first, capped by plan usage, one at a time per organization; credentials are discarded when the import finishes. Docs: `telemetry/imports/overview`. Offer this when the audit finds an existing Langfuse/LangSmith/Braintrust setup the user wants to keep as history while switching live traffic to Latitude.

## Long-term memory? Add memory observability

If the app has **long-term memory** — state the agent persists and reloads across separate interactions — it is **highly recommended** to also instrument its memory operations. That unlocks Latitude's Memory page: each store's contents, per-record change history and diffs, the tokens read and written per session, and the session behind every write. Memory operations ride this same telemetry pipeline, so there is no extra account or exporter setup — only memory-specific spans to add.

- **What counts as long-term memory.** State the agent **writes down to use later** and **reads back in** on a subsequent interaction — files (a `memory/` dir, per-user notes), a memory-shaped database table it populates and queries, a vector store the agent both writes and semantically searches for recall, a key-value/Redis store of durable per-user state, or a provider like Mem0/Zep/Supermemory. It persists across sessions, runs, or users.
- **What is NOT long-term memory** (do not instrument as memory): the conversation/message history within a single request or session (that is the trace itself), prompt context and few-shot examples, a pure performance cache, and a read-only reference corpus the agent only queries and never writes (that is retrieval, not memory).
- **How to tell:** you already explored the codebase during the audit — look for a persistence boundary the agent crosses on its own initiative (functions like `remember`/`recall`/`store`/`retrieve`/`upsert`, a `memory/` module, a vector-store client the agent both writes and queries, or a memory-provider SDK import).
- **If it has long-term memory**, read **[`memory.md`](memory.md)** (bundled with this skill) once base tracing is verified, and follow it — it covers the store/record model, where and when to emit, the memory SDK helpers, and raw `gen_ai.memory.*` spans. **If it does not**, do nothing extra; there is no memory to observe.
