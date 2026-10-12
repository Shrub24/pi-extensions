# An unacknowledged launch holds no brief and releases no reservation

**Id:** 35f588ab-593b-4333-b780-1c5f481309fb
**Type:** decision
**Status:** active
**Evidence:** confirmed
**Source:** owner rulings on the relaunch and regression-repair passes; Radar contract pinned at f87348032a80 (`spawn.get`, `spawn.list`, `spawn.close`, `agent.retire`)
**Revisit when:** the launch can prove the child's identity before the pane exists, or Radar gains a sanctioned way to retire a spawn edge that never bound a child

## Decision

A delegate under Radar launches the child, waits for the child's own readiness
acknowledgment, and only then writes the assignment into the child's mailbox. When
readiness never arrives the delegate returns `pane_not_ready`, writes nothing into the
child's mailbox, and leaves the launch as a retained reservation: its spawn record, its
label and its mailbox stay held. A second delegate for that label is refused with
`agent_label_exists`. Nothing releases the reservation automatically, and a retry never
replays the old request.

The reservation is reported as unresolved with explicit uncertainty. The operator decides
what happens to it. Daemon evidence that the pane is gone, or that an exit was observed,
does not release it.

## Why no brief is held before readiness

The launch-then-verify-then-deliver order never hands a brief to a process whose identity
is not yet proved. Holding the brief durably before readiness would store an assignment
whose target may never exist, and would make a later retry look like a replay of a
delivered assignment when no child received it.

## Why no reservation is released

Radar's pinned contract does not let us certify that an unbound launch is gone.

- `spawn.get` and `spawn.list` report `exit_observation` for an unbound edge, but a pane
  that disappears is `unresolved`, not exited. `exit_observation` is retained
  pane-command evidence. It is not independent proof that the launched process ended,
  and an out-of-band respawn or server change can replace what it observes.
- Neither an exit report nor a disappearance revokes the spawn token, which is still
  unused.
- `spawn.close` refuses an edge with no bound child (`spawn edge has no bound child to
  close`). Spawn records stay durable.
- `agent.retire` retires a channel writer, not a spawn.

So releasing the reservation locally would be a guarantee the daemon does not give. The
label would be reused while the daemon still holds a token that a child could redeem.

## Missing contract (Radar side)

There is no sanctioned way to retire a spawn edge that never bound a child. This is a
genuine gap at f87348032a80, not a misread endpoint. It is what keeps the reservation
held. The next reader should not assume we forgot the retirement path. Automatic
release waits on that contract.

## Rejected alternatives

- **Hold the assignment durably before readiness, and redeliver the same request id on
  retry.** Rejected for the reason above: the brief would sit in durable storage for a
  target that may never exist.
- **Release the reservation when `spawn.get` reports the pane gone or the exit observed.**
  Rejected: that evidence is not proof the process ended, and the daemon can still redeem
  the token.
- **Close the unbound spawn to clear it.** Rejected: `spawn.close` refuses an edge with no
  bound child, so the call would be a refusal presented as cleanup.
