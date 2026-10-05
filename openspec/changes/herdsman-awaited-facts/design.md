# Design

## Context

The pane-metadata contract gives Herdr one flat token map per pane, one publisher
per token name, and leaves presentation to Radar. Herdsman publishes a generic
per-pane set, hierarchy facts, assignment facts for workers, and — for a worker —
its assignment projection as `pi_herdsman_state` under the owner's source.

## Decisions

### D1 — The state is derived, the set is published

`waiting` is what a non-empty awaited set means for a pane that is not working.
It is not published as its own key. A pane awaiting two background tasks and one
nested agent has one state and three items; a single reason or state value cannot
express that, and choosing one would lose the rest.

### D2 — The set is published regardless of the agent's own state

The set is a fact about what is outstanding, not about what the agent is doing.
An agent that spawned two tasks and is still working publishes them, so the
sidebar can show "working · 2 awaited"; the same pane shows "waiting · 2" once
its turn ends and the set is still non-empty. Publication therefore does not
depend on the pane's lifecycle state.

### D3 — Items and shape

`pi_herdsman_awaited` is a comma-separated list of `agent:<label>` and
`owner` entries, capped at 8 entries, at most 80 Unicode characters, control
characters replaced by spaces, cleared when empty. Labels are used rather than
session ids because the sidebar shows labels, and the ids are already published
by the hierarchy keys.

- A Lead lists its live workers.
- A worker lists its live nested children.
- A pane that has asked its owner lists `owner`.

### D4 — Cadence

While the set is non-empty: publish on every membership change and refresh every
15 s with a 30 s TTL, matching the owner-state path. When the set becomes empty,
clear the key and stop the timer. A pane awaiting nothing publishes nothing and
runs no timer, so an idle session costs nothing.

### D5 — `pi_herdsman_state` keeps its meaning

The assignment projection remains the control input it is documented to be,
including `settling`, `delivered` and `lost`, which only an owner can know and
which must remain publishable when the worker itself is gone. Radar uses it only
for what it cannot derive.

### D6 — The consumer rule is documented, not implied

The pane-metadata reference states the rule so every consumer derives the same
state: working panes are `working`; a pane that is not working with a non-empty
union of awaited items is `waiting`; otherwise it is idle. The union spans
publishers, because `pi_bg_running` and `pi_herdsman_awaited` have different
owners and the contract forbids one key with two publishers.

## Non-Goals

- No change to `pi_herdsman_state`, `available_tools`, or any control decision.
- No background-task facts. pi-bash-processes owns those
  (`bash-processes-pane-facts`).
- No Radar change; the union and the derived state are the consumer's work.
- No new settings key.

## Risks

- **Cadence cost.** A pane awaiting something publishes every 15 s; a pane
  awaiting nothing publishes not at all.
- **Stale set after a crash.** Bounded by the 30 s TTL, and the pane's semantic
  state is unaffected.
- **Token budget.** One key is added; Herdr retains 32 per pane and accepts 16
  per report.
