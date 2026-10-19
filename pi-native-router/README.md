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

Defaults per route: `contextWindow:200000`, `outputReserve:8192`, `stayRetries:1`, `maxTransitions:3`, `maxRecoveries:2`. A candidate fits when its context window is at least `max(route.contextWindow, currentContextTokens + route.outputReserve)` and its max output is at least the route reserve. Routed turns use Pi's usage-aware context count (the same count shown in the footer); direct calls fall back to estimating their request messages. Transition/recovery limits may be zero. Timeout is 1–60000ms; routes have 1–32 unique candidates. Disable **native Pi** automatic compaction separately as shown; the router does not invoke it. Magic Context must remain loaded with its own compaction/materialization enabled (its `compaction-off` flush refusal blocks transitions).

### Optional TypeScript choice strategy

By default the router uses existing ordered/sticky selection. A route may instead load a trusted local TypeScript module to choose among the router's eligible physical targets:

```json
"strategy": {
  "module": "/home/operator/.config/pi/routing/peak-quota-strategy.ts",
  "options": { "resetHorizonMinutes": 120 }
}
```

The module default-exports `{ version: 1, choose(context) }` and returns `{ targetId, reason }`. Import the public types with `import type { RoutingContext, RoutingStrategy } from "@vanillagreen/pi-native-router/strategy"`. See `examples/peak-quota-strategy.ts` for one small policy that prefers fresh authoritative quota near reset, then avoids peak windows, then keeps the incumbent or configured order. Its ordering is illustrative, not an economic guarantee.

The snapshot contains eligible candidates and rejection reasons, account-scoped quota windows and cache evidence, pricing/peak facts, request estimate, current/pinned target and retry/transition budgets. Cache-switch cost is explicitly `unknown` unless the target is already current; no saved tokens or dollar savings are fabricated from TTL alone. Missing, stale and non-authoritative quota and incomplete/unknown prices remain explicit; list prices are not subscription marginal cost. `peak.costTreatment` distinguishes router-adjusted OpenCode Go cost from Command Code cost already calculated by its provider, so a custom strategy can avoid double-counting. The snapshot contains no prompts, keys, key paths, host objects or mutable router handles. The router performs no tracker/catalog fetch in the strategy call.

This is trusted code, not a sandbox: a strategy can read local files or block the Pi process. Keep `choose` synchronous, deterministic from its supplied snapshot and free of I/O. The router validates that it returns an eligible target and bounded explanation; errors or invalid results fall back to ordered/sticky selection and are reported. It cannot add models, bypass health/context/auth checks, or dispatch requests. A newly set pin or cycle target overrides incumbent stickiness and automatic strategy choice once, if eligible; after dispatch the selected target stays sticky. Without a fresh override, recovery targets and bounded same-target retries retain precedence. Persistent pins remain context for custom strategies and are preferred over configured order when no incumbent is eligible. An ineligible pin follows normal fallback selection; `/route-pin` cycling remains configured-order based.

The host's native TS module loader caches the module once per absolute path for the Pi process lifetime. Restart Pi after editing the strategy source; reload the extension after changing route settings/options. To roll back, remove `routes.<role>.strategy` and reload; existing pin, quota, health and cache state is unchanged. Routes without the setting retain existing behavior.

## Providers

One `providers` map (user settings only) holds everything the router knows about a provider. Shared settings sit on the provider: an optional `name` (footer label) and a single key or quota. The optional `accounts` map is for multi-account providers only: each account has its own key and quota and is named in routes as `account`.

A key is one of **`apiKeyFile`** (absolute path, e.g. a sops-nix secret; read and trimmed at use time, so rotation takes effect without a restart; preferred) or `apiKeyEnv` (a variable name). Literal keys are rejected. A provider takes either a single key or `accounts`, never both.

```json
{
  "providers": {
    "opencode-go": {
      "name": "OpenCode Go",
      "accounts": {
        "go-a": { "apiKeyFile": "/run/secrets/OPENCODE_GO_KEY_A", "quota": { "source": "codexbar", "provider": "opencodego", "account": "go-a", "enforce": true } },
        "go-b": { "apiKeyFile": "/run/secrets/OPENCODE_GO_KEY_B", "quota": { "source": "codexbar", "provider": "opencodego", "account": "go-b", "enforce": true } }
      }
    },
    "commandcode": {
      "name": "Command Code",
      "apiKeyFile": "/run/secrets/COMMANDCODE_API_KEY",
      "quota": { "source": "codexbar", "provider": "commandcode", "enforce": true }
    },
    "openai-codex": {
      "name": "Codex",
      "quota": { "source": "codexbar", "provider": "codex", "enforce": true }
    }
  },
  "routes": {
    "worker": {
      "candidates": [
        { "provider": "opencode-go", "id": "YOUR-MODEL-ID", "account": "go-a" },
        { "provider": "opencode-go", "id": "YOUR-MODEL-ID", "account": "go-b" },
        { "provider": "commandcode", "id": "YOUR-MODEL-ID" }
      ]
    }
  }
}
```

- A provider with a single key has no account id: its candidates name no account, and routes, the footer and telemetry show the provider alone. Its key is activated for its candidates like an account's key.
- A provider with `accounts` must name an account on every candidate, so no candidate can fall through to a different credential. A bare candidate for such a provider expands to one candidate per account, in configured order, so it is a pool; each expansion keeps its own health, stickiness and cache epoch. Account ids are unique across providers.
- A provider with neither a key nor accounts uses Pi's own login (default-auth). Its `quota`, when set, is read by CodexBar's logged-in account for that provider.
- A missing or empty key source makes that candidate unavailable, never a silent fallback.

Activation uses Pi's runtime key operation (`ModelRuntime.setRuntimeApiKey`, reached through the same private facade as `pi-accounts`). It runs after any pre-dispatch Magic Context flush and before the replacement request. Mutations are serialized per runtime, and the effective key is read back to verify activation. Any failure fails the route closed before dispatch and emits `native-router:account-unavailable`; it never falls back to another key once the account has been selected. **This is provider-global within one Pi runtime**: one active key per provider serves all requests in that process, including overlapping or direct calls. Concurrent isolation requires separate Pi runtimes. Parent and worker processes each keep their own active key. A host without the runtime operation drops keyed candidates from selection, so default-auth candidates keep working; a route whose only candidates are keyed reports that the host lacks runtime key activation. This depends on Pi 1.1.0's private `ModelRuntime` facade and is not a public API: re-validate it on every Pi upgrade. Cooldowns are per account, and provider-scoped failures apply to the provider.

## Per-model cache TTL

`cacheTtlMs` is set per candidate, so each physical model can carry its own cache lifetime. It is opt-in: a candidate without it never expires its cache and triggers no flush.

```json
"coder": { "candidates": [
  { "provider": "anthropic", "id": "opus-5-5", "thinkingLevel": "medium", "cacheTtlMs": 300000 },
  { "provider": "opencode-go", "id": "deepseek-v4.1-flash", "thinkingLevel": "medium", "cacheTtlMs": 300000 }
] }
```

- Use the retention the provider actually gives you (for example `300000` for 5 minutes, `3600000` for 1 hour). The TTL is an estimate: an expired TTL flushes Magic Context before the next dispatch, but it does not prove the provider missed the cache.
- Cache age is tracked per account and model. Switching accounts or models starts a new epoch, and an account never inherits another's cache age.
- Successful assistant responses refresh the age; aborted, errored and direct calls do not.
- Routing stays sticky. Expiry alone never switches a healthy route.

## Shared health

Account and provider causes are shared across Pi processes of the same user on one machine, in a private SQLite store at `$PI_CODING_AGENT_DIR/pi-native-router/health.sqlite` (default `~/.pi/agent/...`; directory `0700`, file `0600`). It holds only secret-free records: scope key (provider, account, or provider/model with account), cause kind, deadline, revision and probe lease. Keys, headers and response bodies are never stored.

- **Scopes:** explicit quota and invalid-key evidence block the account across all its models; a model-access 403 blocks only that model; provider-wide evidence blocks the provider. Other accounts and providers are unaffected.
- **Quota and auth deadlines** are kept up to eight days when the provider supplies them as epoch milliseconds; transient and rate hints stay capped at 15 minutes. Ambiguous reset units fall back to the default backoff.
- **Recovery** after a deadline admits exactly one probe per scope through an atomic lease (60 s, expiring if its holder crashes). Success clears only the causes the probe proved recovered; a newer failure, an operator reset or a late result cannot be erased by an older one.
- **Partial output** from a quota or auth failure still records health, but the request is never replayed.
- **Degradation:** if the store cannot be opened or accessed, routing keeps the process-local mirror and emits one `native-router:health-degraded` event per distinct error. Dispatch is not stalled by coordination.
- **Inspect and reset:** `/native-router-health` lists causes with their reason and expiry, and probe leases. The header states the coordination mode: `shared`, `DEGRADED` (the store failed, so only process-local health applies), or `local-only` (`sharedHealth` is off). `/native-router-health reset <account>` clears that account's causes, leaves other accounts and provider-wide outages in place, and fences its in-flight probes.
- **Rollback:** set `"sharedHealth": false` at the top level of the router configuration to return to process-local health. Parent and worker processes need the same setting to share state.

## Account quotas (CodexBar)

A provider or account may map to a CodexBar provider so `/quotas` can show its windows; the mapping sits beside its key (see Providers):

- `/quotas` runs `codexbar usage --provider <provider> [--account <label>] --format json` with a 15 s deadline and a 64 KiB output cap, under a per-account refresh lease, and prints each window with a fill bar, its usage to two decimals, reset and observation age. Missing binary, timeout or unrecognised output is shown as unknown and never counts as capacity or as a generation failure.
- `enforce: true` writes a tracker-sourced cause that skips the account until its exhausted window resets. It is **off by default**; enable it per account when you want valid CodexBar quota readings enforced.
- **Default-auth providers** (Pi's own login, such as `openai-codex` and `anthropic`) have no key or accounts; their quota sits on the provider. CodexBar reads the logged-in account for these, so no label is passed. An exhausted window blocks every model on that provider until its reset. A provider with `accounts` puts its quota on each account instead.
- A healthy snapshot clears only tracker-sourced causes. Auth, rate, outage and error-derived quota causes are unaffected.
- `/quotas-config [--replace] [path]` writes CodexBar's config from the quota mappings: each account becomes a token account labelled with its quota account (or router id); a single-key provider's key goes on the provider as `apiKey`, as CodexBar requires. Providers are set to `source: "api"` so their meters are account-authoritative rather than device-local. The file is written 0600 via a temporary file and rename, and an existing file is refused unless `--replace` is given. Accounts whose key variable is unset are reported and skipped.
- Refresh runs on session start and every five minutes. The shared store is the gate: any process reuses an account's last CodexBar attempt (success or failure) if it is under four minutes old, so all Pi processes on the machine run CodexBar at most once per gate per account. `/quotas` reuses that fetch; `/quotas refresh` forces a new one. Dispatch never waits for CodexBar.
- Fresh, structurally valid snapshots are authoritative by default, including CodexBar's CLI source. Explicitly estimated readings and local-derived sources (`local`, `local+api`, or cached `codexbar-app`) remain advisory and never enforce a block.
- **Default strategy: no quota ranking.** Quota snapshots only block an exhausted account until its window resets. Without a custom route strategy, the router does not rank candidates by remaining headroom; configured order and health decide. An opted-in trusted TypeScript strategy may explicitly use quota observations to express operator preference.
- **Rollback:** set `enforce` to `false` (or remove the `quota` mapping) per account to stop blocking. Removing the mapping also stops refresh. Existing tracker causes expire at their reset, or clear with `/native-router-health` reset.

## Model pricing (estimates)

`/pricing refresh` downloads models.dev (provider-specific records) and LiteLLM's price map, validates them, and keeps the last valid snapshot at `$PI_CODING_AGENT_DIR/pi-native-router/pricing.json` (`0600`). Refresh runs only on demand; nothing is fetched during dispatch. Redirects and non-200 responses are refused.

**Rollback of the catalog backup:** delete `pricing.json`. A missing snapshot is treated as no catalog, so backfill stops and Pi's recorded cost stands. Overrides in configuration are separate and must be removed from settings. DeepSeek peak doubling is not controlled by the snapshot and has no configuration switch; disabling it needs a change to the router.

- `/pricing show <provider>/<model>` prints the rates in USD per million tokens, labelled as a **list-price estimate**, with its source.
- Lookup is exact on provider and model. models.dev wins; LiteLLM fills only a physical model models.dev lacks, under the same provider and id.
- Unknown components stay unknown. A model without a cache-write rate is reported as partial, not free. Context-tiered pricing is reported as partial, because the base rates alone do not price long contexts.
- Local overrides go under `pricing.overrides` as exact `provider/model` keys with optional `input`, `output`, `cacheRead` and `cacheWrite` rates. Overrides are labelled `override`.
- **Cost source of truth is Pi's own `usage.cost`**, which Pi derives from its bundled model catalog and pi-otel exports as `gen_ai.usage.cost`. The snapshot is a backup only:
  - **Catalog backfill:** the message cost is priced from the exact snapshot record (or a complete local override) when Pi has no price for the model, or when Pi recorded zero cost for a message with tokens. A nonzero Pi cost is never overwritten, a genuinely free model stays zero, and partial or tiered records leave cost unknown rather than zero. The estimate is exported with `pi.pricing.source` (`catalog` or `override`) in pi-otel.
  - **DeepSeek peak pricing:** OpenCode Go bills its DeepSeek models at twice the off-peak rate Pi records. On weekdays 01:00–04:00 and 06:00–10:00 UTC, the router doubles each recorded cost component on the finished message before pi-otel reads it, for `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro`, `deepseek-v4.1-flash` and `deepseek-flash`. Only the `deepseek-v4.1-flash` IDs in those windows are confirmed by live traffic; the other IDs follow the provider documentation. Command Code applies the same peak rate inside its own provider cost calculation, so its recorded cost is already at peak. The router does not double it again; it only sets `pi.pricing.peak_multiplier` to 2 on those DeepSeek messages. Weekends are off-peak for both.

## Thinking level

A route advertises every thinking level, so Shift+Tab and `/thinking` work on `route/<role>`. Your explicit choice is stored on the session branch, per role, and applies to every later request on that route until you change it. Each physical candidate clamps the choice to the levels it supports, using pi-ai's rule (upward first, then downward). Without an explicit choice, each candidate's configured `thinkingLevel` applies.

Switching model does not count as a choice: a physical model's own thinking level never becomes a route choice.

`/route-thinking default` clears the choice, so candidate defaults apply again. A change to the level the shown candidate would run at anyway is stored as no choice, so the pencil only marks a level that differs from the default.

### Footer status

The router publishes four status items for powerline's `customItems` (`native-router-provider`, `native-router-model`, `native-router-peak`, `native-router-thinking`):

- **Provider:** the provider serving the current request, with its account after `·` (e.g. `OpenCode Go · go-a`). Before the first request on a route, it shows the candidate the next request will try.
- **Model:** Pi's model name for that candidate, with `⚑` while a route pin is set.
- **Peak:** a `▲` while the physical model is in a peak window.
- **Thinking:** the one thinking state shown, for direct and route models alike: the level name that will run (e.g. `high`). A Nerd Font pencil (`\uF040`, `nf-fa-pencil`) follows, after a space, when you chose the level on the route. Keep Pi's built-in thinking segment out of the powerline layout so the level is shown once.

The model part of `provider/model` is Pi's own model name, so model labels come from Pi's catalog and need no config. A provider's `name` replaces its id in the footer. Labels change only what the footer shows, never routing, keys or telemetry.

## Physical pin

`/route-pin` sets a preferred candidate without removing the route's fallbacks. A newly selected pin is a one-shot user override: if eligible, the next request switches to it even from a healthy current model; after dispatch, that target stays sticky. If the pin cannot serve the request, the normal eligibility and fallback path applies and the pin remains stored. With no argument it opens a picker of `auto` and the route's candidates; `/route-pin <candidate>` (for example `opencode-go/deepseek-v4.1-flash#go-c`) or `/route-pin auto` sets it directly, and completion offers the labels. The hotkey cycles the pin to the next eligible candidate in route order and wraps; set it under `shortcuts.cyclePin` (default `ctrl+shift+m`, which Pi leaves unbound; `ctrl+shift+p` is taken by `app.model.cycleBackward`).

- The pin is stored per route on the session branch, so resume and fork restore it. It is never shared across sessions.
- A newly changed eligible pin overrides the incumbent once. On later requests, an eligible current model stays sticky even if a different pin remains stored; when there is no eligible incumbent, the pin is preferred over route order. A fresh manual choice also overrides pending recovery preference, but never health, fit, transition, activation or flush safeguards.
- A pin that cannot serve (cooldown, exhausted quota, or too small for the request) is dormant: that request uses the route's automatic selection, and the pin becomes a preference again once the incumbent is unavailable.
- `auto` clears the pin. So does picking the candidate that automatic selection would already pick now; without a custom strategy this is the last served candidate, else the first in route order.
- The physical footer item shows `⚑` only when its displayed physical target matches the pin. A separate single warning glyph marks a pinned target that is cooling down, without marking the healthy fallback. Each manual change is logged with reason `manual`.
- A pin change reports that an eligible new choice will apply on the next request and then stay sticky; an actual physical switch uses the normal cache-rebuild notice.

Selecting a route shows its next candidate (pending explicit pin, then healthy current model, then eligible stored pin, then configured automatic selection), so cycling starts from what the route will do. Failures surface as notices: a candidate that fails with a quota, auth, or rate error warns with its cooldown deadline, and a failover warns with the old and new candidates. Transient errors retried on the same candidate are shown as info.

## Decision log

Each change of physical target is appended to `$PI_CODING_AGENT_DIR/pi-native-router/decisions.jsonl` (default `~/.pi/agent/...`, mode `0600`), one JSON object per line:

`{"at","session","logical","previous?","physical","account?","reason","contextTokens?","requiredContext?"}` (`requiredContext` is the minimum window a candidate had to provide: the route's capacity or this request's need)

`reason` is `initial` (first selection), `failover` (after a failed request), or `sticky` (any other change). The log holds identities and reasons only, never keys, prompts or responses. Logging is best-effort and never affects dispatch. Read it with `jq`, for example `jq -c 'select(.reason=="failover")' decisions.jsonl`.

## Stickiness and capacity

JSON branch state persists the last dispatched identity and bounded turn-recovery bookkeeping. Restore, fork and compaction retain it. Healthy user turns and tool continuations stay on the physical model; successful failover stays there rather than automatically returning to the first candidate. Candidate/config/catalog changes reconcile against the current registry. Per-turn counters reset when a new real user transcript entry appears, not at native `agent_start` retry boundaries.

Direct registry requests select deterministically from current candidates/health without reading or writing session state, triggering flushes or consuming session recovery budgets. Local health can exclude candidates for direct calls, but direct calls do not update it.

**A candidate must honour the route's declared capacity, and this request must fit.** The route's configured `contextWindow` is the capacity it advertises to Pi, so every candidate needs at least that window. The request additionally has to fit the conservative canonical/latest-successful-usage estimate plus the reserve, where the reserve is the greater of the configured output reserve and the candidate's maximum output, and the candidate must support the configured output reserve.

Nothing is carried across a model switch: switching roles or candidates never raises or lowers the requirement, so a fallback may use a smaller window than the model it replaces whenever the conversation fits and the route's capacity is honoured. Capacity therefore never becomes a reason a route cannot fail over, and one large candidate cannot pin a route to itself. Pi routes *before* extension context preparation, so final effective tokens (including refreshed Magic Context additions) are unavailable; these estimates are not a hard final-token guarantee.

## Failure policy

- Safe transient transport/server errors stay for `stayRetries` native retry callbacks, then cool down that model and advance.
- Rate limits cool down the model by default. Quota/billing exhaustion and authentication failures cool down the provider. Structured JSON error text can specify `status`, `scope:"provider"`, `retryAfterSeconds` or epoch-millisecond `resetAt`.
- Default cooldowns: transient 30s, rate 60s, quota/auth 300s; available hints clamp to 1s–900s. Health is shared across same-user processes through the store described under Shared health, and survives restarts until each deadline. Provider-wide scope applies only to provider-wide evidence; account evidence stays on its account. Pi's public assistant error exposes strings, not reliable raw HTTP headers; no header parsing is promised.
- Aborts, invalid requests, context overflow, unknown/non-provider errors, tool/deferred content and nonempty partial text/thinking do not migrate. `Stream ended without finish_reason` is treated as transient only when no output was produced; a partial stream remains unsafe. Native Pi may independently retry errors under its own policy; the router refuses other unsafe migrations.
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

Tests use actual Pi 1.1.0 AgentSession/ModelRuntime with deterministic fake providers, including terminal quota recovery, native transient retry, tool continuation/no replay, flush failure/timeout/abort, capacity requirements, JSON branch restore/fork/compaction, direct isolation and package entry loading. The host materialization fixture models MC's public pending-flag protocol and asserts provider-visible transformed messages, not merely event ordering. Complementary peer-owned actual `executeCtxFlush`/registered context-handler tests pass (154 tests in MC's context-handler.test.ts), proving pending drop/history materialization independently. Together these establish the scoped flush claim; **they are not a single-process deployed-plugin end-to-end smoke**. Deployment/live credentials have not been activated or tested.

Deferred: final-effective-context late preparation/re-route host seam, correlated MC requests, provider/account-specific health granularity. Rollback: unload this package and select a physical model directly; credentials are unchanged.
