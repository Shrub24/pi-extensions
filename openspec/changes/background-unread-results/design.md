# Design

## Context

Two flags were being read as one.

- `exitNotified` answers *was this exit announced?* It is claimed when a wake is sent
  (`pi-bash-processes/extensions/background-tasks.ts`, grouped flush and single wake both)
  and dropped when a CLI read makes the pending wake redundant.
- `resultResolution` answers *was this result handed over?* It is written once, durably,
  and only by a delivery site.

`outstanding` is derived from the second, so a delivered wake never cleared the ledger —
which is why the incident looked contradictory: the wakes were delivered (child transcript
`custom_message` entries at 02:59:24, 03:04:54, 03:10:05, 03:13:45), the tasks still read
`awaiting-result-review`, Herdsman held the settlement, and the lead was told the worker
was waiting.

The worker's read was not through the CLI: it used `tail`/`grep` on
`/tmp/kendex-pi-bg/lanes/<session>/bg-*.log`, a path it learned from an earlier `bg_task`
result, whose model-facing text prints the capture path
(`registrations.ts` → `formatTaskResultText` → `handoff.artifact.path`). For a terminal
certified capture that artifact *is* the retained log — `snapshot-artifact.ts` copies
nothing, because a settled capture is already immutable — so one ordinary retrieval
discloses the lane convention and with it every other task's live capture.

## Decision 1: an unretrieved terminal result does not hold an assignment

Unfinished work is a dependency: the worker cannot answer yet. An unretrieved result is
not. Once the capture is terminal and certified, the worker is free to answer, and the
ledger's own record cannot distinguish "read" from "not read" — reading is unobservable.
A block whose release condition cannot be observed is not a guarantee, it is a deadlock
waiting for an unlucky worker.

Held work keeps its existing semantics unchanged: running processes, captures still
flushing, captures that never certified (including after a restore), the `waiting`
projection, the refused interrupt, the bounded provider re-query and the durable withhold
record.

### Considered alternatives

- **Let the wake clear the hold.** Rejected. A wake carries the task id, the outcome/exit
  status, the command and a running inventory — never the output. It proves the process
  ended, not that the result was seen, and it is a notification channel with a policy
  surface around it (`notifyOnExit`, the output-wake budget, voiding pending wakes at
  shutdown). Making it authoritative would tie settlement to display policy and would
  delete the reason to call the CLI at all.
- **Bound the hold with a grace window.** Rejected as the primary mechanism. It needs a
  clock, a configured grace value and a third state ("held, expired"), and it still
  publishes the wrong advisory for something that is not a wait. The exit wake remains the
  natural trigger if a future requirement needs a bounded hold.
- **Count only running work, treating unread results as fully resolved.** Rejected: it
  loses the retention protection, the reminder and the visibility that make an unread
  result findable at all.

## Decision 2: the ledger does not auto-clear; dismissal is explicit and recorded

An unretrieved result is never silently dropped: it survives the finished-task bound and
`clear` reports it rather than discarding it. The two ways out are a real handoff and an
explicit dismissal, and the second is what gives "output I do not need" a cheaper answer
than reading it. A dismissal is recorded as its own resolution kind, so a discarded result
is distinguishable from a delivered one and is never reported as a handoff.

## Decision 3: provenance rides the delivered result

Since settlement no longer waits, the owner needs the fact that the worker's answer may be
less informed than it looks. The delivered result names each unreviewed task with its
outcome. This keeps "nobody silently finalizes" as a property of the *conversation*
rather than of a hold, which is what the hold was trying to protect and could not.

## Decision 4: the capture path stops being model-facing text

Removing the path costs the model nothing. Tool-result `content` is what the model reads;
`details` is the operator surface ("for logs or UI rendering" in the host's own types), so
the TUI keeps its `Full output: …` line. Structured tool results are also model-facing:
managed Bash must leave `full_output_path` unset because it would name the task capture
file. For oversized text, `pi-output-policy` materializes a separate immutable artifact
and names that artifact in its truncated response; it is not the background-task capture
path and remains the explicit reference for complete output.

### Considered alternatives

- **Owner-only permissions or a private directory.** Rejected as enforcement: the agent
  runs as the same uid and can `chmod` or `find`. Kept as hygiene (the capture file
  becomes 0600) and paired with the deferred barrier below.
- **Copy the capture to a materialized artifact only on consumption.** Deferred with the
  daemon. It would add an I/O copy to every full read for a barrier that the same uid can
  bypass anyway, while the daemon gets the barrier as a side effect of owning the bytes.
- **A capture daemon now.** Deferred, not rejected. It is the real barrier when it
  runs under a distinct dedicated or dynamic OS user: the worker cannot `chmod` or
  `find` its capture, because it does not own the file. It is a larger change than this
  one — user lifecycle, packaging, IPC, cleanup, authorization, and recovery — and is not
  required to fix the incident.

## Risks

- **Enforcement becomes advisory.** A worker can now publish an answer while one of its
  results is unread. Accepted: the read is unobservable, so the previous guarantee was
  nominal, and the cost of pretending otherwise was an undelivered answer. The mitigation
  is Decision 3 plus the visibility in Decision 2; the barrier in Decision 4's deferred
  work is what makes the advisory trustworthy rather than decorative.
- **A worker that never consumes anything accumulates ledger rows.** Bounded by retention
  and reportable by `clear`; the pane shows live and unretrieved work separately so the
  accumulation is visible rather than silent.
