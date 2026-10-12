# Design

## Context

See proposal.md. Pi 1.1.0 computes `Usage.cost` on each assistant message from the physical model's `cost` rates per million tokens (input, output, cache read, cache write), and pi-otel exports the reported total. Its public `ModelRegistry` exposes `find`, but no method updates one model's cost. The only registration seam, `registerProvider(name, {models})`, replaces every model of the provider, cost included, so using it to change one price means re-registering the provider's whole list. The router therefore reconciles cost after the fact, on the finalized message, and leaves the registry alone.

The catalog sources are estimates of list price. They do not establish what a provider billed an account.

## Goals / Non-Goals

**Goals:** Keep Pi's recorded cost primary. Apply catalog backfill and peak adjustment as explicit, tagged adjustments on the finalized message. Keep refresh bounded and off the dispatch path. Keep unknown prices unknown.

**Non-Goals:** Changing the registry or any model's cost through it, price-aware routing, invoice or subscription reconciliation, a second cost calculator in pi-otel, caching or warming requests, and credentials.

## Decisions

1. **Pi's recorded cost is primary.** `message_end` may replace `usage` only for the documented adjustments below. Provider-reported or Pi-computed cost is never overwritten by a catalog estimate that Pi's registry already prices.

2. **Refresh is separate from dispatch.** `/pricing refresh` fetches models.dev provider records (bounded: 20 s, 12 MB, redirects refused) and LiteLLM's map, validates them, and keeps the last valid snapshot at `$PI_CODING_AGENT_DIR/pi-native-router/pricing.json` with mode `0600`. Dispatch reads only that file. No background polling.

3. **Open decision: when does a catalog price fill in for Pi's recorded price?** The current code calls the backfill only when `ctx.modelRegistry.find` returns no model (`piModel?.cost !== undefined` is false). Pi registers every model it knows with a cost object, so for every model in our routes the backfill never runs. The intended rule is unresolved. Two options:
   - **A. Missing model only (current effective behaviour).** The backfill fills in only for models absent from Pi's registry. Simple, and it matches the code, but it leaves the backfill with no effective case for our routes.
   - **B. Missing or placeholder price.** The backfill also applies when Pi's registry cost is all zero and the snapshot holds a complete, nonzero record for the exact provider/model. An explicit zero from a complete catalog record that is also zero stays zero, so genuinely free models such as `opencode-go/longcat-2.5-preview-free` are not repriced.
   Recommendation: B, because it is the only option that backfills a placeholder. The choice must be made before tasks 3.1 and 3.2 are implemented. Until then the spec states the requirement without picking an option.

4. **Exact mapping and overrides.** Lookup is by exact `provider/model` key in the snapshot, with `pricing.overrides` taking precedence and recording its own provenance. Name similarity never maps a model. Tiered records are reported partial and are not applied.

5. **Peak adjustment.** OpenCode Go's `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4.1-flash` (and the vision and `deepseek-flash` aliases) are doubled on weekdays 01:00–04:00 and 06:00–10:00 UTC, using the published DeepSeek windows. Weekends are off-peak. The adjustment sets `peakMultiplier: 2`, which pi-otel exports as `pi.pricing.peak_multiplier`. The schedule has been tested by driving handlers, not against live traffic.

6. **Tag catalog-derived cost.** A catalog backfill is marked with a provenance value such as `pi.pricing.source = "catalog"` (and `"override"` for local overrides). Pi-recorded cost and peak-adjusted Pi cost are left without a catalog tag. pi-otel exports the tag next to `gen_ai.usage.cost`. It does not recalculate cost.

## Risks / Trade-offs

- [Catalog price differs from the account's real rate] → Catalog-derived values are labelled as estimates with the snapshot's retrieval time. They are never presented as billed cost.
- [Option A leaves the backfill inert] → Decision 3 must be resolved explicitly; the spec does not claim the backfill is active until it is.
- [Peak schedule changes or is wrong] → Schedule is hard-coded from published DeepSeek windows; verify on live traffic before relying on its totals.
- [Model that Pi prices at zero really is free] → Option B only fills a zero from a complete, nonzero catalog record for the exact key.
- [Source schema changes] → Validate strictly, retain the last valid snapshot, and surface failures.

## Migration Plan

Without a snapshot, without overrides and outside peak windows, the router changes no cost. `/pricing refresh` only writes the snapshot file. Rollback deletes the snapshot or disables the pricing handler; Pi's native cost then applies unchanged. Nothing rewrites provider catalogs or activates a deployment as part of this change.
