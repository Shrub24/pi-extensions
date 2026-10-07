# herdsman-control Specification

## Purpose
An operator surface can ask the owner of a managed worker to close or restart
it through a request/result file contract, and every outcome is one of a fixed
set the requester can derive from the files alone.

## Requirements

### Requirement: Requests are files in an owner-created trusted directory

The owner SHALL create `control/<ownerSessionId>/{inbox,results}` itself, owned
by the current user, mode 0700, not a symlink, and watch `inbox` from session
start. A requester SHALL refuse a directory that fails that check. A request and
a result SHALL each be written atomically as `<requestId>.json`, mode 0600, with
`requestId` a UUID, and SHALL NOT exceed 8 KiB.

#### Scenario: The directory is not trusted

- **WHEN** the control directory is a symlink, is not owned by the user, or is not mode 0700
- **THEN** the requester writes nothing and reports the directory untrusted

#### Scenario: The owner is watching before any request

- **WHEN** an owner session starts
- **THEN** its inbox exists and is watched before it handles a prompt

### Requirement: A request targets an identity, never a process

A request SHALL name `agent` and `runId`, and MAY name `paneId`, `piSessionId`
and `piSessionPath`. The owner SHALL refuse with `target_ambiguous` when any
supplied cross-check disagrees with its record, and SHALL refuse with
`target_not_found` when no managed worker matches `agent` and `runId`.

#### Scenario: A cross-check disagrees

- **WHEN** the request's `paneId` differs from the pane recorded for that run
- **THEN** nothing is closed and the result is `target_ambiguous`

#### Scenario: The target changes between receipt and effect

- **WHEN** the live session identity no longer matches at execution time
- **THEN** the result is `target_ambiguous` and nothing is changed

### Requirement: The owner re-runs the existing close preflight

Executing `close` SHALL apply every check `agent_close` applies, at execution
time: exact label resolution, live-session identity validation, the Herdr agent
integration match, exact-running proof, refusal on an unretrieved durable
result, and the pane close under the lifecycle lock with the assignment lock
held. A refusal SHALL use the existing error category for that condition.

#### Scenario: An unretrieved result blocks the close

- **WHEN** the target has an undelivered durable result
- **THEN** the close is refused and the pane is left open

#### Scenario: Presence cannot be proven

- **WHEN** the target's presence is `unknown`
- **THEN** the close is refused

### Requirement: Each request id has exactly three terminal states

The owner SHALL begin execution by creating `inbox/<requestId>.claim` with
`O_EXCL`; if creation fails it SHALL NOT execute. A request id is in exactly one
state: a result file exists; a claim exists with no result (execution started,
outcome unknown); or no claim exists and `expiresAt` has passed (not executed).
The owner SHALL refuse an expired request without acting, SHALL NOT retry a
claimed request, and at its next start SHALL write an `unknown` result for each
claim that has none.

#### Scenario: Two owners race one request

- **WHEN** two executions attempt the same request id
- **THEN** exactly one creates the claim and the other does not execute

#### Scenario: The owner dies mid-execution

- **WHEN** a claim exists with no result and the owner restarts
- **THEN** the owner writes an `unknown` result and does not repeat the operation

#### Scenario: The request outlives its owner

- **WHEN** no claim exists and `expiresAt` has passed
- **THEN** the requester reads "not executed" without any owner response

### Requirement: Restart applies only to an idle managed worker

`restart` SHALL relaunch an idle retained managed worker continuing the same Pi
session with its label, run id and lineage preserved. It SHALL refuse a working,
waiting or blocked target as `agent_busy`, a lost target as close-only, an
unknown presence, and a lead, root or standalone session as
`unsupported_target`.

#### Scenario: An idle worker restarts

- **WHEN** an idle retained worker is restarted
- **THEN** the result is `restarted` with `process_relaunched` and the same run id

#### Scenario: A working worker is refused

- **WHEN** the target is working
- **THEN** the result is `agent_busy` and the process is untouched

#### Scenario: A lead has no restart

- **WHEN** the target is a lead or standalone session
- **THEN** the result is `unsupported_target`

### Requirement: Confirmation is required and matches the target

A request SHALL carry a confirmation naming the operation, label and run id. The
owner SHALL refuse a request with no confirmation or a confirmation that does
not match its own target as `invalid_request`. A result SHALL list the effects
actually applied.

#### Scenario: The confirmation names a different agent

- **WHEN** the confirmation's label differs from the target's
- **THEN** the result is `invalid_request` and nothing is changed

### Requirement: Only positive evidence permits a direct close

A requester SHALL close a pane through Herdr directly only when it holds
positive evidence the pane is unmanaged. A Pi pane publishing any
`pi_herdsman_*` key is managed, an idle retained worker included. A Pi pane
publishing none is unverified and SHALL be refused. A tab or workspace close that
contains a managed pane SHALL be refused as a whole.

#### Scenario: An idle retained worker is managed

- **WHEN** a pane is idle and publishes `pi_herdsman_role`
- **THEN** it is managed and is closed only through its owner

#### Scenario: No herdsman keys

- **WHEN** a Pi pane publishes no `pi_herdsman_*` key
- **THEN** it is unverified and the direct close is refused

### Requirement: The contract tolerates an older requester

Version 1 SHALL NOT gain a required field. The owner SHALL ignore unknown fields
and treat every cross-check as optional, and SHALL refuse a `version` other than
`1` as `invalid_request`.

#### Scenario: An unknown field is present

- **WHEN** a request carries a field this build does not define
- **THEN** the request is handled as if the field were absent

### Requirement: The owner's model learns only what changes live work

Handling a control request SHALL NOT create a model turn and SHALL be recorded as
a session entry excluded from model context. Closing a target with an unresolved
assignment SHALL resolve that assignment through its terminal result path, typed
as closed by an operator. Closing or restarting an idle or delivered target SHALL
NOT notify the model, and `agent_list` SHALL reflect the outcome.

#### Scenario: A working worker is closed by an operator

- **WHEN** a control request closes a worker that has an unresolved assignment
- **THEN** the assignment resolves as closed by an operator through the normal result path and no separate prompt is sent

#### Scenario: An idle worker is closed by an operator

- **WHEN** a control request closes an idle or delivered worker
- **THEN** the model is not notified and the worker is absent from the next `agent_list`

### Requirement: Completion is signalled by a token and settled by the file

The owner SHALL publish `pi_herdsman_control=<requestId>:<outcome>` on its own
pane with a short TTL after writing a result. The results directory SHALL remain
authoritative; a requester that never sees the token SHALL read the file. The
owner SHALL prune results older than 24 hours and SHALL NOT prune a claim that
has no result.

#### Scenario: The token is missed

- **WHEN** a requester starts after the token expired
- **THEN** it reads the result file and obtains the same outcome
