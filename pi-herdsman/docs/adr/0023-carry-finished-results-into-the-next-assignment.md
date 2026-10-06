# Carry finished results of an earlier assignment into the next one

## Decision

When a resumed worker binds a new assignment, a background task of an earlier
assignment that has finished with a certified result and has not been retrieved
is carried: it counts as outstanding (`awaiting-result-review`) for the request
now bound, and binding succeeds. The task keeps the association it was spawned
with and is never cleared; only an actual retrieval (`bg_task get`) retires it.

A task of an earlier assignment that is still running or whose capture is not
certified, and a task that belongs to no assignment, still block the bind.

## Rationale

The earlier rule quarantined every foreign task, which is right for work that
may still change but wrong for finished history. A worker exited by hand with
unread results could not be continued: admission refused the bind, the owner has
no way to retrieve a child's tasks, and the only recovery was to open the session
in a separate unmanaged Pi, retrieve each task there, and retry. That put an
operator and a second process in the path of an ordinary resume.

Carrying keeps the property the quarantine protected: nothing is silently
resolved. The unread result stays in the pane's awaited set and in the settlement
snapshot, so the new assignment cannot settle while it is unretrieved and the
existing recovery prompt tells the worker to retrieve it. Re-associating the task
with the new request was rejected because the association is the only record of
which request produced the work.

## Consequences

- A worker can be continued after a manual exit without separate-Pi reconciliation.
- The new assignment's result can wait on work it did not start. The outstanding
  entry's reason names the earlier request so the worker can tell the two apart.
- Work that is live or uncertified is unchanged: the bind still refuses it.

## See also

- [Recover a held settlement without a wake](0021-recover-a-held-settlement-without-a-wake.md)
- [Retain workers across assignments](0013-retain-workers-across-assignments.md)
