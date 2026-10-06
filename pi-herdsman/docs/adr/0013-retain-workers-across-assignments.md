# Retain workers across assignments

## Decision

When `retainWorkers` is enabled, delivering a managed Agent's terminal result
keeps its verified live process, pane, label, and mailbox instead of cleaning
them up. The assignment is still complete: the controller removes the result
file after delivery, and the retained shape is derived rather than stored —
`completedRequestId` set, no result file pending, no active request, and a live
verified process. The new public `idle` state projects that shape, and its only
eligible controls are `agent_inspect`, `agent_transcript`, and `agent_close`.

Background-work waiting is not the retained `idle` shape. Its request remains
active and unresolved until provider work is resolved and the worker publishes a
fresh post-review result. It is not eligible for continuation or Clear idle;
`agent_close` and explicit shutdown remain cancellation, not successful delivery.

`agent_continue` for a session whose single representation is a directly owned
`idle` worker submits the next assignment into that existing process through the
normal `submit` path, bypassing the busy and label-collision rejections and
reporting `reused: true`. `runId`, the Herdr alias, the pane, and the Pi session
stay those of the process. Reuse therefore does not create a new generation: in
this fork a generation means one process lifetime, and a generation may serve
several assignments, each identified by its `requestId`.

Reuse requires the launch configuration the process actually started with. At
launch the controller appends `pi-herdsman-worker-launch {runId, label,
fingerprint}` to its own session, where the fingerprint hashes the resolved
definition inputs that shape the process: the expanded body including `@file`
contents, `systemPromptMode`, model, thinking, the effective tools and exclusion
lists, skills, extensions, context inheritance, and the child executable the
launch runs when `PI_HERDSMAN_CHILD_COMMAND` selects one. A matching fingerprint
reuses the idle worker. A mismatch, or a missing launch entry, closes the worker
through the existing `closeManagedAgent` path and continues the same session in
a fresh process, reporting `relaunched: "definition_changed"`.

`agent_close` and the `/agents` → `Clear idle…` action release retained workers
explicitly; `Clear idle…` closes only directly owned `idle` workers. Retention is
off by default.

## Rationale

A delivered result is the boundary of an assignment, not of a process. Keeping
the process keeps its warm system prompt, loaded extensions, and Pi session
context, so the next assignment on the same session costs no startup and loses
no in-memory state.

The retained shape is derived from existing durable facts so that recovery
cannot resurrect a closed worker or drop a retained one. The controller removes
a result file only after delivery evidence exists, so its absence is a durable,
child-readable "delivered" fact; recovery that finds `completedRequestId`
without a result file re-reads the setting and retains again instead of closing.
No new `ManagedAgentState` field is needed, so the mailbox validator and its
size budget are untouched.

Reuse goes through the normal `submit` path because every identity check
(`validateIdentity`, result cleanup, recovery) compares `runId`, `paneId`, and
the session, and all three stay constant for a reused process. Acknowledgement,
soft-window arming, watchers, and result delivery are unchanged.

The launch fingerprint exists because a live process cannot rebuild its system
prompt or reload a changed definition. Hashing the resolved definition inputs
compares what actually shapes the process, including `@file` bodies and overlay
composition, which a raw file comparison would miss.

## Alternatives rejected

- A stored `retained` state field: redundant with the derived shape, and it
  costs a mailbox schema change plus size-budget review.
- Comparing raw definition files for drift: misses expanded `@file` contents and
  overlay composition.
- Re-minting `runId` per assignment: every identity check compares `runId`, so
  this would require re-registering the Herdr alias mid-life.
- Cleaning up or closing the worker and starting a fresh process on every
  continuation: defeats the purpose of retention and discards warm process
  state.
- Reusing a worker whose definition changed: the process would run under a stale
  system prompt and stale extension set.

## Consequences

- A worker's logical label stays occupied while it is `idle`, so continuation of
  that session keeps its label and a different label cannot reuse it.
- `idle` workers are excluded from stale and soft-deadline attention and from
  herd-run completion checks. A `waiting` assignment remains unresolved for
  herd-run completion and stays eligible for its soft-deadline digest.
- `available_tools` for an `idle` worker is inspect, transcript, and close only.
- An operator who does not want retained panes must disable `retainWorkers` or
  clear idle workers explicitly.

## Supersedes

- `docs/concepts/lifecycle.md:190-191` — "Each accepted task request maps to one
  final assignment result. Each managed agent generation receives exactly one
  assignment; a completed agent is not available for another task."
- `docs/concepts/agents.md:107-111` — "Every managed agent generation executes
  exactly one delegated assignment. Its terminal result is delivered once, then
  the agent's pane, process, mailbox, and runtime state are cleaned up."
- `docs/reference/agent.md:55-58` — "Continuation always creates a new agent
  generation for one assignment with a live label; **it never assigns work to an
  existing agent.**"
- `docs/reference/agent-states.md:27` — "an agent generation handles one
  assignment only."
- `SKILL.md:62-64` — "Each managed agent exists for one assignment only. After
  its terminal result is delivered, Pi Herdsman cleans up that agent
  automatically."
- `docs/guides/handoffs.md:221-222` — "Each agent generation builds its system
  prompt once for its single assignment. Session continuation builds a new
  generation with the current effective definition configuration while
  preserving the saved Pi session context." The first sentence now covers a
  process; the second holds for a fresh generation, and for a reused process the
  launch fingerprint requires its launch configuration to equal the current
  effective definition.

ADR 0004's separation of delegation from continuation is unchanged:
`agent_continue` remains the only way to assign to an existing session's worker.
