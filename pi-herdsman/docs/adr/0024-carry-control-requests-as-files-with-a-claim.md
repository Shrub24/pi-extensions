# Carry owner control requests as files with an exclusive claim

## Decision

An operator surface asks the owner of a worker to close or restart it by writing
a JSON request file into `control/<ownerSessionId>/inbox/`; the owner answers with
a result file in `results/`. The owner creates and trusts that directory itself at
session start and watches `inbox` with `fs.watch` plus a startup scan. There is no
socket and no inbound surface, so the filesystem is the whole transport.

Execution begins by creating `inbox/<requestId>.claim` with `O_EXCL`. A claimed
request is never retried. The owner tells its model about a close only when the
closed target left an assignment unresolved; closing or restarting an idle or
delivered target is lifecycle only.

## Rationale

A request file outlives the requester's local timeout and the owner's process. A
connection would not: a session with no background tasks holds no bus connection,
the connection belongs to `pi-bash-processes`, and an owner restart would lose
every pending request. Because the file survives both sides, a request id has
exactly three terminal states that a requester derives from the files alone (a
result; a claim with no result; no claim and past expiry), so a local timeout
never has to be read as an owner being unavailable.

The watcher is armed at session start rather than on demand. Watching only while
a request is pending cannot work, because the owner would need to learn of the
request without watching for it. The startup scan covers what a request written
while the owner was down needs: expiry, or execution.

A close or restart whose first attempt may have succeeded cannot be repeated,
because an owner that died mid-execution cannot tell what applied. So the claim,
not a retry, is what records that execution started: it is created with `O_EXCL`,
exactly one execution can start for a request id, and a requester that finds a
claim without a result reads "execution started, outcome unknown" and decides
what to do next. At its next start the owner writes an `unknown` result for each
orphaned claim, so the requester always reaches a terminal state; it still never
repeats the work.

A control request is an operator action, not a conversation turn, so it creates
no prompt. What the owner's model needs depends on what it was waiting on. A
close of a target that still had an unresolved assignment leaves the lead waiting
on a result that will never arrive, so that assignment resolves through the
result channel a failed delegation already uses, typed as closed by an operator.
An idle or delivered target changes only lifecycle, which `agent_list` already
reports, so the model is not told.

## Alternatives rejected

- A unix socket owned by Herdsman: a new inbound attack surface, and it is lost
  on restart, taking pending requests with it.
- Riding the Radar bus: it carries display metadata, and its owner is not the
  session that owns the target.
- Asking the owner through `agent.prompt` or `send_keys`: it puts a control
  decision in a model turn and returns no result the requester can read.
- Retrying a claimed request: the first attempt may already have applied.
- Treating a local requester timeout as an owner failure: the request file
  outlives the timeout, so the timeout says nothing about the owner.
- Telling the model about every outcome: a lifecycle change on an idle worker is
  not a conversation turn, and the lead can see it in `agent_list`.
- Notifying the model of nothing: a lead waiting on a closed worker would wait
  forever for a result that can no longer arrive.

## Consequences

- The trust check fails closed. The owner creates the directory itself, mode
  `0700`, owned by the current user and not a symlink; a requester that finds
  anything else writes nothing and reports the directory untrusted.
- A refusal is a result file, not a missing answer, so every refusal is
  attributable to the request id.
- Results older than 24 hours are pruned. A claim with no result is never
  pruned, because it is the only proof that execution started.
- A control request re-runs the preflight the `agent_close` tool uses, through
  the same function, so a control close can never apply a weaker check than the
  tool.
- Version 1 of the contract never gains a required field, for the reason
  [ADR 0022](0022-accept-an-older-owners-request-shape.md) gives: the owner and
  the requester do not reload together.
- The owner publishes `pi_herdsman_control=<requestId>:<outcome>` as a wake hint
  with a short TTL. The results directory stays authoritative, so a requester
  that misses the token reads the same outcome from the file.

## See also

- [Herdsman control](../reference/herdsman-control.md)
- [Accept an older owner's request shape](0022-accept-an-older-owners-request-shape.md)
- [Retain workers across assignments](0013-retain-workers-across-assignments.md)
- [Manager owns project assignment resolution](0012-manager-owns-project-assignment-resolution.md)
