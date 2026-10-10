# Spec Delta

## Purpose

Keep a session's capture store out of what the model is told, give an unretrieved result an
explicit way out, make every wake say what each of its tasks actually owes the reader, and
tell the consumer which outstanding work can never certify.

## ADDED Requirements

### Requirement: Clearing can target exact tasks

`clear` SHALL accept specific task ids and remove only those, reporting what it kept. A bulk
clear SHALL remove finished tasks without removing running work, and SHALL report any
terminal task it deliberately did not remove.

#### Scenario: Clearing one task by id

- **WHEN** a caller clears one of three finished tasks by id
- **THEN** only that task is removed
- **AND** the remaining tasks stay retrievable

#### Scenario: Bulk clear with running work

- **WHEN** a bulk clear runs while a task is still running
- **THEN** the running task is kept and reported as kept

### Requirement: An unretrieved terminal result can be explicitly dismissed

A terminal result whose output was never handed over SHALL be dismissible. A dismissal SHALL
be recorded as its own resolution kind, distinct from a delivered result and from a capture
error, and MUST NOT be reported as a successful output handoff.

#### Scenario: Dismissing an unretrieved result

- **WHEN** a caller dismisses a terminal task whose result was never retrieved
- **THEN** the task records a deliberate discard rather than a delivery or a capture error
- **AND** it no longer classifies as awaiting retrieval

#### Scenario: Dismissal does not reach running work

- **WHEN** a dismissal targets a task that is still running
- **THEN** the request is refused and the task is unaffected

### Requirement: An uncertified terminal capture is distinguishable from an unretrieved result

A settlement snapshot SHALL mark, per outstanding task, whether its terminal capture is certified, so a consumer that must tell a capture loss apart from a certified result it merely has not retrieved does not have to read the reason text. A restored terminal capture whose record left readiness unestablished SHALL be marked uncertified; a certified terminal result SHALL carry no such mark, and the mark SHALL NOT appear on running or flushing work.

#### Scenario: A restored capture that never certified

- **WHEN** a snapshot reports a terminal task whose capture was never certified, as after a restore
- **THEN** that task's entry is marked as an uncertified capture
- **AND** it remains outstanding until its result is delivered or dismissed

#### Scenario: An ordinary unretrieved result

- **WHEN** a snapshot reports a certified terminal result whose output was never retrieved
- **THEN** its entry carries no uncertified mark
- **AND** it is indistinguishable from any other certified terminal result awaiting retrieval

### Requirement: Wakes name each task's result status

Every completion, progress and reminder wake SHALL name, for each task it reports, the task
id, its outcome or state, and whether its result is still unretrieved. A batched wake SHALL
carry that same per-task detail rather than a count alone.

#### Scenario: A single completion wake

- **WHEN** one task reaches a terminal state and its wake is delivered
- **THEN** the wake names its outcome and whether its result is still unretrieved

#### Scenario: A batched completion wake

- **WHEN** several tasks reach terminal states in the same turn and their wake is coalesced
- **THEN** each task is named with its own outcome and result status
- **AND** the wake does not reduce them to a count or a single summary line

### Requirement: An unretrieved result stays retrievable and reminded

A terminal result SHALL remain retrievable and protected from retention until it is
delivered or explicitly dismissed, and an unretrieved result SHALL remain subject to the
review reminder until then.

#### Scenario: An unretrieved result outlives the finished-task bound

- **WHEN** a terminal result belonging to a bound assignment is never retrieved
- **THEN** retention keeps it past the finished-task bound

#### Scenario: A reminder for unretrieved output

- **WHEN** an unretrieved terminal result's review interval elapses
- **THEN** a wake names the task and the retrieval or dismissal it still owes

### Requirement: The capture path is not model-facing

A task operation's model-facing text SHALL NOT name the capture file, its directory, or a
snapshot copy of it. The model-facing structured result of a `bash` command SHALL NOT name
it either: the field that would carry the file holding the complete output is left unset.
The path MAY remain in tool-result details for the operator surface.
Where a response is too large, the reference offered for the complete content SHALL be the
truncated-output artifact rather than the capture path.

#### Scenario: An ordinary full read

- **WHEN** a caller retrieves a terminal task's complete output
- **THEN** the model-facing text names no filesystem path
- **AND** the operator surface still carries the capture path

#### Scenario: A response too large to deliver

- **WHEN** the delivered output exceeds the response limits
- **THEN** the complete content is referenced through the truncated-output artifact
- **AND** no capture path is disclosed

#### Scenario: A structured result for an oversized command

- **WHEN** a managed command's output exceeds what its structured result carries
- **THEN** that result marks the output as truncated
- **AND** it names no file from which the missing bytes could be read
