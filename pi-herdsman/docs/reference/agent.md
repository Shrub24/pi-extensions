# Agent tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

Managed-agent operations are exposed as ten distinct tools:

```text
agent_list
agent_delegate
agent_continue
agent_steer
agent_interrupt
agent_extend
agent_reply
agent_close
agent_inspect
agent_transcript
```

Each tool accepts only its operation's fields. Schemas require necessary fields
and reject unrelated properties; runtime authorization and fresh lifecycle
checks remain authoritative. These tools are registered only for the lead
controller and authorized delegating-agent controllers.

## `agent_delegate`

```json
{
  "definition": "implementer",
  "label": "approved-change",
  "task": "---\nschema: delegation-brief/v1\nprofile: execution\nobjective: Implement the approved change\ncontext:\n  summary: none\n  inputs: []\nscope:\n  allowed: [\"pi-herdsman/extension\"]\n  excluded: []\nconstraints: []\nacceptance: [\"The targeted behavior is implemented and verified\"]\nresponse: role-defaults\nexecution:\n  affectedArea: \"pi-herdsman/extension\"\n  validationExpectations: [\"Run the focused test and package check\"]\n---\nMake the requested change."
}
```

Call `agent_delegate` with `definition`, a complete versioned Markdown brief in
`task`, and optional `label` and `files`. A plain task sentence is rejected with
field-specific guidance before a pane, request, or advisory window is created.
The brief must satisfy the selected definition's profile; custom definitions use
the common profile unless configured stricter. Include all common fields, even
when lists are intentionally empty, and use `context.summary: none` with
`inputs: []` when no context is required. Context inputs are privately
snapshotted and bound to the accepted request. Use `files` for additional
assignment evidence. The optional `label` must match
`^[a-z][a-z0-9_-]{0,31}$` and sets the requested logical agent label; an existing
live-label collision fails. Fresh delegation runs in the calling controller's cwd.
The definition is resolved from the effective roster and delegating agent
controllers may use only their allowlisted definitions. Project definitions
still require trusted project approval. A fresh delegation starts a new Pi
session.
Each accepted definition delegation creates one agent generation that executes
one assignment at a time. The terminal result is delivered once and the agent is
cleaned up. With `retainWorkers` enabled, delivery keeps the verified live
worker as `idle` instead of cleaning it up, so the worker can take a later
assignment without a new process.

## `agent_continue`

This example targets a common-profile worker; use the profile required by the
saved definition for other workers.

```json
{
  "session": "<exact .jsonl path or full UUID>",
  "task": "---\nschema: delegation-brief/v1\nprofile: common\nobjective: Continue the investigation\ncontext:\n  summary: The exact saved session contains the prior investigation.\n  inputs: []\nscope:\n  allowed: [\"the stated investigation\"]\n  excluded: []\nconstraints: []\nacceptance: [\"Return the requested findings with evidence\"]\nresponse: role-defaults\n---\nContinue from the saved history and report the requested findings."
}
```

Call `agent_continue` with an exact `session`, a fresh complete versioned
Markdown brief in `task`, and optional `files`. Continuation never inherits the
previous assignment's scope or response override; the new brief must satisfy the
saved definition's role profile. The exact saved session path or full UUID
supplies its cwd, definition identity, and historical Pi context. Continuation
hands one more assignment to the session's
agent, creating a new agent generation (a new process) when no retained worker
can take the work; it never assigns work to a working or settling
agent. The cwd comes from the saved session. The saved definition is resolved again
from current configuration and must currently be enabled and authorized; its
current effective configuration
is used for the continued assignment. Omitted model and thinking fields restore the
saved session settings, while explicit definition fields override them.
Concurrent or otherwise conflicting managed representations of the exact
session fail closed. The controller's own active Pi session cannot be continued
to itself.

When `contextRetirement` is enabled, `agent_continue` is rejected for a retired
managed-agent session; delegate a fresh agent and pass the previous
handoff/result and relevant files instead. Retired results explicitly instruct
the controller to delegate a fresh agent.

Continuation reports one of four outcomes:

| Outcome     | Result evidence                      | Behavior                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reused      | `reused: true`                       | With `retainWorkers` enabled, the session's single representation is a directly owned `idle` worker whose recorded launch configuration still matches the current definition: the task is submitted into that existing verified live process, so no new process, pane, or label appears. |
| relaunched  | `relaunched: "definition_changed"`    | The idle worker's launch configuration drifted (prompt body including `@file` contents, `systemPromptMode`, model, thinking, the effective tools, skills, extensions, and context inheritance, or the selected child executable) or its launch record is missing. The worker is closed and a fresh generation continues the same session. |
| recovered   | `relaunched: "process_lost"`         | The session's directly owned worker is a proven `lost` generation: its process is gone, and its pane is either gone too or survives as a shell. A `lost` record is retired through the shared close preflight and a new generation continues the same Pi session in a new process and pane. Nothing is closed or removed by hand first, and a surviving pane is left untouched. Unprovable identity still refuses `agent_busy` — an unclaimed run-scoped alias refuses instead with the named `target_ambiguous` diagnostic — and an unretrieved durable result still refuses rather than being overwritten. |
| fresh       | neither field                        | The work starts as a new agent generation because no verified live process represents the session.                                                                                                                                                                    |

A reused process keeps its launch-time system prompt and in-memory extension
state, so reuse requires the same launch configuration the process started with.
Working, settling, or ambiguously represented sessions still fail closed
(`agent_busy`), and an occupied logical label still fails
(`agent_label_exists`). A continuation whose recorded session file is missing or
unreadable fails with a session-unavailable `invalid_request` naming that
exact path.

Fresh delegate assignments receive an automatically chosen logical label when
no label is supplied. The saved session's logical label is inherited exactly
for the continued generation; if that label is occupied, continuation fails
with `agent_label_exists`.

Successful delegate and continue results preserve their respective action
names. They include `agent`, `definition`, request, session, and startup
evidence where available. All return after atomic
recording for controller restart recovery, not completion. A terminal result
makes the exact session identity
prominent for a later `agent_continue` call.

## Child executable

Managed children run the binary selected by `PI_HERDSMAN_CHILD_COMMAND` in the
lead's own process environment. Herdsman reads it when it builds a launch, so it
is not a configuration-file setting and has no `/agents` menu entry.

| Value              | Effect                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset or empty     | No command is configured; the launch is unchanged.                                                                                                                            |
| an absolute path   | That file is used; it must exist and be executable.                                                                                                                           |
| a command name     | The name is resolved on the launch `PATH`, and the resolved executable is used.                                                                                                |
| anything else      | The launch fails before any pane or process is created, with an `invalid_request` naming `PI_HERDSMAN_CHILD_COMMAND`. No default executable is substituted for a mistyped value. |

The selected executable is part of the recorded launch configuration, so a
retained `idle` worker whose recorded command differs from the current one —
including set where it was unset, or cleared where it was set — is relaunched
instead of reused. The value is read once per launch and is therefore fixed for
a running lead: changing it takes effect on launches after the lead restarts.

One value covers the whole herd. The child environment receives the resolved
value with its launch, so a worker that delegates a further worker reuses the
value it inherited and nested workers run the same binary without a shell
exporting anything. The export itself belongs to the lead process's environment
(the operator's shell or dotfiles); this repository documents the contract and
does not manage those files. To roll back, unset the variable and restart the
lead.

### How a configured child starts

When a command is configured, the launch runs it in the pane instead of asking
Herdr to start its canonical `pi` executable. `<command> <child args…>` is typed
as one shell line with every element single-quoted, so a path holding a space, a
quote or a shell metacharacter reaches the child unchanged, and the pane's
interactive shell parses the line. Nothing else about the launch changes: the
pane, its environment, the recorded shell process, the failure shape and the
rollback are the same start path as before.

An argument holding a newline cannot be typed this way: it would arrive as a
second input line, and an interactive shell's plugin can refuse to submit that,
leaving the pane holding an unterminated command. Such a launch runs from a
script instead — Herdsman writes `exec <command> <args…>` to a private file and
types that file's path, so the pane still receives one line and the argv still
reaches the child byte-exact. The launch retires the file once it is over, after
the child has read it.

Herdr does not start this child, so the running process registers itself in
Herdr's agent registry and Herdsman waits for that record before it reports the
launch successful. The Herdsman alias is then applied with `agent rename` and
verified through `agent get`, so the child answers to the same alias as a child
Herdr started. The session path Herdr reports is written at session start and
the file appears with the child's first turn; a launch never fails on a session
file that does not exist yet.

This path relies on measured Herdr behaviour, recorded for herdr 0.9.3 in the
`herdsman-child-command` change's `probe.md` (the repository's decision record
for it is [ADR 0029](../adr/0029-run-a-configured-child-in-its-pane.md)):
detection of a `pane run` agent, `agent rename`, registration timing, `pane
run` quoting and the script-borne form. A Herdr version that changes any of them
needs the probe re-run before the launch code is adjusted.

A launch that fails is reported and rolled back exactly as a failed
`agent start`: the typed command is never retried, because it may already have
started the child, and the pane's recent output is attached to the failure when
Herdr can still read it.

## Separate response contracts

The incoming delegation brief defines the assignment; its `response` field is
`role-defaults` or an explicit versioned `response-contract/v1` override. This
outgoing contract is independent of the required brief fields and cannot weaken
the role's incoming brief profile. It selects `inline`, `artifact`, or `both`,
`text` or `markdown`, required Markdown sections and an optional registered
metadata schema. Artifact targets also name a workspace-relative path and state
whether an unchanged pre-existing artifact may be reused. A short inline answer
needs no file; reports are required only when the accepted contract says so.

Before publishing success, the worker validates the actual inline response and/or
requested artifact. Artifact validation checks canonical containment, regular-file
identity, symlinks, baseline freshness, bounded bytes, Markdown structure and
metadata. Success details include framework-owned contract and brief hashes,
worker session identity, text origin, and observed artifact path, hash, byte count,
and created/reused disposition. Model-authored claims about checks are not
execution evidence. A rejected answer, or a reply cut off by the model's output limit, is first
corrected in the worker's own session, at most twice per assignment (ADR 0019).
If it is still unacceptable, the result is a one-shot failure with a typed
`invalid_response` or `artifact_error` code and bounded field diagnostics.

## Background-work waiting

A registered background-work provider binds spawned tasks to the accepted
request. An exit notification records that a wake was delivered; it does not
resolve the task. A protected waiter receives one mandatory terminal-resolution
wake even when `notifyOnExit` is false; the shared scheduler coalesces it with
existing exit notifications and cancels a held wake if `get` or confirmed `stop`
resolves the task first. Resolution requires a certified result handoff or
delivery of an unrecoverable-error notice. While assigned work is running, flushing, or
awaiting review, the worker remains on the same request and no successful final
result is published. While its model turn has yielded but provider completion or
the required post-review answer is still outstanding, `agent_list` reports
`waiting`: the assignment stays busy, cannot be interrupted, continued, replaced,
or selected by Clear idle. The owner may inspect or transcribe it, steer it,
extend an armed soft window, or explicitly close it as cancellation.
Herdsman persists the provider, revision, and outstanding task IDs, then
revalidates them during recovery and immediately before result
persistence. A missing, failing, or identity-changed provider for a bound
request fails closed. After the work resolves, the worker reviews it and emits
a post-review response before the assignment settles. A waiting assignment does
not depend on the provider's wake arriving: while an assignment is held, the
worker re-queries the provider on a bounded cadence and re-runs settlement when
a change notification arrives while a fresh answer is pending, so a provider
that reports resolution without delivering a wake still produces exactly one
result. The bounded re-query stops once the assignment settles, the worker is
reused, or it is closed. Assignments accepted
without a provider keep the ordinary lifecycle; `retainWorkers` affects only
post-delivery cleanup and does not abandon an unresolved request.

Mailbox envelopes use protocol v5 while retaining the existing `mailboxes-v4`
storage directory for in-place migration. A migrated v4 artifact is accepted
only for an exact active or completed request id in the bounded legacy allowlist;
a legacy control cannot admit a new task, and the marker clears after result
delivery.

## `agent_list`

`agent_list` request:

```json
{}
```

No selectors or other fields are accepted. A successful result includes the
effective `agent_definitions` roster and visible agent records.

Each valid durable generation in the controller's proven ownership projection
remains visible, including physically unresolved `unknown` and proven `lost`
records. Each actionable live agent record includes:

| Field                                                           | Meaning                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                                                         | Exact live logical agent identity to pass to the applicable `agent_inspect`, `agent_transcript`, `agent_steer`, `agent_interrupt`, `agent_reply`, or `agent_close` tool. It is not a continuation identity. |
| `state`                                                         | Safe lifecycle state for observability.                                                                                                                                                                     |
| `available_tools`                                               | Snapshot of currently eligible callable tools, using their exact names.                                                                                                                                     |
| `workspace_id`, `pane_id`, `tab_id`, `tab_label`                | Herdr identity evidence.                                                                                                                                                                                    |
| `cwd`, `pi_session_id`, `pi_session_path`                       | Agent location and Pi session evidence.                                                                                                                                                                     |
| `owner_session_id`                                              | Exact direct owner Pi session.                                                                                                                                                                              |
| `agent_definition`                                              | Effective definition name.                                                                                                                                                                                  |
| `active_request_id`, `last_activity_at`, `stale`, `inactive_ms` | Assignment and advisory activity evidence.                                                                                                                                                                  |
| `parent_label`                                                  | Durable parent assignment when the parent is visible.                                                                                                                                                       |
| `cleanup_error`, `result_error`, `diagnostic`, `tokens`         | Bounded recovery and presentation evidence when present.                                                                                                                                                    |

`available_tools` is authoritative model guidance for the current snapshot.
Do not infer eligibility from `state`.
`agent_close` is listed only when the current snapshot passes the applicable close
preflight. For a Lead-owned delegating agent, that preflight covers the complete
owned descendant cascade because closing the parent closes that cascade
child-first. Invocation always reacquires current evidence and revalidates
identity, ownership, mailbox state, durable results, and lifecycle before
mutation. Active work may list `agent_steer`; a valid correlated pending
`ask_owner` may list `agent_reply`. A currently working agent may list
`agent_interrupt`; a delegating agent blocked while waiting on children may
still list `agent_steer` but not `agent_interrupt`.
`available_tools` never lists `agent_delegate` or `agent_continue`: these are
controller tools, not controls on an already-live agent. An agent cannot
receive a second assignment. Directly owned live agents may expose the
applicable live controls; directly owned live or proven `lost` records expose
`agent_transcript` when their materialized persisted Pi session file exists. Directly
owned live or proven `lost` records may expose `agent_close` when the applicable close
preflight currently succeeds. Unknown records and non-direct descendants expose
no mutation actions. Every operation rechecks identity, ownership, mailbox
state, and lifecycle immediately before mutation.
The public record does not expose `steerable`.

The session-start instructions include the same complete definition metadata
projection returned by `agent_list` for that controller. It is a startup snapshot;
use `agent_list` for live agent state, ownership, or a refreshed definition roster
after configuration changes. Leaf agents do not receive a definition roster.

Lead controllers see the complete effective definition roster and agents whose
durable ownership chain resolves to that lead. Delegating agents see only allowed
enabled leaf definitions and their direct agents. Unrooted, ambiguous, or cyclic
durable ancestry is not attributed to the current controller. Unknown mailbox
diagnostics remain non-actionable.

## Health attention

Health reconciliation is event-driven with a 30-second fallback scan. It
reconciles fresh mailbox and Herdr state and sends attention only to the exact
direct owner while that owner is idle. The `available_tools` included in an
attention event is an advisory snapshot of current authority; every later
`agent_steer`, `agent_interrupt`, `agent_reply`, or `agent_close` call revalidates identity, ownership,
mailbox state, and lifecycle.

Persistent actionable attention may repeat while the same condition remains
unresolved. Reminder timing is process-local and advisory, not a mailbox API;
restarting may cause an unresolved condition to be reminded again. The normal
cadence for other repeatable conditions is approximately `5m → 2m30s → 1m15s → 1m`.
The first stale advisory remains eligible after ten minutes without qualifying
execution progress; unchanged stale episodes repeat approximately every five
minutes, subject to 30-second scan granularity.

The first stale attention for an episode attempts one bounded live inspect
capture when inspect is currently authorized. The automatic capture has a short
health-path deadline and does not change agent state. The stale message may
carry the same live evidence fields exposed by inspect. Repeated reminders for
the same episode do not automatically capture again.

Generic attention reasons are:

- `result_error`: a terminal result could not be durably persisted; follow the
  stored recovery details and `nextAction`;
- `blocked`: the live Herdr runtime is blocked without a pending `ask_owner`
  question;
- `handoff`: an old durable request remains unacknowledged; do not duplicate or
  resubmit it because non-acknowledgement does not prove non-delivery;
- `unknown`: physical identity is ambiguous and remains fail-closed, with no
  mutation actions and at most one attention event per episode.

Stale and lost assignments, and delivered `ask_owner` questions, retain their
dedicated message types. Stale attention is advisory and does not by itself
justify intervention. `settling` alone does not generate generic attention.

The public `blocked` projection can also mean that a delegating parent is
waiting for direct children; that progress-capable parent state is distinct
from a live Herdr runtime reporting `blocked`.

Initial attention eligibility is: stale after ten minutes without qualifying
progress; lost, `result_error`, live runtime `blocked`, and physical `unknown`
immediately; an old retained handoff after ten minutes; and a delivered
`ask_owner` reminder approximately five minutes after health reconciliation
first observes that the original ask was successfully delivered. The reminder
path never duplicates first ask delivery. Unknown is the exception to repeated
attention: it is one notification per unresolved physical-identity episode.

For stale recovery, use supplied evidence first. If it is absent or
insufficient, perform at most one bounded diagnostic read: `agent_transcript` for
persisted conversation/tool history or `agent_inspect` for live terminal/process
evidence. Do not repeat a read solely because the same stale episode was
reminded again. `agent_steer` acceptance means a cooperative correction was queued
for Pi, not that the current operation observed it: Pi delivers it after the
current assistant turn and its tool calls reach a steering boundary. An unchanged
stale episode means no qualifying execution boundary occurred, so a steer queued
during that episode cannot yet have taken effect. Continue waiting only while
existing evidence positively supports legitimate long-running work; otherwise
use `agent_interrupt` to preempt the active Pi operation and continue the same
assignment. It supersedes earlier undelivered steering. Use `agent_close` only
when abandoning the assignment is intended. Do not poll or create another
delivery path for health attention.

## Soft deadlines

A soft deadline is an advisory checkpoint that is separate from the health
conditions above. With `softTimeoutMs` positive (default `300000` milliseconds;
`0` disables the feature), every accepted assignment arms a window measured from
the worker's acknowledgement. On the same health cadence, so up to one
30-second scan after expiry, and only while the owner is idle, the controller
receives one `pi-herdsman-agent-soft-deadline` message covering every due worker
it directly owns. Each entry names the worker and its definition, the
assignment's elapsed time, and the controls that worker currently allows, taken
from the same eligibility as `agent_list`'s `available_tools`. The message
states that it is advisory, that no worker was aborted, steered, or closed, and
that waiting is a valid response. After each delivered digest every included
window re-arms for another `softTimeoutMs` unless `agent_extend` replaced it, so
a long assignment is checkpointed periodically until it resolves. Delivery,
`agent_close`, and proven loss stop the windows, and a resolved assignment never
appears in a later digest. A due digest and other health attention are delivered
independently: neither suppresses the other.

Before the digest is delivered, the controller emits it on Pi's extension event
bus as `pi-herdsman:soft-deadline`. The payload is
`{ownerSessionId: string, entries: [...] , annotations: string[]}`; `entries`
are the same entries delivered with the digest, and `annotations` is a mutable
list that subscribers may append to synchronously. Non-empty annotations render
as a trailing section of the digest. A listener that throws is isolated and
does not block delivery, and with no subscriber the delivered digest is
unchanged.

## `agent_inspect`

```json
{ "agent": "implementer-1" }
```

`agent_inspect` accepts only the exact live agent label. It is available
only to that agent's direct owner, and only when the agent is a current,
unambiguous managed identity. The result is read-only live terminal/process
evidence only: it contains the exact session/pane identity, Herdr's up to 80
recent-unwrapped terminal lines, and advisory foreground process evidence when
available. Herdsman applies a local 16 KiB byte cap to the captured terminal
output. The public `recent_output_truncated` boolean is true only when that
local byte cap truncates the output and false otherwise; process evidence has
separate bounds. The result does not expose persisted Pi session-message
history. Its model-facing text includes the agent, session, pane, useful
foreground commands, and recent activity; raw process and recent-output
evidence remains in the structured result details.
The identity is checked again after capture; if the pane or Pi session was
replaced, inspection fails closed. Inspection does not change agent state,
mailbox records, lifecycle, or available controls.

## `agent_transcript`

```json
{ "agent": "implementer-1" }
```

`agent_transcript` accepts only the exact agent label. It is available only to
the exact direct owner when `available_tools` includes `agent_transcript`.
It reads the exact persisted Pi session through Pi's native compaction-aware
session context and returns user text, visible assistant text, tool calls,
textual tool results, and persisted compaction/branch summaries. It does not
expose raw assistant reasoning, system messages, extension custom entries or
messages, model/provider metadata, images, or live terminal/process state.

Pi can assign a session ID and future session path before creating the JSONL
file. During that brief interval `agent_transcript` is not listed in
`available_tools`; this is normal startup behavior. A materialized session
file must be non-empty before `agent_transcript` is advertised. Output is tail-bounded
to 16 KiB. Individual textual tool results larger than 4 KiB preserve their
beginning and end and replace their middle with an omission marker. The
`transcript_truncated` field is true when an individual tool result or the final
transcript was bounded. A finalized assistant tool call is
persisted before the tool starts, so a currently executing tool may appear
without a corresponding tool result. That absence does not itself prove that
the tool is still running. `agent_inspect` remains the live terminal/process
observation path. Transcript is read-only and does not change agent state.

## `files`

`files` is valid on `agent_delegate`, `agent_continue`, `agent_steer`,
`agent_interrupt`, and `agent_reply`; it is not valid on `agent_list`,
`agent_close`, `agent_inspect`, or `agent_transcript`. It accepts
ordinary paths,
reusable direct-agent refs such as `result:researcher#1`, and canonical
`result:<request-id>` refs already supplied as evidence. Semantic refs use the
exact direct-agent label and index shown in a completion and resolve against the
calling Pi session's current branch before ordinary file preparation; see
[Result handoff](../guides/handoffs.md).
Ordinary paths are resolved from the controller cwd, checked as readable regular
files, canonicalized with `realpath`, and embedded only when the exact message
limit permits. Otherwise they remain canonical references. Semantic direct refs
are resolved on the current branch, while canonical `result:<request-id>` refs
remain logical result references. `files` is a `string[]` for all three forms.

`files` is explicit per-message evidence. A fresh delegated session does not
implicitly receive the caller's conversation or caller-side attachments.
`agent_continue` resumes the exact saved managed-agent Pi history.

Startup uses Herdsman's default timeout budget; it is unrelated to managed-agent
Pi shell execution. Direct calls from a managed agent to the Pi built-in
`bash` or `powershell` tool receive a default 600-second timeout when the call
omits `timeout`; an explicit timeout is kept unchanged. Current message limits
are governed by the Herdsman config file and its defaults, plus the fixed
mailbox protocol ceiling. Mailbox records now use protocol V5 while retaining
the `mailboxes-v4` storage path so existing assignments can migrate in place.
Reading V4 state carries forward only its exact active and completed request
IDs to authorize legacy V4 request, ask, and result artifacts; unrelated V4
records remain rejected. V4 control markers remain readable during migration,
while new control requests use `__PI_HERDSMAN_AGENT_V5__:`.

Do not attach or mention agent instruction files such as `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`, or equivalents merely because they exist. Rely on normal project or
runtime discovery. Attach one only when the task requires inspecting,
modifying, comparing, or transmitting it, the user requests it, or its required
instructions would not otherwise reach the target. Attach a required `SKILL.md`
only when the task needs it and the selected definition does not already provide
that skill. Ordinary relevant source, documentation, configuration, and
evidence files remain attachable.

## `agent_steer`

```json
{
  "agent": "implementer-1",
  "message": "Also update the focused regression.",
  "files": [".pi-herdsman/review.md", "result:reviewer#1"]
}
```

Call `agent_steer` only when `available_tools` lists it. Steering changes the
current assignment and does not create another final result.

`agent_steer` changes the current assignment without cancelling the current Pi
operation. While Pi is executing a model or tool operation, steering may remain
queued until that operation reaches a safe boundary. Steering cannot stop a
wedged tool.

## `agent_interrupt`

```json
{
  "agent": "implementer-1",
  "message": "---\nschema: delegation-brief/v1\nprofile: execution\nobjective: Replace the current approach and finish the assignment\ncontext:\n  summary: The current approach is blocked by a hanging command.\n  inputs: []\nscope:\n  allowed: [\"the existing assignment\"]\n  excluded: []\nconstraints: [\"Stop the hanging command before proceeding\"]\nacceptance: [\"Complete the assignment using the replacement approach\"]\nresponse: role-defaults\nexecution:\n  affectedArea: \"the current assignment\"\n  validationExpectations: [\"Verify the replacement approach\"]\n---\nStop the hanging command and continue with a different approach."
}
```

`agent_interrupt` accepts the exact live `agent` and a fresh complete versioned
Markdown brief in `message`, plus optional `files`. The replacement brief and
response requirements are bound to the same active request; it is available only
to the exact direct owner while the agent has a currently working Pi operation.
`agent_steer` and `agent_reply` remain free-form and do not replace the assignment brief.

Interrupt is preemptive: it requests Pi cancellation of the current operation,
supersedes earlier steering Pi has not yet delivered, and continues the same
managed generation and assignment using the replacement message. It does not
create another assignment or terminal result and does not
close or recreate the agent. Previous Pi-queued steering/follow-up input is
removed from execution by Pi's native abort behavior and is not retained in the
child editor.

Cancellation uses Pi's native abort mechanism. Non-cooperative third-party
tools may not stop immediately; `agent_close` remains the destructive fallback.

## `agent_extend`

```json
{
  "agent": "implementer-1",
  "windowMs": 1800000
}
```

Call `agent_extend` only when `available_tools` lists it. It accepts the exact
live `agent` identity and an integer `windowMs` from `1` through
`2147483647`; no other field is accepted. It replaces that worker's current
soft-deadline window with a fresh window of `windowMs`, measured from the call,
so the worker is not checkpointed again until that window elapses. It changes
no assignment, does not steer or interrupt the worker, and creates no result.
Windows armed after that one use the configured `softTimeoutMs` again.

It is unavailable for any worker that is not directly owned, for a worker whose
live presence is not currently proved (including a closed or proven `lost`
record and a recovered `unknown` record), for a resolved assignment, and
whenever `softTimeoutMs` is `0`; such a call fails without changing any window.
See
[Soft deadlines](#soft-deadlines).

## `agent_reply`

```json
{
  "agent": "implementer-1",
  "message": "Use option B."
}
```

Call `agent_reply` only when `available_tools` lists it for a valid correlated
pending `ask_owner` question. The reply continues the same assignment and
contains its request, ask, assignment, and session correlation evidence.

See [`ask_owner` API](ask-owner.md).

## `agent_close`

```json
{ "agent": "implementer-1" }
```

Call `agent_close` with `agent`. Close requires exact direct ownership
and a current applicable close preflight. For a Lead-owned parent, that
preflight covers the complete owned descendant cascade because closing the
parent closes that cascade child-first. Invocation always reacquires current
evidence and revalidates identity, ownership, mailbox state, durable results,
and lifecycle before mutation. Closing abandons a pending owner question;
closing a delegating agent cascades through directly owned agents first. Cleanup
remains fail-closed when exact identity or ownership cannot be proved. A direct
owner may also close a proven `lost` generation after a fresh absence proof when
the applicable close preflight succeeds; `unknown` presence remains
non-actionable, and a refusal that a pane resolves an occupant for whose
run-scoped alias it does not answer names that pane and leaves the mailbox and
saved session in place.

## Result delivery and errors

An accepted delegated task remains the internal mailbox `kind: "task"` request
and has one correlated final result. Delivery goes to the exact owning Pi
session and occurs exactly once. Success is published only after the accepted
response contract validates the requested inline and/or artifact output. Invalid
responses are corrected in the worker's session up to twice (ADR 0019), then
produce one terminal `invalid_response` or `artifact_error` result with bounded
field diagnostics. An explicit provider error is reported with the failure it
caused: when the turn that ended carries one (a `429`, for example), the terminal
result names the provider's own error text before the validation outcome, so an
owner can tell a provider failure from an answer the worker could have fixed. A
turn that ends without provider evidence reports the validation outcome alone.
After that, correction requires a new valid assignment or an
eligible interrupt replacement.
A persisted reusable completion's model-visible wording is:

```text
Agent result · agent=<agent> · definition=<definition> · session=<id> · status=completed

Result ref: result:<agent>#<index>
```

Reusable result artifacts persist the source agent label, definition, assignment
cwd, and producing Pi session ID (when available) with the agent-authored result
so later `files` handoffs retain their provenance. The framework-owned
`responseValidation` details include accepted contract/brief hashes, worker
session identity, text source, and observed artifact hashes, sizes, and
created/reused dispositions. These records attest to output structure and
artifact identity, not the truth of worker claims or whether claimed checks ran.

Details retain durable `agentLabel`, `resultIndex` when present,
`agentDefinition`, `piSessionId`, `piSessionFile`, canonical result references,
elapsed time, context usage, truncation, response-validation provenance and
diagnostics, and persistence-error evidence. The
agent is cleaned up after the terminal result is delivered; the Pi session
remains available for continuation.

Tool failures return structured details for normal public errors. See
[Errors](errors.md), [agent states](agent-states.md), and
[agents and identity](../concepts/agents.md).
