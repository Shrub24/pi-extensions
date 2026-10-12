# Proposal

## Why

Pi computes `Usage.cost` for each assistant message from the selected physical model's own cost rates, and pi-otel exports that reported total. Pi's own rates are the primary source and stay so. Two cases still need pricing from outside Pi: a model whose recorded price is missing, and a provider whose time-of-day pricing Pi does not model (OpenCode Go's DeepSeek peak windows). The router already handles the second with a fixed multiplier. The first is handled by a catalog backfill that does not yet run for models Pi knows (see design, Decision 3).

Pi 1.1.0 offers no public API that updates one model's cost. Replacing a provider's model list to change a price would risk the provider's other models, so this change does not mutate Pi's registry.

## What Changes

- Keep Pi's recorded `Usage.cost` as the primary cost for every physical model. Pricing is applied to a finalized message only as a documented adjustment, and the router never edits the model registry.
- Keep the existing opt-in, bounded refresh of provider-specific catalog records (models.dev, with LiteLLM as a fallback for exact provider/model keys it holds), stored as a last-valid snapshot. Refresh runs only on `/pricing refresh`, never on dispatch.
- Decide and implement when a catalog price may fill in for Pi's recorded price, then test it (see design, open decision).
- Keep the time-of-day peak multiplier for OpenCode Go DeepSeek models, exported through `pi.pricing.peak_multiplier`.
- Tag catalog-derived cost so telemetry distinguishes it from Pi-recorded and peak-adjusted cost.
- Keep unknown and partial prices unknown rather than free.

## Capabilities

### New Capabilities
- `physical-model-pricing`: Maintain explicit, provenance-bearing price data and apply it as documented adjustments to native physical-model usage cost, without treating any estimate as billed cost.

### Modified Capabilities
- None.

## Impact

Affects `pi-native-router` (pricing catalog, reconciliation in the `message_end` handler, `/pricing` commands) and pi-otel's export of the reconciled cost and its provenance attribute. No change to route selection, credentials, shared health, quota tracking or deployment activation. Pricing has no account or shared-health prerequisite and can be disabled without affecting routing.
