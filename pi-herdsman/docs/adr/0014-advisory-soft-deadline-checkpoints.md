# Advisory soft-deadline checkpoints

## Decision

`softTimeoutMs` arms one advisory soft-deadline window for each accepted
`agent_delegate` or `agent_continue` assignment, measured from the worker's
acknowledgement. When a window expires while its assignment is unresolved, the
idle direct owner receives exactly one digest listing every due worker with the
controls that worker currently allows, and the windows re-arm. `0` disables soft
windows entirely; the default is 300000 (five minutes).

The window is checked by the existing health-reconciliation scan, not by a
timer. `scanAgentHealth` gains a final pass, after the health ladder, that
collects every due window the controller owns and publishes one digest. That
pass ignores the one-attention-per-scan gate and keeps its state in a dedicated
`softWindows` map keyed by `requestId`, so it cannot starve or be starved by
stale and other health attention.

The anchor is controller-observed acceptance. When `submit` sees the accepted
task acknowledgement it records `pi-herdsman-soft-window {requestId, label,
runId, armedAt, windowMs}` in the lead's own session; each delivery appends
`{requestId, deliveredAt, nextArmedAt, windowMs}`, and `agent_extend` appends
`{requestId, armedAt, windowMs, extended: true}`. Recovery replays the last entry
per unresolved `requestId`, falling back to `state.lastAck.acknowledgedAt` when an
unresolved live assignment has no entry.

The digest is a new custom message type, `pi-herdsman-agent-soft-deadline`,
delivered with `triggerTurn: true`, whose entries list each worker's current
`available_tools` and describe only choices that worker currently allows. A
background-work waiter remains digest- and extend-eligible, but never lists
`agent_interrupt`. When `agent_close` is available, it is explicit abandonment,
not completion. "Continue" is avoided because `agent_continue` already means a new
assignment.

`agent_extend` is a tenth controller tool with the strict schema
`{agent: string, windowMs: integer 1..2147483647}` and
`additionalProperties: false`. It is listed only for a directly owned record
with an armed window and has no side effects beyond replacing that worker's next
window. Immediately before `sendMessage`, the pass emits `pi-herdsman:soft-deadline`
with `{ownerSessionId, entries, annotations}`; a listener throw is caught and
ignored, and non-empty annotations render as a trailing digest section.

A soft deadline never aborts, steers, or closes anything. It is an elapsed-time
advisory choice point, not a health condition.

## Rationale

The health ladder answers "is this worker failing?" and is deliberately narrow.
A soft deadline answers "is this choice still the one you want?", which is a
different question with the same surface: one direct-owner message offering
control choices. Riding the existing scan keeps a single delivery path, one
idle-gated wake, and restart-safe recovery instead of adding a second
scheduler.

A trailing pass is required because the ladder publishes at most one attention
per scan and shares its reminder slot per `runId`. A soft digest inside the
ladder would be starved by unrelated attention and would cancel stale backoff.
A separate map preserves both contracts.

Acceptance time is the measured clock; `lastActivityAt` measures progress.
Recording the anchor as lead-session entries keeps it durable across controller
restarts without touching the mailbox validator or `LIMITS.state`, and it never
enters model context, so it cannot disturb prompt caching
([ADR 0009](0009-preserve-prompt-cache-continuity.md)).

Listing `available_tools` from the same projection that lists controls means the
digest never offers a control the worker cannot accept.

## Alternatives rejected

- A dedicated `setTimeout` per window: exact timing, but it is the second
  delivery path `docs/guides/recovery.md` forbids and it would need its own idle
  gating and restart handling. Up to one scan interval (30 s) of lateness at a
  300 s window is acceptable.
- Reusing `attentionReminders`: its slot is per `runId`, so stale and soft
  deadlines would cancel each other's backoff.
- A new `ManagedAgentState` field for the anchor: the child would carry
  owner-side scheduling state, and the change would hit mailbox validation and
  the size budget.
- An optional `softTimeoutMs` on `agent_steer` or `agent_delegate`: advisory
  scheduling does not belong on assignment-changing operations.
- Extending the health conditions: a deadline is elapsed time, and the health
  ladder is deliberately narrow.

## Consequences

- Soft windows are checked on the health-reconciliation cadence, so a digest can
  arrive up to one scan interval late.
- The pass runs only for an idle controller with a direct owner, and for
  unresolved `working`, `blocked`, or `waiting` assignments with an armed window.
- `agent_extend` becomes part of the strict per-operation tool schema set and the
  extension contract.
- The digest is model-facing: a controller that ignores it simply waits, and the
  next window re-arms.

## Supersedes

- `docs/concepts/lifecycle.md:134-142` — "The health conditions are deliberately
  narrow: stale working and proven lost retain their dedicated messages; a
  delivered owner question may be reminded; `result_error`, a live runtime
  `blocked` condition, and an old retained unacknowledged handoff use generic
  attention. A retained request is not proof of non-delivery and must not be
  duplicated. Physical `unknown` remains fail-closed and receives at most one
  attention event for an episode. `settling` alone is not a timeout or generic
  attention condition." The narrowing still holds for the health ladder; the
  soft deadline is documented as a separate advisory pass, not a health
  condition, and not a duplicated delivery of a retained request.
- `docs/guides/recovery.md:36-39` — "Reminder state is process-local and
  advisory, not durable mailbox state. Health attention is direct-owner-only; do
  not poll, add a second delivery path, or keep a turn alive solely to wait."
  The reminder state is still process-local and the delivery path is still the
  single scanner; the window anchor alone is durable, because a restart must not
  silently restart a window.
- `docs/concepts/lifecycle.md:110-114` — "Routine progress checking remains
  prohibited. A stale health-attention event is different: it is an unsolicited
  diagnostic boundary." A soft deadline is an advisory choice point with a
  one-shot cadence, which is neither routine progress checking nor the decaying
  stale diagnostic boundary.
- `docs/concepts/lifecycle.md:126-131` — the stale reminder cadence
  `5m → 2m30s → 1m15s → 1m` and "Stale first becomes eligible after ten
  minutes…". The soft window does not decay and is one-shot per armed window, so
  both cadences are documented separately.
- `docs/reference/agent-states.md:80-90` — the inactivity fields section that
  ties `stale`, `inactive_ms`, and `last_activity_at` to a single ten-minute
  threshold. Those fields remain progress evidence; the soft deadline is
  measured from acceptance and exposes its own evidence.
