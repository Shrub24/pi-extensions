# Proposal

## Why

On 2026-10-10 a managed worker produced a complete, correct final answer and it never
reached its lead. The worker had spawned four background checks, read their output, and
written its report. The assignment still did not settle: a terminal result that has not
been handed over counts as outstanding work, so Herdsman withheld publication, projected
`waiting`, and refused `interrupt`. The lead saw a worker that was busy; the worker was
idle and finished.

The ledger is not wrong about what it recorded. It is wrong about what the record means.
It had no way to clear: the worker read the capture file itself — an ordinary `bg_task`
result had printed that file's absolute path one turn earlier — and a read outside the
CLI is undetectable by design. So an honest worker that retrieves its output directly is
permanently "awaiting review", and the hold that produces is unbounded, session-scoped
and invisible. A worker held that way publishes nothing and says nothing about why.

The hold also does not achieve what it was written to achieve. It does not stop a worker
from concluding; it stops the conclusion from being *delivered*. `waiting` is not a
protection against an uninformed report, it is an outage with a misleading label.

Two defects are fixed here, and they are separate:

1. **An unretrieved terminal result is an advisory, not a lifecycle block.** It stays
   durable, visible, retention-protected and reminded, but only unfinished work — running,
   still flushing, never certified — may hold an assignment.
2. **The capture is reachable outside the CLI.** Its path is disclosed in the
   model-facing text of a routine retrieval, so "unretrieved" cannot be read as "unread".

## What Changes

- **Settlement waits only on unfinished work.** `running`, still-flushing and
  never-certified captures keep the existing hold, `waiting` projection and refused
  controls. A certified terminal result does not, whether or not it was retrieved.
- **The delivered result names unreviewed results.** When a worker settles with its own
  unretrieved terminal results, the published result names each one and its outcome, so
  the owner judges the report instead of inferring from silence.
- **An unretrieved result is explicitly dismissible.** `clear` accepts specific task ids
  and may discard a terminal result that was never retrieved, recording the discard as a
  deliberate resolution distinct from a delivered handoff. Running work is never cleared.
- **Wakes report per-task result status**, in the batched form as well as the single one:
  id, outcome, and whether the result is still unretrieved.
- **The capture path is not model-facing text.** An operation's result text names no
  capture file or directory; the operator surface (tool-result details) keeps the path,
  and an oversized response keeps its reference through the truncated-output artifact.
  Capture files become owner-only.

## Impact

- Capabilities: `background-task-retrieval`, `herdsman-background-work`,
  `background-pane-facts`.
- Packages: `pi-bash-processes` (provider, retrieval and clear surfaces, wake text,
  capture privacy), `pi-herdsman` (settlement hold, `waiting` projection, delivered
  result provenance).
- Supersedes the blocking clauses of ADR 0021 and ADR 0023; recorded as ADR 0032.
- **Not in scope:** making the capture unreadable. This change removes the disclosure that
  made it discoverable and records the remaining gap; a real barrier is separate future
  work. The preferred direction is a capture daemon with its own dedicated or dynamic OS
  user, so the capture is not readable by the worker's uid. The daemon lifecycle,
  packaging, IPC, and recovery contract are substantial and deferred.
