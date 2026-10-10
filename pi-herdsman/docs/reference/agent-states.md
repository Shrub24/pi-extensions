# Agent states

[Herdr pane metadata](pane-metadata.md) publishes this projection separately from Herdr's semantic state; Radar owns its presentation.

[Documentation index](../README.md)

The public state is a safe-control projection built from live lifecycle and
durable assignment/convergence evidence. It is not a raw herdr lifecycle string.

| State      | Meaning                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `idle`     | A retained worker: its terminal result was delivered and its verified live process is available for one new assignment. |
| `working`  | An assignment is active; `stale` remains an advisory field on this state.                                |
| `waiting`  | The model turn has yielded while unfinished provider-backed work (running, flushing, or explicitly uncertified capture) or a required response remains unresolved. A certified unretrieved terminal result alone is advisory and does not produce `waiting`. |
| `blocked`  | Active assignment is waiting for owner input or another condition, including an active question-tool dialog. |
| `settling` | Assignment handoff, completion/result delivery, launch, direct-agent gate, or cleanup is converging.     |
| `unknown`  | Exact safe control state cannot be proved.                                                               |
| `lost`     | Physical execution is proven absent before a durable terminal result; the assignment remains unresolved. |

## `available_tools` is authoritative

A live agent record in `agent_list` includes an `available_tools` snapshot.
Use only tools currently listed there; do not infer control eligibility
from `state` alone. `agent_steer` means active work accepts cooperative steering,
`agent_interrupt` means a currently working Pi operation may be preempted,
superseding earlier undelivered steering with replacement direction,
`agent_reply` means a correlated pending `ask_owner` is valid, and
`agent_close` means exact direct ownership and the current applicable close
preflight permit teardown. For a
Lead-owned parent, that preflight includes its owned descendant cascade.
`available_tools` never includes `agent_delegate`; a worker generation handles one assignment at a time, and a
retained worker takes its next assignment through the controller. Every operation
revalidates identity, ownership, mailbox state, and lifecycle immediately before
mutation.

A delegating agent may be blocked while direct agent work is pending and still accept
steering when `agent_steer` is listed, but it cannot expose `agent_interrupt` without a
currently working Pi operation. A `waiting` worker remains on its active assignment while unfinished provider-backed
work (running, flushing, or explicitly uncertified capture) is unresolved. A
certified terminal result the worker has not retrieved is advisory: it does not
by itself project `waiting`, withhold the worker's answer, or restrict ordinary
controls. The published answer names any such unreviewed task results. While
genuinely waiting, `agent_interrupt`, continuation, replacement assignment,
and Clear idle are unavailable. Inspection,
transcript, steering, and an armed `agent_extend` remain available; an explicit
`agent_close` may still abandon the assignment when its close preflight permits.
Stale or inactive fields are advisory and do not automatically authorize or recommend
interrupt. Descendant visibility does not imply authority;
records outside the controller's direct ownership can have an empty action list.
Directly owned live records may expose the applicable live controls; directly
owned live or proven `lost` records may expose `agent_close` when the applicable close
preflight currently succeeds. They may also expose the read-only `agent_transcript`
action when a materialized persisted Pi session file exists. `agent_extend`
appears only for a directly owned, currently live record with an armed soft
window, so it is absent when `softTimeoutMs` is `0`, when the assignment has
resolved, for every record that is not directly owned, and for a recovered
`unknown` or proven `lost` record. A direct call for such a record fails with
`agent_busy` and changes no window. Unknown records and
non-direct descendants remain fail-closed with no actions.

## Soft-deadline windows

A soft window is advisory scheduling state, not a public state and not a health
condition. When `softTimeoutMs` is positive (default `300000` milliseconds; `0`
disables the feature), an accepted assignment arms a window measured from the
worker's acknowledgement. Once it elapses, the owning controller receives one
`pi-herdsman-agent-soft-deadline` digest covering every due worker it owns, on
the health cadence, so delivery can lag expiry by up to one 30-second scan and
happens only while the owner is idle. Each entry lists the worker's current
controls from the same eligibility as `available_tools`, so a record waiting on
an owner question lists `agent_reply` and not `agent_interrupt`. A background-work
waiter remains eligible for the digest and `agent_extend`, but never becomes
interruptible merely because its task is unresolved. After a delivered digest the
window re-arms for another `softTimeoutMs`, so a long
assignment is checkpointed periodically; delivery, `agent_close`, and proven
loss end the windows, and a resolved assignment is never listed again.
`agent_extend` lengthens one worker's next window without changing its
assignment. A checkpoint does not mean the worker is stale, hung, or safe to
terminate.

## `idle`

With `retainWorkers` enabled, delivering a worker's terminal result leaves its
verified live process, pane, label, and mailbox in place, so the same worker can
take a later assignment. That resolved shape is the public state `idle`: its
result file is gone, it has no active request and no pending owner question, and
its process is still proved live. An `idle` worker's `available_tools` is exactly
`agent_inspect`, `agent_transcript` when its persisted session file exists, and
`agent_close`; it never lists steering, interrupt, reply, or extend. `idle` is
not stale, never receives inactivity attention or a soft-deadline digest, and
does not keep its owner's herd run open. When `retainWorkers` is `false` the
delivered worker is closed and removed instead, so `idle` never appears. A
retained worker whose process is proven absent projects as `lost` under the same
rules as any other worker.

## `blocked` and owner questions

An agent waiting on a valid `ask_owner` reply projects as `blocked` after its ask
turn settles. Answer through the exact direct owner using `agent_reply` with the exact `agent` identity.

When `@juicesharp/rpiv-ask-user-question` emits its public
`rpiv:ask-user:blocked` event, the managed worker projects as `blocked` while
the dialog waits for input. The signal clears when the question completes,
is cancelled, or errors; it is scoped to the exact run, Pi session, and active
assignment. Because the event is process-local, Herdsman relays only that
identity through a transient mailbox marker rather than forking the question
tool. This is not a Herdsman `ask_owner` request and does not enable
`agent_reply`.

A delegating parent can also project as `blocked` while it waits for direct
children. That is progress-capable parent waiting, not evidence that the child
runtime is externally blocked. Recovery attention for `blocked` is reserved for
a live Herdr runtime that itself reports `blocked` while an active request
exists and no `ask_owner` question is pending; a question-tool wait does not
produce that attention.

## `settling`

Examples include an uncompleted task handoff, pending final result delivery,
direct-agent gating, terminal cleanup, result persistence recovery, and startup
or integration handoff. Do not assign another task to a settling agent.

`settling` alone is not timeout-worthy and does not generate generic health
attention. A durable `result_error` within settling may still produce direct
owner attention so the stored persistence recovery can be handled.

## `unknown`

Unknown is intentional fail-closed behavior. Unreadable, oversized, malformed,
or validation-failing mailbox state is reported with a bounded diagnostic and an
empty `available_tools` list. Do not substitute pane idleness, elapsed time,
model metadata, missing activity, a guessed session, or an old agent identity.

When physical identity is ambiguous for an otherwise valid direct-owned record,
Herdsman may emit one generic `unknown` attention event for that unresolved
episode. It does not add mutation actions, prove loss, or broaden `ask_owner`.
When exact physical evidence changes, re-evaluate the record from fresh state.

A pane that resolves an occupant but not the run-scoped alias is also `unknown`.
Every destructive control closes a generation through `herdr agent get <alias>`,
so a pane whose agent never reported that alias — or that holds a different or
unnamed one — cannot authorize a close, a retirement, or a relaunch. The record
keeps its empty `available_tools` list, carries a diagnostic naming the pane and
the alias, and preserves its mailbox and saved Pi session for the operator to
resolve. Alias absence alone never proves loss.

`lost` is different: a coherent Herdr inventory proves the expected pane,
session, and run-scoped alias are absent. It is not completion or task failure;
use direct-owner `agent_close` to abandon the unresolved generation when the
applicable close preflight succeeds. Lost attention may repeat for the direct
owner while the assignment remains unresolved.

## Result precedence and actions

A durable terminal result or `result_error` takes precedence over physical
absence and projects as `settling` while delivery or recovery converges. A
failed inventory never proves `lost`; relocated or conflicting evidence is
`unknown`.

| Record    | Direct-owner actions                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`    | `agent_inspect`, eligible `agent_transcript`, and `agent_close` when the applicable close preflight succeeds.                                                   |
| `waiting` | `agent_inspect`, eligible `agent_transcript`, `agent_steer`, eligible `agent_extend`, and `agent_close` when the applicable close preflight succeeds; never `agent_interrupt` or Clear idle. |
| `live`    | `agent_inspect`, eligible `agent_transcript`, `agent_steer`, `agent_interrupt` only for a working operation, `agent_reply` only for a valid pending ask, eligible `agent_extend`, and `agent_close` when the applicable close preflight succeeds. |
| `lost`    | eligible `agent_transcript` and `agent_close` when the applicable close preflight succeeds.                                                                    |
| `unknown` | None.                                                                                                                                                          |

Owned descendants remain visible through proven durable ancestry but do not gain
direct control from that visibility.

## Inactivity fields

A qualifying `working` agent may also report `stale`, `inactive_ms`, and
`last_activity_at`. Qualifying progress includes model streaming and tool
execution boundaries (`tool_execution_start` and `tool_execution_end`), along
with the surrounding turn and message boundaries. Streaming tool updates alone
do not advance `last_activity_at`. This advisory does not change the state or
prove a hang. The first stale attention is eligible after ten minutes without
qualifying progress; if the same condition persists, reminders may repeat at
approximately `5m → 2m30s → 1m15s → 1m`, subject to the 30-second health scan.
Leave healthy or legitimately long-running work alone. Use `agent_transcript` for persisted evidence and `agent_inspect` for live evidence; stale alone does not justify `agent_interrupt` or `agent_close`.
The stale episode is defined by its active request and last qualifying activity;
first-attention diagnosis is bounded, and repeated reminders do not automatically
repeat the live capture.

## See also

- [Lifecycle](../concepts/lifecycle.md)
- [Recovery](../guides/recovery.md)
- [Agent tools](agent.md)
