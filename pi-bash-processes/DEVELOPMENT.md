# pi-background-tasks development

For maintainers. What it does for a consumer is [README.md](README.md); the agent-facing contract (`bg_task` parameters, notify modes, durability promises) is `instructions.md`, and the mechanics live as comments on the modules named below. This file holds the invariants that span them.

## Invariants

- After registering its managed `bash`, the extension publishes `Symbol.for("kendex.background-tasks.managed-bash")` on `globalThis` until `session_shutdown`. Renderer packages defer their Bash decision until `session_start`, so either package order sees the marker; shutdown removes it before Pi loads a fresh extension runtime.
- The declared tool surface is a function of the session mode, and it is declared at
  `session_start`, never at factory load: the factory knows no mode, so it registers
  `bg_task` alone and the mode branch adds `bg_status` only where it belongs. That is
  why the TUI can satisfy "`bg_status` is absent" without an unregister API that does
  not exist. `extensions/tool-surface.ts` is the single spelling of the surface, the
  action enums and every mode-dependent phrase; `registrations.ts` declares from it,
  and the wake, acknowledgement, managed-bash and schema-description text all read it,
  so a mode is never handed prose for an operation it cannot call.
- A wake never depends on `pi-output-policy`. Wakes go out through `pi.sendMessage`, which that policy does not see, so every byte a wake adds to the transcript is bounded here: one inline tail capped by `outputAlertMaxChars`, a task manifest whose long fields are cut at `WAKE_MANIFEST_FIELD_MAX_CHARS`, a headline command preview cut at `WAKE_CONTENT_COMMAND_MAX_CHARS`, and a per-task output-wake budget after which one exhaustion notice is sent and further output wakes are dropped. `extensions/wake-events.ts::compactBackgroundTaskSnapshot`, `shouldEmitOutputWake`, `sendOutputWakeBudgetExhaustedNotice`. The same compact manifest is what `bg_task` and `bg_status` return in `details`, so a log-polling loop cannot grow the transcript through tool results either.
- Exit wakes are durable and fire exactly once. A task's snapshot carries `exitNotified`; a terminal task that never fired its exit wake is replayed on the next `session_start`. Exit wakes ignore the output-wake budget. `extensions/lifecycle.ts::closeTaskLifecycle` sets a task's terminal state and `sendExitWakeLifecycle` sends its exit wake; the record-and-persist tail of `sendExitWakeLifecycle` is the shared acknowledgment (`extensions/task-result.ts::acknowledgeCompletion`), so host submission, terminal retrieval, a confirmed stop, and a foreground delivery all settle the same obligation. `extensions/background-tasks.ts::finalizeTask` (exit, spawn error, timeout, stop) and `extensions/lifecycle.ts::finalizeTaskLifecycle` (orphan watcher) call both. Restore (`extensions/snapshot.ts::restoredTaskFromSnapshot`) and `session_shutdown` set status themselves, and `extensions/lifecycle.ts::replayMissedExitsLifecycle` sends the wakes restore finds missing. See "Completion lifecycle" below for how process exit, output readiness, acknowledgment, and retention differ.
- The orphan watcher observes and never signals. A task whose child outlived Pi rehydrates as `running` and `extensions/orphan-watcher.ts` polls an asynchronous identity probe (pid plus process start time; the kernel comm name is recorded but is not part of identity, because `exec` rotates it) until the process is gone or the pid was reused, then finalizes through the lifecycle. Adding a `kill` there resurrects a failure where a snapshot flicker terminates a live workload.
- Resource controls change nothing when off. With `resourceControlEnabled=false` the spawn is `getShellConfig` plus the command as one argument in a detached process group; `extensions/resource-control.ts::planResourceControlledSpawn` wraps it only when enabled, and a `systemd-run` task persists its unit name so stop, timeout and shutdown stop the unit rather than the wrapper. A failed unit stop leaves the task running rather than reporting it stopped.
- Session-state writes are bounded. `extensions/persistence.ts::createPersistence` is the only writer of the `kendex-background-tasks:state` entry: identical task lists are deduplicated by fingerprint, and a payload over `BG_TASKS_SNAPSHOT_MAX_BYTES` degrades to a manifest while the sidecar at `sidecarStatePath` stays canonical and is read first on restore. `extensions/tool-result-details.ts::bgToolResultTasks` bounds `details.tasks` the same way, and `restoreSnapshots` treats a manifest as a barrier so an older full snapshot cannot regress restored state.
- A chunk of task output costs no synchronous log write, no widget render and no full state write. `extensions/log-writer.ts::createLogWriter` batches log appends per window with one asynchronous write in flight per file, and `extensions/background-tasks.ts` coalesces the widget refresh and the output-driven persist into windows (`extensions/coalesce.ts`). Pending text at `LOG_WRITE_NOW_BYTES` is written without the window, and pending text at `LOG_MAX_PENDING_BYTES` behind a write in flight makes `append` return a hold, on which the task pauses its stdout and stderr. `LOG_WRITE_STALL_MS` is the one deadline for a write in flight: past it the file is stalled, the hold, `flush` and `drain` stop waiting, and text past the cap is counted into a marker line until the write settles. A slow disk costs no log bytes; a stalled or failing one costs counted bytes and never holds a task's output or its close. A task's close sets its final status and clears its timers at once through `extensions/lifecycle.ts::closeTaskLifecycle`; only the exit wake waits for `flush`. After the wake, the task drops its in-memory output unless `LogWriter.settled` says its last write failed or is still stalled, and the finished-task bound runs; a task whose exit wake still waits is not counted by the bound, and neither is a terminal result still owed to a bound assignment (`assignmentRequestId` without `resultResolution`) — retention keeps that evidence past the bound and `clear` skips it (`kept` in the tool result) until the model has actually received it. `clear` and the bound delete a task's log only after `flush` settles its file, so a held write cannot create the log again; a write still stalled past `LOG_WRITE_STALL_MS` can, and the lane prune removes the file it leaves in the session's own lane.
- Liveness has one decision. `extensions/snapshot.ts::livenessVerdict` answers alive, pid-gone, pid-reused or unknown for restore and for the orphan watcher; unknown counts as alive for that pass, and the orphan pass logs a diagnostic for it. Subprocess checks (`ps`, `systemctl`) go through `extensions/probes.ts::runProbe`, which is asynchronous, or `runProbeSync` for synchronous spawn planning, both with a 1 s timeout. A restore or orphan pass runs at most `PROBE_CONCURRENCY` probes. Restore replays plain snapshot data from the whole history and probes only the final task set, and the watcher's first pass waits one poll interval.
- Broker publication is best-effort and outside control flow. `extensions/activity.ts::publishBackgroundTaskActivity` and `publishBackgroundTaskStarted` publish `bg_task.*` events to `pi-session-bridge`'s broker when present, catch every publisher error, and are never awaited by task control.
- Diagnostics never touch the terminal. `extensions/diagnostics.ts::logBackgroundDiagnostic` writes to a log file only when `PI_BG_TASK_DEBUG`, `PI_BG_TASK_DIAGNOSTICS` or `PI_BG_TASK_DIAGNOSTIC_LOG` is set; stdout and stderr would corrupt the TUI widgets.
- The settlement seam has one owner and stays fail-closed. `extensions/background-work.ts` is the public registration/query interface (protocol `background-work/v1`) and owns no task state: the provider it registers is this extension, answering from the single authoritative `tasks` map. Ownership rules for it:
  - **Task authority.** The `tasks` map plus the persisted snapshots are the only truth. The adapter adds no second registry, timer or wake loop; the registration slot lives on the supplied bus (`Symbol.for("pi-background-work:v1.registration")`) purely as a duplicate/stale guard shared by every loaded copy of the helper.
  - **Registration lifecycle.** `session_start` replaces any live registration before restore (so a query during the async restore window sees an explicit reconciling state, never absence or a stale answer), and `session_shutdown` disposes it first (so nothing answers while the map is emptied). A registration failure is logged and leaves the provider absent: a consumer that expects this provider then reads `missing` — fail closed — while an ordinary session keeps its normal lifecycle.
  - **Snapshot semantics (openspec `herdsman-background-handoffs` Group 2, tasks 2.1–2.4).** `ready` requires the exact active session (the snapshot carries `activeSessionId`, making a wrong-session query an `identity-mismatch`) and a completed successful restore; it then holds whenever no unresolved work is unattributable to the requesting scope. Unresolved tasks are classified per scope: tasks associated with the request are listed in `outstanding` (`running`, `flushing` while `resultReady` is not established, `awaiting-result-review` for a terminal task whose result resolution is not recorded — including a restored capture that was never certified); unresolved tasks with no association or another request's association are quarantined (`reconciling` under the bound assignment, `error` for any other scope) and never adopted. A failed restore records `error` and rethrows, preserving the pre-existing control flow — neither can degrade into empty success. More than `BACKGROUND_WORK_MAX_OUTSTANDING` outstanding tasks for the scope throws (fail closed) rather than truncating. The monotonic `revision` bumps on restore completion/failure, spawn, resolution, and binding changes.
  - **Association, resolution and protection.** `bind(scope)` refuses while unresolved work is not attributable to `scope.requestId` (the reason names the blocking task ids and the reconciliation path), then becomes the binding every later spawn inherits as `assignmentRequestId` — written once at spawn, persisted in the task snapshot, never rewritten; a session restart clears the binding but keeps association, so a rebind re-adopts its own tasks. `resultResolution` is recorded only by an actual delivery: a certified terminal tool/foreground/wait handoff or a settled CLI receipt records `delivered`; a delivered unrecoverable capture error (the tool's failure handoff, or the CLI's `delivered: "error"` receipt confirmed by the generated client) records `error`, first observation standing. Every observation routes through `task-result.ts::resultResolutionForDelivery`: while the 250 ms log flush is still finalizing it records nothing (a flushing capture is never a result), and a capture that can never certify resolves as `error`. `acknowledgeCompletion` never writes it: `exitNotified` is host-wake notification state, and a notified-but-unretrieved terminal task stays `outstanding`. `protect(scope, on)` requires the bound assignment and marks it settlement-waiting; while marked, that assignment's exit wakes bypass the `notifyOnExit` gate in `sendTaskWake` (the `exitMandatory` dependency), including the grouped flush, so its terminal results can never be stranded; every new bind clears the previous protection. Protecting reconciles work that ended before the mark existed — a suppressed terminal unresolved task is woken exactly once at protect time (a held, mid-turn one only at the run boundary), and never again once `resultResolution` is recorded. Do not infer ownership from timestamps, environment variables or `exitNotified`, and do not treat notification acknowledgment as result resolution; Group 3 (Herdsman settlement consumption) is the scheduled follow-up.

## Completion lifecycle: readiness, acknowledgment, and review

Separable things happen around the end of a task, and each is recorded
separately because they do not end together. `extensions/task-result.ts` holds
the rules; `extensions/background-tasks.ts` supplies the host effects.

- **Process exit.** `finalizeTask` closes the process first: status, exit code,
  termination reason and timers settle at once, and the exit-wake decision runs
  while an attached foreground or bounded waiter is still unsettled (that is how
the wait result becomes the delivery channel).
- **Output readiness.** The exit wake names the task's log as its full output, so
  it waits on `taskLogs.flush`. `resultReady` records that second half:
  `taskReadiness` answers `running` (process active), `finalizing` (process gone,
  flush still settling), `terminal` (flush settled *or* stalled) or `incomplete`
  (a rehydrated task whose snapshot recorded an unsettled flush — the process
  that owned the writer is gone, so the state can never advance).
  `status !== "running"` is deliberately *not* the readiness signal, because it
  is true during the flush window; a retrieval that races the flush may report
  `finalizing`, never a complete result whose last bytes are still queued. Tests
  inherit the same rule: `tests/fixtures/extension-host.ts::settledTask` is the
  only wait for a terminal record, because a fixture that waited on status alone
  could read a log inside that window and report a product failure where the
  bytes were simply still in the writer's queue. A log
  write that stalls past `LOG_WRITE_STALL_MS` still resolves the barrier, so a
  slow disk never holds a task's close. That leaves the second half of the
  question to `buildTaskResultObservation`: `outputComplete` is true only when
  `readiness` is terminal, `taskLogs.settled(file)` says the file has no write in
  flight, no pending text and no failure marker outstanding, *and* the task's
  durable capture record does not say otherwise. A failed or still-stalled write
  leaves the retained log short by the bytes it dropped (counted in a marker on
  the file's next batch), so the terminal read is a *short* result and must be
  reported as short rather than as a complete one. A *running* read is the
  separate allowed case: a partial snapshot handed off against a running
  readiness is an ordinary running handoff.
- **A capture failure is not a successful result handoff.** A terminal
  observation with `outputComplete: false`, and any observation whose readiness
  is `incomplete`, must not be handed off as the completed result of the
  command: the caller keeps the partial bytes and the loss/error metadata
  reachable (never an empty success), labels them as incomplete, and commits
  neither terminal acknowledgment nor a review reset on that handoff —
  `acknowledgeCompletion` is not called, so the completion obligation stays
  where it is. Dropped bytes are never re-created, so no caller retries a
  capture.
- **Readiness survives a restart by record, not by re-derivation.**
  `completeResultFinalization(task, outputComplete)` records the writer's own
  answer next to the readiness latch, and `taskSnapshot` persists both
  (`outputComplete` is written only for terminal tasks). A rehydrated task has no
  process left to flush and a fresh, empty writer queue, so `restoredTaskFromSnapshot`
  reads the snapshot instead of recomputing:
  a snapshot that recorded `resultReady === false` — the mid-flush window, the
  `session_shutdown` coercion, which stamps a terminal status without awaiting
  the flush it drains later, and every running task — restores as `incomplete`
  with `resultReady === false` and `outputComplete === false`; a snapshot that
  recorded `resultReady === true` with `outputComplete === false` restores as
  ready but explicitly short. Reconciliation may establish *unknown* readiness
  (a snapshot that recorded nothing — legacy — is still resolved as ready and
  complete); it may never overwrite a known incomplete capture with a complete
  one, and a recorded `false` is never upgraded later, not even by the orphan
  watcher finalizing a task whose producer is gone.
- **Acknowledgment.** `acknowledgeCompletion` is the single idempotent entry
  point for terminal retrieval, confirmed stop, foreground command delivery, the
  retained bounded wait, host notification, and the missed-exit replay. It
  records `exitNotified` in the snapshot and persists it, and by default drops
  any completion wake this process still holds; the caller that is itself
  placing a held wake passes `cancelHeld: false`. An already-acknowledged task is
  never written twice. A successful `get` or confirmed `stop` cancels a held
mandatory wake; protected assignments retain normal soft-timeout progress
reminders. The record is what stops a restart from replaying the
  wake; it never deletes retained output or invalidates the handle. Host
  submission is the commit point: a wake the host refused (shutdown) leaves the
  obligation outstanding. A retrieval that could not certify the capture (see
  above) does not call this at all. `replayMissedExitsLifecycle` acknowledges each replayed
  exit through this same entry point and then persists the batch once, so a
  replayed wake and a delivered one cannot disagree about what the record means.
- **Data retention.** Acknowledgment and retention are independent. Finished
  tasks are bounded by `MAX_FINISHED_TASKS`, and the bound never counts a task
  whose exit wake still waits on its flush or whose result a retrieval is
  preparing (`resultPreparationLeases`). A retained log that is gone reads as an
explicit expiry error — never as a successful empty result.

Review is a fourth clock: the configured `defaultSoftTimeoutMs` interval is
measured from the last successful review (`lastReviewedAt`, falling back to
`startedAt`), so the first review is due one interval after the start and a
delivered reminder is itself a review. Output activity, listing, and internal
retention scans never move it, and it never moves the absolute
`timeoutSeconds`/`expiresAt` ceiling. `reviewRevision` is the staleness token: a
review bumps it, so a reminder already armed for the previous deadline is
discarded instead of firing. At most one reminder is armed per task.

## Mechanics worth knowing

- Auto-backgrounding covers the agent's `bash` tool, interactive `!` commands, and bash issued over RPC; an RPC caller gets the acknowledgement text in place of the output. The built-in patterns and the `sleep`-loop heuristic are `extensions/auto-background.ts::autoBackgroundDecision`; user patterns are `/regex/flags` or a case-insensitive plain regex per line.
- `notifyMode` unset resolves to `first-match-only` when `notifyPattern` is set and to `transition` otherwise (`extensions/wake-events.ts::resolveNotifyMode`); `transition` wakes only when the tail hash changes, and `dedupeKey` shares one hash bucket across tasks.
- An output wake scheduled before a `stop` or `clear` is voided; a queued callback that still fires is suppressed and logged as a `voided-wake-fired` diagnostic, which separates stale Pi-core delivery from an extension bug.
- The `f5` shortcut always opens the dashboard alongside the configured `dashboardShortcut`; shortcuts register at load, so a changed key needs a restart.

## Tests

```bash
bun test ./tests ./extensions/__tests__
```

Lifecycle, wake budgets, orphan identity (including a live probe of exec drift), resource-control planning and stop semantics, bounded snapshots, tool-result details, and the per-chunk write path and restore probe count (`tests/write-path.test.ts`) each have a suite under `tests/`. A change to a bound above ships with the control that overruns it.
