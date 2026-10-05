# Push background-task detail to Agent Radar over its local socket

## Why

The `pi_bg_*` pane tokens say that a session has outstanding background tasks
and name them, but Herdr caps a pane at 32 token keys and a worker pane already
uses about 30, so tokens cannot carry per-task detail: run time, output
activity, exit code. Agent Radar defines a private local socket for exactly this
(`agent-radar/docs/radar-bus.md`, fixture `docs/radar-bus.fixture.json`). The
extension that owns the tasks is the only one that can supply the detail.

## What Changes

- pi-bash-processes dials Radar's socket and publishes the complete list of the
  session's unresolved tasks on every change, throttled, with an explicit empty
  list when the last one resolves.
- The publisher is passive and best-effort: Radar absent, refusing or slow never
  affects a turn, a task or a result, and nothing the bus carries can retrieve,
  acknowledge or stop a task.
- `command` and `cwd` are not sent.

## Impact

- New `pi-bash-processes` module and tests; one wiring point beside the existing
  pane-facts publication.
- No settings key, no herdsman change, no change to task behaviour, wake or
  settlement semantics.
- The `pi_bg_tasks` token and the bus describe the same unresolved set from one
  projection, so they cannot disagree about which tasks exist.
