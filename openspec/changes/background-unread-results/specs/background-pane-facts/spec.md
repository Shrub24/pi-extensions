# Spec Delta

## Purpose

Keep the pane's background-work tokens a truthful description of what a session still owes,
separating live processes from finished work whose result nobody has read.

## MODIFIED Requirements

### Requirement: A session with running tasks advertises them on its own pane

A TUI session running in Herdr with background work outstanding SHALL publish `pi_bg_running`,
`pi_bg_tasks` and `pi_bg_started` on its own pane under its own source. `pi_bg_running` SHALL
count live processes only, and `pi_bg_tasks` SHALL list live tasks and terminal tasks whose
result is still unretrieved, each with its phase, so finished but unreviewed results stay
visible while the running count is zero.

#### Scenario: A task starts

- **WHEN** a TUI session in Herdr spawns a background task
- **THEN** its pane carries `pi_bg_running` as 1, `pi_bg_tasks` naming that task, and `pi_bg_started`

#### Scenario: A second task starts

- **WHEN** a second task starts while the first is still running
- **THEN** `pi_bg_running` is 2, `pi_bg_tasks` names both, and `pi_bg_started` remains the older start

#### Scenario: Running tasks end with their results unretrieved

- **WHEN** the last running task ends and its result has not been retrieved or dismissed
- **THEN** `pi_bg_running` is 0 and `pi_bg_tasks` still names that task with its phase
- **AND** Herdsman does not project the worker as `waiting` if the capture is certified

#### Scenario: The last task ends

- **WHEN** the last outstanding task ends and its result is retrieved or dismissed
- **THEN** all three keys are cleared from the pane

#### Scenario: A long task stays visible

- **WHEN** a task runs longer than the publication TTL
- **THEN** the facts are re-published before expiry and remain on the pane

#### Scenario: A session outside Herdr, or without a TUI, publishes nothing

- **WHEN** the session is headless or has no Herdr pane id
- **THEN** no fact is published and any previously published key is cleared
