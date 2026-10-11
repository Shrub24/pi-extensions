# pi-native-router (v0.1)

Opt-in native Pi virtual models: `route/<role>` selects an ordered physical registry candidate while Pi owns credentials, transport, streaming, reasoning, retries and physical usage accounting. Requires Pi **1.1.0+**; validated against 1.1.0. No routes or paid requests are enabled by default.

## Configuration

Load this package through Pi package/extension discovery in **both parent and worker runtimes**. Set user-owned `$PI_CODING_AGENT_DIR/settings.json` (default `~/.pi/agent/settings.json`):

```json
{
  "compaction": { "enabled": false },
  "kendex": {
    "extensionManager": {
      "config": {
        "@vanillagreen/pi-native-router": {
          "flushTimeoutMs": 5000,
          "routes": {
            "worker": {
              "contextWindow": 200000,
              "outputReserve": 8192,
              "stayRetries": 1,
              "maxTransitions": 3,
              "maxRecoveries": 2,
              "candidates": [
                { "provider": "anthropic", "id": "YOUR-MODEL-ID", "thinkingLevel": "high", "cacheTtlMs": 1800000 },
                { "provider": "openai-codex", "id": "YOUR-MODEL-ID", "thinkingLevel": "medium" }
              ]
            }
          }
        }
      }
    }
  }
}
```

IDs must resolve to physical models with configured credentials in the native registry. Missing/unconfigured candidates are skipped; malformed definitions, duplicate candidates, nested routes and unknown settings fail loading. No network probing is performed by the router. Project settings do not override routing: a checkout must not silently redirect paid requests. Reload the extension after configuration edits. Candidate thinking levels are fixed per candidate; Pi clamps them to supported levels. Optional positive integer `cacheTtlMs` opts that physical model into request-driven estimated expiry handling; it is not a provider guarantee and is disabled when omitted.

Defaults per route: `contextWindow:200000`, `outputReserve:8192`, `stayRetries:1`, `maxTransitions:3`, `maxRecoveries:2`. Transition/recovery limits may be zero. Timeout is 1–60000ms; routes have 1–32 unique candidates. Disable **native Pi** automatic compaction separately as shown; the router does not invoke it. Magic Context must remain loaded with its own compaction/materialization enabled (its `compaction-off` flush refusal blocks transitions).

## Named API-key accounts

Optional `accounts` map (user settings only) binds an opaque ID to a provider and the **environment variable** holding its key. One key is one account. Candidates may name an account; a provider with named accounts must name one on every candidate, so no candidate can fall through to a different credential.

```json
{
  "accounts": {
    "go-a": { "provider": "opencode-go", "apiKeyEnv": "OPENCODE_GO_KEY_A" },
    "go-b": { "provider": "opencode-go", "apiKeyEnv": "OPENCODE_GO_KEY_B" }
  },
  "routes": {
    "worker": {
      "candidates": [
        { "provider": "opencode-go", "id": "YOUR-MODEL-ID", "account": "go-a" },
        { "provider": "opencode-go", "id": "YOUR-MODEL-ID", "account": "go-b" }
      ]
    }
  }
}
```

Activation uses Pi's runtime key operation (`ModelRuntime.setRuntimeApiKey`, reached through the same private facade as `pi-accounts`) before the selected candidate's request is prepared, and verifies the effective key. **This is provider-global within one Pi runtime**: one active key per provider serves all requests in that process, including overlapping or direct calls. Concurrent isolation requires separate Pi runtimes. Parent and worker processes each keep their own active key. A candidate with no `account` on a provider that has named accounts expands to one candidate per account, in configured order, so a bare `opencode-go` candidate is a pool; each expansion keeps its own health, stickiness and cache epoch. A missing environment variable makes that candidate unavailable, never a silent fallback. A host without the runtime operation fails the named-account candidate before dispatch; default-auth candidates are unaffected. Literal keys are rejected. Cooldowns are per account and provider-scoped failures apply to that account only.

## Shared health

Account and provider causes are shared across Pi processes of the same user on one machine, in a private SQLite store at `$PI_CODING_AGENT_DIR/pi-native-router/health.sqlite` (default `~/.pi/agent/...`; directory `0700`, file `0600`). It holds only secret-free records: scope key (provider, account, or provider/model with account), cause kind, deadline, revision and probe lease. Keys, headers and response bodies are never stored.

- **Scopes:** explicit quota and invalid-key evidence block the account across all its models; a model-access 403 blocks only that model; provider-wide evidence blocks the provider. Other accounts and providers are unaffected.
- **Quota and auth deadlines** are kept up to eight days when the provider supplies them as epoch milliseconds; transient and rate hints stay capped at 15 minutes. Ambiguous reset units fall back to the default backoff.
- **Recovery** after a deadline admits exactly one probe per scope through an atomic lease (60 s, expiring if its holder crashes). Success clears only the causes the probe proved recovered; a newer failure, an operator reset or a late result cannot be erased by an older one.
- **Partial output** from a quota or auth failure still records health, but the request is never replayed.
- **Degradation:** if the store cannot be opened or accessed, routing keeps the process-local mirror and emits one `native-router:health-degraded` event per distinct error. Dispatch is not stalled by coordination.
- **Inspect and reset:** `/native-router-health` lists causes and probe leases; `/native-router-health reset <account>` clears that account's causes and fences its in-flight probes.
- **Rollback:** set `"sharedHealth": false` at the top level of the router configuration to return to process-local health. Parent and worker processes need the same setting to share state.

## Account quotas (CodexBar)

An account may map to a CodexBar provider so `/quotas` can show its windows:

```json
"accounts": {
  "go-a": {
    "provider": "opencode-go",
    "apiKeyEnv": "OPENCODE_GO_KEY_A",
    "quota": { "source": "codexbar", "provider": "opencodego", "account": "go-a", "enforce": true }
  }
}
```

- `/quotas` runs `codexbar usage --provider <provider> [--account <label>] --format json` with a 15 s deadline and a 64 KiB output cap, under a per-account refresh lease, and prints each window with its usage, reset and observation age. Missing binary, timeout or unrecognised output is shown as unknown and never counts as capacity or as a generation failure.
- `enforce: true` writes a tracker-sourced cause that skips the account until its exhausted window resets. It is **off by default**; enable it per account once the account's CodexBar source is authoritative (`api`, `web` or `oauth`).
- A healthy snapshot clears only tracker-sourced causes. Auth, rate, outage and error-derived quota causes are unaffected.
- `/quotas-config [--replace] [path]` writes CodexBar's config from the quota-mapped accounts: each becomes a token account labelled with its quota account (or router id) and its key read from the same environment variable. Providers are set to `source: "api"` so their meters are account-authoritative rather than device-local. The file is written 0600 via a temporary file and rename, and an existing file is refused unless `--replace` is given. Accounts whose key variable is unset are reported and skipped.
- Refresh runs on session start and every five minutes (leased, so concurrent Pi processes do not duplicate it), and `/quotas` refreshes on demand. Dispatch never waits for CodexBar.
- Snapshots are authoritative only when the tracker reports server meters (`source` api, web or oauth, or an explicit authoritative confidence). A `local+api` blend or estimate never enforces a block.

## Model pricing (estimates)

`/pricing refresh` downloads models.dev (provider-specific records) and LiteLLM's price map, validates them, and keeps the last valid snapshot at `$PI_CODING_AGENT_DIR/pi-native-router/pricing.json` (`0600`). Refresh runs only on demand; nothing is fetched during dispatch. Redirects and non-200 responses are refused.

- `/pricing show <provider>/<model>` prints the rates in USD per million tokens, labelled as a **list-price estimate**, with its source.
- Lookup is exact on provider and model. models.dev wins; LiteLLM fills only a physical model models.dev lacks, under the same provider and id.
- Unknown components stay unknown. A model without a cache-write rate is reported as partial, not free. Context-tiered pricing is reported as partial, because the base rates alone do not price long contexts.
- Local overrides go under `pricing.overrides` as exact `provider/model` keys with optional `input`, `output`, `cacheRead` and `cacheWrite` rates. Overrides are labelled `override`.
- **Cost source of truth is Pi's own `usage.cost`**, which Pi derives from its bundled model catalog and pi-otel exports as `gen_ai.usage.cost`. The snapshot is a backup only:
  - When Pi's model registry has no price for a physical model and the snapshot has a complete record, the message cost is priced from the snapshot. Partial or tiered records leave cost unknown rather than zero.
  - **DeepSeek peak pricing:** OpenCode Go bills DeepSeek models (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4.1-flash`) at DeepSeek's peak rate, which is twice the off-peak rate Pi records. On weekdays 01:00–04:00 and 06:00–10:00 UTC, the router doubles each recorded cost component on the finished message before pi-otel reads it. Weekends are off-peak.

## Thinking level

A route advertises every thinking level, so Shift+Tab and `/thinking` work on `route/<role>`. Your explicit choice is stored on the session branch, per role, and applies to every later request on that route until you change it. Each physical candidate clamps the choice to the levels it supports, using pi-ai's rule (upward first, then downward). Without an explicit choice, each candidate's configured `thinkingLevel` applies.

Switching model does not count as a choice: a physical model's own thinking level never becomes a route choice.

## Decision log

Each change of physical target is appended to `$PI_CODING_AGENT_DIR/pi-native-router/decisions.jsonl` (default `~/.pi/agent/...`, mode `0600`), one JSON object per line:

`{"at","session","logical","previous?","physical","account?","reason","contextTokens?","floor?"}`

`reason` is `initial` (first selection), `failover` (after a failed request), or `sticky` (any other change). The log holds identities and reasons only, never keys, prompts or responses. Logging is best-effort and never affects dispatch. Read it with `jq`, for example `jq -c 'select(.reason=="failover")' decisions.jsonl`.

## Stickiness and capacity

JSON branch state persists the last dispatched identity, non-decreasing context-window floor and bounded turn-recovery bookkeeping. Restore, fork and compaction retain it. Healthy user turns and tool continuations stay on the physical model; successful failover stays there rather than automatically returning to the first candidate. Candidate/config/catalog changes reconcile against the current registry while retaining the floor. Per-turn counters reset when a new real user transcript entry appears, not at native `agent_start` retry boundaries.

Direct registry requests select deterministically from current candidates/health without reading or writing session state, triggering flushes or consuming session recovery budgets. Local health can exclude candidates for direct calls, but direct calls do not update it.

**v0.1 never automatically falls back to a smaller context window.** Initial selection honors configured logical capacity and conservative canonical/latest-successful-usage estimates. Subsequent selection also honors the stored physical capacity floor, including after restore/config changes. Reserve is the greater of configured output reserve and the candidate's maximum output; a candidate must support the configured output reserve. Pi routes *before* extension context preparation, so final effective tokens (including refreshed Magic Context additions) are unavailable. These estimates are not a hard final-token guarantee; preserving capacity prevents failover itself from shrinking the window. No host patch is required for this conservative rule.

## Failure policy

- Safe transient transport/server errors stay for `stayRetries` native retry callbacks, then cool down that model and advance.
- Rate limits cool down the model by default. Quota/billing exhaustion and authentication failures cool down the provider. Structured JSON error text can specify `status`, `scope:"provider"`, `retryAfterSeconds` or epoch-millisecond `resetAt`.
- Default cooldowns: transient 30s, rate 60s, quota/auth 300s; available hints clamp to 1s–900s. Health is shared across same-user processes through the store described under Shared health, and survives restarts until each deadline. Provider-wide scope applies only to provider-wide evidence; account evidence stays on its account. Pi's public assistant error exposes strings, not reliable raw HTTP headers; no header parsing is promised.
- Aborts, invalid requests, context overflow, unknown/non-provider errors, tool/deferred content and nonempty partial text/thinking do not migrate. Native Pi may independently retry errors under its own policy; the router refuses unsafe migration.
- Safe terminal errors recover only at `agent_before_settle`, when another candidate and both budgets remain. A `context_edit:null` omits only the empty failed assistant from projected context; raw history is retained. The existing user/tool-result context continues without synthetic instructions or replaying completed tools. Partial output is never omitted by this extension.
- No candidate or budget remaining means settlement. Recovery uses native scheduling only; no custom execution/retry loop exists.

## Transition handshake

A real session physical change (not initial, same-model or direct dispatch) awaits `magic-context:flush` → matching-session `magic-context:flush-result`. For an opted-in model, an expired successful-activity epoch also flushes before the next dispatch even when the physical model is unchanged; that emits `native-router:estimated-cache-invalidation`, not transition events. Switch plus expiry shares the one transition flush. Only `status:"success"` succeeds. Skips, failures, missing extension/timeouts and aborts prevent replacement dispatch; state/observation is committed only after pre-dispatch work succeeds. Handshakes serialize within the session. The protocol lacks correlation IDs: an unrelated emitter for the **same session** can still produce an ambiguous result; do not issue concurrent external flush requests during routing.

The flush result signals pending work, **not completion of provider-context materialization**. Pi 1.1.0 subsequently runs `context` handlers before physical streaming, on retries and terminal continuations too. Magic Context consumes pending-op/history flags there. Its system adjunct refresh is different: it waits until the next `before_agent_start`, which native retries and settlement continuations do not invoke. Flush is not wrapup or unconditional compression.

Local integrations can synchronously register work:

```ts
pi.events.on("native-router:before-transition", (event: any) => {
  event.waitUntil(myPreDispatchWork(event));
});
pi.events.on("native-router:transition", (event: any) => {
  // observation: sessionId, logical, from, to
});
```

`waitUntil` must be called during event delivery; its promise is awaited under the same timeout/abort boundary. `installRouter(pi, config, { transition })` exposes a replaceable local transition hook for an owning integration/test; the default is the Magic Context bridge. Observations do not change logical model selection.

## Parent / Herdsman workers

Select `--model route/worker`. Inherited virtual models must allow extension discovery; the narrow Herdsman compatibility change recognizes registry virtual models even though their providers do not appear in `getRegisteredProviderIds()`. Pinned virtual models with `noExtensions:true` still need explicit extension paths or a definition that allows discovery. A wrapper using `--no-extensions` must explicitly load this package **and the full Magic Context entry**; the lean MC subagent entry does not register the flush bridge. Parent and worker must read the same route config and use matching Pi APIs; each has independent local health. Bundle loading and activation remain deployment-owner work.

Magic Context's Pi-only idle-TTL disablement and preserved **200000** pressure threshold are peer-owned. This package neither edits external repositories nor changes shared OpenCode TTL policy. Do not deploy until those settings and full-entry worker loading are verified.

## Validation / limits

```sh
cd pi-native-router
bun run typecheck
bun test tests
```

Tests use actual Pi 1.1.0 AgentSession/ModelRuntime with deterministic fake providers, including terminal quota recovery, native transient retry, tool continuation/no replay, flush failure/timeout/abort, capacity floors, JSON branch restore/fork/compaction, direct isolation and package entry loading. The host materialization fixture models MC's public pending-flag protocol and asserts provider-visible transformed messages, not merely event ordering. Complementary peer-owned actual `executeCtxFlush`/registered context-handler tests pass (154 tests in MC's context-handler.test.ts), proving pending drop/history materialization independently. Together these establish the scoped flush claim; **they are not a single-process deployed-plugin end-to-end smoke**. Deployment/live credentials have not been activated or tested.

Deferred: final-effective-context late preparation/re-route host seam, correlated MC requests, provider/account-specific health granularity. Rollback: unload this package and select a physical model directly; credentials are unchanged.
