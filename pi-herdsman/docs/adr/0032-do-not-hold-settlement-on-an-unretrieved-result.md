# Do not hold settlement on an unretrieved result

## Decision

**A certified terminal background result never holds an assignment.** Outstanding
work is a running process, a capture still flushing, or a terminal capture the
provider explicitly marked uncertified. A certified result that nobody retrieved
is not outstanding, so it does not withhold settlement and does not project
`waiting`.

**Unfinished work still blocks, and the provider owns the distinction.** A
restored capture that can never certify stays outstanding; the provider marks it
`captureCertified: false` on its snapshot entry, and consumers use that field
alone for the decision. They must not parse the entry's reason text.

**An unretrieved result is durable advisory state.** It is never auto-cleared; it
is protected from retention, keeps being surfaced by the review reminder, and
leaves the ledger either through a real handoff or through an explicit dismissal
recorded as its own resolution kind, distinct from a delivery and from a capture
error.

**The obligation it carries moves to the conversation.** When a worker settles
with its own unretrieved results, the published result names each one and its
outcome, so the owner judges the report knowing what may not have informed it.

**The capture path stops being model-facing, and enforcement is deferred.** An
operation's model text names no capture file or directory; the operator surface
keeps the path, an oversized response is referenced through the truncated-output
artifact, and captures are created owner-only. The real barrier is a capture
daemon — preferably under its own dedicated or dynamic OS user, so the worker
does not own the bytes — and it is future work, not a property of this decision.

## Rationale

A worker produced a complete answer that never reached its lead. It had spawned
four background checks and read their output, but it read the *files*: an
ordinary retrieval had printed the capture path, and reading outside the tool
surface is undetectable by design. The ledger said the results had not been
handed over, Herdsman withheld publication, the pane said `waiting`, and
`interrupt` was refused. The worker was idle and finished; the lead was told it
was busy.

The hold could not achieve what it was written for. It never stopped a worker
from concluding — it stopped the conclusion from being *delivered*. And its
release condition, a handoff, is unobservable from the worker's side whenever the
read happens outside the tool surface, so the block was a deadlock waiting for an
unlucky worker rather than a guarantee. An unread result is a fact worth keeping
and reporting; it is not a dependency, and treating it as one turned a
bookkeeping gap into a lost result and a misleading state.

## Alternatives rejected

- **Let the completion wake clear the hold.** The wake carries the task id, the
  outcome, the command and an inventory — never the output. It proves the process
  ended, not that the result was seen, and it is a delivery channel with policy
  around it (`notifyOnExit`, the output-wake budget, pending wakes voided at
  shutdown). Making it authoritative would tie settlement to display policy and
  remove the reason to retrieve anything.
- **Bound the hold with a grace window.** It needs a clock, a configured value
  and a third state ("held, expired"), and it still publishes the wrong advisory
  for something that is not a wait.
- **Count only running work and drop the ledger state.** That loses the retention
  protection, the reminder and the visibility that make an unread result findable
  at all.
- **Enforce with permissions or an obfuscated private store.** The agent runs as
  the same uid and can `chmod` and `find`; these are speed bumps, not barriers.
  Kept as hygiene, replaced as enforcement by the daemon.
- **Copy the capture only on consumption.** Adds an I/O copy to every full read
  for a barrier the same uid can bypass anyway, while the daemon gets the barrier
  as a side effect of owning the bytes.

## Consequences

- Enforcement is advisory: a worker may publish an answer while one of its
  results is unread. This is accepted because the read is unobservable — the
  previous guarantee was nominal — and the cost of pretending otherwise was an
  undelivered answer.
- Superseded clauses: the resolution condition in ADR 0021 ("only an actual
  retrieval retires it" as a settlement dependency) and the outstanding-work
  clause in ADR 0023 — a certified finished result of an earlier assignment is
  still carried into the next one, but it no longer holds that assignment either.
  The bind refusal and every rule for live or uncertified work are unchanged.
- The bounded re-query and the "produce a fresh post-review answer" prompt now
  serve genuinely held work only.
- A worker that never consumes anything accumulates ledger rows until it is
  dismissed; retention bounds them and the pane separates live work from
  unretrieved results, so the accumulation is visible.

## See also

- [Recover a held settlement without a wake](0021-recover-a-held-settlement-without-a-wake.md)
- [Carry finished results into the next assignment](0023-carry-finished-results-into-the-next-assignment.md)
- [Retain workers across assignments](0013-retain-workers-across-assignments.md)
