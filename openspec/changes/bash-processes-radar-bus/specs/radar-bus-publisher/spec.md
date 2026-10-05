# Radar bus publisher

## ADDED Requirements

### Requirement: The session publishes its unresolved tasks to Radar

A session with at least one unresolved background task SHALL connect to Radar's
local socket, send `hello` with its Pi session UUID, and send a `tasks` message
carrying every unresolved task after every change to that set.

#### Scenario: A task starts

- **WHEN** the first background task starts and a trusted Radar socket exists
- **THEN** the publisher sends `hello` and then a `tasks` list containing that task as `running`

#### Scenario: A task exits and awaits review

- **WHEN** a task's process exits and its result has not been retrieved
- **THEN** the next list carries that task as `flushing` and then `review`, with its `exit_code`

#### Scenario: The last task resolves

- **WHEN** the last unresolved task is retrieved
- **THEN** the publisher sends an explicit empty `tasks` list on the same connection

#### Scenario: A session never runs a task

- **WHEN** a session spawns no background task
- **THEN** it opens no connection

### Requirement: The bus and the tokens describe the same set

The tasks on the bus SHALL be exactly the tasks named in `pi_bg_tasks`, with the
same phase words.

#### Scenario: Same unresolved set

- **WHEN** a task is on the bus as `review`
- **THEN** `pi_bg_tasks` names it as `review`

### Requirement: Publishing never affects the session

A failure to connect, write or stay connected SHALL NOT fail or delay a turn, a
task, a wake or a result, and SHALL NOT be reported to the model.

#### Scenario: Radar is not running

- **WHEN** no socket exists or the connection is refused
- **THEN** the session behaves exactly as without the publisher

#### Scenario: Radar stops reading

- **WHEN** the peer stops draining the socket
- **THEN** only the latest list is retained and no turn is delayed

### Requirement: The socket is trusted before use

The publisher SHALL connect only when the socket's directory is owned by the
current user, has mode 0700 and is not a symlink, except for an explicit
`RADAR_SOCKET` override.

#### Scenario: A directory fails the check

- **WHEN** the directory is a symlink, owned by another user, or has a looser mode
- **THEN** the publisher does not connect

### Requirement: A tasks message carries the complete unresolved set

Every `tasks` message SHALL list every unresolved task; the list SHALL NOT be
truncated, and the publisher SHALL stop publishing once the shutdown clear has
run.

#### Scenario: Many tasks outstanding

- **WHEN** more tasks are unresolved than a pane token could name
- **THEN** every one of them appears in the message

#### Scenario: A task close event arrives after the shutdown clear

- **WHEN** a killed task reports its close after the session shut the publisher down
- **THEN** nothing is published and no connection is reopened

### Requirement: The bus is passive and carries no output content

The publisher SHALL send each task's `command` and `cwd` bounded to 256
characters, SHALL NOT send output, output content or any log path, SHALL NOT
read inbound messages as instructions, and SHALL NOT mark a result delivered,
reviewed or acknowledged.

#### Scenario: A long command

- **WHEN** a task's command line exceeds 256 characters
- **THEN** the emitted value is its first 256 characters

#### Scenario: A task's log path

- **WHEN** a task has a log file
- **THEN** no emitted line carries that path

### Requirement: Updates are ordered and throttled

Messages SHALL be written in order by a single writer. Set or state changes SHALL
be sent promptly; changes that only move output counters SHALL be coalesced to
at most one message per second.

#### Scenario: Output counters churn

- **WHEN** a task writes output continuously
- **THEN** at most one `tasks` message per second is sent for the counter change
