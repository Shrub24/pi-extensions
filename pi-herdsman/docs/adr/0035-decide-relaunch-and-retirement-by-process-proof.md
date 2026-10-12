# Decide relaunch and retirement by process proof

## Decision

**Only a process verdict grants permission.** A Radar-launched child may be
relaunched, or retired by close, only when `agent.get` reports its registered
process `absent` or `mismatched`. Nothing else grants it.

**Close outcomes and listing state are never authority, in either direction.**
A `completed`, `already_exited` or `refused` close neither permits nor vetoes a
relaunch, and neither does the listed state of the agent. A close still records
what it did, and that record decides retirement and names residue. It does not
decide whether the process may be replaced.

**The four verdicts decide as follows.**

| Answer | Decision | Reason |
|---|---|---|
| `absent` | permit | the birth tuple is positively gone |
| `mismatched` | permit | the PID is live with another birth identity, so the registered process is gone |
| `verified` | refuse | the registered process is still there |
| `unavailable` | refuse | no claim is not evidence of absence |
| `not_found` (the call's error, not a verdict) | refuse | ambiguous between a gone process and a missing registration |

**A proved-gone child may be retired by close without a pane close.** Its
process is gone, so there is nothing alive to protect. Its mailbox is retired and
its assignment is abandoned, and the verdict is recorded as the evidence. The
pane is not closed by this path; it is left as residue if it still exists.

**A refusal is a stop, not a dead end.** A refused proof leaves the mailbox, pane
and edge in place, so a later attempt can still prove absence and relaunch. No
path retries through a different route or falls back to another source.

**An outstanding assignment under an unproved process refuses before any effect.**
A process proved gone while work was owed is a loss. It is reported, and the
assignment is neither resumed nor retired by the gate.

**Operator hints name only actions the state permits.** A hint shown for an
unproved child with an outstanding assignment names no action and states why.
It does not offer close, because close refuses there. The refusal is the
safety property; the hint is what has to match it.

## Rationale

Presence is the weakest fact the system has. A pane can be missing while its
process runs, a close can report an edge's recorded exit, and a listing reflects
mailbox state. Letting any of these grant or veto a relaunch lets the weakest
evidence decide over the strongest. The process verdict is the only fact that
says the registered process is no longer there, so it is the only fact that
grants permission.

`not_found` and `unavailable` are refused rather than treated as absence. A
daemon that lost its registry would report `not_found` for a live process, and
`unavailable` is the contract's own term for no evidence. Accepting either would
turn an unreadable answer into a relaunch of a process that may still be running.

Retiring a proved-gone child without a pane close follows from the same proof. The
rule protects a process that might be alive. Once it is proved gone, there is
nothing to protect, and requiring a pane close would only block cleanup on a
pane that the daemon may not be able to close.

## Alternatives rejected

- **Derive absence from a pane read or from freshness.** A missing pane is not an
  exit: the contract defines it as `unresolved` and never as process exit.
  Freshness is not liveness. Both are presence facts and cannot prove a process
  gone.
- **Check the proof before the close.** The process is alive before the close, so
  a pre-close read cannot prove absence. The proof runs after the close, before
  the mailbox is retired.
- **Re-derive the live observation to retry a relaunch.** After a completed close
  the pane is gone, so the observation cannot succeed and a retry would be
  stranded. A stored close is reconciled instead, and it is evidence, not
  permission.
- **Let `refused` or `already_exited` veto a proof of absence.** A refusal before
  any effect says nothing about the process. The pane it leaves is residue and is
  named on the result.
- **Resume or retire the assignment of a proved-gone child automatically.** A
  process gone while work was owed is a loss, and the operator decides what
  happens to the work.
- **Relax a refusal to make an operator hint true.** The hint was wrong, not the
  gate. The gate refuses an unproved child with an outstanding assignment, and it
  keeps refusing.

## Consequences

- An operator who closes a proved-gone child gets its mailbox retired and its
  pane left in place. The result names the pane and the verdict, so the residue is
  visible.
- A child whose process cannot be proved either way stays stuck until the
  process can be proved. This is accepted: a permanent wrong relaunch costs more
  than a visible refusal, and the refusal names the state.
- The absence proof is verified against the fake daemon only. The live
  disposable-tmux check is not run, so the contract reading is a risk until it is.
- `not_found` is refused for process proof even though the control-plane contract
  says to treat it as absent for record reads. Process proof and record reads are
  different questions.

## See also

- [Publish agent facts to the Radar daemon registry](0031-publish-agent-facts-to-the-radar-daemon-registry.md)
- [Do not hold settlement on an unretrieved result](0032-do-not-hold-settlement-on-an-unretrieved-result.md)
- [Retain workers across assignments](0013-retain-workers-across-assignments.md)
