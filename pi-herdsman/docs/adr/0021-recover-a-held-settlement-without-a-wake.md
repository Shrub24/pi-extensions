# Recover a held settlement without a wake

## Decision

A withheld settlement no longer depends on the background-work provider
delivering a wake. While an assignment is held, a bounded `unref`ed backstop
re-runs settlement on a 5-second cadence, and a provider change notification
lets settlement re-run immediately when a fresh answer is already pending.
Publication stays inside settlement: only `settleCurrentAgent` writes a result,
and a notification still never resolves anything by itself.

The fresh-answer recovery prompt is sent once per request. If its run starts
and then settles without a fresh answer, with all dependencies resolved, the
assignment fails with `empty_result`. Provider notifications and backstop ticks
cannot establish that the recovery run has ended; they must not fail a worker
that is still answering.

## Rationale

A provider that reports the outstanding work resolved without delivering a
notification or a wake left the worker held forever — observed on a held worker
whose provider resolved atomically. Settlement previously ran only from
`agent_settled`, so with no wake there was no second trigger and the completed
result was never published. Recovery has to come from Herdsman's own cadence
rather than from a peer's delivery guarantee.

## Alternatives rejected

- Depend on the wake alone: the defect this replaces.
- Publish from the change notification: a notification reports a provider's
  state change, not an accepted answer; publishing there would break both
  exactly-once publication and the rule that a wake never resolves a result.
- A blocking wait or repeated model polling: contradicts the background-work
  contract, which requires waiting without either.
- Re-prompt the worker on every tick: the hold already asks for a fresh answer
  once the work resolves, and a tick that finds work still outstanding must
  leave the worker alone.

## Consequences

- A held worker issues a provider query every 5 seconds while held. The query is
  an in-process event exchange, and the timer stops itself as soon as the
  assignment is no longer held; it is also stopped explicitly on settle, on
  worker reuse, and at session shutdown.
- The durable `background settlement withheld completion` record is still
  written once per hold, not once per tick.
- A tick that finds work still outstanding neither publishes nor re-prompts; a
  tick that finds a fresh answer pending lets the ordinary settlement path
  publish it.
- An empty recovery uses the existing failed-result publication and write-retry
  path rather than leaving an unmovable hold or spending another model turn.

## See also

- [Persist intent and derive runtime state](0002-persist-intent-and-derive-runtime-state.md)
- [Correct a finished answer before failing it](0019-correct-a-finished-answer-before-failing-it.md)
