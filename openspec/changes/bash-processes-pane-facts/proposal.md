# Advertise running background tasks on the session's own pane

## Why

The agent-radar sidebar can show what an agent is doing, but not what it is
waiting on. Herdsman publishes a worker's assignment projection
(`pi_herdsman_state`, including `waiting` while a worker is held on
background work) and the official Herdr integration publishes semantic state,
yet neither covers a session that has background bash tasks outstanding after
its turn ended — the pane reads `idle`, indistinguishable from a session with
nothing to do. pi-bash-processes owns those tasks and publishes nothing to
Herdr today.

## What Changes

- pi-bash-processes publishes a small fact set on its own pane while it has
  running background tasks: how many, which ids and states, and when the oldest
  started.
- The keys are cleared when the last task ends and on shutdown, and refreshed
  while any task runs so a long task stays visible.
- Nothing else changes: herdsman keeps the worker assignment projection, the
  official integration keeps semantic state, and Radar keeps presentation.

## Impact

- New `pi-bash-processes` extension module and its tests.
- README/instructions documentation of the published keys, which are also the
  consumer contract for Radar.
- No herdsman change, no settings key, no change to task behaviour.
