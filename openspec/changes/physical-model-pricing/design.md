# Design

## Context

See proposal.md - Why. Pi's provider/model registry resolves physical models before request dispatch. The inspected Pi 1.1.0 `ModelRegistry` facade exposes synchronous physical `find(provider, modelId)` and refresh/auth/virtual-model APIs, but no public price mutation method. In the installed pi-ai runtime, usage cost is calculated from `model.cost` rates per million tokens (including cache read/write); the model shape has numeric rates and cannot by itself encode an unknown component. pi-otel's `SpanTracker` accumulates and exports `Usage.cost.total` from the assistant message; its tracker is not an independent calculator. Thus a supported safe seam to update physical model rates is a feasibility gate, not an established host capability.

The models.dev API provides provider-specific model records and pricing fields; its model-only `models.json` is not a substitute for provider-specific pricing. Catalog records do not establish what a provider billed an account. Existing Pi host types and internal registry implementation should be rechecked against the supported exact Pi release when implementing; no undocumented internals are assumed here.

## Goals / Non-Goals

**Goals:** Define an independently deployable, opt-in price metadata source, mapping, snapshot, and application contract; maintain consistent native `Usage.cost` and OTel visibility when a supported application seam exists; preserve source and estimate semantics.

**Non-Goals:** Price-aware routing, choosing among models, provider/account invoice reconciliation, subscriptions, broad capability metadata overrides, OTel-side cost arithmetic, secrets/auth transport, cache warming, or changing router-cache lifecycle.

## Decisions

1. **Separate refresh from dispatch.** A pricing component loads and validates a bounded catalog snapshot outside request dispatch; callers use the last valid frozen snapshot. This avoids network activity in route callbacks and keeps dispatch behavior deterministic. Reject on-demand dispatch-time catalog fetching and background polling as unnecessary complexity; refresh cadence and storage remain bounded configuration choices.

2. **Provider-specific source and exact mappings.** Use the models.dev provider API records, not model-only `models.json`, and require explicit exact `(provider, model)` mapping to a catalog record. Local overrides are exact-keyed and take precedence with explicit provenance. Do not guess aliases by name similarity: provider namespaces and model variants may have different rates.

3. **Normalize to USD per million tokens without losing unknowns.** Preserve distinct input, output, cache-read, and cache-write components. Validate finite nonnegative numbers but represent absent components as unknown in the pricing domain model. Since Pi's current cost-rate shape expects numeric values and computes a total, never coerce unknown to zero for an advertised complete estimate. Apply a rate set only when all components needed for the requested accounting semantics are known, or mark the resulting amount incomplete/unknown through a supported explicit path. An explicit source zero remains a valid known zero.

4. **Prefer a supported physical-model update seam; do not mutate hidden registry state.** Investigate and use a public host API that can update cost metadata on the actual resolved physical model before native usage accounting. Registry `find` returns a model, but mutating that object is not established as safe or stable by its public API. A virtual model wrapper or price-sensitive router policy is not an equivalent substitute. If no safe supported seam exists, keep runtime application disabled pending host support rather than patching private runtime internals or claiming price agreement.

5. **Reuse native cost production, not a second calculator.** Once supported metadata application is proven, Pi remains the sole calculator of `Usage.cost`; pi-otel continues exporting that supplied cost and token usage. Attach snapshot provenance/estimated status through a supported metadata/telemetry path, without presenting catalog rates as a provider-reported bill. A separate OTel calculator is rejected because it can diverge from provider-specific usage arithmetic and duplicate cost.

6. **Independent packaging and rollout.** Prefer an independently usable pricing extension/component with explicit opt-in and local settings, not a hard dependency on the native router. Router integration may be optional only if it can consume the physical metadata without owning catalog refresh or changing selection. This change has no account/shared-health prerequisite.

## Risks / Trade-offs

- [Catalog prices may be stale or differ from an account's negotiated billing] → label all catalog-derived values as estimates and expose source revision/retrieval time; never claim billed cost.
- [Current Pi host may not expose a safe physical cost update API] → feasibility gate is a release blocker for runtime application; do not use hidden mutation as a workaround.
- [Pi's numeric cost structure may force absent rates into zero] → do not apply incomplete price sets as complete estimates; preserve unknown/incomplete status outside that numeric structure or defer runtime application.
- [Models.dev schema changes or omits cache prices] → validate source fields strictly, bound cache size, retain last valid snapshot, surface source failure, and leave missing rates unknown.
- [A catalog rate might overwrite provider-reported semantics] → only update model metadata before usage calculation and retain provenance; never overwrite a provider-supplied usage result in telemetry.

## Migration Plan

No default behavior changes: without explicit enablement/mapping, model metadata and current native/OTel usage costs remain untouched. Roll out first with validation/preview of a bounded snapshot, then enable only after targeted accounting tests and host seam verification. Rollback disables the pricing component and restores ordinary registry metadata/configuration; do not persistently rewrite provider catalogs or activate deployments as part of this plan. This rollout is independent of account/shared-health work.
