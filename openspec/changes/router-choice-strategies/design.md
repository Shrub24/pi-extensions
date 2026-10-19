# Design

## Context

See proposal.md for motivation. `policy.choose()` currently filters health/context fit and returns the preferred target or first eligible target. `index.ts` separately handles direct calls, recovery/transient-retry precedence, incumbent stickiness and pin preference, shared probe admission, flushes, key activation and branch state. `displayed()` and the pin-clear comparison also call `choose()`, so replacing only dispatch would make the picker and footer misleading.

Quota data is already source-neutral (`quota.ts`) and cached in the shared store; fetching is off-path. Pricing combines Pi model metadata, cached catalogs/overrides and DeepSeek peak helpers in `pricing/reconcile.ts`. Cache activity is keyed by physical target including account; the router does not know every server-side cache entry. Decision logging currently records target changes, not complete per-request snapshots.

Main specs contain no router capabilities yet. Related contracts remain in `pi-native-router`, `router-api-key-accounts`, `router-shared-health`, `router-account-quotas`, `router-cache-ttl`, `physical-model-pricing` and `router-physical-pin` changes. Preserve their safety behavior. The README's unconditional no-ranking statement must be narrowed to the default strategy, not silently left contradictory. The pending `physical-pin` spec says auto and dormant pins use route order; for an opted-in route this change deliberately substitutes configured strategy selection. Unconfigured routes retain that behavior. Reconcile those pending requirement texts during implementation/sync so archive order cannot restore an unconditional route-order rule.

## Goals / Non-Goals

**Goals:** A small public choice interface with a rich prepared snapshot; per-route trusted TS customization; unchanged defaults; explicit ownership of automatic stickiness; no new provider execution path.

**Non-Goals:** A built-in optimizer, policy composition framework, arbitrary route creation, sandboxing, subprocesses, dispatch-time data fetching, persistent strategy-private state, or new cross-process allocation guarantees.

## Decisions

### 1. Per-route module and options

Configuration extends each route with an optional setting:

```json
{
  "strategy": {
    "module": "/home/operator/.config/pi/routing/balanced.ts",
    "options": { "avoidPeak": true, "resetHorizonMinutes": 120 }
  }
}
```

Use an absolute local file path, no URL/package-name guessing or cwd-relative resolution. Omission selects the built-in ordered/sticky strategy; delete the setting to roll back. Options are a JSON object and are copied into the snapshot; arbitrary router config, provider key declarations and secret references are not forwarded. Options must themselves contain no secrets; the router cannot detect secrets deliberately placed in trusted custom data.

The module default-exports `{ version: 1, choose }`. Start loading once during extension initialization, shared by canonical module path for the Pi process; options remain per invocation. Bun's native module cache does not reliably invalidate a `.ts` import when only its file content changes, so restart Pi after editing strategy source. Extension reload is sufficient for changed route settings/options, but not cached source code. Pi-Bolt's runtime is Bun, which natively loads TypeScript modules; use its standard dynamic import seam, rather than adding jiti or depending on Pi's private loader. This keeps the router dependency surface unchanged. Loader failures disable only the affected strategy and use compatibility selection.

### 2. Snapshot in, one choice out

Publish types through the router package's `strategy` subpath; type-only imports in custom modules create no runtime dependency on router internals. The core shape is:

```ts
export interface RoutingStrategy {
  readonly version: 1;
  choose(context: RoutingContext): RoutingChoice;
}
export interface RoutingChoice {
  readonly targetId: string;
  readonly reason: string;
}
```

`RoutingContext` version 1 is deeply readonly and frozen at invocation. It contains JSON-compatible plain objects only. Target IDs reuse the existing physical/provider/model/account identity function. No `Model`, `ExtensionContext`, credential source, health store or messages object crosses this seam.

Snapshot fields:

- `version`, `now` (epoch ms), `route` (role, declared capacity, reserve, configured order, retry/transition limits), `options`.
- `mode`: preview or dispatch; `reason`: initial, continuation, direct, failover or admission-retry. Preserve the original failure context when reselection follows admission refusal.
- `targets`: configured, account-expanded target descriptors with registration/eligibility state and known rejection reasons; `eligibleTargetIds` is the sole permitted output domain.
- Each resolved target: provider/model/account, display name, context/output capabilities, configured and effective thinking, pricing, peak and quota observations, plus known cache activity. Unregistered targets have no invented model facts.
- `currentTargetId`, optional pin/recovery target; remaining retries/transitions/recoveries; bounded failure classification and excluded IDs. No raw provider error message.
- `request`: context-token estimate with source (`pi-usage` or message heuristic), output reserve (a budget, not predicted output), session thinking/override as applicable. Direct calls have no fabricated session cache or pin state.

Default selection and custom invocation use the same prepared candidate set. No strategy returns a ranking or a new candidate. Explanations are required, plain text, control-character normalized and capped at 512 characters; oversized/malformed outputs fail validation. Reject promises/thenables rather than awaiting them; safely observe rejected promises to avoid unhandled rejections.

Prefer an ordinary function over a rules DSL or scored-feature interface: policy authors can implement simple rules or their own scores without exposing that machinery as router policy. Strategies must be synchronous, deterministic over the supplied snapshot and free of I/O and mutable cross-invocation policy state. Trusted TS can violate those requirements; freezing is not a sandbox.

### 3. Facts, not invented economics

Quota projection copies every existing window, mapping, observed time, freshness and authority, plus known refresh status. Represent missing/stale/invalid/unavailable distinctly. Shared provider/account observations may be referenced by multiple model targets but must not be treated as independent budgets. No new CodexBar call occurs during preview or dispatch. Local health fallback may coexist with unavailable shared quota facts; unknown stays unknown.

Project pricing from existing native metadata and cached exact-key catalog/override sources, respecting the current precedence and preserving source/as-of information where available. Supply USD-per-million-token rate components and partial/tiered status; do not collapse missing prices to zero. Expose peak state/multiplier separately, using existing provider/model schedules. Only provide adjusted effective rates when their off-peak/already-adjusted basis is established; otherwise leave them unknown. In particular, do not multiply Command Code's already-adjusted native rates twice. Subscription quota consumption per token is not derivable from list price and remains unknown unless explicitly available from existing data.

Cache projection includes logical/physical/account identity, last successful activity and estimated expiry where recorded. Other targets are unknown, not guaranteed cold or warm. A monetary switching-cost estimate is optional and includes assumptions/provenance; version 1 may leave it null when token reuse, retention pricing or rates are insufficient. No new cost forecasting subsystem is required.

### 4. Safety precedence and bounded reselection

Automatic selection order:

1. Apply existing auth/key capability checks, health/quota causes, context/output fit and current-attempt exclusions. When a transition budget is exhausted, automatic alternatives requiring a transition are not selectable.
2. Honor a fresh eligible manual pin override for one resolution, then explicit recovery targets and admitted bounded same-target transient retries. Persistent pins are automatic-selection context, not an override of the healthy incumbent under ordered selection. Preserve the existing direct-call path's active-only credential behavior and absence of session pin semantics.
3. Invoke the configured strategy; default strategy uses last served target then configured order. Custom strategies see current and persistent-pin context but are not overridden by ordinary incumbent stickiness.
4. Validate the choice, or fall back to default selection over the same eligible set.
5. Perform existing shared probe admission, awaited transition/cache flush and verified credential activation. Strategy code cannot mutate those operations.

A refused admission adds that target to the per-attempt exclusions before another call. Retain the existing fail-closed policy for activation/flush failures rather than turning every exception into a fresh automatic replay. A genuine retry/failover is invoked only when Pi/router recovery already permits it; partial output remains non-replayable. Empty eligible sets use existing exhaustion diagnostics. The loop has at most one selection per remaining target before exhaustion; errors inside a strategy are not provider health failures.

Do not add a second global stickiness/hysteresis layer. Policy authors control that tradeoff using current target and cache evidence. Document the risk of oscillating strategies; the illustrative strategy prefers the incumbent on equal policy preference and only switches when an explicit rule changes preference.

### 5. Shared preview and clear semantics

Route preview, pin normalization and dispatch use the same snapshot builder and choice evaluator. Preview uses cached data and records no probe/credential/cache activity. Its `mode` is explicit; the result remains tentative because time, quota and admission may change. Do not promise byte-identical snapshots at different times.

Cycling retains configured eligible order. Pin-to-auto normalization evaluates custom automatic choice without the pin, avoiding recursion. Existing per-candidate thinking resolution supplies both preview and dispatch fields; thinking preference behavior does not change. The overflow-recovery selection path must use the same explicit precedence; a fresh user pin may override automatic recovery preference, but not eligibility or transition safeguards.

### 6. Diagnostics and example policy

Extend existing decision records with strategy ID (built-in or module identity), selection origin (strategy, default, pin, retry, recovery), normalized explanation, fallback category and relevant observation timestamps. Log physical changes and strategy fallbacks; avoid routine unchanged-success records and repeated UI warnings. Never serialize the full snapshot/options or arbitrary thrown error text. Existing transition warnings cover custom automatic switches. Module paths/options are not echoed in TUI errors.

Ship one documented, typechecked sample TS module demonstrating peak avoidance and fresh authoritative near-reset quota preference, with thresholds as options and current-target/config-order ties. Module source changes require a Pi process restart because the host caches imports. It is not an enabled built-in strategy. Explicitly document rule precedence and that every applicable quota window constrains usable allowance; unknown readings do not earn a quota bonus. Keep its rule ordering illustrative rather than claiming universal economic optimality.

## Risks / Trade-offs

- Trusted synchronous code can block the Pi process indefinitely → document small pure functions; no false promise of a cancellable timeout. A worker/process sandbox would be a separate change.
- Automatic switching can cost more than it saves → expose cache evidence, demonstrate incumbent ties and log explanations; no automatic monetary guarantee.
- Quota percentages and list prices are not comparable across plans → preserve units, provenance and all windows; leave marginal dollars/consumption unknown.
- Module/preview failures can spam diagnostics → bounded categorized messages, deduplicated in the UI; no arbitrary exception payloads.
- Rich context can become coupled to private types → versioned plain public types; adapter owns existing data translation; additive fields within v1, incompatible semantics require a new version.

## Migration Plan

1. Add contract, loader and default implementation without enabling custom modules.
2. Wire all automatic selection/preview callers through the evaluator while retaining existing recovery, direct-call and flush contracts.
3. Document and exercise a sample module with controlled snapshots; only enable it on a route when the operator opts in.
4. Roll back by removing that route's strategy setting and reloading. Existing account/health/cache/pin state remains valid; no state migration or shared-store schema change is required.
