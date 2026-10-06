# herdsman-retained-workers Specification

## Purpose
Keep managed workers alive between assignments, so one persistent worker can take successive assignments in the same live process and pane, under its owner's control, until the owner explicitly releases it.

## Requirements

### Requirement: `retainWorkers` setting

The configuration SHALL accept a boolean `retainWorkers`, default `false`. Any non-boolean value SHALL make the configuration invalid. While it is `false`, worker lifecycle SHALL be identical to the unretained behaviour: one assignment per process, with cleanup after result delivery. The `/agents` menu SHALL show the current value and SHALL toggle it.

#### Scenario: Default keeps one-shot workers

- **WHEN** `retainWorkers` is unset and a worker's result is delivered
- **THEN** the worker's pane and process are closed and its mailbox is removed, as before

#### Scenario: Toggle from the menu

- **WHEN** the user selects the retain-workers item in `/agents`
- **THEN** the setting flips, the change is written to the configuration file, and the user is notified of the new value

### Requirement: Delivered workers are retained, not closed

While `retainWorkers` is `true`, delivering a worker's result to its owner SHALL leave the worker's process and pane running. The worker SHALL stay bound to its agent label and its owner. Its completed assignment SHALL be marked resolved, so it never produces a second result. The worker's pane SHALL stop showing the finished assignment's task and activity. Retention SHALL apply to the worker whose result was delivered. Workers that a delegating worker started SHALL follow the setting in effect for their own owner. The decision to retain or close SHALL be made from the configuration at delivery time, and SHALL be idempotent: repeating delivery cleanup after a crash or restart SHALL NOT close a retained worker.

#### Scenario: Result delivered with retention on

- **WHEN** `retainWorkers` is `true` and a worker's result is delivered to the lead
- **THEN** the worker's pane and Pi process stay alive, `agent_list` still shows it under the same label, and no second result is ever delivered for that assignment

#### Scenario: Crash during retention

- **WHEN** the lead restarts after a result was delivered but before retention finished
- **THEN** recovery completes retention and does not close the worker

### Requirement: Retained workers project as `idle`

A retained worker with no active assignment, no pending result, no pending owner question, and a live, verified process SHALL have the public state `idle`. An `idle` worker's `available_tools` SHALL contain only `agent_inspect`, `agent_transcript` (when its session file exists), and `agent_close`. It SHALL NOT be reported as stale, and SHALL NOT receive health attention for inactivity or a soft-deadline digest. An `idle` worker SHALL NOT keep its owner's herd run open. A retained worker whose process is proven absent SHALL project as `lost`, as any other worker does.

#### Scenario: Listing a retained worker

- **WHEN** the lead calls `agent_list` after a retained worker delivered its result
- **THEN** that worker has state `idle` and `available_tools` of exactly `agent_inspect`, `agent_transcript`, and `agent_close`

#### Scenario: No inactivity attention

- **WHEN** an `idle` worker remains idle for 30 minutes
- **THEN** its owner receives no stale attention and no soft-deadline digest for it

#### Scenario: Herd run finishes with idle workers

- **WHEN** every worker a lead owns is `idle`
- **THEN** the lead's herd run is reported finished

### Requirement: Continuation reuses an idle retained worker

When `agent_continue` targets a session whose worker is `idle` and directly owned by the caller, the assignment SHALL be delivered into that live process. Herdsman SHALL NOT start a new process. The worker SHALL keep its label, pane, and Pi session. The assignment SHALL follow the normal assignment lifecycle: acknowledgement, working, owner questions, steering, interruption, exactly one result, and then retention or cleanup. The successful `agent_continue` result SHALL state that the existing worker was reused. Continuation of a session whose worker is not `idle` SHALL keep its existing rules: a live working or settling worker SHALL be rejected as busy, and a session with no live worker SHALL start a new process. A session whose single directly owned record is a proven `lost` generation SHALL follow the recovery requirement below.

#### Scenario: Second assignment in the same process

- **WHEN** a lead calls `agent_continue` with the session of its `idle` worker `impl`
- **THEN** the same pane receives the new task, `impl` becomes `working` under the same label, and the result reports the worker as reused

#### Scenario: Busy worker still rejected

- **WHEN** a lead calls `agent_continue` for a session whose worker is `working`
- **THEN** the call fails as busy and the worker's assignment is unchanged

#### Scenario: Not the owner

- **WHEN** a controller calls `agent_continue` for an `idle` worker it does not directly own
- **THEN** the call fails closed and the worker is unchanged

### Requirement: Continuation recovers a proven-lost worker

When `agent_continue` targets a session whose single directly owned managed representation is a proven `lost` generation, Herdsman SHALL retire that stale record through the same preflight a lost `agent_close` uses and continue the same Pi session in a new process and pane under the same logical label, without requiring `agent_close` or manual mailbox removal first. The lost-generation safeguards SHALL be preserved: an unprovable identity SHALL refuse `agent_busy` without weakening presence to `lost`, an unretrieved durable result SHALL refuse rather than be overwritten, and a surviving pane SHALL be left untouched because it may hold unrelated operator work. The prior terminal assignment's records in the owner's session SHALL remain, and the successful result SHALL report `relaunched: "process_lost"`.

#### Scenario: Recover after a vanished pane

- **WHEN** a worker's process and pane are gone and the lead calls `agent_continue` with its exact saved session
- **THEN** the stale record is retired, a new generation starts on the same Pi session under the same label, no pane is closed, and the result reports `relaunched: "process_lost"`

#### Scenario: Recover behind a surviving shell

- **WHEN** a worker's process is gone but its pane survives as a plain shell past the maximum startup window
- **THEN** continuation starts a new generation and leaves the surviving pane untouched

#### Scenario: Unprovable identity still refuses

- **WHEN** a live foreign agent or an unclaimed pane makes the lost worker's identity unprovable
- **THEN** continuation fails `agent_busy`, starts nothing, and the record is unchanged

#### Scenario: Unretrieved result is never overwritten

- **WHEN** the lost generation has a durable result that was never retrieved
- **THEN** continuation refuses instead of discarding it

### Requirement: Definition drift relaunches instead of reusing

Before reusing an `idle` worker, Herdsman SHALL compare the worker's launch configuration with the current effective configuration of its definition. The launch configuration SHALL cover: the expanded prompt body including referenced files, the system-prompt mode, the model, the thinking level, the tool, skill, and extension selections, and the context inheritance. If they differ, or the launch configuration cannot be established, Herdsman SHALL close the idle worker and continue the same Pi session in a new process with the current configuration. The `agent_continue` result SHALL state that the worker was relaunched because its definition changed.

#### Scenario: Model changed since launch

- **WHEN** the definition's model was changed after the `idle` worker launched, and the lead calls `agent_continue` for its session
- **THEN** the old process is closed, a new process starts on the same session with the new model, and the result says it was relaunched for a definition change

#### Scenario: Unchanged definition reuses

- **WHEN** nothing in the definition's launch configuration changed
- **THEN** the idle worker is reused and no process is started

### Requirement: Explicit release

`agent_close` on an `idle` worker SHALL close its process and pane and remove its runtime state. Its Pi session SHALL remain available to `agent_continue`, which SHALL then start a new process. The `/agents` menu SHALL offer a `Clear idle` action. That action SHALL close every `idle` worker the caller directly owns, after confirmation. It SHALL leave working, blocked, settling, unknown, and lost workers untouched, and SHALL report how many workers it closed.

#### Scenario: Close an idle worker

- **WHEN** the lead calls `agent_close` on an `idle` worker
- **THEN** its pane closes, it disappears from `agent_list`, and a later `agent_continue` on its session starts a new process

#### Scenario: Clear idle

- **WHEN** the lead confirms `Clear idle` while owning two `idle` workers and one `working` worker
- **THEN** both idle workers are closed, the working worker is untouched, and the user is told two workers were closed

### Requirement: Retained workers survive controller restart

After the owning controller restarts, every retained worker whose process is still verified live SHALL be restored as `idle` under its label and owner. Such a worker SHALL remain reusable through `agent_continue`, subject to the same definition-drift check. A retained worker that cannot be verified SHALL project as `unknown` or `lost` under the existing rules, and SHALL never be rebound to a different process.

#### Scenario: Lead restart

- **WHEN** the lead restarts while it owns one live retained worker
- **THEN** after recovery `agent_list` shows that worker as `idle`, and `agent_continue` on its session reuses it
