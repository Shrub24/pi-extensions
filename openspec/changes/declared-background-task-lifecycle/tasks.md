# Tasks

Boxes are checked only with recorded phase evidence, never as a planning claim. Read `handoff.md` for ownership, gates, and stop conditions; use `context.md` for source/test anchors.

Checkbox state is per-phase evidence, not progress optimism. Phase A (section 1,
plus the review-clock and hard-deadline primitives of 3.3/3.5) is checked off below;
the remaining 3.x verification clauses required the declared `get` adapter and were
subsequently verified in phases B/C. See
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

Phase B (section 2 and tasks 3.1/3.2) is verified against
`background-task-phase-b.md`: full suite **230 pass / 0 fail** (exit 0) on baseline
`d5a595a3a4c39e6cf408b5404585fd1795777272`, with the pre-B file set re-run alone at
**188 pass / 0 fail** — the same 188 the A pass left green — so the 42 added tests
are additive and nothing previously green regressed. `pi-output-policy`'s own
suite is 42/0 and that package is unmodified; the output-policy regression imports
it as a consumer only.

Checked on that evidence: **2.1–2.6, 3.1, 3.2**.

Two real defects were found and fixed while finishing these boxes, both caught by
pre-existing owner tests rather than by the new ones:

- the first `bg_task stop` implementation printed the task's **raw** command into
  the result text, so a 100KB heredoc leaked into the transcript; `stop-content-e2e`
  failed on `bounded: false`. All transcript-facing fields of the result text are
  now bounded, and the stop's own wording moved to `details.stopMessage` so the
  command is not printed twice.
- awaiting termination left the wait's **deadline timer armed** on the path where
  the signal was refused, which `resource-stop-integration` caught as a surviving
  timer. The wait is now cancelable and is retired with the refusal.

The stop fixture contract changed with the approved behaviour and is updated where
it encoded the old fire-and-forget shape: a tool stop now drives its child's end
while the call is pending, the stop's own wait deadline appears in the pinned
timer-event tables, and the stop-result text budget is a small multiple of the
bounded command rather than a single line's. The anti-leak assertions the rows
exist for (`excludesBomb`, `commandRetained`, `taskRetained`) are unchanged.

## 1. Establish the result lifecycle and acknowledgment boundary

- [x] 1.1 Record the actual jj source baseline and run the existing bash-processes suite before edits; verify the baseline report distinguishes pre-existing owner changes/failures from this change and preserves the codemode tests.
- [x] 1.2 Add explicit result readiness tied to the existing process-close/log-flush lifecycle and a shared result preparation path; verify deterministic tests cover exit-before-flush, running/finalizing retrieval, final output inclusion, and task replacement/generation races.
- [x] 1.3 Centralize idempotent completion acknowledgment for foreground delivery, terminal get/stop, retained legacy wait, and host notifications; verify concurrent acknowledgment/deferred flush tests and failed-preparation tests leave exactly the documented notification obligation.
- [x] 1.4 Extend snapshot state conservatively for readiness/review/acknowledgment and protect in-flight terminal retrieval from pruning; verify acknowledged legacy snapshots never replay merely because new fields are absent, orphan/restore outcomes stay accurate, and missing output returns an error rather than empty success.
- [x] 1.5 Document the readiness/acknowledgment contract beside the implementation and in the developer notes; verify those descriptions distinguish process exit, output readiness, host submission, and data retention.

2.4 was **reopened** for the narrow receipt-retirement gate below and is checked
again only on the recheck evidence recorded with it.

Receipt-retirement correction (2.4 reopen, re-verified): the store's cap retired accepted
records and `settleReceipt` then answered the retired token with
`receipt-unaccepted` — "nothing is recorded as acknowledged or unacknowledged for
it", which is false for a token that *was* accepted, and is the
abandoned-preparation answer the spec forbids for an accepted one. Calling that a
capacity artifact did not exempt it from the same contract as the TTL path, so
both paths are fixed together: the aging pass now applies only to a preparation
that committed nothing, the cap retires unaccepted preparations first and never
evicts an accepted handoff of a retained task, and a token carries a keyed digest
over its own task identity. A token the session minted but no longer holds a
record for is therefore answered as an expiry that makes no claim about
acknowledgment, instead of as a never-accepted preparation; a token the session
never minted still gets the unaccepted-preparation refusal, which is true for it.

Recheck evidence (`background-task-phase-b.md` §12.4–§12.6): the named cases run
together — abandoned-preparation TTL, cap overflow with >64 accepted handoffs whose
tasks are all pruned, retained-task retry idempotency, unknown-token refusal,
altered-token refusal with no state mutation, and saturation by accepted handoffs
whose tasks are **still retained** — **9 pass / 0 fail, exit 0**; seven B gate
suites **47 pass / 0 fail** twice; pre-B file set **188 pass / 0 fail** (A
baseline); full suite **235 pass / 0 fail**, 1439 expect() calls, 83 files, exit 0.
Four mutation checks, every restore checksum-verified: collapsing the no-record
branch to `receipt-unaccepted` fails the overflow regression; restoring the
TTL-deletes-accepted branch fails the TTL regression; an unsigned nonce makes an
altered token answer `expired` instead of `receipt-unaccepted`; and allowing
eviction to retire an accepted record of a retained task removes the explicit
capacity refusal. The last two are the parent's carried-forward receipt-boundary
items: the digest now covers the complete token including its nonce, and the cap is
satisfied only by retiring the accepted handoff of an already-pruned task — when
nothing is retirable the read fails explicitly with a `capacity` error rather than
being handed a token that could never settle.

## 2. Implement stable output snapshots and declared CLI retrieval

- [x] 2.1 Implement bounded-preview and immutable full-snapshot preparation using the persisted combined log, not the in-memory tail; verify a running snapshot stays unchanged as new output arrives and a terminal snapshot preserves markers before and after an output larger than 1 MiB.
- [x] 2.2 Make managed foreground completion preserve complete output before any inline truncation and share final-result construction with get/stop; verify full-artifact contents and references survive output-policy minimization/truncation and structuredContent forwarding.
- [x] 2.3 Implement a session-private declared get/list/stop request/response bridge and generated `pi-bg` adapter; verify separate sessions, stale task generations, malformed requests, unavailable endpoint, bounded bridge failures, and requests launched through managed bash are handled without global daemon, cross-session access, or deadlock. Establish this two-session/managed-bash bridge fixture before building the full CLI adapters or removing receipts.
- [x] 2.4 Implement `pi-bg get ID [--output]` with stdout output/stderr metadata and explicit successful-handoff acknowledgment; verify redirection produces an uncontaminated complete snapshot, piping/filtering works, preview/full have identical terminal acknowledgment semantics, and snapshot/open/write/disconnect/EPIPE failures do not commit a receipt or review reset, including large output piped into head; verify accepted-receipt retries remain idempotent throughout task retention and cannot be confused with expired unaccepted preparations; short successful writes count as delivery without certifying downstream reads.
- [x] 2.5 Retain/reuse stable final artifacts while protecting their lifetime from live-task pruning; verify repeated get after completion/stop works within retention and expiry returns an explicit error.
- [x] 2.6 Document the CLI examples, partial-snapshot labeling, combined-stream limits, operation exit status, and handoff failure/pipe semantics; verify each documented command in the CLI fixture and compare file output against the captured log.

## 3. Implement completion-aware get, confirmed stop, and review reminders

- [x] 3.1 Expose get through `bg_task` using the shared operation and output schema; verify running retrieval resets only the review clock, terminal retrieval acknowledges only after successful output preparation, unchanged output is identified, and list has no lifecycle side effects.
- [x] 3.2 Make stop await the bounded existing termination/finalization procedure and return the result under the same task ID; verify natural completion wins accurately, SIGTERM-ignore/SIGKILL escalation is covered, failed/unconfirmed stop remains explicit, and stop followed by get/full output succeeds.
- [x] 3.3 Change soft scheduling to time since review with one held reminder per task; verify fake-clock tests cover running get, delivered reminder rearming, stale held reminder cancellation, noisy output not resetting, disabled soft intervals, and restore coalescing of overdue reviews.
- [x] 3.4 Revalidate completion/reminder batches at dispatch and persist fulfilled obligations; verify get-vs-completion, stop-vs-completion, completion-vs-reminder, active-turn deferral, idle batching, restore, and already-queued host-message cases without clearing unrelated Pi queues.
- [x] 3.5 Verify hard deadlines are immutable across get/list/review/legacy extend, and preserve the current configured defaults; add tests for repeated inspection reaching the original hard limit and for a task with hard timeout disabled.
- [x] 3.6 Update operation result/render text and settings descriptions with the new stop/review model; verify no prose equates signal submission with confirmed stop, soft reminder with termination, or acknowledgment with output deletion.

Phase C (sections 3.3–3.6, 4.1–4.5, 5.1–5.3, 5.5) is verified against the current-profile
recovery evidence (`background-task-current-profile-recovery.md`). The parent subsequently
accepted 5.4 against the fresh independent recheck; see `review.md`.

Correction (5.2/5.3 re-verified on the current host): the earlier
`background-task-phase-c-refilled-final.md` claimed Phase C while leaving the live codemode
row to unit fixtures and ran its host checks against
`/nix/store/y18i95z11bw59ildb6wwmwal8j53vfzv-pi-0.99.2/bin/pi`; the parent rejected that
waiver. The current profile resolves
`/nix/store/qmnwmkpw9ajnq824vqmy7s9lbmfi4ql3-pi-0.99.2/bin/pi` (`pi --version` 0.99.2), and
every probe output below embeds that store path in Pi's own assembled prompt, so the
recorded pair (extension revision, host binary) is the current one. Codemode is exercised
only as a root model tool call — codemode is `model-only`, so the old nested
`ctx.executeTool("codemode", …)` probe could never reach it: a scripted local provider
drives genuine root tool calls through the real SDK/sandbox/pipeline with `--no-extensions`
and an explicit `builtin:codemode`.

Surface switch: the factory registers `bg_task` only, and `session_start` declares
the mode's own surface — `tui` gets exactly `spawn/get/stop/list` and no
`bg_status`; `print`/`json`/`rpc`/runtime-unknown keep the compatibility set with the
bounded `wait` and `bg_status`. Re-verified on a fresh Pi 0.99.2 with an isolated
`PI_CODING_AGENT_DIR`: TUI `getActiveTools()` = `['read','bash','edit','write','codemode','bg_task']`
(no `bg_status` in the registry at all), `bg_task` enum = `['spawn','get','stop','list']`,
no `waitSeconds` property, assembled prompt free of `bg_status` and `action:"wait"` and
stating "There is no bounded wait in this mode"; `json` mode keeps the eight-action enum,
`waitSeconds`, `bg_status`, and the session-specific bounded-wait guidance
(`print`/`rpc`/runtime-unknown stay on that compatibility set and are fixture-covered in
`tool-surface.test.ts`). Mode-dependent text is centralized in
`extensions/tool-surface.ts` and consumed by the wake, acknowledgement, managed-bash
running and schema-description producers, so no mode is handed prose for an operation
it cannot call.

Codemode live gate (previously unevidenced): with `--no-extensions` and an explicit
`-e builtin:codemode`, a root model call ran `tools.bash` inside the real sandbox and
returned the `BASH_OUTPUT_SCHEMA` structured result (`{output,truncated,exit_code,wall_time_seconds}`);
a root call using the wrong argument name is refused (`must have required properties code`);
a `tools.bash` call without the required `intent` fails validation while the intent-bearing
call succeeds; and `bg_task` spawn inside codemode is refused with no second task started
while a root spawn is allowed.

Suites on the frozen tree, all exit 0: bash-processes **255 pass / 0 fail** (87 files,
1899 expect), `pi-output-policy` **42 pass / 0 fail**, `pi-tool-renderer` **176 pass / 0
fail**. `openspec validate declared-background-task-lifecycle --strict` passes. The scoped
baseline-to-current diff is `pi-bash-processes/**` + this change directory, with no debug
instrumentation and no unrelated baseline edits; the only out-of-scope working-copy changes
are another owner's `pi-tool-renderer/**`.

## 4. Switch the ordinary interactive surface and remove read inference

- [x] 4.1 Register only bg_task spawn/get/stop/list in TUI and do not register bg_status there; retain noninteractive/child bg_status and bounded wait, routing compatibility list/stop/log through shared list/stop/get. Verify all modes and unknown-mode fallback, required compatibility names/actions, no live-path bypass, and no absent-tool/polling/wait recommendation in the assembled TUI prompt.
- [x] 4.2 Remove live-log advertisements from spawn/yield/get/stop/wake text, render/details/activity/dashboard paths, and consumption-related bash environment exports; verify an exact-literal surface audit and fixtures show only task IDs and explicitly handed-off immutable artifacts.
- [x] 4.3 Remove inferred-read PATH interception and per-process consume-log bookkeeping only after declared CLI acknowledgments pass; verify raw reads of retained snapshot artifacts do not mutate notification state, no legacy inferred-consumption channel is accidentally authoritative, and unrelated PATH/process safety behavior remains intact.
- [x] 4.4 Retire read-shim replacement/live-path CLI bypasses and the interactive sleep-as-wait path, preserving only named legacy compatibility proven necessary; verify CLI help and old caller compatibility tests route to explicit operations or give actionable migration errors rather than silently bypassing acknowledgment.
- [x] 4.5 Update `instructions.md`, README fork delta/API examples, DEVELOPMENT notes, CHANGELOG, schema/settings copy, and any generated append-system content using the existing install mechanism; keep the shared installed block mode-neutral and free of names/actions absent in any mode; add TUI push-wait and noninteractive/child named bounded-wait compatibility guidance through the supported per-session prompt hook. Verify the effective assembled prompt and model-visible schema for tui/print/json/rpc/unknown in fixtures and a fresh Pi boot, without dynamically rewriting shared user instructions.

## 5. Integration, independent review, and delivery

- [x] 5.1 Run complete bash-processes, output-policy, and renderer suites on the same baseline host/dependencies; verify their captured exit statuses and compare failures with the recorded baseline without reinstalling packages to hide regressions.
- [x] 5.2 Run the acceptance matrix in `handoff.md`, including large-output/redirection, both streams, deterministic finalization races, same-ID stop/get, review rearm/hard-limit, and two-session isolation; verify concrete evidence is saved for every required row.
- [x] 5.3 Run a fresh Pi 0.99.2 interactive/fixture live check for yield, get, completion/progress wakes, and stopped-result retrieval; verify task ownership/cleanup and schema/guidance selection. This is not the deferred subagent bridge test.

Parent re-opened 5.2/5.3 after consuming the C report: the live codemode row was explicitly
unevidenced and its unit-test substitution was not authorized, and that report ran its host
checks against the old `y18i95z11bw59ildb6wwmwal8j53vfzv` host. Re-verified on the current
profile (`/nix/store/qmnwmkpw9ajnq824vqmy7s9lbmfi4ql3-pi-0.99.2/bin/pi`): the matrix rows are
covered by the 255-test bash-processes suite (`snapshot-artifact`, `result-readiness-barrier`,
`finalize-lifecycle`, `pi-bg-output`, `output-policy-artifact`, `stop-content-e2e`,
`resource-stop-integration`, `soft-timeout`, `task-lifecycle`, `pi-bg-bridge`, `pi-bg-receipt`)
plus the recorded fresh-host runs; the codemode row is now a genuine root model call. Ownership
and cleanup were checked (`stop all` ended the owned pids, and every probe pid is gone). 5.4
remains parent-owned.
- [x] 5.4 Obtain a fresh-context read-only review of the scoped implementation against specs/design and the baseline diff; verify P0/P1 findings are resolved with regression tests and no pi-subagents/Pi-core/Nix mutation has entered the change.
- [x] 5.5 Inspect the scoped jj diff, deliver phase/result evidence and residual host-queue/crash/retention limitations, and update the task boxes only for verified work; verify no unrelated baseline edits, debug instrumentation, or scratch artifacts are included and no push occurs without authorization.
