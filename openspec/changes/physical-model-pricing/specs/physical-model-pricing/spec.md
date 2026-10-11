# Spec Delta

## Purpose

Define how explicit physical-model price metadata is sourced, mapped, applied, and surfaced consistently for native usage accounting and telemetry without treating estimates as provider-billed cost.

## ADDED Requirements

### Requirement: Bounded catalog pricing snapshots
The system MUST refresh pricing only from an explicitly configured, provider-specific catalog source using a bounded cached snapshot. Refresh MUST be separate from route selection and provider dispatch. Catalog data MUST retain its source identity/version and retrieval time. The system MUST NOT treat models.dev data as billed provider cost.

#### Scenario: Catalog snapshot is available
- **WHEN** an enabled refresh obtains valid pricing records from the configured models.dev provider API
- **THEN** the system stores a bounded snapshot with source, catalog version or equivalent source revision, and retrieval timestamp
- **AND** the refresh does not initiate model traffic or affect candidate selection

#### Scenario: Refresh is unavailable or invalid
- **WHEN** the source is unavailable, malformed, or exceeds the configured bound
- **THEN** the system retains the last valid snapshot if present, reports the refresh failure, and does not replace prices with zero

### Requirement: Exact physical model mapping and overrides
The system MUST apply catalog rates only through explicit exact provider-and-model mappings or explicit local overrides. It MUST NOT match by model name alone, fuzzy aliases, virtual-model identity, or a broad capability catalog. A local override MUST take precedence for the exact mapped physical model and MUST retain its own provenance.

#### Scenario: Exact provider/model mapping
- **WHEN** a physical provider/model pair has an explicit mapping to a valid catalog record
- **THEN** only that physical model may receive the mapped rates
- **AND** a similarly named model under another provider remains unchanged

#### Scenario: Local override
- **WHEN** a valid local override exists for an exact physical provider/model pair
- **THEN** its rates are used instead of catalog rates and provenance identifies the override source

### Requirement: Explicit units and cache-price completeness
The system MUST represent rates as USD per one million tokens, independently for input, output, cache read, and cache write. The system MUST distinguish an explicitly supplied numeric zero from an absent or unknown rate. It MUST treat missing required rates as unknown, not free, and MUST NOT calculate a complete total from incomplete rates as though missing components were zero.

#### Scenario: Complete prices
- **WHEN** all applicable rate components are known and usage is available
- **THEN** native Pi cost calculation uses USD-per-million rates with the matching input, output, cache-read, and cache-write usage components
- **AND** the result is explicitly identified as estimated catalog-derived cost

#### Scenario: Missing or partial cache rates
- **WHEN** the catalog provides ordinary input/output rates but omits a cache-read or cache-write rate required by observed usage
- **THEN** the affected estimated total is unknown or explicitly incomplete, never silently priced as zero

#### Scenario: Explicit zero rate
- **WHEN** the source explicitly supplies a zero rate for a component
- **THEN** that component is distinguishable from a component whose rate is absent

### Requirement: Safe physical metadata application
The system MUST apply one frozen price snapshot to the supported physical model metadata before native usage cost calculation, without exposing credentials or changing routing behavior. If the supported Pi host cannot safely apply an updated snapshot before usage calculation, runtime application MUST remain disabled and the limitation MUST be reported rather than claiming native and telemetry agreement.

#### Scenario: Snapshot applied before usage
- **WHEN** a mapped physical model is resolved for a request and host feasibility is established
- **THEN** native Pi usage accounting receives the snapshot's model cost rates before calculating Usage.cost
- **AND** virtual routing selection remains independent of price

#### Scenario: Host cannot safely apply snapshot
- **WHEN** supported host APIs cannot update physical model rates before usage accounting
- **THEN** the pricing integration does not mutate routing or claim that native costs use catalog rates
- **AND** the host feasibility limitation remains visible

### Requirement: Provenance and estimated-cost semantics
Every catalog-derived or locally overridden price MUST carry provenance and version/retrieval information sufficient to identify the basis of its estimate. Catalog-derived estimated cost MUST remain distinguishable from provider-reported usage cost and subscription/account billing amounts. The system MUST NOT describe an estimate as an invoice, actual charge, or subscription cost.

#### Scenario: Estimated cost is exported
- **WHEN** Pi reports usage cost derived from applied catalog pricing
- **THEN** telemetry may export Pi's existing Usage.cost fields without independently recalculating cost
- **AND** the associated price provenance and estimated-versus-reported distinction remain available to consumers

#### Scenario: Provider-reported amount exists
- **WHEN** a provider integration supplies its own usage cost
- **THEN** that amount is not silently overwritten or relabeled as catalog-derived billing evidence
