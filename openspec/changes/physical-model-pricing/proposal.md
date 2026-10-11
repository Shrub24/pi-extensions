# Proposal

## Why

Native Pi computes `Usage.cost` from the selected physical model's `cost` rates, while pi-otel exports the reported `usage.cost.total`; incomplete or zero placeholder rates therefore make native usage accounting and telemetry misleading. Add an optional, auditable catalog-derived price snapshot that updates physical model metadata before use, while keeping unknown prices unknown and preserving provider-reported usage as authoritative telemetry.

## What Changes

- Add opt-in, bounded refresh of provider-specific pricing data from models.dev, with explicit exact provider/model mappings and local overrides.
- Apply a frozen price snapshot to supported physical model cost metadata so Pi's existing native accounting and pi-otel observe the same `Usage.cost` result.
- Represent USD per-million-token input, output, cache-read, and cache-write rates with provenance/version and retrieval time; do not infer zero/free prices from missing data.
- Keep refresh separate from routing/dispatch and avoid credential transport or price-based route selection.
- Gate activation on verifying that the supported Pi host can safely update pricing metadata before usage calculation; otherwise retain a documented host-feasibility gate and do not promise runtime application.

## Capabilities

### New Capabilities
- `physical-model-pricing`: Maintain and apply explicit, provenance-bearing catalog price metadata for native physical models and downstream usage telemetry.

### Modified Capabilities
- None. The existing capability inventory has no pricing capability.

## Impact

Planning affects a prospective pricing extension/integration, Pi 1.1.0 physical model registry and usage cost calculation, and pi-otel's existing `Usage.cost` export. The models.dev API is an external catalog source, not provider billing evidence. No router selection policy, subscription accounting, credentials, deployment activation, or external account/quota design changes are included. This work can roll out independently and has no account/shared-health prerequisite.
