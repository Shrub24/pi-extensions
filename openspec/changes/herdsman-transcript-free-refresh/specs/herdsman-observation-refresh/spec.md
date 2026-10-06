# Spec Delta

## Purpose

Keeps recurring herd-observation refreshes — lead status, worker-leaf status, agent
health and supervision snapshots — free of session-transcript body loads, while
preserving bounded session identity checks, explicit transcript validation and
independently proven loss classification.

## ADDED Requirements

### Requirement: Recurring observation performs no transcript body load

Recurring observation refreshes — lead status, worker-leaf status, agent health and
supervision snapshots — SHALL NOT load or parse a session transcript body, and MUST
NOT call `SessionManager.open` on their recurring paths. This applies whether the
observed session is the process's own or another live agent's. Existing bounded
header-reader buffers remain permitted; incidental bytes after the header in such
a buffer MUST NOT be processed as transcript entries.

#### Scenario: Idle lead status refresh

- **WHEN** a lead's periodic status refresh runs while its session transcript is unchanged
- **THEN** the refresh calls no `SessionManager.open` and reads no transcript body
- **AND** the rendered status rows and lead breadcrumb are produced

#### Scenario: Worker, health and supervision refreshes

- **WHEN** a managed worker's leaf status refresh, an agent health scan, or a supervision snapshot runs on its recurring interval
- **THEN** none of those paths calls `SessionManager.open` or reads a transcript body

### Requirement: Bounded session identity checks remain permitted and unchanged

Existing bounded session-header identity checks SHALL remain in place and MUST NOT be
widened into a transcript body load. An exact-path identity proof MAY read the
bounded session header only, and its fail-closed outcome MUST be preserved.

#### Scenario: Bounded header identity proof

- **WHEN** an exact-path identity check needs the session id of a transcript file
- **THEN** the bounded session header read proves or rejects the identity
- **AND** no transcript body is parsed

#### Scenario: Bounded check still rejects

- **WHEN** the bounded header records a different session id than expected
- **THEN** the identity check rejects the mismatch exactly as before this change

#### Scenario: Existing missing-file path fallback is preserved

- **WHEN** the exact observed path matches the saved expected path but canonicalization reports `ENOENT`
- **THEN** the existing exact-path fallback is preserved
- **AND** this change introduces no stricter path-existence requirement

### Requirement: Periodic lead authority is derived from coordination state

On recurring paths, the authority that marks an owner session as a lead SHALL be the
published lead coordination state for that session, not the contents of the owner's
session transcript.

#### Scenario: Lead with published coordination state

- **WHEN** an owner session has published coordination state whose role is lead
- **AND** the recurring refresh observes that owner's agents
- **THEN** the owner is observed as a lead without reading its transcript body

#### Scenario: Worker resolves its owner's authority

- **WHEN** a managed worker's recurring refresh needs its owner's lead authority
- **THEN** the authority is resolved from the owner's published coordination state
- **AND** the owner's transcript body is not read

### Requirement: Missing or malformed coordination evidence stays unknown

When coordination state is absent, unreadable, oversized or malformed, the recurring
refresh SHALL report the observed authority as `unknown`. It MUST NOT fail the
refresh, MUST NOT report the owner as a lead, and MUST NOT infer `lost` from that
absence.

#### Scenario: Malformed coordination record

- **WHEN** the coordinator record for a candidate owner is malformed or unreadable
- **THEN** the refresh completes and the observed authority is `unknown`
- **AND** neither a transcript body nor `lost` is substituted for the missing evidence

#### Scenario: Legacy lead without a coordinator record

- **WHEN** an owner session is genuinely a lead but has published no coordinator record
- **THEN** its recurring authority is `unknown` rather than `herd`

### Requirement: Loss and staleness classification stays independently proven

Absence of recurring coordination evidence alone SHALL NOT classify an agent as
`lost` or `stale`. Proven-loss, unresolved-`unknown` and expired-`stale`
classifications SHALL keep their existing independent evidence and MUST remain
unchanged by this change.

#### Scenario: Missing evidence is not loss

- **WHEN** an owner's coordinator evidence is missing but no independent loss evidence exists
- **THEN** its periodic lead classification is unresolved
- **AND** missing coordinator evidence alone changes neither independently observed agent activity nor presence classification

#### Scenario: Independently proven loss is unchanged

- **WHEN** an agent is proven lost by its existing independent evidence
- **THEN** it still projects as `lost`
- **AND** an expired observation still projects as `stale`

### Requirement: Unresolved observations are displayed but never trusted as authoritative

An `unknown` observation MAY be displayed as unresolved and MAY be republished as the
current tick's observation. It MUST NOT be persisted, cached or reused as a session's
authoritative identity, definition or authority, and a later explicit resolution
SHALL win over an earlier recurring `unknown`.

#### Scenario: Unknown is shown as unresolved

- **WHEN** a recurring refresh resolves `unknown` for a live agent
- **THEN** the unresolved state is displayed without failing the refresh

#### Scenario: Explicit resolution wins over an earlier unknown

- **WHEN** a recurring refresh reports `unknown` and a later explicit path resolves the real legacy definition or identity
- **THEN** the explicit resolution is the value used
- **AND** the earlier recurring `unknown` is not reused as authoritative

### Requirement: Periodic definition resolution does not load legacy transcripts

When a mailbox carries no current agent definition, recurring paths SHALL report the
definition as `unknown` rather than loading the legacy session transcript to
reconstruct it.

#### Scenario: Mailbox without a recorded definition

- **WHEN** a recurring refresh encounters a mailbox whose agent definition is absent
- **THEN** the reported definition is `unknown`
- **AND** no session transcript body is loaded to derive it

### Requirement: Names come from published pane facts

Display names used by recurring observation SHALL come from the facts already
published onto panes, and MUST NOT require loading a session transcript body.

#### Scenario: Supervision snapshot naming

- **WHEN** a supervision snapshot labels a live agent whose pane publishes a name fact
- **THEN** the snapshot uses that published name
- **AND** no transcript body is loaded to obtain a session name

#### Scenario: No published name fact

- **WHEN** a live agent publishes no name fact
- **THEN** the snapshot falls back to another already-available observation field
- **AND** still loads no transcript body

### Requirement: Overlapping refreshes are bounded and generation-safe

At most one refresh of a kind SHALL run at a time, and at most one pending rerun SHALL
be queued while it runs. Triggers arriving during an in-flight refresh MAY schedule
later runs after it completes; sustained fresh triggers are not prohibited from
causing later runs. A superseded generation or a shutdown MUST NOT publish.

#### Scenario: Refresh exceeds its interval

- **WHEN** a status or supervision refresh exceeds its own interval
- **THEN** exactly one refresh of that kind is in flight and at most one rerun is pending
- **AND** two refreshes of the same kind never run concurrently

#### Scenario: Sustained fresh triggers

- **WHEN** new triggers keep arriving while a refresh is in flight
- **THEN** later runs occur only after the in-flight refresh finishes
- **AND** the pending queue never exceeds one rerun

#### Scenario: Superseded generation

- **WHEN** a refresh completes after the observed generation or role changed
- **THEN** its result is discarded and no partial state is published

#### Scenario: Shutdown clears pending work

- **WHEN** the extension shuts down or the session is replaced
- **THEN** the pending rerun is cleared and no refresh starts afterwards

### Requirement: Explicit transcript reads and identity validation are preserved

Operations that require transcript contents SHALL keep validating identity against
that transcript. Explicit transcript reads, continuation and settlement identity,
definition-conflict detection and retirement checks MUST remain authoritative and
fail closed.

#### Scenario: Explicit transcript read

- **WHEN** an operator or agent explicitly requests a session transcript
- **THEN** the transcript body is opened and its contents returned

#### Scenario: Conflicting or retired identity is still rejected

- **WHEN** an identity-sensitive operation finds conflicting definition entries or a retired session
- **THEN** it fails closed exactly as before this change
