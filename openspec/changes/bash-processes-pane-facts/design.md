# Design

## Context

The pane-metadata contract (`pi-herdsman/docs/reference/pane-metadata.md`)
gives Herdr one flat token map per pane, requires that each token name has
exactly one publisher, and leaves presentation to Radar. Herdsman publishes the
generic per-pane set (`model`, `provider`, `thinking`, `session`,
`context_usage`, `pi_herdsman_session`), the hierarchy facts, and — for a
managed worker — its assignment projection as `pi_herdsman_state` under the
owner's source. The Lead pane publishes the generic set plus
`pi_herdsman_role`, `pi_herdsman_name` and `pi_herdsman_ask`; it publishes no
state token, so its sidebar state is the official reporter's `agent_status`.

pi-bash-processes knows its tasks in-process and already sees their lifecycle
events (spawn, exit, settlement) and their attribution
(`PI_BG_SESSION`, `HERDR_PANE_ID`, cwd).

## Decisions

### D1 — pi-bash-processes publishes, not herdsman

The extension that owns the tasks owns the facts. Routing them through herdsman
would make it republish another extension's facts, and Radar would still need
the detail tokens from their real owner. It also keeps the contract's rule
intact: one publisher per token name, and no token name changes hands.

### D2 — Facts, not a state token

pi-bash-processes publishes counts and identifiers, and publishes no
`state`-like key. A session's semantic state stays the official integration's,
and a worker's assignment projection stays herdsman's. Radar derives the
presentation — "waiting on 2 tasks" — from the facts plus the pane's own state,
which is exactly the division of labour the contract already assigns it.

### D3 — The published keys

| Key | Value | Purpose |
| --- | --- | --- |
| `pi_bg_running` | count of running tasks | the primary fact |
| `pi_bg_tasks` | `id:state` entries, comma-separated, capped | which tasks, and whether one is flushing or awaiting result review |
| `pi_bg_started` | ISO 8601 start of the oldest running task | lets Radar show an age without a refresh loop |

`pi_bg_started` is a timestamp rather than an elapsed duration so that a task
running for an hour needs no re-publish to stay accurate.

### D4 — Cadence, expiry and clearing

Facts are published on every task state change, refreshed on a timer while any
task is running (TTL 60 s, refresh every 20 s), cleared when the last task ends,
and cleared on shutdown with the clear awaited before the process exits. The TTL
is what bounds a crashed session: nothing else removes a token for a pane that
still exists.

### D5 — The facts describe outstanding work, not the session's state

A task spawned mid-turn is advertised while the session is still working, and
the same facts remain once the turn ends and the session is waiting on them. The
waiting presentation is the consumer's derivation from the facts plus the pane's
own state, so publication never depends on the session's lifecycle state.

### D6 — Gating

Publication happens only in a TUI session, only with a Herdr pane id, and only
while at least one task is running; otherwise the keys are cleared. Headless
sessions, non-Herdr sessions and idle sessions publish nothing, which is the
same gate herdsman applies.

### D7 — No settings key

The behaviour is bounded by D5: it cannot act outside a TUI pane in Herdr with
running tasks. A settings key is deferred until someone wants it off, rather
than added speculatively.

## Non-Goals

- Task output, commands, logs, prompts or working directories are never
  published. The sidebar needs presence and state, and a pane token is not a
  place for content.
- No Radar change. The token set is published as a consumer contract; the
  rendering is theirs.
- No herdsman change, and no change to how tasks are spawned, awaited, retained
  or reaped.
- No fetching path. Reading the task store directly would couple Radar to a
  private on-disk format.

## Risks

- **Stale facts after a crash.** Bounded by the TTL: a session that dies leaves
  at most 60 s of stale keys, and the official reporter's state is unaffected.
- **Token budget.** Herdr retains at most 32 keys per pane and 16 per report;
  three keys are published, and herdsman's own reports are unaffected.
- **Two publishers on one pane.** They write disjoint key names, which is the
  contract's coexistence rule.
