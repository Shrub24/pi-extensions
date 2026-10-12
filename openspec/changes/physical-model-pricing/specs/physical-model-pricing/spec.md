# Spec Delta

## Purpose

Define how price data is sourced and applied as documented adjustments to native physical-model usage cost, and how that cost is labelled in telemetry. Catalog and peak-derived values are estimates and are never presented as provider-billed cost.

## ADDED Requirements

### Requirement: Bounded catalog snapshots
The system MUST refresh catalog prices only through an explicit `/pricing refresh`, from provider-specific catalog records, using a bounded fetch. Refresh MUST be separate from route selection and provider dispatch. Each stored snapshot MUST retain its source identity and retrieval time. Catalog data MUST NOT be treated as billed provider cost.

#### Scenario: Snapshot is available
- **WHEN** a refresh obtains valid records from the configured catalog source within its bounds
- **THEN** the system stores a snapshot with the source and retrieval time
- **AND** the refresh initiates no model traffic and does not affect candidate selection

#### Scenario: Refresh is unavailable or invalid
- **WHEN** the source is unavailable, malformed or larger than its bound
- **THEN** the system keeps the last valid snapshot, reports the failure, and does not replace prices with zero

### Requirement: Exact physical model lookup and overrides
The system MUST look up catalog prices only by exact `provider/model` key, with explicit local overrides taking precedence for that key. It MUST NOT match by model name alone, fuzzy alias, virtual route identity or broad capability catalog. An override MUST retain its own provenance.

#### Scenario: Same name under another provider
- **WHEN** a model name exists under two providers in the catalog
- **THEN** only the exact provider's record applies to a request for that provider

#### Scenario: Local override
- **WHEN** a valid override exists for an exact provider/model key
- **THEN** its rates are used instead of catalog rates and provenance identifies the override

### Requirement: Units and price completeness
The system MUST represent rates as USD per one million tokens, separately for input, output, cache read and cache write. It MUST distinguish an explicit numeric zero from an absent rate. A missing rate MUST make the affected amount unknown or partial, never free. A tiered record without a supported tier MUST NOT be applied as complete.

#### Scenario: Complete record
- **WHEN** all rate components needed by the observed usage are known
- **THEN** the catalog estimate is computed from the matching usage components in USD per million tokens

#### Scenario: Missing cache rate
- **WHEN** a record omits a cache-read or cache-write rate and the observed usage includes that component
- **THEN** the estimate is reported as partial or unknown, not priced as zero

#### Scenario: Explicit zero
- **WHEN** the source explicitly supplies a zero rate
- **THEN** the component is treated as a known zero, distinct from an absent rate

### Requirement: Recorded cost stays primary
The system MUST treat Pi's recorded cost for a finalized assistant message as the primary cost. A catalog price MUST fill in only where the requirement for backfill is met (see the backfill requirement below). The system MUST NOT modify the physical model registry to change a model's price.

#### Scenario: Pi prices the model
- **WHEN** Pi's registry supplies a price for the physical model
- **THEN** the catalog snapshot does not replace Pi's recorded cost

#### Scenario: Registry is not mutated
- **WHEN** a price adjustment is applied
- **THEN** only the finalized message's usage is replaced, and no provider's model list is re-registered

### Requirement: Catalog backfill
The system MUST backfill a catalog estimate for a physical model only when the backfill rule in the design (open decision 3) is met and the record is complete for the observed usage. The rule MUST be fixed before this requirement is claimed as active. Until it is, no catalog backfill is reported as in effect.

#### Scenario: Backfill applies
- **WHEN** the backfill rule is met and a complete exact record exists
- **THEN** the finalized usage cost is replaced with the catalog estimate and tagged with catalog provenance

#### Scenario: Backfill does not apply
- **WHEN** the backfill rule is not met or the record is partial
- **THEN** the recorded cost stays as it is and no catalog provenance is attached

### Requirement: Time-of-day peak adjustment
The system MUST double the recorded cost of OpenCode Go's DeepSeek models during the published weekday peak windows (01:00–04:00 and 06:00–10:00 UTC), set the usage's peak multiplier to 2, and leave every other model and every weekend unchanged.

#### Scenario: Peak window
- **WHEN** a DeepSeek model finishes a message on a weekday between 01:00 and 04:00 UTC
- **THEN** each recorded cost component is doubled and the peak multiplier is 2

#### Scenario: Off-peak or other model
- **WHEN** the model is not a listed DeepSeek model, or the time is a weekend or outside the windows
- **THEN** the recorded cost is unchanged and no peak multiplier is set

### Requirement: Provenance and estimate semantics in telemetry
Telemetry MUST export Pi's reported `gen_ai.usage.cost` without independent recalculation. A catalog or override estimate MUST carry a provenance attribute so consumers can tell it from Pi-recorded cost. The system MUST NOT describe any estimate as an invoice, actual charge, or subscription cost.

#### Scenario: Catalog estimate exported
- **WHEN** a finalized message carries catalog backfill
- **THEN** pi-otel exports the cost with the catalog provenance attribute set

#### Scenario: Recorded or peak cost exported
- **WHEN** the cost is Pi-recorded, with or without a peak multiplier
- **THEN** no catalog provenance is attached, and the peak multiplier is exported when set

#### Scenario: Provider-reported amount
- **WHEN** a provider supplies its own usage cost
- **THEN** the amount is not overwritten or relabelled as catalog-derived
