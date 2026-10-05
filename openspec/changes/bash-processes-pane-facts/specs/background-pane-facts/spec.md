# Background pane facts

## ADDED Requirements

### Requirement: A session with running tasks advertises them on its own pane

A TUI session running in Herdr with at least one running background task SHALL
publish `pi_bg_running`, `pi_bg_tasks` and `pi_bg_started` on its own pane
under its own source.

#### Scenario: A task starts

- **WHEN** a TUI session in Herdr spawns a background task
- **THEN** its pane carries `pi_bg_running` as 1, a `pi_bg_tasks` entry naming that task, and `pi_bg_started`

#### Scenario: A second task starts

- **WHEN** a second task starts while the first is still running
- **THEN** `pi_bg_running` is 2, `pi_bg_tasks` names both, and `pi_bg_started` remains the older start

#### Scenario: The last task ends

- **WHEN** the last running task ends
- **THEN** all three keys are cleared from the pane

#### Scenario: A long task stays visible

- **WHEN** a task runs longer than the publication TTL
- **THEN** the facts are re-published before expiry and remain on the pane

#### Scenario: A session outside Herdr, or without a TUI, publishes nothing

- **WHEN** the session is headless or has no Herdr pane id
- **THEN** no fact is published and any previously published key is cleared

### Requirement: The facts do not depend on the session's state

The facts SHALL be published while the session is working as well as while it
is stopped, because they describe what is outstanding rather than what the
session is doing.

#### Scenario: Tasks spawned mid-turn

- **WHEN** a session spawns a background task and keeps working
- **THEN** the facts are published while the session is working

### Requirement: Only presence and state are published

Published values SHALL contain task identifiers, their states and a start
timestamp, and SHALL NOT contain command text, output, prompts, working
directories or any other task content.

#### Scenario: Task content stays in the session

- **WHEN** any fact is published
- **THEN** no task command, output or path appears in any published value

### Requirement: Published values are bounded and terminal-safe

Every published value SHALL be at most 80 Unicode characters with control
characters replaced by spaces, and a fact that cannot be established SHALL be
cleared rather than guessed.

#### Scenario: More tasks than the list cap

- **WHEN** more tasks are running than fit the `pi_bg_tasks` cap
- **THEN** the value is capped and still terminal-safe

### Requirement: No agent-state token is published

pi-bash-processes SHALL NOT publish a semantic-state or agent-state key.

#### Scenario: A session waits on background work

- **WHEN** a session has running tasks and its turn has ended
- **THEN** the pane's semantic state is left unchanged and the waiting presentation is left to the consumer
