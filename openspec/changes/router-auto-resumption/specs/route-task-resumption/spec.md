# Spec Delta

## Purpose

Allow an explicitly authorized session task to wait for scoped provider capacity and safely continue when that capacity becomes available, without replaying completed work or waking unrelated sessions.

## ADDED Requirements

### Requirement: Explicit session authorization

Resumption SHALL require explicit authorization for the current session task. It SHALL support one successful resumption or standing authorization through capacity pauses until normal task settlement, cancellation or deadline. Direct calls and unarmed sessions SHALL never be resumed by this capability.

#### Scenario: Unarmed exhaustion
- **WHEN** an unarmed session exhausts its route
- **THEN** it settles normally without a pending wake

#### Scenario: Once and standing modes
- **WHEN** an armed task resumes successfully after a capacity pause
- **THEN** once mode disarms
- **AND** standing mode remains armed until normal successful settlement, cancellation or deadline

### Requirement: Explicit capacity scope

The waiting scope SHALL default to the current route and SHALL support a provider, provider/account or exact physical model/account within that route. A pinned-target convenience SHALL snapshot the exact current pin when armed. Pins SHALL NOT implicitly narrow the scope or retarget an armed wait.

#### Scenario: Route-wide wait
- **WHEN** a task waits on its route and any candidate becomes admissible
- **THEN** normal route selection can resume it without waiting for the primary or stored pin

#### Scenario: Named provider or account
- **WHEN** a task waits for a provider or account
- **THEN** recovery outside that scope does not wake it
- **AND** candidates absent from the route cannot be introduced by the wait

#### Scenario: Pinned target is a snapshot
- **WHEN** the user arms a pinned-target wait and later cycles the pin
- **THEN** the waiting scope remains the captured target
- **AND** status continues to name that target

### Requirement: Capacity pauses are distinguished from other failures

Waiting SHALL begin only after ordinary recovery has ended with quota exhaustion or a reset-bound rate limit and every otherwise usable candidate in scope is capacity-blocked. Abort, auth failure, invalid requests, context mismatch, unavailable credentials and exhausted safety budgets alone SHALL NOT authorize waiting or reset recovery bounds.

#### Scenario: All usable candidates quota-blocked
- **WHEN** terminal settlement leaves all otherwise usable scoped candidates blocked by quota
- **THEN** an armed task enters waiting with the blocking scopes and next check recorded

#### Scenario: Mixed non-capacity rejection
- **WHEN** no candidate serves because credentials are missing or context cannot fit rather than recoverable capacity
- **THEN** the session stops with that diagnostic and does not enter an automatic retry loop

### Requirement: Quota restoration requires scoped evidence

Readiness SHALL consider all applicable quota windows and health scopes. Reset deadlines SHALL schedule rechecks, not declare success. A fresh usable authoritative reading showing capacity, or an expired failure-derived cooldown with no contradictory quota evidence, SHALL permit one normal leased recovery attempt. Manual resets and unavailable or stale readings SHALL NOT alone prove restoration.

#### Scenario: Short window resets but weekly window remains exhausted
- **WHEN** the five-hour window resets while the weekly window is exhausted
- **THEN** the task remains waiting

#### Scenario: Earlier provider restoration
- **WHEN** a fresh authoritative quota reading restores all limiting windows before the old predicted reset
- **THEN** readiness is reevaluated without waiting for the old deadline

#### Scenario: Tracker refresh fails after operator clear
- **WHEN** an operator clears tracker blocks but the tracker returns unavailable
- **THEN** absence of the block alone does not wake the task

### Requirement: Readiness constrains actual dispatch

A resumed attempt SHALL select only admissible candidates inside the armed scope using existing route policy, credentials, fit checks, probe leases and awaited transition handling. A waiting scope SHALL NOT bypass blocks like a manual pin override. If readiness becomes stale before dispatch, the task SHALL return to waiting within its limits.

#### Scenario: Provider-specific continuation
- **WHEN** a provider-scoped task wakes while another provider would otherwise be selected
- **THEN** dispatch remains within the armed provider scope

#### Scenario: Capacity consumed before dispatch
- **WHEN** another session consumes the restored capacity or holds its recovery lease
- **THEN** no unauthorized candidate or duplicate probe is dispatched
- **AND** the task remains waiting or stops at its configured limit

### Requirement: Safe continuation and bounded wakes

Resumption SHALL preserve transcript and tool state through a supported native continuation boundary. Completed tools SHALL NOT be replayed. Unsafe partial output or unresolved tool execution SHALL leave the task stopped. Wake attempts SHALL be bounded by an explicit deadline and failure limit; a changed timer or quota observation SHALL NOT reset those limits.

#### Scenario: No-output quota failure
- **WHEN** a safe failed task regains capacity
- **THEN** the existing conversation continues once without duplicating its prior tool executions

#### Scenario: Unsafe partial completion
- **WHEN** terminal failure contains unsafe partial output or unresolved tool execution
- **THEN** no automatic continuation is scheduled and the reason is visible

#### Scenario: Repeated unsuccessful wakes
- **WHEN** the wake failure limit or authorization deadline is reached
- **THEN** the wait stops and notifies the operator instead of repeating indefinitely

### Requirement: Cancellation fences pending continuation

User abort, a new user task, selected model change, branch/session switch, explicit disarm and shutdown SHALL invalidate pending wakes before they can start execution. Successful normal task settlement SHALL disarm standing permission. Restart or session restoration SHALL require explicit re-arming rather than silently executing old intent.

#### Scenario: User changes model while waiting
- **WHEN** the user selects another route or direct model
- **THEN** the pending wait is cancelled instead of retargeted

#### Scenario: Late callback after cancellation
- **WHEN** a timer or quota refresh completes after cancellation
- **THEN** it cannot start a continuation for the cancelled intent

#### Scenario: Process restored
- **WHEN** a process or session restores a stored waiting intent
- **THEN** it shows the suspended intent but starts no execution until explicitly re-armed

### Requirement: One session owner per wake

An intent SHALL have one execution owner and one outstanding wake. Shared observations SHALL NOT awaken unarmed sessions. Concurrent observations, duplicated session processes and expired owners SHALL be fenced so that only one valid owner can dispatch a continuation.

#### Scenario: Reset observed by multiple Pi processes
- **WHEN** several processes observe the same quota reset
- **THEN** each can wake only its own explicitly armed task
- **AND** two owners of the same intent cannot both execute it

### Requirement: Controls and bounded diagnostics

The router SHALL provide arm-once, arm-standing, off and status controls with scope selection and optional deadline. Status SHALL identify mode, scope, blockers, next check, deadline and last outcome. Waiting and resuming SHALL be announced without per-poll noise. Stored diagnostics SHALL exclude credentials, prompts and raw provider bodies and use bounded retention.

#### Scenario: Operator inspects a waiting task
- **WHEN** status is requested
- **THEN** it states exactly which capacity the session awaits and when it will check next

#### Scenario: Standing permission completes
- **WHEN** the task finishes normally
- **THEN** the waiting indicator clears and the authorization is no longer active
