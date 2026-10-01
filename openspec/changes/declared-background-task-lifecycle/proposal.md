# Proposal

## Why

Background-task completion is currently acknowledged partly by inferring shell reads of live log files. That inference misses valid reads and conflates progress inspection, completion delivery, and cancellation; the replacement makes each operation explicit and keeps output available after notification acknowledgment.

## What Changes

- Keep managed bash's foreground window, automatic yield, and explicit background dispatch. A yield returns a session-scoped task ID, status, and a bounded preview, not a live log path.
- Introduce one completion-aware retrieval operation: running `get` returns progress and resets its soft review interval; final `get` returns the flushed result and acknowledges completion. Retrieval remains repeatable.
- Emit complete output snapshots through ordinary CLI stdout (`pi-bg get ID --output`); metadata goes to stderr, so pipes and `>` work normally. Oversized tool responses hand off an immutable complete-output artifact before truncation.
- Make `stop` report confirmed termination or the actual competing outcome, and deliver the result without requiring a subsequent `get`. Keep the same ID and retained output readable.
- Keep `list` observational: no acknowledgment and no timer reset. Soft reminders measure time since review; hard deadlines remain absolute.
- Persist completion acknowledgment and reconcile it with deferred wakes and restored snapshots. Cancel extension-held stale notifications; document Pi 0.99.2's lack of selective cancellation for custom messages already queued in Pi.
- **BREAKING:** stop advertising live log paths, remove inferred-read acknowledgment/PATH read shims, and replace the ordinary interactive log/wait/extend workflow with get/stop/list. Preserve only the explicit legacy child/headless wait compatibility required while the subagent bridge remains deferred.

## Capabilities

### New Capabilities

- `background-task-retrieval`: session-scoped task handles; running/final retrieval; complete-output snapshots; stop-as-result; observational inventory; notification acknowledgment, review reminders, deadlines, and recovery.

### Modified Capabilities

None. The current OpenSpec capability inventory is empty.

## Impact

Primary implementation is in `pi-bash-processes/`: task lifecycle, CLI/IPC, retrieval, result formatting, snapshots, reminders, registration/schema, prompts, and tests. Integration checks cover `pi-output-policy` artifact preservation and `pi-tool-renderer` tool contracts. Preserve the existing codemode foreground/structured-bash route and prohibition on background dispatch from scripts.

No new runtime dependency or async-programming framework is proposed. No `pi-subagents` implementation changes, Pi core patch, Nix configuration edits, or stream-separated captured-command logs are included. Command stdout/stderr remain combined; the CLI deliberately separates raw captured output (stdout) from retrieval metadata (stderr). The child pending-work bridge and selective Pi queue cancellation are follow-up work, not claims of this change. This request creates planning/handoff artifacts only; implementation needs a subsequent authorization.
