# Agent hierarchy

## Purpose

Let a Herdr sidebar reconstruct who delegated to whom and what each worker's public state is, without Herdsman owning presentation and without parent-held child lists.

## ADDED Requirements

### Requirement: Session identity token

A lead or managed worker SHALL publish its own Pi session id as `pi_herdsman_session`. The value MUST be the session identity Herdsman already uses for ownership, MUST be cleared when no session is active, and MUST update when the session is replaced in the same pane.

#### Scenario: Session replaced
- **WHEN** a pane starts a new Pi session
- **THEN** `pi_herdsman_session` is replaced with the new session id

### Requirement: Child-owned parent pointer

A managed worker SHALL publish `pi_herdsman_parent_session` equal to its direct owner's Pi session id, taken from its launch environment. Leads SHALL NOT publish a parent pointer. Herdsman MUST NOT publish child lists, depth, sort keys, glyphs, colours or row order.

#### Scenario: Worker under a lead
- **WHEN** a lead delegates to a worker
- **THEN** the worker pane carries `pi_herdsman_parent_session` equal to the lead's session id and the lead pane carries no parent token

#### Scenario: Consumer derives the tree
- **WHEN** a consumer matches each `pi_herdsman_parent_session` against panes' `pi_herdsman_session`
- **THEN** it can derive parents, children and depth with no additional Herdsman-published data

#### Scenario: No presentation data
- **WHEN** any Herdsman publication is inspected
- **THEN** it contains no ordering, glyph, colour or layout token

### Requirement: Nested ownership correctness

For a worker that itself delegates, the published parent pointer SHALL be the identity of its direct delegating owner, not the root lead. Verification of that environment value is a prerequisite for supporting depth greater than one.

#### Scenario: Delegating worker
- **WHEN** a worker delegates to a second worker
- **THEN** the second worker's parent pointer equals the first worker's session id

### Requirement: Owner-published projection state

The owning agent SHALL publish `pi_herdsman_state` onto each directly owned worker's pane under a separate source `pi-herdsman:owner:<runId>`, with a TTL, reflecting the exact public projection state (`idle`, `working`, `blocked`, `settling`, `unknown`, `lost`, and `waiting` when available). The value MUST equal the public state name, MUST be refreshed while the owner lives, and MUST NOT be published by the worker itself.

#### Scenario: State change
- **WHEN** a worker's public projection changes from `working` to `settling`
- **THEN** the owner updates `pi_herdsman_state` on that worker's pane

#### Scenario: Worker is lost
- **WHEN** a worker's process is proven absent before a terminal result
- **THEN** the owner publishes `lost` for that worker, and the worker's own source is not required to be alive

#### Scenario: Owner crashes
- **WHEN** the owning agent stops refreshing
- **THEN** the TTL expires the owner-view token rather than leaving a stale state indefinitely

#### Scenario: Semantic state untouched
- **WHEN** the owner publishes a projection state
- **THEN** Herdr's semantic agent state for that pane is unchanged

### Requirement: Descendant visibility is not authority

Publishing hierarchy or projection tokens MUST NOT grant control. A record Herdsman does not directly own SHALL NOT receive owner-view state from this agent.

#### Scenario: Non-owned descendant
- **WHEN** a pane belongs to another owner's subtree
- **THEN** this agent publishes no `pi_herdsman_state` for it
