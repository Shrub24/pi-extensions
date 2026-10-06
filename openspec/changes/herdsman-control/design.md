# Design

## D1. Files, not a socket

The owner session has no listener and Herdsman has no inbound surface. Requests
and results are JSON files under
`~/.pi/agent/pi-herdsman/control/<ownerSessionId>/{inbox,results}/<requestId>.json`.

- The owner creates the directory itself at session start (owned by us, mode
  0700, not a symlink) and holds an `fs.watch` (inotify, not a poll) over
  `inbox/` from then on. A requester refuses a directory that fails the same
  trust check the Radar bus publisher applies.
- A watcher armed at start, not on demand: "watch only while a request is
  pending" would need the watcher to learn of a request without watching.
- Files survive an owner restart; a connection would not. A session with no
  background tasks has no Radar bus connection at all, and the connection
  belongs to pi-bash-processes, so inbound frames would move admission into
  another extension.

Rejected: a unix socket owned by Herdsman (new attack surface, lost on
restart), riding the Radar bus (metadata only, wrong owner), `agent.prompt` or
`send_keys` into the owner (puts a control decision in a model turn and gives no
result).

## D2. The owner is the target's parent

The owner of a managed worker is the session named by its
`pi_herdsman_parent_session`. A nested worker's owner is the worker that
delegated it. A lead, a root session and a standalone Pi session have no owner,
so there is nowhere to send a request and the answer is `unsupported_target`.

## D3. Identity, not process

A request names `agent` (the runtime label) and `runId`. `paneId`,
`piSessionId` and `piSessionPath` are optional cross-checks: any supplied value
that disagrees with the owner's record refuses. At execution time the owner
re-runs the full existing preflight (candidate resolution, live-session identity
validation, the `herdr agent get` integration match, exact-running proof, and
the pane close under the lifecycle lock with the assignment lock held), so a
change between receipt and effect is `target_ambiguous`.

## D4. Admission: expiry, claim, three terminal states

A local requester timeout cannot mean "owner unavailable", because the request
file outlives it. So:

- The request carries an absolute `expiresAt`. The owner checks it at
  execution time and refuses an expired request without acting.
- Execution begins by creating `inbox/<requestId>.claim` with `O_EXCL`. Exactly
  one execution can start per request id.
- Every request id therefore ends in one of three states, which a requester can
  derive from the files alone: a result file; a claim with no result
  ("execution started, outcome unknown"); no claim and past `expiresAt`
  ("not executed").
- A claim with no result is never retried. At its next start the owner writes
  an `unknown` result for each orphaned claim, so the requester sees a terminal
  state; it still never repeats the work.

Retrying would repeat a close or restart whose first attempt may have
succeeded, and the owner cannot tell. The requester decides what to do next.

## D5. Containment

A requester may close a pane directly (through Herdr) only with positive
evidence that it is unmanaged: no agent in it, or an agent kind Herdsman never
manages. A Pi pane publishing any `pi_herdsman_*` key is managed, an idle
retained worker included. A Pi pane publishing none is unverified and refused.
Metadata absence means unknown, never unavailable and never unmanaged. A tab or
workspace close that contains a managed pane refuses the whole scope; the
requester issues one `close` request per managed agent to that agent's owner
and closes the container only once it holds no managed pane. Nothing is partially
applied.

## D6. Restart is managed-idle only

Restart reuses the retained-worker relaunch path: it continues the same Pi
session in a new process with label, run id and lineage preserved (ADR 0013).
That path needs the owner's mailbox, the recorded launch fingerprint and a
retained pane, so it exists only for managed workers. Working, waiting and
blocked targets refuse as `agent_busy`; a lost target is close-only; an unknown
presence refuses. Herdr's `agent.start --kind pi --pane` needs the pane back at a
shell, so there is no atomic in-place restart to offer anything else.

## D7. Confirmation and effects

Each request carries a confirmation echoing the operation, label and run id the
operator saw. The owner refuses a request whose confirmation does not match its
own target. The result names the effects actually applied
(`process_ended`, `pane_closed`, `session_retained`, `process_relaunched`), so a
surface can render what happened rather than what it asked for.

## D8. The owner's model is not prompted

A control request is an operator action, not a conversation turn. The owner
records it as a durable session entry that Pi does not send to the model, and
`agent_list` reflects the outcome (a closed worker is gone; a restarted one
carries `relaunched`). The model learns the effect when it next looks. This is
the default pending the user's confirmation.

## D9. Compatibility

Per ADR 0022 a required request field is only safe when both sides reload
together, which a long-lived requester makes impossible. So v1 never adds a
required field: new fields are optional and the reader ignores unknown ones. A
request whose `version` is not `1` is refused with `invalid_request`.

## D10. Wake and retention

The owner publishes `pi_herdsman_control=<requestId>:<outcome>` on its own pane
with a short TTL as a wake hint. The results directory is authoritative: a
requester that misses the token reads the file. The owner prunes results older
than 24 hours and never prunes a claim without a result.

## D11. Result shape and the refusal mappings

A refusal is `outcome: "refused"` with the error category in `category`, not a
category-valued outcome. The wake token carries only `<requestId>:<outcome>`; a
requester that needs the category reads the file. Revisit if a surface needs the
category without a file read.

The reference page's eligibility table is the normative mapping from target
state to outcome. Where the requirements leave a state unstated it was resolved
from the meanings in `errors.md`: `agent_busy` for a restart of a `settling` or
`lost` target (a lost target is close-only), `target_not_found` for an `unknown`
presence on either operation (`errors.md` already defines it as "could not prove
this exact target"), and `invalid_request` for an expired request, which is
refused before the claim is created and so leaves none. Whether closing a proven
`lost` generation reports `pane_closed` is left to the implementation.
