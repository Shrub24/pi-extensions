# Herdsman control

[Documentation index](../README.md)

An operator surface asks the owner of a managed worker to close or restart it by
writing a request file, and the owner answers with a result file. There is no
socket and no inbound surface: the filesystem is the whole transport, so the
contract is `herdsman-control/v1`, carried in
[`herdsman-control.fixture.json`](herdsman-control.fixture.json).

Every request id ends in exactly one of three terminal states that a requester
derives from the files alone, so a requester never has to guess whether its own
local timeout meant the owner was unavailable.

## Where a request goes

The owner of a target is the session named by that target's
`pi_herdsman_parent_session`; a nested worker's owner is the worker that
delegated it. A lead, a root session and a standalone Pi session have no owner,
so there is nobody to ask and the answer is `unsupported_target`.

Requests and results live under
`~/.pi/agent/pi-herdsman/control/<ownerSessionId>/`:

```text
inbox/<requestId>.json     a request the owner watches for
inbox/<requestId>.claim    written by the owner when execution begins
results/<requestId>.json   the owner's answer
```

The owner creates `inbox` and `results` itself at session start, owned by the
current user, mode `0700`, not a symlink, and watches `inbox` from then on, so
it is watching before it handles a prompt. A requester refuses a directory that
fails the same trust check and writes nothing.

A request and a result are each written atomically as `<requestId>.json`, mode
`0600`, and neither exceeds 8 KiB. `requestId` is a UUID and names both files.

## Request

```json
{
  "version": 1,
  "requestId": "a0000000-0000-4000-8000-000000000001",
  "operation": "close",
  "agent": "implementer-1",
  "runId": "8f2b1c34-5d6e-4f70-8a91-2b3c4d5e6f71",
  "paneId": "w1:p3",
  "piSessionId": "9a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d",
  "piSessionPath": "/home/user/.pi/agent/sessions/--project--/2026-01-01T00-00-00-000Z_9a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d.jsonl",
  "confirmation": {
    "operation": "close",
    "label": "implementer-1",
    "runId": "8f2b1c34-5d6e-4f70-8a91-2b3c4d5e6f71"
  },
  "requestedAt": "2026-01-01T00:00:00.000Z",
  "expiresAt": "2026-01-01T00:00:30.000Z",
  "requester": "agent-radar"
}
```

| Field | Value |
| ---------------- | -------------------------------------------------------------------- |
| `version` | `1`. A `version` the owner does not speak is refused. |
| `requestId` | UUID naming the request, the claim and the result. |
| `operation` | `close` or `restart`. |
| `agent` | Exact runtime label of the target. |
| `runId` | Exact run UUID of the target. |
| `paneId` | Optional cross-check: the herdr pane of that run. |
| `piSessionId` | Optional cross-check: the Pi session of that run. |
| `piSessionPath` | Optional cross-check: the persisted session file. |
| `confirmation` | `operation`, `label` and `runId` as the operator saw them. |
| `requestedAt` | ISO 8601 time the requester wrote the request. |
| `expiresAt` | Absolute ISO 8601 expiry; the owner refuses an expired request. |
| `requester` | Name of the surface writing the request. |

`agent` and `runId` name an identity, never a process. Every other target field
is an optional cross-check: a supplied value that disagrees with the owner's
record refuses instead of acting, and an omitted one is not required. The owner
ignores fields this build does not define, and version 1 never gains a required
field, so an older requester keeps working against a newer owner.

The confirmation is not optional. It must name the operation, label and run id
the operator saw, and the owner refuses a request with no confirmation or a
confirmation that does not match its own target.

## Result

```json
{
  "version": 1,
  "requestId": "a0000000-0000-4000-8000-000000000001",
  "operation": "close",
  "outcome": "closed",
  "message": "Closed implementer-1 run 8f2b1c34-5d6e-4f70-8a91-2b3c4d5e6f71.",
  "effects": ["process_ended", "pane_closed"],
  "completedAt": "2026-01-01T00:00:01.000Z"
}
```

| Field | Value |
| --------------- | --------------------------------------------------------- |
| `version` | `1`. |
| `requestId` | The request this result answers. |
| `operation` | `close` or `restart`. |
| `outcome` | `closed`, `restarted`, `refused` or `unknown`. |
| `category` | Present when the outcome is `refused`: why it was refused. |
| `message` | One line naming the target and the reason. |
| `effects` | The effects actually applied, in the order they happened. |
| `completedAt` | ISO 8601 time the owner wrote the result. |

A result names the effects actually applied rather than the operation that was
asked for. Closing a live target reports `process_ended` and `pane_closed`.
Closing a proven lost generation removes its mailbox but leaves any surviving
shell pane untouched; it reports only `process_ended`, indicating that the
managed process is no longer live, not that this request terminated it.
`restart` reports `process_ended`, `session_retained` and `process_relaunched`,
and keeps the pane, so it never reports `pane_closed`. A refusal and an `unknown`
outcome list no effects. Requesters must read `effects`, not infer a pane close
from the `closed` outcome.

| Outcome | Meaning |
| ------------- | --------------------------------------------------------------------------------------- |
| `closed` | The managed generation was closed. `effects` says whether its pane was also closed; a lost generation's surviving shell pane is left untouched. |
| `restarted` | The process ended and a new process continues the same Pi session, label and run id. |
| `refused` | The owner declined and applied no effect; `category` names the reason. |
| `unknown` | Execution had started and its outcome cannot be established; never retried. |

A `refused` result carries the error category for its condition, using the
categories [Errors](errors.md) defines verbatim and adding `unsupported_target`
for a target that has no owner to act on it:

| Category | Condition |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `invalid_request` | The request is malformed, carries a version the owner does not speak, has no confirmation or a mismatched one, or has expired. |
| `target_not_found` | No managed worker matches the named identity, or the target's presence cannot be proven. |
| `target_ambiguous` | A supplied cross-check disagrees, or the live identity no longer matches at execution time. |
| `agent_busy` | The target's state or readiness does not allow the operation. |
| `unsupported_target` | The target is a lead, root or standalone session, so it has no owner. |

## Terminal states

A requester reads the files in this order and stops at the first answer. A
result outranks a claim, and a claim outranks expiry, because a claim proves
execution started.

| State | File evidence | What it means |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `result` | `results/<requestId>.json` exists | Terminal. Read the result; the outcome is settled. |
| `started` | No result, `inbox/<requestId>.claim` exists | Terminal. Execution started and its outcome is unknown. A claimed request is never retried; the owner writes an `unknown` result for the orphaned claim at its next start. |
| `not_executed` | No result, no claim, `expiresAt` has passed | Terminal. Nothing was executed, with or without an owner response. |
| `pending` | No result, no claim, `expiresAt` has not passed | Not terminal. The owner may still run it; read again later. |

Expiry is checked before the claim is created, so an expired request is refused
without acting and leaves no claim. The owner creates `inbox/<requestId>.claim`
with `O_EXCL` as its first execution step, so exactly one execution can start
for a request id even if two owners see the same file.

A requester uses its own timeout only to decide how long to wait, never as a
verdict: the request file outlives the timeout, and the three terminal states
above are the only answers.

## Eligibility

Eligibility is decided at execution time from fresh evidence, not from what the
request recorded. For `close` that is the complete `agent_close` preflight:
exact label resolution, live-session identity validation, the herdr agent
integration match, exact-running proof, refusal while a durable result is
unretrieved, and the pane close under the lifecycle lock with the assignment
lock held. See [Agent tools](agent.md#agent_close).

| Target state | `close` | `restart` |
| -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `idle` retained managed worker | Allowed when the preflight passes. | `restarted`, same run id, same pane. |
| `working` | Allowed when the preflight passes; the assignment is abandoned. | Refused `agent_busy`. |
| `waiting` | Allowed when the preflight passes; the assignment is abandoned. | Refused `agent_busy` while the worker has unfinished background work (running, flushing, or explicitly uncertified capture). An unretrieved certified terminal result alone does not restrict interrupt. |
| `blocked` | Allowed when the preflight passes; a pending owner question is abandoned. | Refused `agent_busy`. |
| `settling` | Allowed only when the preflight passes; an unretrieved durable result refuses it. | Refused `agent_busy`. |
| `lost` | Allowed when the preflight passes over proven absence. | Refused `agent_busy`; a lost target is close-only. |
| `unknown` | Refused `target_not_found`. | Refused `target_not_found`. |
| lead, root or standalone session | Refused `unsupported_target`. | Refused `unsupported_target`. |

`restart` continues the same Pi session in a new process on the retained-worker
relaunch path, which needs the owner's mailbox, the recorded launch fingerprint
and a retained pane. It therefore exists only for an idle retained managed
worker: any other owned target is refused `agent_busy`. Working, waiting and
blocked stay untouched by a refused restart.

A refusal leaves the target exactly as it was. A close that is refused for an
unretrieved durable result leaves the pane open, and an `unknown` presence is
never closed on the strength of missing metadata.

## Containment

A requester closes a pane through herdr directly only with positive evidence
that the pane is unmanaged: no agent in it, or an agent kind Pi Herdsman never
manages. A Pi pane publishing any `pi_herdsman_*` key is managed, an idle
retained worker included, and is closed only through its owner. A Pi pane
publishing none is unverified, and the direct close is refused. Metadata absence
means unknown, never unavailable and never unmanaged.

A tab or workspace close that contains a managed pane is refused as a whole.
The requester sends one `close` request per managed agent to that agent's owner
and closes the container only once it holds no managed pane, so nothing is
partially applied.

## Handling and retention

A control request is an operator action, not a conversation turn, and creates no
prompt. The owner records it as a session entry Pi does not send to the model.
What the model learns depends on what it was waiting on. Closing a target with an
unresolved assignment resolves that assignment through its normal terminal result
path, typed as closed by an operator, so the lead learns it as it would any failed
delegation. Closing or restarting an idle or delivered target is lifecycle only:
the model is not told, and `agent_list` reflects it (a closed worker is gone, a
restarted one carries `relaunched`).

After writing a result the owner publishes
`pi_herdsman_control=<requestId>:<outcome>` on its own pane with a short TTL as a
wake hint. The results directory is authoritative: a requester that never sees
the token reads the file and obtains the same outcome. The owner prunes results
older than 24 hours and never prunes a claim that has no result.

## See also

- [Agent tools](agent.md#agent_close)
- [Agent states](agent-states.md)
- [Pane metadata and hierarchy](pane-metadata.md)
- [Errors](errors.md)
