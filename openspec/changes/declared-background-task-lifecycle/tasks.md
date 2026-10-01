# Tasks

Boxes are checked only with recorded phase evidence, never as a planning claim. Read `handoff.md` for ownership, gates, and stop conditions; use `context.md` for source/test anchors.

Checkbox state is per-phase evidence, not progress optimism. Phase A (section 1,
plus the review-clock and hard-deadline primitives of 3.3/3.5) is checked off below;
the remaining 3.x verification clauses name the declared `get` adapter, which is
delivered in a later phase, so those boxes stay open. See
`background-task-phase-a.md` for the phase-A evidence and the exact next-phase
interface.

Correction pass (reopened, then re-verified): 1.1, 1.3 and 1.4 were reopened for
a durable restore-readiness rule (`snapshot.ts` `restoredTaskFromSnapshot` no
longer overwrites a persisted readiness record or re-derives capture
completeness from a fresh writer queue), centralization of the missed-exit
replay onto the shared acknowledgment entry point (`lifecycle.ts`
`replayMissedExitsLifecycle`), and a corrected baseline provenance claim. All
three are checked again only against the re-verified evidence in
`background-task-phase-a-corrected.md`, including the pristine pre-edit baseline
captured from the owner input commit
`d5a595a3a4c39e6cf408b5404585fd1795777272` (160 pass / 0 fail).

Second 1.4 correction (reopened, then re-verified): the same requirement
covered a *running* snapshot too, and the first pass left it as an inherited
exception. `restoredTaskFromSnapshot` now treats a snapshot that recorded
`resultReady === false` — the mid-flush window, the `session_shutdown` coercion,
and every running task — as an uncertified capture with no producer left, so a
pid-gone coercion restores as a new `incomplete` readiness with
`outputComplete === false` instead of as a ready, complete result;
`completeResultFinalization` refuses to upgrade a rehydrated capture the record
left uncertified (the orphan watcher's finalize included), and a terminal
`outputComplete === false` or `incomplete` observation is documented as *not* a
successful complete-output handoff (no terminal acknowledgment, no review reset,
partial bytes kept reachable). Legacy snapshots that recorded nothing still
reconcile, and an acknowledged one still stays silent. Evidence:
`background-task-phase-a-corrected.md`, section on the 1.4 carryover; suite 188
pass / 0 fail (exit 0).

## 1. Establish the result lifecycle and acknowledgment boundary

- [x] 1.1 Record the actual jj source baseline and run the existing bash-processes suite before edits; verify the baseline report distinguishes pre-existing owner changes/failures from this change and preserves the codemode tests.
- [x] 1.2 Add explicit result readiness tied to the existing process-close/log-flush lifecycle and a shared result preparation path; verify deterministic tests cover exit-before-flush, running/finalizing retrieval, final output inclusion, and task replacement/generation races.
- [x] 1.3 Centralize idempotent completion acknowledgment for foreground delivery, terminal get/stop, retained legacy wait, and host notifications; verify concurrent acknowledgment/deferred flush tests and failed-preparation tests leave exactly the documented notification obligation.
- [x] 1.4 Extend snapshot state conservatively for readiness/review/acknowledgment and protect in-flight terminal retrieval from pruning; verify acknowledged legacy snapshots never replay merely because new fields are absent, orphan/restore outcomes stay accurate, and missing output returns an error rather than empty success.
- [x] 1.5 Document the readiness/acknowledgment contract beside the implementation and in the developer notes; verify those descriptions distinguish process exit, output readiness, host submission, and data retention.

## 2. Implement stable output snapshots and declared CLI retrieval

- [ ] 2.1 Implement bounded-preview and immutable full-snapshot preparation using the persisted combined log, not the in-memory tail; verify a running snapshot stays unchanged as new output arrives and a terminal snapshot preserves markers before and after an output larger than 1 MiB.
- [ ] 2.2 Make managed foreground completion preserve complete output before any inline truncation and share final-result construction with get/stop; verify full-artifact contents and references survive output-policy minimization/truncation and structuredContent forwarding.
- [ ] 2.3 Implement a session-private declared get/list/stop request/response bridge and generated `pi-bg` adapter; verify separate sessions, stale task generations, malformed requests, unavailable endpoint, bounded bridge failures, and requests launched through managed bash are handled without global daemon, cross-session access, or deadlock. Establish this two-session/managed-bash bridge fixture before building the full CLI adapters or removing receipts.
- [ ] 2.4 Implement `pi-bg get ID [--output]` with stdout output/stderr metadata and explicit successful-handoff acknowledgment; verify redirection produces an uncontaminated complete snapshot, piping/filtering works, preview/full have identical terminal acknowledgment semantics, and snapshot/open/write/disconnect/EPIPE failures do not commit a receipt or review reset, including large output piped into head; verify accepted-receipt retries remain idempotent throughout task retention and cannot be confused with expired unaccepted preparations; short successful writes count as delivery without certifying downstream reads.
- [ ] 2.5 Retain/reuse stable final artifacts while protecting their lifetime from live-task pruning; verify repeated get after completion/stop works within retention and expiry returns an explicit error.
- [ ] 2.6 Document the CLI examples, partial-snapshot labeling, combined-stream limits, operation exit status, and handoff failure/pipe semantics; verify each documented command in the CLI fixture and compare file output against the captured log.

## 3. Implement completion-aware get, confirmed stop, and review reminders

- [ ] 3.1 Expose get through `bg_task` using the shared operation and output schema; verify running retrieval resets only the review clock, terminal retrieval acknowledges only after successful output preparation, unchanged output is identified, and list has no lifecycle side effects.
- [ ] 3.2 Make stop await the bounded existing termination/finalization procedure and return the result under the same task ID; verify natural completion wins accurately, SIGTERM-ignore/SIGKILL escalation is covered, failed/unconfirmed stop remains explicit, and stop followed by get/full output succeeds.
- [ ] 3.3 Change soft scheduling to time since review with one held reminder per task; verify fake-clock tests cover running get, delivered reminder rearming, stale held reminder cancellation, noisy output not resetting, disabled soft intervals, and restore coalescing of overdue reviews.
- [ ] 3.4 Revalidate completion/reminder batches at dispatch and persist fulfilled obligations; verify get-vs-completion, stop-vs-completion, completion-vs-reminder, active-turn deferral, idle batching, restore, and already-queued host-message cases without clearing unrelated Pi queues.
- [ ] 3.5 Verify hard deadlines are immutable across get/list/review/legacy extend, and preserve the current configured defaults; add tests for repeated inspection reaching the original hard limit and for a task with hard timeout disabled.
- [ ] 3.6 Update operation result/render text and settings descriptions with the new stop/review model; verify no prose equates signal submission with confirmed stop, soft reminder with termination, or acknowledgment with output deletion.

## 4. Switch the ordinary interactive surface and remove read inference

- [ ] 4.1 Register only bg_task spawn/get/stop/list in TUI and do not register bg_status there; retain noninteractive/child bg_status and bounded wait, routing compatibility list/stop/log through shared list/stop/get. Verify all modes and unknown-mode fallback, required compatibility names/actions, no live-path bypass, and no absent-tool/polling/wait recommendation in the assembled TUI prompt.
- [ ] 4.2 Remove live-log advertisements from spawn/yield/get/stop/wake text, render/details/activity/dashboard paths, and consumption-related bash environment exports; verify an exact-literal surface audit and fixtures show only task IDs and explicitly handed-off immutable artifacts.
- [ ] 4.3 Remove inferred-read PATH interception and per-process consume-log bookkeeping only after declared CLI acknowledgments pass; verify raw reads of retained snapshot artifacts do not mutate notification state, no legacy inferred-consumption channel is accidentally authoritative, and unrelated PATH/process safety behavior remains intact.
- [ ] 4.4 Retire read-shim replacement/live-path CLI bypasses and the interactive sleep-as-wait path, preserving only named legacy compatibility proven necessary; verify CLI help and old caller compatibility tests route to explicit operations or give actionable migration errors rather than silently bypassing acknowledgment.
- [ ] 4.5 Update `instructions.md`, README fork delta/API examples, DEVELOPMENT notes, CHANGELOG, schema/settings copy, and any generated append-system content using the existing install mechanism; keep the shared installed block mode-neutral and free of names/actions absent in any mode; add TUI push-wait and noninteractive/child named bounded-wait compatibility guidance through the supported per-session prompt hook. Verify the effective assembled prompt and model-visible schema for tui/print/json/rpc/unknown in fixtures and a fresh Pi boot, without dynamically rewriting shared user instructions.

## 5. Integration, independent review, and delivery

- [ ] 5.1 Run complete bash-processes, output-policy, and renderer suites on the same baseline host/dependencies; verify their captured exit statuses and compare failures with the recorded baseline without reinstalling packages to hide regressions.
- [ ] 5.2 Run the acceptance matrix in `handoff.md`, including large-output/redirection, both streams, deterministic finalization races, same-ID stop/get, review rearm/hard-limit, and two-session isolation; verify concrete evidence is saved for every required row.
- [ ] 5.3 Run a fresh Pi 0.99.2 interactive/fixture live check for yield, get, completion/progress wakes, and stopped-result retrieval; verify task ownership/cleanup and schema/guidance selection. This is not the deferred subagent bridge test.
- [ ] 5.4 Obtain a fresh-context read-only review of the scoped implementation against specs/design and the baseline diff; verify P0/P1 findings are resolved with regression tests and no pi-subagents/Pi-core/Nix mutation has entered the change.
- [ ] 5.5 Inspect the scoped jj diff, deliver phase/result evidence and residual host-queue/crash/retention limitations, and update the task boxes only for verified work; verify no unrelated baseline edits, debug instrumentation, or scratch artifacts are included and no push occurs without authorization.
