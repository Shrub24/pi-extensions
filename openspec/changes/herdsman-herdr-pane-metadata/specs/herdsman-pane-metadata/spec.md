# Pane metadata

## Purpose

Give Herdr one Herdsman-owned, documented, bounded stream of display metadata per Pi pane, separate from the semantic agent state that the official Herdr integration owns.

## ADDED Requirements

### Requirement: State authority is not Herdsman's

Herdsman SHALL NOT report semantic agent state, session identity or release for a pane. The official Herdr Pi integration is the only reporter of those. Herdsman publications MUST NOT change Herdr's `idle`, `working`, `blocked`, waits, notifications or rollups.

#### Scenario: Metadata only
- **WHEN** Herdsman publishes any token for a pane
- **THEN** it uses only display metadata requests and never a state-report request

### Requirement: One publisher and one source per process

A Herdsman process SHALL publish all of its pane's metadata through one queue under one role-based source. Session-self tokens and orchestration tokens MUST NOT be written from independent code paths, and superseded queued snapshots MUST be dropped in favour of the latest.

#### Scenario: Worker publishes once
- **WHEN** a worker's model and its active task change in quick succession
- **THEN** one publication carries the latest values and no stale intermediate snapshot is sent after it

### Requirement: Session-self tokens

When enabled, a lead or managed worker SHALL publish `model`, `provider`, `thinking`, `session` and `context_usage` for its own pane. Each value MUST be sanitised terminal text bounded to 80 characters. `context_usage` MUST be a whole-number percentage. A value that is unknown MUST be cleared, not retained.

#### Scenario: Unknown usage
- **WHEN** the context usage cannot be read
- **THEN** `context_usage` is cleared rather than left at its previous value

#### Scenario: Oversized or control text
- **WHEN** a value contains terminal control sequences or exceeds 80 characters
- **THEN** control sequences are removed and the value is truncated at 80 characters

### Requirement: No overlapping token names

Herdsman SHALL NOT publish the same token name from two sources on one pane. The previous bare worker tokens `managed`, `role`, `request`, `task`, `started`, `ctx`, and worker-published bare `model` and `thinking` outside the session-self set, MUST be removed. All orchestration tokens use the `pi_herdsman_` prefix.

#### Scenario: Worker token set
- **WHEN** a worker has an active assignment
- **THEN** its published orchestration tokens are all prefixed `pi_herdsman_` and no bare legacy orchestration token is present

### Requirement: Bounded refresh and clearing

Publications SHALL carry a TTL and be refreshed before it elapses while the process lives. Shutdown, role change and session replacement SHALL clear the process's tokens. A clear MUST NOT remove tokens owned by another source.

#### Scenario: Refresh before expiry
- **WHEN** a session stays open past half of the TTL without any value change
- **THEN** its current tokens are republished

#### Scenario: Other source survives
- **WHEN** a process clears its own tokens at shutdown
- **THEN** tokens published by other sources on that pane are unaffected

### Requirement: Gating and best-effort delivery

Publication SHALL occur only for the `lead` and `managed-agent` roles with a Herdr pane id. It MUST be best effort: failure, timeout or a missing Herdr binary MUST NOT fail delegation, block a turn or throw into Pi. Sessions outside Herdr publish nothing.

#### Scenario: Not in Herdr
- **WHEN** a session has no Herdr environment
- **THEN** no metadata is published and no error is surfaced

#### Scenario: Publication failure
- **WHEN** a metadata request fails
- **THEN** delegation and the current turn continue unaffected

### Requirement: Documented token contract

A reference document SHALL list every published token, its source, role, value form, bound, and clearing rule, and SHALL include a machine-readable fixture of a lead, a worker and an owner-view publication that herdr-radar can consume in its own tests.

#### Scenario: Contract matches behaviour
- **WHEN** the deterministic tests run
- **THEN** the produced token sets for each role equal the documented fixture

### Requirement: Reporter loading is verified

The worker launch argument list SHALL load the Herdr state integration at most once. A missing installed integration SHALL be reported once with its install command and MUST NOT make the cause of a launch failure obscure.

#### Scenario: Single load
- **WHEN** a worker is launched
- **THEN** its extension arguments contain no duplicate path for the Herdr integration
