# Proposal

## Why

Which binary a managed child runs is decided today by a shell function in the owner's
dotfiles, keyed on `PI_HERDSMAN_MAILBOX` / `PI_SUBAGENT_CHILD`, because `herdr agent start`
only types its canonical executable (`pi`) into the pane shell. The decision therefore
lives outside Herdsman, cannot be recorded with a launch, and is invisible to any consumer
that does not source that shell. Herdsman already receives its own environment and already
assembles the child's launch environment, so the operator's choice can be read and recorded
there instead.

## What Changes

- `PI_HERDSMAN_CHILD_COMMAND` in Herdsman's own process environment becomes the single input
  that selects the binary a managed child runs. No configuration key and no `/agents` menu
  entry are added.
- The value is read and validated at launch time: an absolute path or a command name
  resolvable on the launch `PATH`, naming an executable. An invalid value fails the launch
  with a typed error naming the variable. An unset or empty variable leaves today's launch
  unchanged.
- When set, the value is exported to the child's pane environment in stage 1, so an existing
  wrapper may still honour it, and the same value is recorded in the worker launch
  configuration fingerprint so a worker launched under a different value is relaunched
  rather than reused (the ADR 0013 path).
- **Stage 2 (probe-gated)**: start the child by running the command directly in the pane,
  replacing `herdr agent start --kind pi` with Herdsman-side readiness polling, alias
  application after launch, structured failures, and the same rollback — so the command is
  applied on every launch, including a pane-restart where pane environment is fixed at
  creation.
- Do not touch `PI_SUBAGENT_CHILD` / `PI_SUBAGENT_PARENT_SESSION` / `PI_USE_STOCK`
  semantics, and do not change the `herdr agent start` path in stage 1.

## Capabilities

### New Capabilities

- `herdsman-child-command`: the launch-time input that selects a managed child's binary, its
  export to the child environment, its place in the launch configuration identity, and the
  direct start path that runs it.

### Modified Capabilities

None. `herdsman-retained-workers` still owns the reuse rule ("a matching fingerprint reuses
the idle worker, a mismatch relaunches"); this change adds *what* the fingerprint covers,
which is a new concern rather than changed behavior of that capability.

## Impact

Stage 1 touches the shared launch plan and its environment assembly (`extension/index.ts`),
the launch-fingerprint inputs (`extension/agent-definitions.ts`) and one launch-input helper
in `extension/herdr.ts`, plus the launch documentation. Stage 2 replaces the two
`herdr agent start` call sites and adds one start helper in `extension/herdr.ts`. No
configuration-file schema change, no new dependency, no wire protocol change, no new durable
file, and no mailbox or control-protocol change.

The dotfiles owner must set `PI_HERDSMAN_CHILD_COMMAND` in the lead's own environment (the
value used today is `/home/saurabhj/.nix-profile/bin/pi-bolt-child`) and may then reduce its
`pi` shell function to honouring that variable, or delete it once stage 2 lands. That work
happens in the dotfiles repository, not here.

## Non-goals

- Removing Herdr. Stage 2 reduces Herdr dependence for the *start* path only; placement,
  panes, lifecycle events and the agent registry still come from Herdr.
- A tmux backend, Radar changes, or a second agent-start mechanism kept in parallel.
- A configuration key, a `/agents` menu entry, or per-definition/per-label overrides: the
  environment variable is the only input.
- Changing stock Pi subagent behaviour (`PI_USE_STOCK`) or the child/parent session
  environment variables.
- Any change to the control protocol (`herdsman-control/v1`), the mailbox protocol, the
  delivery ledger or result redelivery.
