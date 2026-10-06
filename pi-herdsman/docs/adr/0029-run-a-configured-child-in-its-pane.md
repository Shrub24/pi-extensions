# Run a configured child in its pane instead of asking Herdr to start it

## Decision

When `PI_HERDSMAN_CHILD_COMMAND` is set, the managed child is started by typing
its command into the pane the launch created (or reused) and letting the child
register itself with Herdr. Herdsman then applies the Herdsman agent alias with
`agent rename` and verifies it through `agent get` before the launch is reported
successful. With the variable unset, the launch keeps using
`herdr agent start --kind pi` unchanged.

Two implementation rules follow from the measured CLI behaviour, recorded in
`openspec/changes/herdsman-child-command/probe.md` for herdr 0.9.3:

- Every element of the child argv is single-quoted into one line, because
  `pane run` joins its arguments with single spaces and sends the result to the
  pane's interactive shell unquoted.
- A launch whose argv holds a newline is not typed at all: Herdsman writes
  `exec <command> <args…>` to a private `launch.sh` and types that file's path,
  so the pane still receives one input line and the argv still reaches the child
  byte-exact. The file is retired once the launch is over, after the child has
  read it.
- Registration is polled for (`agent get <pane>`) before readiness is accepted
  and before the alias is applied, because the child, not Herdr, registers the
  agent and `agent rename` answers `agent_not_found` until that record exists.

## Rationale

Herdr's `agent start` picks the executable from its own `--kind` table, so the
operator's choice of child build could only reach the child through a shell
function that Herdr's canonical `pi` executable happened to load. Running the
resolved command in the pane makes the operator's environment the single source
of truth, and it keeps every other launch guarantee: the same pane topology, the
same recorded shell process, the same `HerdrStartFailure` shape and the same
`rollbackHerdrStart` ownership proofs. The recorded probe showed Herdr detects
the agent, accepts the rename and reports the session for a `pane run` child
exactly as it does for an `agent start` child.

Readiness cannot be `agent wait --until idle`. A delegated child receives its
assignment in the mailbox at startup, so it is usually already `working` by the
time the wait is issued; waiting for `idle` would hold the launch until the first
assignment finished, or fail it on the startup deadline. The launch therefore
accepts the record Herdr reports for the pane once it carries a reported session
or a known status, which is what the rest of the start path already consumes.

A newline cannot be quoted away. The pane receives the typed text as input, so an
element holding a newline is a second input line; the probe observed a shell
plugin (`__abbr_tips_bind_newline`) abort that line's submission and leave the
pane holding an unterminated command, which would strand every later launch in
the pane. Carrying the argv in a script keeps the input to one line for every
argv, and the script is the same shape the probe already measured byte-exact.

## Alternatives rejected

- `agent wait <pane> --until idle --timeout` as the readiness gate: measured as
  fast for a prompt-free child, but it blocks a child that starts working
  immediately. The launch budget would be spent on the assignment, not startup.
- `agent wait <pane> --timeout` without a state: its settlement semantics are
  not documented for a fresh child, so it is not a gate this code can reason
  about.
- Keep the shell side as the dispatcher: it couples the child build to the
  operator's interactive shell configuration, which is the problem this change
  removes.
- A per-launch script file for every launch: the probe verified it byte-exact,
  but it costs a file, a mode and a cleanup path for arguments quoting already
  handles. It is used only for an argv holding a newline, where the typed line
  would otherwise be multi-line input.
- Typing the quoted line even when it holds a newline: measured to leave the pane
  holding an unterminated command, which breaks every later launch in that pane.
- Escaping the newline inside the quoted line (`$'\n'`): not portable across the
  pane's interactive shells, and it reaches the child through the shell's escape
  semantics instead of as an argument.
- Quote only when an element needs it: uniform quoting is one rule, and a
  conditional rule has to be right for every metacharacter.

## Consequences

- The launch line is shell text parsed by the operator's own login shell, so a
  shell configuration that mangles Enter is on the launch path (one observed fish
  plugin aborts on a newline-bearing line), and a newline-bearing argv therefore
  runs from a script instead. A metacharacter, space or quote in a path is not;
  those are quoted.
- A script-borne launch leaves a private file under Herdsman's temp root until the
  child has read it; the launch removes it on success and on failure, so nothing
  accumulates for a completed or rolled-back start.
- Herdr is still required for panes, placement, lifecycle events and the agent
  registry, and the `pi-bolt-child` wrapper stays the child build. The change
  removes dispatch, not the dependency.
- `agent start`'s `agent_pane_busy` retry has no counterpart on the direct path:
  a delivered line is never typed twice, and a failure after delivery is a
  structured failure the caller rolls back.
- Readiness depends on the child's reporting cadence (0.55 s to a record, ~0.9 s
  to `idle` on the probe machine), not on screen detection. A Herdr version that
  changes rename or detection semantics needs the probe re-run; the code that
  depends on it is one helper.
- Rolling back the whole change is "unset the variable and restart the lead".

## See also

- [Prefer native Pi and Herdr contracts](0008-prefer-native-pi-and-herdr-contracts.md)
- [Retain workers across assignments](0013-retain-workers-across-assignments.md)
- [Ignore a foreign session record before validating it](0027-ignore-a-foreign-session-record-before-validating-it.md)
