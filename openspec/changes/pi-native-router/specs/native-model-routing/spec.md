# Spec Delta

## Purpose

Provide explicit, sticky native physical-model routing and safe provider recovery for ordinary Pi sessions and Herdsman workers.

## ADDED Requirements

### Requirement: Logical routes preserve native execution

The router SHALL register configurable logical models with ordered physical candidates resolved through Pi's model registry. Pi SHALL retain provider execution, credentials, streaming, reasoning, retry scheduling and physical usage accounting.

#### Scenario: Initial selection
- **WHEN** a configured logical model receives its first session request
- **THEN** it selects the first available, authenticated, context-compatible candidate not on cooldown
- **AND** the selected logical model remains distinct from the physical dispatch

### Requirement: Sticky branch-local session routing

The router SHALL preserve a healthy physical route through user turns and continuations, persisting JSON-serializable branch state across restore, fork and compaction. A successful fallback SHALL remain sticky rather than automatically returning to the original candidate.

#### Scenario: Healthy continuation and restored session
- **WHEN** a subsequent request or restored branch has a healthy stored route
- **THEN** it dispatches to that route rather than reselecting the first candidate

#### Scenario: Auxiliary request isolation
- **WHEN** a direct request uses a logical route
- **THEN** its selection is deterministic and does not mutate session stickiness, recovery budgets or session transition state

### Requirement: Bounded native recovery

The router SHALL distinguish transient transport/server errors, rate limits, quota exhaustion, authentication failures and non-provider errors. Ordinary retry routing SHALL use Pi's retry schedule. Eligible terminal provider failures SHALL receive bounded continuation through Pi's pre-settlement seam only when safe; recovery SHALL neither replay completed tools nor retry partial completed output. Aborts, malformed requests and context overflows SHALL NOT cause automatic migration.

#### Scenario: Transient retry then fallback
- **WHEN** a safe transient provider failure exceeds the configured stay budget
- **THEN** Pi's next native retry selects an eligible fallback
- **AND** recovery stays bounded across the execution

#### Scenario: Terminal quota exhaustion
- **WHEN** a provider returns terminal quota exhaustion without successful partial work
- **THEN** an eligible fallback can continue the existing session before final settlement
- **AND** exhaustion of candidates or recovery budget ends recovery predictably without a loop

#### Scenario: Abort or unsafe failure
- **WHEN** the request is aborted, malformed, over context, or contains unsafe partial output
- **THEN** the router does not request another execution

### Requirement: Scoped local cooldowns

The router SHALL apply local temporary cooldowns appropriate to failure classification, honoring available retry/reset information within bounded limits. Model-specific failures SHALL NOT disable unrelated healthy models; provider/account failures SHALL suppress that provider's affected candidates.

#### Scenario: Provider quota versus model failure
- **WHEN** an account-level quota failure is observed
- **THEN** alternatives using the affected provider are excluded until cooldown expiry
- **AND** a model-specific failure excludes only that model

### Requirement: Awaited physical transition lifecycle

Each actual session physical-model change SHALL expose an awaitable pre-dispatch seam and observational transition events. The router SHALL invoke and await Magic Context's existing flush request/result surface before replacement dispatch. Initial selection, direct requests and repeated same-model dispatch SHALL NOT trigger session flushes. Flush failure SHALL prevent replacement dispatch with a bounded diagnostic rather than hang or silently bypass the boundary.

#### Scenario: Replacement waits for context flush
- **WHEN** a session route changes from physical A to physical B
- **THEN** exactly one successful pre-dispatch flush completes before B is dispatched
- **AND** observation identifies the logical and physical models without changing the logical selection

### Requirement: Context-compatible lifecycle configuration

Routing SHALL preserve Magic Context's 200k-token pressure threshold and disable its independent idle-TTL execution trigger in the owning configuration. Flush SHALL NOT imply unconditional compression. With native Pi compaction disabled, incompatible candidates SHALL be rejected.

#### Scenario: Owning lifecycle policy
- **WHEN** routing is enabled for Pi
- **THEN** the owning Magic Context configuration disables Pi idle-TTL execution while retaining the 200k pressure threshold
- **AND** flush applies pending transformations without requesting unconditional wrapup

### Requirement: Conservative v0.1 capacity compatibility

Selection SHALL use canonical/latest-successful-usage estimates plus output reserve and initial logical capacity. A persisted, non-decreasing physical capacity floor SHALL prohibit smaller-window automatic fallback. This SHALL NOT be represented as a hard final-token guarantee: Pi 1.1.0 does not expose final extension-prepared context at route time.

#### Scenario: Smaller fallback
- **WHEN** a fallback is below the persisted physical capacity floor, configured logical capacity, or conservative context estimate plus required output reserve
- **THEN** the router skips it or stops with a clear exhaustion error
- **AND** a smaller physical window is rejected even when a small request appears to fit
- **AND** it does not invoke native Pi compaction
