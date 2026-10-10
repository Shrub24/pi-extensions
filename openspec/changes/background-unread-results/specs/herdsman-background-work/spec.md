# Spec Delta

## Purpose

Hold a managed worker's assignment only while its background work can still change, keep an
unretrieved terminal result as durable advisory state rather than a lifecycle block, and
report those results to the owner alongside the answer they did or did not inform.

## MODIFIED Requirements

### Requirement: Assignment-scoped outstanding work

Outstanding work SHALL belong to an exact worker session and assignment, and SHALL include
only work that can still change or can never become a certified result: a running process,
an output capture still flushing, or a terminal capture explicitly marked uncertified. A
certified terminal result SHALL NOT be outstanding work, whether or not its result was
retrieved. A delivered completion notification alone MUST NOT resolve unfinished work.
Consumer decisions SHALL use only `captureCertified === false` to identify uncertified
captures; task reason text MUST NOT be inspected to infer readiness.

#### Scenario: Exit before result readiness

- **WHEN** a process exits but its output capture is still flushing
- **THEN** its assignment remains outstanding and cannot settle

#### Scenario: Notification without retrieval

- **WHEN** a terminal result's completion notification has been delivered but its result has not been handed over
- **THEN** the assignment is not held by that result if the capture is certified
- **AND** the delivered result names it as unreviewed

#### Scenario: Notification for an uncertified capture

- **WHEN** a terminal result's completion notification has been delivered but its capture is marked `captureCertified: false`
- **THEN** the assignment remains held until explicit resolution

#### Scenario: Capture that never certifies

- **WHEN** a restored task's capture can never be certified and the provider marks it `captureCertified: false`
- **THEN** its assignment remains outstanding until explicit recovery, error delivery, or dismissal
- **AND** retrieval reports the loss as an unrecoverable capture rather than a complete result

#### Scenario: Reused worker

- **WHEN** a worker accepts a later assignment after its earlier assignment resolved
- **THEN** only unfinished work belonging to the later assignment can hold its completion

### Requirement: Automatic waiting instead of premature completion

At turn settlement, a worker with unfinished owned background work SHALL enter public state
`waiting`. Its assignment SHALL remain active and its process SHALL remain alive regardless
of the worker retention setting. An unretrieved terminal result MUST NOT produce `waiting`,
withhold settlement, or restrict controls.

#### Scenario: Retention disabled

- **WHEN** a worker ends its turn with a running task and `retainWorkers` is false
- **THEN** it enters waiting without publishing a result or closing its pane

#### Scenario: Early assistant conclusion

- **WHEN** a worker produces concluding text while its task is running or flushing
- **THEN** that text is not accepted as assignment completion

#### Scenario: Only unreviewed results remain

- **WHEN** a worker ends its turn with certified terminal results that are unretrieved
- **THEN** it does not enter `waiting`
- **AND** it publishes its result through the ordinary settlement path

#### Scenario: Only an uncertified terminal capture remains

- **WHEN** a worker ends its turn with a terminal capture explicitly marked uncertified
- **THEN** it remains `waiting` and does not publish a successful result
- **AND** the capture remains outstanding until it is recovered, an error is delivered, or it is explicitly dismissed

## REMOVED Requirements

### Requirement: Wake, review and resume

**Reason**: Superseded by "A held worker is resumed and re-queried without a wake", which
keeps wake delivery, bounded re-query and exactly-once publication while dropping the
clause that made result handoff a resolution condition for terminal work. That clause
held a finished worker's answer undelivered.

**Migration**: Waiting workers are still resumed by the background-work wake and
re-queried while held. Certified terminal work no longer gates settlement; an uncertified
capture remains held until explicit recovery, error delivery or dismissal.

## ADDED Requirements

### Requirement: Uncertified terminal captures remain outstanding

An `awaiting-result-review` entry marked `captureCertified === false` SHALL remain
outstanding and block settlement until explicit recovery, error delivery or dismissal.
Consumers MUST use only this field value to identify uncertified captures, never reason
text.

#### Scenario: Uncertified capture blocks settlement

- **WHEN** the provider reports an `awaiting-result-review` entry marked `captureCertified === false`
- **THEN** the worker remains held until that task is explicitly resolved

### Requirement: A held worker is resumed and re-queried without a wake

Completion/readiness and progress reminders SHALL resume a waiting worker through the
existing background-work wake delivery. Waiting SHALL NOT require a blocking wait tool or
repeated model polling. While an assignment is held, the worker SHALL re-query the provider
on a bounded cadence, and publication SHALL remain exactly once per assignment.

#### Scenario: Exit notifications disabled

- **WHEN** a waiting worker's task reaches terminal-ready state with ordinary exit notifications disabled
- **THEN** the required assignment-resolution wake still reaches the worker once

#### Scenario: Multiple completions

- **WHEN** multiple waiting tasks become ready together
- **THEN** the existing wake mechanism coalesces them without duplicate result delivery

#### Scenario: Resolution without a wake

- **WHEN** a held worker's provider reports the unfinished work resolved without delivering a wake
- **THEN** the worker still produces and publishes exactly one post-resolution result through the bounded provider re-query

### Requirement: The delivered result names unreviewed background results

When a worker settles while terminal results of its own remain unretrieved, the result
published to its owner SHALL name each such task with its identity and outcome. Naming them
SHALL NOT change settlement, retention, or the task's lifecycle.

#### Scenario: Settling with unreviewed results

- **WHEN** a worker publishes its answer while two terminal results of its own remain unretrieved
- **THEN** the published result names both tasks and their outcomes

#### Scenario: Controls after settling

- **WHEN** such a worker has settled and is idle
- **THEN** the ordinary owner controls, including interrupt, are exposed
