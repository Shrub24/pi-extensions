# Design

## Context

See proposal.md for motivation. `installRouter` currently instantiates one in-memory `Health`; `choose` consults it and retry/boundary hooks update it. Quota/auth failures use provider keys because account identity did not exist. `classify` treats partial output as unsafe before health recording, and its deadline hints cap at 15 minutes. Nearby policy tests explicitly exercise those behaviors.

This change depends on `router-api-key-accounts` for stable canonical provider/account/attempt identity. No quota fetching belongs here; `router-account-quotas` adds that separate source.

## Goals / Non-Goals

**Goals:** Share just health decisions across participating same-user local Pi processes; retain native execution and bounded router recovery. Make failure evidence, safe replay and admission separately testable.

**Non-goals:** Multi-host coordination, distributed locks, account quota pools, scheduling all provider concurrency, a daemon, selecting by price/headroom, replacing Pi auth refresh or intercepting transports.

## Decisions

### Separate observation from safe recovery

Normalize attempt evidence into a small health observation: account/model/provider scope, failure kind, verified code/status, observed time, attempt admission revision and optional credible deadline. Separately evaluate whether the original request may continue/retry using existing empty-output/abort/non-provider guards.

Record a supported quota observation after partial output, but do not remove/replay that assistant entry or completed tools. An abort alone is not a provider failure. Unknown text remains unknown. Preserve native-formatted status handling, but replace the blanket 403-auth interpretation when explicit model-access evidence is present.

No raw body is stored. Structured status/code/reset hints are consumed only through documented native evidence; if the current host discards relevant response metadata, the scoped host handoff must expose normalized attempt metadata, not a monkeypatched provider transport. Code-only errors with no reset remain supported through fallback backoff.

### Use account identity and explicit scope precedence

Persistent keys are:
- Account: canonical provider + account ID.
- Account/model: canonical provider + account ID + physical model ID.
- Provider: verified canonical service scope.

A default native auth target uses the reserved default-account identity from the account change. Native OAuth refresh remains Pi-owned; only final provider-auth failures are observations. Adding multiple OAuth accounts is not part of this design.

Explicit Go subscription/quota errors and invalid-key codes block the account. Access denial narrows to account/model. Rate limits default to account/model unless provider-specific authenticated semantics justify account scope. Transient model/transport errors stay narrow; a local network failure is not proof of a service-wide outage.

Selection consults every applicable scope. Store each cause independently so recovering quota cannot accidentally clear auth or a provider outage. Do not add a quota-pool grouping abstraction for this release.

### One small transactional local store

Use a private user-state SQLite database, with atomic transactions for observations, admission and probe leases. Choose a supported binding after a targeted runtime check against deployed Pi and the declared Node test host; do not assume Bun-only imports or optional experimental Node APIs are portable. Keep one backend, not a generalized persistence framework.

Minimal tables hold scoped cause records and their revision/deadline, plus fenced probe leases. Account identities are configuration labels, not key hashes. Apply user-only directory/file permissions, schema versioning and bounded busy/access timeouts. No network server or unbounded migration/cleanup job.

Do not use process-local maps as the source of truth or unlocked read-modify-write JSON. Maintain a bounded local last-known mirror for degradation; access failure emits a bounded diagnostic and uses local health without pretending cross-process guarantees hold.

### Admission is an atomic state transition, not a sleep loop

For each applicable blocked scope:
- Before deadline: skip.
- At/after deadline: atomically lease a single recovery attempt.
- Lease held elsewhere: skip.
- Eligible without causes: use ordinary ordered/sticky selection.

Choose the target and acquire all applicable probe admissions in one transaction, or acquire none. Candidate inspection must not consume a lease for a target later rejected by capacity/auth checks. Bound leases; a crashed process eventually releases admission through expiry. Do not heartbeat ordinary long requests into an unbounded lease.

A successful eligible probe clears only its proved causes under the same revision/lease fence. A late result cannot clear an operator reset, a replacement probe or a newer failure. Successful requests admitted before a block cannot erase that block. Multiple failures keep the strongest applicable current deadline; stale observations cannot shorten it.

Pi still schedules native retries. The router only admits/selects targets and records observations; it adds no retry timers or new execution queue.

### Credible resets outlive transient backoff caps

Provider-specific parsing validates units, source and future reset plausibility. Retain explicit weekly/monthly deadlines instead of clamping every failure to the existing 15-minute hint limit. Unknown resets use bounded category-specific backoff; a failed recovery probe can increase that backoff without unlimited growth.

Persist wall-clock deadlines for cross-process/restart comparison, with rollback/skew checks. A contradictory/invalid timestamp becomes unknown rather than immediate healthy status. Expiry opens a probe, not unrestricted healthy admission.

### Expose a narrow observation and diagnostics boundary

A health-store facade supports reading/admitting targets, recording attempt observations and fenced resets/recovery. `router-account-quotas` can add source-labelled quota observations through that boundary; it cannot edit unrelated cause records directly.

Operator inspect/reset uses the existing router command/extension style. Reports distinguish shared versus local-only state and show normalized scope, reason, deadline and probe lease. Resetting one account fences old results but does not clear a provider-wide outage.

## Risks / Trade-offs

- [Shared storage adds contention/runtime requirements] -> Small indexed transactions, bounded timeouts, runtime compatibility gate and local degradation.
- [Broad guesses disable healthy alternatives] -> Narrow defaults and explicit source-backed widening.
- [Quota block conflicts with a concurrent success] -> Attempt admission ordering and cause-specific revision fencing.
- [Process crashes while probing] -> Bounded lease with stale-result fencing; duplicate physical work after lease expiry is possible, but old results cannot erase current health.
- [Store unavailable permits extra quota failures] -> Explicit local-only degradation; do not stall all Pi execution on advisory coordination.
- [Raw provider details leak sensitive data] -> Persist only allowlisted normalized fields, never messages/headers.

## Migration Plan

1. Require the account/attempt identity contract from `router-api-key-accounts`.
2. Refactor pure observation versus replay safety while retaining native-router safety tests.
3. Add versioned shared storage and bounded local fallback, then enable shared health by default for configured routes.
4. Verify two real processes sharing one store before documenting parent/worker behavior.
5. Roll back through an explicit process-local health mode; shared records remain inert and contain no secrets. No activation is implicit in this change.

## Validation

The decisive experiment is two separate Pi/router processes: A records X quota exhaustion; B skips all X models but selects Y. A restart must retain X's block. A second two-process race at expiry must issue one fenced probe. Add focused scenarios for partial-output quota without replay, model-specific 403, native status strings, seven-day reset retention, stale success, crash/expired lease, scoped operator reset, storage failure and no-safe-target exhaustion. Keep fake-provider host tests for continuation/tool safety rather than constructing a broad new simulation framework.
