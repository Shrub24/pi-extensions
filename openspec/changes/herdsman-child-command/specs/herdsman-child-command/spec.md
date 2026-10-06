# herdsman-child-command

## Purpose

Let the operator choose, through their own environment, which binary a managed child
session runs, so the choice is validated and recorded with the launch instead of being made
by a shell function, and so a worker started under a different choice is detected.

## ADDED Requirements

### Requirement: Child command is a launch environment input

Herdsman SHALL take the child command solely from `PI_HERDSMAN_CHILD_COMMAND` in its own
process environment, read at launch time. No configuration key, settings-menu entry or other
source SHALL override, replace or supplement it. An unset or empty value SHALL mean no
command is configured and SHALL leave the launch unchanged. Because the value comes from the
lead's own environment, changing it SHALL require a lead restart.

#### Scenario: Unset variable leaves the launch unchanged

- **WHEN** `PI_HERDSMAN_CHILD_COMMAND` is unset or empty and a managed worker is launched
- **THEN** the launch args, environment and identity are identical to a launch before this change

#### Scenario: Set variable is the input

- **WHEN** `PI_HERDSMAN_CHILD_COMMAND` is set to a valid value and a managed worker is launched
- **THEN** that value selects the child binary for that launch

#### Scenario: Changing the value needs a lead restart

- **WHEN** the variable is changed in the environment of an already running lead
- **THEN** the running lead keeps the value it read, and the new value applies to launches after that lead restarts

### Requirement: An invalid value fails the launch

A set value SHALL be either an absolute path or a command name resolvable on the launch
`PATH`, and SHALL name an executable. A value that is neither, or that names a non-executable
file, SHALL fail the launch with a typed error naming the variable, before any pane or child
process is created. Herdsman SHALL NOT silently fall back to the default executable.

#### Scenario: Unresolvable value refused

- **WHEN** the variable holds a relative path that does not resolve, or a name that is not found on the launch `PATH`
- **THEN** the launch fails with an error naming `PI_HERDSMAN_CHILD_COMMAND` and no pane or child process is created

#### Scenario: Non-executable file refused

- **WHEN** the variable holds the absolute path of an existing file that is not executable
- **THEN** the launch fails with the same typed error rather than starting the default executable

### Requirement: Command reaches the child and its workers

When a valid command is configured, every managed child launch SHALL carry it to the child
environment as `PI_HERDSMAN_CHILD_COMMAND` exactly once, with the resolved value. A worker
that delegates a further worker SHALL be allowed to use the value it inherited, so nested
delegation does not depend on the child's shell exporting anything.

#### Scenario: Configured launch carries the assignment

- **WHEN** a managed worker is delegated or relaunched with a configured command
- **THEN** its child environment carries exactly one `PI_HERDSMAN_CHILD_COMMAND` assignment whose value is the configured command

#### Scenario: Nested worker uses the inherited value

- **WHEN** a managed worker that received the assignment delegates a further worker
- **THEN** the new child is launched with the same command through the inherited value rather than a refusal or a default

### Requirement: Command identifies a worker's launch configuration

The command read at launch SHALL be part of the launch configuration recorded with a worker
and compared before a retained worker is reused. A worker whose recorded command differs from
the command read now, including set-versus-unset transitions, SHALL be relaunched by
continuing the same session in a new process rather than reused. A matching command SHALL be
reused, and a record with no command identity SHALL be treated as a mismatch.

#### Scenario: Differing recorded command relaunches

- **WHEN** the command recorded for an idle retained worker differs from the command Herdsman reads now and that worker receives the next assignment
- **THEN** the worker is relaunched, its Pi session and label are preserved, and the new process runs the current command

#### Scenario: Matching command reuses the process

- **WHEN** the recorded command equals the command read now for an idle retained worker
- **THEN** the existing process takes the assignment without a relaunch

#### Scenario: Setting and clearing are changes

- **WHEN** the command is set where it was previously unset, or cleared where it was previously set
- **THEN** the retained worker is relaunched rather than reused under the old decision

### Requirement: Direct child start applies the current command

Once the recorded start-path probe for the installed Herdr version establishes detection,
alias, readiness and argv behaviour, Herdsman SHALL start a child with a configured command
by running that command in the pane instead of asking Herdr to start its canonical
executable. The running child SHALL be registered under the Herdsman agent alias, readiness
SHALL be established before the launch is reported successful, and a start that fails or
times out SHALL be reported as a structured launch failure and rolled back like a failed
`agent start`. Until that probe is recorded, this requirement SHALL NOT be implemented.

#### Scenario: Alias is established

- **WHEN** a child is started directly by the configured command
- **THEN** the running child is addressable by its Herdsman agent alias through Herdr's agent queries

#### Scenario: Readiness precedes success

- **WHEN** the command has been run but the child is not yet interactive
- **THEN** the launch is not reported successful until readiness is observed, within the existing startup budget

#### Scenario: Failure is structured and rolled back

- **WHEN** the command cannot be run, the child never reaches readiness, or the pane is unusable
- **THEN** the launch fails with a structured failure naming the stage, ownership evidence is preserved, and no orphaned pane or agent record is left behind

#### Scenario: Pane-reusing restart applies the current command

- **WHEN** an idle retained worker is restarted in its existing pane after the configured command changed
- **THEN** the restarted process runs the current command even though the pane's creation-time environment is unchanged

### Requirement: Session and ownership semantics unchanged

`PI_SUBAGENT_CHILD`, `PI_SUBAGENT_PARENT_SESSION` and stock-subagent semantics SHALL be
unchanged by a configured command, and ownership, identity, admission and control behaviour
SHALL NOT depend on it.

#### Scenario: Child and parent session variables unchanged

- **WHEN** a managed child is launched with a configured command
- **THEN** its child and forwarding-session assignments are identical to an unconfigured launch

#### Scenario: Ownership still comes from existing provenance

- **WHEN** a session was launched with a configured command
- **THEN** continuation and control rights are decided exactly as before, from the existing owner and identity evidence
