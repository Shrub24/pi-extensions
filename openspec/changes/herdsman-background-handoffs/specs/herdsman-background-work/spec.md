# Background work

## Purpose

Keep managed worker assignments alive while their background work or result review remains outstanding, without premature result publication or silent process loss.

## ADDED Requirements

### Requirement: Assignment-scoped outstanding work

Outstanding work SHALL belong to an exact worker session and assignment. It SHALL include running processes, unfinished output capture and terminal results not yet resolved through an explicit result handoff. A delivered completion notification alone MUST NOT resolve work. Work from a completed assignment MUST NOT become work of a later assignment.

#### Scenario: Exit before result readiness
- **WHEN** a process exits but its output capture is still flushing
- **THEN** its assignment remains outstanding and cannot settle

#### Scenario: Notification without retrieval
- **WHEN** a terminal result's completion notification has been delivered but its result has not been handed over
- **THEN** the task remains outstanding for assignment settlement

#### Scenario: Reused worker
- **WHEN** a worker accepts a later assignment after its earlier assignment resolved
- **THEN** only work belonging to the later assignment can hold its completion

### Requirement: Automatic waiting instead of premature completion

At turn settlement, a worker with outstanding owned background work SHALL enter public state `waiting`. Its assignment SHALL remain active and its process SHALL remain alive regardless of the worker retention setting. No completed result SHALL be published and no completion candidate from before the wait SHALL become the final result.

#### Scenario: Retention disabled
- **WHEN** a worker ends its turn with a running task and `retainWorkers` is false
- **THEN** it enters waiting without publishing a result or closing its pane

#### Scenario: Early assistant conclusion
- **WHEN** a worker produces concluding text while its task is outstanding
- **THEN** that text is not accepted as assignment completion

### Requirement: Wake, review and resume

Completion/readiness and progress reminders SHALL resume waiting workers through the existing background-work wake delivery. Waiting SHALL NOT require a blocking wait tool or repeated model polling. Terminal work SHALL be resolved by a successful result handoff or a confirmed cancellation with its result; an explicitly delivered unrecoverable capture error SHALL resolve the work as a failure, never as success.

#### Scenario: Exit notifications disabled
- **WHEN** a waiting worker's task reaches terminal-ready state with ordinary exit notifications disabled
- **THEN** the required assignment-resolution wake still reaches the worker once

#### Scenario: Multiple completions
- **WHEN** multiple waiting tasks become ready together
- **THEN** the existing wake mechanism coalesces them without duplicate result delivery

#### Scenario: Partial retrieval
- **WHEN** a running task is inspected or a terminal result handoff fails
- **THEN** it remains outstanding

#### Scenario: Irrecoverable capture
- **WHEN** the worker explicitly receives an unrecoverable result-capture error
- **THEN** the work can resolve as a recorded failure without certifying complete output

### Requirement: Safe controls and deadlines while waiting

A directly owned waiting worker SHALL expose inspect, transcript and steer when their existing prerequisites hold, and extend when its advisory window is armed. It MUST NOT expose interrupt, new-task continuation or Clear idle eligibility; direct invocations SHALL enforce the same restrictions. Pending owner questions SHALL retain their exact reply rules. Waiting assignments SHALL count as unresolved work and remain subject to the existing idle-lead soft-deadline digest.

#### Scenario: Interrupted waiter
- **WHEN** the owner calls interrupt on a waiting worker
- **THEN** the request is rejected without cancelling tasks or changing the assignment

#### Scenario: Owner redirects cooperatively
- **WHEN** the owner steers a waiting worker to retrieve or stop its tasks
- **THEN** the correction resumes the same assignment without admitting another task

#### Scenario: Waiting advisory window expires
- **WHEN** a waiting assignment's window expires and its lead is idle
- **THEN** the normal digest includes it with current eligible controls and no interrupt option

### Requirement: Race-safe settlement and recovery

The settlement decision SHALL revalidate task and assignment identities. Outstanding work SHALL survive recoverable session restart without being mistaken for idle or completed. Settlement SHALL occur exactly once only after work is resolved and a final worker response is produced after result review. An unavailable registered work provider SHALL prevent success rather than look like zero tasks; workers without that provider SHALL retain their ordinary lifecycle.

#### Scenario: Exit races with settlement
- **WHEN** task completion or retrieval races with turn settlement
- **THEN** no result is published before resolution and no duplicate completion is produced

#### Scenario: Restart while waiting
- **WHEN** a waiting worker or its lead restarts
- **THEN** recovered ownership and unresolved task evidence preserve the active assignment until reconciliation succeeds

#### Scenario: Provider unavailable
- **WHEN** a registered provider cannot reconcile its task state
- **THEN** the assignment exposes an actionable blocked/error condition rather than a completed result

#### Scenario: No background module
- **WHEN** a worker has no managed background-work provider
- **THEN** the additional hold does not prevent ordinary completion
