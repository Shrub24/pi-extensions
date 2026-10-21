# Spec Delta

## Purpose

Share error-specific provider and account health across local Pi processes so recovery avoids known-unavailable targets without replaying unsafe requests or penalizing healthy alternatives.

## ADDED Requirements

### Requirement: Shared health applies across processes and logical routes

Participating Pi processes for the same user on one machine SHALL consult persistent shared health before selecting a routed target. An account block SHALL apply to every logical route and model using that account and SHALL survive a process restart.

#### Scenario: Worker discovers exhausted account
- **WHEN** worker A observes account X's explicit quota exhaustion
- **THEN** worker B and a parent subsequently skip every target using X
- **AND** another account for the same provider remains eligible

#### Scenario: Process restarts during cooldown
- **WHEN** a Pi process restarts before a stored cooldown deadline
- **THEN** the unavailable scope remains blocked until its recovery policy permits admission

### Requirement: Health evidence is independent of replay safety

The router SHALL classify provider health observations independently of retry eligibility. Known provider failure after partial output SHALL update its applicable health scope without authorizing replay. User aborts and non-provider errors SHALL NOT create health penalties.

#### Scenario: Quota failure follows partial output
- **WHEN** a provider reports explicit quota exhaustion after partial text, thinking or a tool call
- **THEN** the account-wide quota observation is recorded
- **AND** the failed request is not automatically replayed

#### Scenario: Request is malformed or aborted
- **WHEN** a request fails from invalid input, context overflow, an extension error or user cancellation without independent provider failure evidence
- **THEN** no shared provider/account penalty is recorded

### Requirement: Failure scope follows specific evidence

Explicit quota exhaustion and invalid API keys SHALL affect the account. Model access failures SHALL affect the account/model. Rate limits SHALL use verified provider semantics or the narrow account/model default. Provider-wide blocks SHALL require explicit service-wide evidence. HTTP status alone SHALL NOT turn every 403 or 429 into an account-wide quota block.

#### Scenario: Specific quota code inside a 429 response
- **WHEN** status 429 carries an explicit account quota-exhaustion code
- **THEN** all models on that account are blocked

#### Scenario: Model access denial inside a 403 response
- **WHEN** status 403 identifies denied access to model M for account X
- **THEN** only X/M is penalized
- **AND** another permitted model on X and another account remain eligible

#### Scenario: Opaque rate limit
- **WHEN** a 429 contains no trustworthy account-wide or service-wide scope information
- **THEN** the default penalty is limited to the attempted account/model

### Requirement: Reset deadlines and fallback backoff are distinct

Credible provider retry/reset deadlines SHALL be retained without truncating long quota windows to a short transient-error cap. Missing or unusable deadlines SHALL use bounded failure-specific backoff. Deadline expiry SHALL permit recovery probing rather than declaring the scope healthy.

#### Scenario: Weekly quota deadline
- **WHEN** an authenticated quota failure supplies a credible reset seven days later
- **THEN** its quota block retains that deadline
- **AND** another model on the account cannot bypass it after a short local cooldown

#### Scenario: Reset information is absent
- **WHEN** quota exhaustion has no usable reset time
- **THEN** bounded quota backoff is recorded and recovery uses the shared probe policy

### Requirement: Recovery probes are atomically leased and fenced

At cooldown expiry only one process SHALL acquire a probe lease for the blocked scope. Other processes SHALL skip that scope while its lease is active. Lease expiry SHALL recover from a crashed probe, and late results from an expired or replaced lease SHALL NOT overwrite newer health.

#### Scenario: Simultaneous expiry in two workers
- **WHEN** two workers try to recover the same account at the same deadline
- **THEN** one obtains admission to probe and the other selects another eligible target or reports exhaustion

#### Scenario: Probe crashes and old result arrives late
- **WHEN** a probe lease expires, a replacement probe updates health, and the old probe reports afterward
- **THEN** the old result cannot clear or replace the newer record

### Requirement: Older attempts cannot clear newer failures

Shared updates SHALL retain observation and attempt ordering. A success from a request admitted before a later failure SHALL NOT clear that newer block. Successful fenced recovery SHALL clear only the scopes it actually proves recovered.

#### Scenario: In-flight success after new quota failure
- **WHEN** request A began before request B recorded account quota exhaustion, and A then succeeds
- **THEN** B's account quota block remains active

#### Scenario: Successful probe does not clear an unrelated block
- **WHEN** a model-level recovery succeeds while an independent account auth block exists
- **THEN** the account auth block remains active

### Requirement: Shared health does not replace native recovery policy

Shared admission SHALL preserve configured order, healthy-route stickiness, context compatibility and existing retry/transition/recovery bounds. It SHALL NOT schedule provider execution itself. Direct routing SHALL remain independent of session state while respecting applicable shared health.

#### Scenario: Fallback becomes healthy and sticky
- **WHEN** a session successfully falls back to eligible account Y
- **THEN** later requests remain on Y while eligible, even if X's cooldown expires

#### Scenario: No shared target is admissible
- **WHEN** all compatible targets are blocked or being probed
- **THEN** the router reports scoped exhaustion without spinning, replaying completed tools or taking another process's probe lease

### Requirement: Shared state and diagnostics are secret-free and bounded

The router SHALL expose inspect and explicit scoped-reset operations with normalized reason, scope, deadline and probe status. It SHALL NOT retain keys, auth headers, raw response bodies or transcripts. Store failure SHALL produce a bounded diagnostic and degrade to retained process-local health rather than hanging dispatch or claiming shared coordination succeeded.

#### Scenario: Shared store is unavailable
- **WHEN** shared-state access fails or exceeds its bounded access time
- **THEN** dispatch may continue under retained local health and configured recovery limits
- **AND** diagnostics identify degraded local-only coordination

#### Scenario: Operator clears one account
- **WHEN** the operator explicitly resets account X's health
- **THEN** unrelated accounts and provider scopes are not cleared
- **AND** the reset fences older probe results
