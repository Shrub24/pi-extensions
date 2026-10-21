# Background-task persistence rollout

## Objective

Make pi-bash-processes' owner store authoritative for recoverable task state.
Stop appending full task lists or state manifests to Pi sessions. Keep small,
session-relevant lifecycle facts in the transcript without making the transcript
an alternative database.

Scope: pi-bash-processes, with coordinated path readers in pi-output-policy if
storage naming changes. Herdsman/Radar ownership and timer changes are separate.
This is an implementation brief, not a claim that the rollout has landed.

## Existing behaviour and starting seam

References checked against the working tree based on `e5b1486c`:

- `extensions/persistence.ts:136-163`: sidecar location and same-directory
  temporary-file/rename writer. Current path is
  `$PI_CODING_AGENT_DIR/kendex/sessions/<session-id>/pi-background-tasks/state.json`.
  Reuse this writer; rename is atomic replacement, not proof of power-loss
  durability (no fsync is shown).
- `extensions/persistence.ts:183-275`: `createPersistence` serialises all tasks,
  fingerprints them and appends a full session snapshot up to 64 KiB or a small
  overflow manifest, then independently writes the same payload to the sidecar.
  Its fingerprint includes task fields that change with output. The cap bounds
  each entry, not cumulative session growth.
- `extensions/background-tasks.ts:532-550`: integration seam; persistence gets
  the full sorted snapshot list, and `persistSoon` coalesces output-driven work.
- `extensions/background-tasks.ts:1240-1314`: restore loads the sidecar, then
  replays custom snapshots AND bash/bg_task/bg_status result details from the
  branch. The replay can clear the restored set. It filters inherited tasks on
  forks and reconciles restored process identity and log readiness.
- `extensions/persistence.ts:53-85`: the manifest barrier exists to keep an older
  full session snapshot from replacing sidecar state. It is legacy restore
  machinery, not the desired new authority rule.
- `extensions/background-tasks.ts:1648-1664,2884-2895`: rejected output wakes
  request deferred persistence; output handlers update volatile counters.
- `extensions/types.ts:128-236`: snapshot fields mix identity, process state,
  output counters, diagnostic wake history, deadlines, capture integrity,
  assignment association and result-delivery obligations.

Earlier session inventory found background-state records accounting for about
3.06 GB of 7.44 GB of session bytes. This is historical evidence, not a new
measurement or a predicted percentage saving. Existing transcripts do not
shrink when the writer changes.

## Required behaviour

### 1. One authority

The owner store contains recoverable task records. Live task objects remain in
memory; full output remains in existing log files. No new database, generic
persistence framework or shared Herdsman/Radar store is required.

Write atomically on meaningful transitions: task creation, confirmed process
identity, terminal/capture-integrity state, changed notification policy or
review deadline, result acknowledgement/resolution, dismissal and removal.
Session shutdown may write a convenience checkpoint but is not the durability
mechanism. Remove output-only persistence triggers rather than moving the same
per-chunk rewrite traffic to another file.

Do not persist raw output, per-chunk counters or rolling diagnostic wake history
as task state. Derive byte counts from the log where sound; otherwise keep them
in memory and label post-restart unknowns honestly. Preserve policy-bearing
state needed to prevent duplicate notifications or reset output-wake budgets;
it changes on a delivered wake, not on every output chunk.

### 2. Small session facts

Append only lifecycle transitions that explain the session: task identity,
writer/session identity, transition, timestamp and small outcome facts. Bound
text fields. Do not include a task roster, repeated full commands, accumulated
wake history, counters or full output. Do not append a manifest on every output
change as a substitute for removing snapshots.

Explicit tool responses and completion wakes still deliver useful bounded
results. Audit their task details so they do not recreate the snapshot stream.
New lifecycle entries and tool-result details are not alternate restore stores.

### 3. Restore and migration

- Version the owner-store format and identify its owning session explicitly.
- A valid new-format store, including an empty task set or explicit removals,
  wins over all older branch snapshots and tool-result details. Otherwise
  deleted tasks can reappear on resume.
- For legacy sessions with no new store, import from the existing sidecar and,
  when needed, the legacy branch restore path. Preserve fork filtering and
  process-reuse protection. Write the imported store before considering the
  migration complete.
- Distinguish missing state, corrupt state and failed writes. Never quietly
  treat corruption as an empty roster or resurrect old work after a failed
  migration. Surface an actionable recovery error and preserve old data.
- Once migrated, do not maintain dual writers. Keep legacy reads only for
  sessions that have not migrated.
- Do not rewrite historical session JSONL files.

If the path is renamed in this slice, proposed owner path is
`$PI_CODING_AGENT_DIR/pi-bash-processes/sessions/<session-id>/state.json`.
Read the legacy location only as migration input. Do not bulk-move live logs;
stored absolute paths remain valid. A path-only cleanup must not change task
ownership or invent a second source of truth.

### 4. Retention and outstanding results

The durable recovery set needs running tasks AND terminal tasks with unresolved
result obligations. “Live only” must not delete output that has not been handed
over. Preserve `resultReady`, capture integrity, assignment association,
notification acknowledgement and result resolution as distinct facts.

Use an explicit count/age bound for ordinary finished history in the owner
store, not the session. Start from the existing 50-finished-task rule rather
than inventing a larger archive. Unresolved result obligations are exempt from
ordinary eviction until delivered, failed with a reported capture error, or
explicitly dismissed. Do not describe that exception as a strict total bound.
Reuse existing log retention with its ownership checks; do not delete shared or
unrecognised files.

## Scope and impact

Changes centre on `persistence.ts`, its integration/restore paths in
`background-tasks.ts`, and the durable record projection. Compatibility reads
and existing restore tests must change together. If storage defaults move,
coordinate pi-output-policy's task-directory detection and cleanup.

Expected effect: session growth follows lifecycle transitions rather than output
activity multiplied by roster size. Store writes become transition-driven.
Existing session files, already-loaded Pi heap and log sizes are unchanged.
Resume becomes owner-store-first for migrated sessions instead of replaying task
state from the branch. Losing the owner file therefore becomes a real recovery
failure; a session transcript is deliberately not a current backup database.

Non-goals: regex-engine changes, renderer fixes, Herdsman timer batching, Radar
background-process ownership, wake-policy redesign, historical transcript
compaction and a new storage dependency.

Completion wakes must remain primary result delivery, briefly batched and sent
as steer during active runs. Result-review is separate, idle-only, one-shot and
advisory. Some current tests encode older held-completion/repeating-review
semantics; do not preserve those accidentally or rewrite wake policy inside this
storage change. Coordinate with the lifecycle owner where the implementation
still differs from the agreed direction.

## Acceptance evidence

Use existing behavioural seams in `tests/snapshot-restore.test.ts`,
`restore-replay.test.ts`, `tool-result-restore-barrier.test.ts`,
`replay-missed-exits.test.ts`, `wake-persistence.test.ts` and
`output-wake-budget-persistence.test.ts` where applicable.

Required observable cases:

1. A chatty task produces no task-state session entries or owner-store writes
   merely because output grows; start/finish still restore correctly.
2. Crash/reload after task creation and after terminal capture preserves identity,
   readiness and outstanding results without claiming incomplete output complete.
3. Acknowledgement survives reload; an unresolved result remains owed, without
   an unconditional exactly-once claim across an external-send/crash boundary.
4. An authoritative empty store/removal is not undone by old custom entries or
   old tool-result rosters later in the branch.
5. Legacy restore migrates once; a fork never acquires its parent's tasks.
6. Failed atomic replacement leaves prior readable state and reports failure;
   malformed/missing migration inputs do not silently discard obligations.
7. Finished-history retention evicts ordinary records but preserves unresolved
   results and their logs until resolution.

Measure entry count/bytes and store-write count with one fixed chatty-task
fixture before and after. Record duration, output volume and task count. No
benchmark expansion or production transcript rewrite is needed.

## Decisions for the owner

Confirm the new owner path and ordinary finished-history retention before
implementation. The store remains extension-owned until Radar actually assumes
background-task lifecycle ownership; state publication alone is not ownership.
Keep rationale for the single-authority rule and rejected dual-write fallback
with the change. Removal dates for legacy readers depend on supported old
sessions, not an arbitrary release count.

## Mechanism: the minimal slice

Checked against the code on 2026-10-22. The sidecar already holds the same full
payload the session entry does, and `restore` already reads it first, so the
authority change is subtractive:

1. **Writer** (`persistence.ts:createPersistence`). Delete the full-snapshot and
   overflow-manifest branches of `appendEntry` and the per-session fingerprint
   dedupe that existed to limit them. Keep the sidecar write unchanged.
   Replace them with a transition append: on each persist, compare each task's
   `(status, exitCode, exitNotified, resultResolution)` with the last tuple seen
   for that task id and append one bounded entry per changed task, carrying only
   those fields, the id, the writing session id and a timestamp. No call site in
   `background-tasks.ts` changes: every transition already ends in
   `persistSnapshots()`.
2. **Restore** (`background-tasks.ts:1240-1314`). When the sidecar loaded, skip
   the branch replay entirely: no `BG_STATE_TYPE` snapshots and no `bg_task` /
   `bg_status` / `bash` tool-result rosters, so nothing older can clear or
   resurrect state. When it did not load, run the existing legacy replay
   unchanged, with its barrier, fork filter and process-reuse checks. A fork has a
   new session id and therefore no sidecar of its own, so it inherits nothing from
   its parent's branch, which is the intended ownership.
3. **Tests.** `bounded-snapshot*.test.ts` (186 lines) encode the manifest and
   barrier contract and are replaced by transition-entry and
   sidecar-authority cases; `snapshot-restore`, `restore-replay`,
   `replay-missed-exits` and `tool-result-restore-barrier` keep their legacy-path
   coverage and gain a sidecar-wins case.

Deferred to a second slice: sidecar write volume (the file is still rewritten in
full on output-driven persists), the owner-path rename, and the `kendex` entry
names. They do not affect session growth.

Estimated effect (reasoning, not a measurement): the session cost of a task falls
from one roster-sized snapshot per structural change to a few entries of roughly
a hundred bytes per lifecycle transition. Measure with the fixed chatty-task
fixture before claiming a figure.
