# Advertise what each pane is awaiting

## Why

A sidebar can show that an agent is idle but not that it is waiting on something
specific. Herdsman's `pi_herdsman_state` is a control projection — it answers
which operations are valid — so its vocabulary splits the same display question
into `waiting` (background work) and `blocked` (an owner reply or nested
children), and it exists only on worker panes. Nothing describes what a pane is
awaiting, and a pane awaiting two tasks and one nested agent has to pick one word.

## What Changes

- Every pane herdsman publishes for advertises `pi_herdsman_awaited`: the set of
  things it is awaiting, as `agent:<label>` and `owner` entries.
- The set is published whenever it is non-empty, whether the agent is working or
  stopped, and cleared when nothing is awaited.
- The set gets its own refresh cadence, because the snapshot cadence (1 h TTL,
  30 min refresh) is far too slow for a live count.
- `pi_herdsman_state` is unchanged and keeps its control meaning.

## Impact

- New key in herdsman's pane metadata, plus its cadence and clearing behaviour.
- The pane-metadata reference documents the consumer rule: `waiting` is a
  derived state, not a published one.
- No change to `available_tools`, the assignment projection, or any control path.
