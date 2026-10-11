# Spec Delta

## Purpose

Coordinate request-driven physical prompt-cache expiry with pending context materialization while preserving healthy-route stickiness and native provider execution.

## ADDED Requirements

### Requirement: User-owned physical cache TTL

The router SHALL accept an optional positive TTL in milliseconds per physical candidate from its existing user-only configuration. Missing TTL SHALL disable expiry handling for that candidate. It SHALL reject malformed TTLs and SHALL NOT infer provider TTL guarantees or import Magic Context's retired idle-TTL policy.

#### Scenario: Existing configuration
- **WHEN** a candidate has no TTL configured
- **THEN** routing and flushing remain unchanged from the initial router contract

#### Scenario: Physical configuration
- **WHEN** a user configures a TTL for one physical candidate
- **THEN** only that candidate's session cache-age policy uses the TTL

### Requirement: Successful session activity anchors cache age

The router SHALL anchor estimated cache age to successful session provider responses on the selected physical route, including successful tool-use responses. Failed, aborted and direct requests SHALL NOT refresh or consume the session cache epoch. Branch state SHALL preserve valid activity and consumed-expiry records across resume and fork; older state without cache metadata SHALL remain usable without an initial expiry flush.

#### Scenario: Failure and auxiliary traffic do not refresh age
- **WHEN** a failed or direct request occurs after the last successful session response
- **THEN** the original session cache-expiry boundary remains unchanged

#### Scenario: Restored branch
- **WHEN** an expired cache epoch is restored in a resumed or forked session
- **THEN** the next session dispatch uses the restored age rather than assuming a new warm cache

### Requirement: Sticky request-driven expiry flush

At or beyond the configured idle TTL, the router SHALL await Magic Context's flush before the next session request's context transformation and physical provider dispatch. Expiry alone SHALL NOT change a healthy physical route. It SHALL NOT flush on initial selection, unexpired epochs, direct requests or an expiry already consumed without a subsequent success. It SHALL NOT create timers or warming requests.

#### Scenario: Same-model expired request
- **WHEN** the next session request reaches an unconsumed TTL boundary
- **THEN** pending drop/history changes materialize before provider dispatch and the physical route remains unchanged

#### Scenario: Recovery within the consumed epoch
- **WHEN** the post-expiry request fails and native Pi retries on the same physical route without a success
- **THEN** the retry does not flush the same expired epoch again

### Requirement: Safe composition with physical transitions

The router SHALL perform at most one flush when expiry and a physical-model transition coincide in a dispatch. Existing transition counters and events SHALL continue to represent actual physical changes. Successful expiry flush SHALL consume the boundary only after acknowledgment; refusal, timeout or abort SHALL prevent the affected replacement request and leave the expiry eligible for a later safe attempt.

#### Scenario: Simultaneous expiry and failover
- **WHEN** a dispatch changes the physical model while its prior cache epoch is expired
- **THEN** it flushes once and reports one actual physical transition

#### Scenario: Flush refused
- **WHEN** the flush fails, times out or the user aborts
- **THEN** no affected physical request is dispatched and the epoch is not recorded as successfully consumed

### Requirement: Estimated invalidation observability

The router SHALL expose a distinct observation identifying the session, logical and physical route and TTL-expiry reason after successful expiry-boundary flushing. It SHALL label the boundary as estimated expiry, not confirmed provider eviction. Cache-read misses SHALL NOT independently trigger repeated flushes. Magic Context flush SHALL retain its established pending drop/history scope and SHALL NOT imply automatic compression or same-turn disk-backed system-adjunct refresh.

#### Scenario: Same physical model
- **WHEN** a same-model expiry is successfully flushed
- **THEN** an estimated cache-invalidation observation is emitted without a physical-transition observation
