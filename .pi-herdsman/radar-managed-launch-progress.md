# Radar managed-child launch — progress

Scope: fresh managed-worker launch through Radar `spawn`, Herdsman keeps
assignment ownership, Radar-sourced presence and `child.close`. Retained-worker
resume/replacement is a separate slice.

State: launch/readiness, presence, close, child registration and retained reuse
are implemented; the focused protocol suites, `extension-contract`, the whole
`controller-lifecycle` and `recovery` files and `radar-launch` are green. The
whole-suite remainder is the migration-stage set named at the end, which this work
did not cause and did not repair.

## The three evidence classes (verified against the daemon source, not inferred)

Read from `agent-radar` at the working copy this session inspected
(`src/control_plane/registry/spawn.rs`, `src/control_plane/server.rs`,
`src/herdr.rs`, `docs/control-plane.md`):

1. **Provenance** — our durable spawn record plus the child's own binding
   (`bound.agent_id`). It says *which* subject this launch created and stays true
   after the child is gone. Never liveness.
2. **Readiness** — the child's own startup acknowledgment for that generation.
   It says the child initialized. Not liveness either.
3. **Current topology/exit observation** — a topology read of that exact edge: `state`
   (`unbound|bound|unresolved`) and `freshness` (`fresh` when the backend's
   *current* inventory reports the recorded pane, `stale` when it does not or
   could not be asked), and `edge.exit_observation`
   (`unknown` | `exited{code,signal,observed_at}`). `unresolved`/`stale` is a
   vanished location, explicitly *not* process exit. A fresh pane with an unknown
   exit observation does not prove that the worker process is alive.

`spawn.get` answers `{"spawn": {"edge": …, "state": …, "freshness": …}}`
(`server.rs:1783`); the spawn *operation* answers `{request, spawn: <edge>}`
(`server.rs:3280`). The client previously read `state`/`freshness` off the edge,
which a real daemon never sends — against a live daemon that made every Radar
child permanently `unknown`.

## Nested delegation (contract question, answered from source)

The daemon does **not** put the child's own pane in the launch environment: it
types one shell line into the created pane (`herdr.rs::launch_line`), so the child
inherits *that pane's* environment — the same fact a lead publishes, and the same
mechanism Herdsman's own pane launch used (pi-extensions ADR 0029; archived
`2026-10-05-herdsman-herdr-pane-metadata` records a managed worker publishing its
own pane from `HERDR_PANE_ID`). The one value that is not the child's own is the
pane the launch was created beside, which the launch records in
`PI_HERDSMAN_PARENT_PANE_ID`; a process reporting that pane publishes no location
*and* refuses to be a managed agent.

So the earlier blanket rule — a Radar-launched process publishes no location, and
therefore only a lead may spawn — was an unapproved restriction built on a guess.
It is removed. A spawned child publishes its own pane and can delegate in turn.

Stronger, daemon-attested path for later: the daemon's own record of the created
pane is readable with `spawn.get`/`spawn.list` (any local client with
`agent_registry`; no caller-ownership filter). A child could publish
`edge.location` from the edge whose `bound.agent_id` is its own subject — a
daemon-attested pane rather than an inherited environment value. Not implemented
here.

## Changed in this increment

- `extension/radar-client.ts` — `spawn.get` decodes the **topology**
  (`RadarSpawnTopology`), the edge carries `exit_observation`, and an
  unreadable observation reads as `exited` (a maybe-dead child must never read as
  live). `spawn`'s own reply stays a bare edge. `child.close` no longer
  pre-refuses locally: the canonical refusal is the daemon's
  `backend_unavailable` (`control-plane.md`, capability row `agent_registry` plus
  `observe` and `close`), and a client-side gate answered `unsupported` instead.
- `extension/radar-launch.ts` — readiness and presence both require
  `freshness === "fresh"`, `state === "bound"` and *no observed exit* on the
  topology. An observed exit outranks a reported pane: the pane's shell outlives
  the process launched in it.
- `extension/index.ts` — `radarProcessLocation` publishes the pane env unless it
  names `PI_HERDSMAN_PARENT_PANE_ID`; the `launchedThroughRadar()` ban and its
  now-false diagnostic are gone.
- `extension/support-radar.ts` — the fake daemon answers topology reads in the
  daemon's shape, records `exit_observation` (`options.exitObservation` drives
  it), and refuses `child.close` with `backend_unavailable` when it does not
  advertise `observe` and `close`, exactly as the daemon does.
- `extension/radar-launch.test.ts` — one new test: a child the daemon observed
  exiting is not live, however present its pane is.
- `extension/extension-contract.test.ts` — the launched-child registration test
  now asserts a child publishes the pane it reads and never its parent's, and the
  lead assertion reads the *lead's* registration (`registeredSubject(1)`) instead
  of the child's, which is why it previously passed while claiming nothing about
  the lead.

## Validation (whole files, run alone, this working copy)

| suite | result | before this increment |
|---|---|---|
| `radar-client.test.ts` | 27/27 | 27/27 |
| `radar-launch.test.ts` | 20/20 | 19/19 |
| `extension-contract.test.ts` | 52/52 | 51/52 |
| `controller-lifecycle.test.ts` | 55/68 (13 fail) | 55/68 (13 fail) |
| `recovery.test.ts` | 92/106 (14 fail) | 89/106 (17 fail) |

Lifecycle's 13, measured this run: `parent delegates two same-definition children
with exact ownership` (physical and virtual), `cascade close revalidates the
parent generation under its assignment lock`, `cascade close keeps the parent
when descendant mailbox cleanup is unresolved`, `staged fresh assignment bridges
pending start through working`, `staged fresh assignment removes a fast
completion without observing working`, `fresh path sessions remain controllable
after controller cache loss`, `lead herd runs start once and stay open through
intermediate settlement`, `restored herd run keeps its start and closes after
settlement`, `recovery cleanup finishes an idle restored herd without
settlement`, `continuation reuses an idle retained worker in its existing
process`, `concurrent continues of an idle retained worker serialize on the
reservation`, `session assignment never adopts a child that claims another pane`.

Recovery's 14 remaining, measured after the three rewrites: the result-delivery
group (`completed and failed one-shot agents converge after
durable delivery`, `settlement redelivers an unpersisted child result in the same
session`), the close/live-identity group (`one-shot close failure retains the
result for exact cleanup retry`, `automatic close invokes the exact lifecycle
only after live identity proof`, `a close that loses its alias claim between
reads refuses without retiring the mailbox`), the descendant-cleanup group
(`delivered-result cascade retries descendant mailbox cleanup failure`,
`recovered no-live result removal retry never cleans up a replacement`,
`live result cleanup keeps a later request owned by the mailbox`), the recovery
session group (`recovery requires the official session and retries one failed
delivery`, `result is removed after agent state reaches completed`), the cleanup
barrier group (`controller cleanup barrier blocks newer work until stale
acknowledgement cleanup succeeds`), `a restart reuses a retained worker in its
existing process`, `softTimeoutMs of zero delivers no digest for an overdue
window`, `accepted result delivery survives session identity failure in status
guidance`.

Neither file's count moved between the two working states, and no failure in
either list names a Radar spawn, presence or close path added by this work. Both
files are the same size as before this increment, so no test was deleted or
skipped to reach these numbers. `npm run check` (= the whole test suite) and
`git diff --check` were run; whitespace is clean and the check fails only on the
suite failures recorded here (there is no tsconfig, so no separate typecheck
gate exists in this package).

## The three stale recovery/rollback tests were rewritten (done)

The recovery/cleanup group's three red tests were rewritten to the Radar contract
and now pass; recovery moved from 89/106 (17 fail) to **92/106 (14 fail)** with no
other test changing state. The old tests and their replacements:

| old (stale mux expectation) | new (Radar contract) |
|---|---|
| `malformed disappearance proof retains failed-launch cleanup evidence` | `an unresolved Radar launch retains its durable evidence and closes nothing` — `acknowledge:false` (child registers, never acknowledges) with `PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS` bounded by the test; asserts `pane_not_ready`, `radarSpawn.unresolved === true`, one spawn under the failed launch's own request id, `rollbackOccurred === false`, no close, and the child's own state present but never handed the assignment |
| `rollback requires disappearance proof after a successful close` | `a refused Radar spawn rolls back nothing and leaves no phantom child` — `refuseSpawn`; asserts the refusal names the launch it authored without `unresolved`, no bound child, no close, no child state |
| `assignment rollback retains primary failure and actionable cleanup details` | `a lost Radar spawn reply reuses the same request id instead of spawning twice` — `dropSpawnReply`; asserts the launch is ready from the daemon's edge, exactly one spawn, one request id, no close |

Finding for the owner: neither the unresolved nor the lost-reply launch surfaces
the durable spawn record through `pi.appendEntry` as `pi-herdsman-radar-spawn`
(`RADAR_SPAWN_ENTRY`, `index.ts:401`), so the tests assert the failure payload's
`radarSpawn` evidence and the daemon's own record instead. If a private on-disk
launch record is the intended surface, its accessor belongs in the fixture.

Original probe note (kept as evidence): the three old tests failed with
`TypeError: Cannot read properties of undefined (reading 'category')` at their own
assertions. A temporary probe of `result.details` in the first one printed a
**successful** delegate payload
(`{"ok":true,"request_id":…,"pane_id":"startup-pane",…}`).

So the launch no longer fails there at all: `support.ts` starts the fake Radar
daemon at module load (`support.ts:127`) and registers this process, so the Radar
launch succeeds and the tests' stimulus — a stubbed Herdr `agent list`/`pane
list` reply with a session mismatch — is never consulted. The failures are stale
*mux*-rollback expectations on tests whose owned behaviour (a failed launch
reports a structured failure and retains its cleanup evidence) is still real; the
stimulus and the assertions have to move to the Radar evidence the production
path uses. They are not related to unrelated work in the shared working copy, and
they are not a Radar consumer gap in production.

Re-specification recipe, from the production code (`index.ts:8689-8711`,
`index.ts:8863-8884`):

- Stimulus: a daemon-side failure of the launch, e.g.
  `daemon.options.acknowledge = false` (child registers, never acknowledges ⇒
  readiness unresolved) or `daemon.options.refuseSpawn` (refusal).
- Assertions: `details.error.category === "pane_not_ready"` for unresolved,
  `details.error.details.radarSpawn = {requestId, generation, unresolved: true,…}`,
  `details.error.rollbackOccurred === false`, `daemon.spawns.length === 1` (no
  second spawn under a new id), the durable `pi-herdsman-radar-spawn` entry still
  present (the cleanup evidence), and the readable text naming the unresolved
  launch plus its next action.
- Do not re-add a disappearance wait or a synthetic Herdr record: there is none
  for a Radar child.

## Durable launch evidence: verified (done)

`pi.appendEntry(RADAR_SPAWN_ENTRY, spawn)` runs immediately before the daemon is
dialed (`index.ts:8650`, then `8711` for the bound form), and the readers
(`radarSpawnFromEntries`, `index.ts:1180`) key on `data.mailbox` + `data.runId`
out of `ctx.sessionManager.getEntries()`, which is the same array the fixture's
`appendEntry` writes. Two regressions now assert that record rather than the
failure payload:

- unresolved launch: exactly one record, `stage: "requested"`, its
  `requestId`/`generation` equal to the failure payload's, `mailbox` and `runId`
  strings present - the shape a reload reads back without the runtime cache.
- lost reply: every record carries one `requestId` (the one authored before the
  dial), the last one at `stage: "bound"`, matching the daemon's single recorded
  edge. A second id would mean a second spawn.

`radarSpawnRecords` is the narrow fixture accessor (`support.ts`) for that entry.

## Lifecycle failures: measured causes (this run, 55/68)

| group | message |
|---|---|
| `parent delegates two same-definition children …` (2, physical+virtual) | close: `target_ambiguous` "Managed agent presence cannot be proved safely", `ids.paneId: "startup-pane"` |
| `cascade close revalidates the parent generation under its assignment lock` | `TypeError: Cannot read properties of undefined (reading 'category')` |
| `cascade close keeps the parent when descendant mailbox cleanup is unresolved` | `true !== false` |
| `staged fresh assignment bridges pending start through working` | state `'unknown' !== 'settling'` |
| `staged fresh assignment removes a fast completion without observing working` | "staged fixture did not write an accepted request" |
| `fresh path sessions remain controllable after controller cache loss` | delegate: `agent_label_exists` |
| `lead herd runs start once …`, `restored herd run keeps its start …` | delegate: `agent_label_exists` |
| `recovery cleanup finishes an idle restored herd without settlement` | `0 !== 1` |
| `continuation reuses an idle retained worker …`, `concurrent continues …` (2) | close: "agent … and pane startup-pane did not disappear after close" (the mux disappearance wait) |

The shared snapshot seam already carries the explicit Radar arm:
`radarChildObservations` (`index.ts:4201`) builds one observation per durable
spawn record, `managedAgentPresence(state, inventory, radar)` returns
`{kind:"radar"}` from it, and `radarChildProvenance` refuses the pane when the
mailbox state's `paneId` disagrees with the launch's recorded pane
(`index.ts:4180-4193`) - a disagreement reads `unknown`, never live. So the
remaining failures are a mix of fixture-written child state that names another
pane (the two `parent delegates` closes), label leakage between tests
(`agent_label_exists`), staged expectations that assume an observation the Radar
contract does not provide, and the retained pair still waiting on a Herdr
disappearance for a child that has none. None of them is fixed here; the pane
attribution for group 1 below is wrong - see *Lifecycle fixture repair*.

## Lifecycle fixture cleanup attempt (superseded: the sweep was removed)

`resetFixtureAgents()` (`support.ts`), called from the lifecycle file's only
`beforeEach` alongside `updateConfig("retainWorkers", false)`, retired every
managed-agent mailbox this process wrote, by listing and by the fallback labels
(`agent`, `child`) the fixtures use. It is gone: it changed nothing whole-file,
and its listing step swept without a workspace filter - wider than the state
those fixtures can prove they own.

- Whole file: **three runs, all 68 tests / 55 pass / 13 fail with the identical 13
  names** - before the helper, after the mailbox sweep, and after retiring the
  labels by name. So the whole-file `agent_label_exists` is not leftover mailbox
  state that `resetAgentMailbox` clears, even though `guardMailboxOccupancy`
  (`index.ts:5721`) fails on the mailbox it reads.
- Group 1's `target_ambiguous` on close (`ids.paneId: "startup-pane"`) was
  unchanged too. `paneFor(1) === "startup-pane"`, `paneFor(2) === "startup-pane-2"`,
  and the simulated child publishes `settings.childPane ?? spawn.pane` - so the
  panes *agree*, and both earlier diagnoses (pane mismatch, "a later condition in
  `radarChildProvenance`") named the wrong cause.

## Lifecycle fixture repair (verified)

Two fixture defects, no production change:

1. The two-child test gave `fakePi` one `entries` array and `fakeAgentContext` a
   second, so the launch's durable `pi-herdsman-radar-spawn` records were invisible
   to `ctx.sessionManager.getEntries()`. `radarChildObservations` returned an empty
   map, `managedAgentPresence` took the mux branch, and the close refused
   `target_ambiguous`. The context now reads `pi.entries` - the same array the
   launch writes.
2. `createStagedAssignmentFixture`'s teardown dispatched only
   `session_shutdown` handler 0, which is Radar execution's `suspend`, not the
   controller - and it never opened the gates a failing test left closed. The
   launch therefore kept its mailbox startup claim, and the next test's label
   collided. The teardown is now async: it opens every gate, awaits the delegation
   the test handed it through the fixture's new `track()`, dispatches and awaits
   **all** `session_shutdown` handlers, then retires its mailbox. An active
   `.starting` claim is never deleted; waiting for the launch is what releases it.
   The fresh-path fixture's teardown dispatches all handlers too.

The oracle three-test reproducer (`a Radar-launched child is proved live|staged
fresh assignment bridges|fresh path sessions remain`):

| | before | after |
|---|---|---|
| primer | pass | pass |
| `staged fresh assignment bridges` | `unknown !== settling` (:1121) | same residual - a staged expectation, not repaired here |
| `fresh path sessions remain` | delegate `agent_label_exists` | its own `lastAck.accepted` assertion |
| duration | 46.2 s (launch-timeout tail) | 2.03 s |

Whole lifecycle file: **55 -> 61 pass, 13 -> 7 fail** (`68` tests). Retired both
`parent delegates two same-definition children …`, `staged fresh assignment
removes a fast completion …`, `lead herd runs start once …`, `restored herd run
keeps its start …`, and `session assignment never adopts a child that claims
another pane`. Still failing: the two `cascade close` tests, the staged
predecessor's staged expectation, the fresh-path fixture's own `lastAck`
assertion, `recovery cleanup finishes an idle restored herd`, and the retained
pair's Herdr disappearance wait. The two-child close now asserts Radar evidence
(`radarDaemon.closes` outcomes, the per-launch panes, `spawn.closed`) instead of
the mux `lifecycle.closeOrder`.

## Process liveness (exact contract limitation)

The daemon can say a *pane* is present (`freshness: "fresh"`) and that it has
observed no exit (`exit_observation: {state:"unknown"}`). Neither is proof that
the Pi process is alive: `unknown` means "no exit observed", and a missing pane
is not an exit either. For retained reuse the controller therefore has to pair
the daemon's pane correlation with the child's own mailbox evidence — a fresh
acknowledgment or heartbeat for the exact unchanged generation — and refuse
(unknown identity) when either side is missing. The daemon offers no
"is this process alive" call, and no synthetic one may be invented.

## Not done in this increment

The three stale recovery/rollback tests are rewritten and green (above); the 13
lifecycle and 14 remaining recovery failures stand at the counts above. No
lifecycle test was rewritten and the three tests' Radar stimuli are the only
test-side change this increment made. The blocked part of the owner's
plan (retained reuse) is decided and unblocked: reuse the existing mailbox
assignment against a proven unchanged running generation, with no Radar resume
call, no pane close/relaunch and no synthetic disappearance proof.


- Lifecycle/recovery consumer migration: the remaining failures read
  `managedAgentSnapshots` and still decide from mux-shaped fields (`alias`,
  `recovery_only`) for Radar children; cascade-close read ordering; staged-launch
  expectations that assume an observation the Radar contract does not provide.
- Retained-worker reuse on Radar (2 lifecycle tests) expects a mux disappearance
  proof for a child that has no mux record; it needs either the retained-reuse
  slice or an explicit decision that Radar children cannot be retained.
- The shared jj working copy carries other sessions' uncommitted work, so only
  per-file numbers are attributable.

## Staged-state and cache-loss acknowledgments repaired (verified)

Two of the seven lifecycle failures are retired. Five defects sat behind them -
four production, one fixture - and each was located by the throw the test
actually reached, not by reading the code:

1. **The owner could not correlate its own in-flight child.** `staged fresh
   assignment bridges pending start through working` read `unknown` with the
   daemon's own diagnostic: *"the daemon's current record of this launch's child
   is recorded on pane startup-pane, not on `undefined`"*. The durable record
   keeps `stage: "requested"` - no pane - until the launch is *ready*, and
   readiness is the child's startup acknowledgment, which this fixture withholds
   by design. `radarChildProvenance` (`index.ts`) now names the launch's recorded
   pane once it has one, and the pane the child's own mailbox claims until then;
   `observeRadarChild` still requires the daemon's read to report whichever pane
   is named, so a mailbox naming another pane reads `unknown` exactly as before.
2. **Recovery dropped a matched child's Radar identity.** The cache-loss test's
   first throw was `pi_herdsman_recovery_error: "Error: Agent agent was not
   launched through Radar"`: `recoverControllerRuntimes` set `radarAgentId` only
   in the branch where no inventory row matched, then proved a *matched* Radar
   child with `validateRadarChild`, which needs it. Every recovered state with a
   durable launch record now carries the launch's identity.
3. **The control path never consulted the launch.** With (2) fixed the same test
   reached `inspect` and failed `live Herdr agent alias mismatch`:
   `resolveRuntime` (inspect/steer/interrupt/reply/extend) built a Herdr-shaped
   runtime and always called `validateIntegration`. It now takes the Radar
   identity from the durable record and branches to `validateRadarChild` - the
   arm `deliverAssignment` already had.
4. **Inspection proved the pane through a name a Radar child never had.** Then
   `Inspection target identity did not match`: `captureManagedInspection`'s
   validate callback required `herdrAliasMatchesIfReported`. A Radar child is now
   proved by `validateRadarChild`; the pane is still read.
5. **The fixture rewrote a Radar child's identity mid-capture** (fixture defect,
   `support.ts`). `startupExecutor.registerChild` answered any unmatched Herdr
   command by writing the child's state under the fixture's own run id, which for
   a Radar-launched child deleted the launch's `startupAck` between inspection's
   two reads - the cause of the second read failing. It now leaves a child that
   already registered under another run alone.

Two assertions in the cache-loss test were stale transport and are corrected:
the child's acceptance is waited for rather than read as already landed (the
fixture's daemon child accepts on its own poll), and the close asserts
`radarDaemon.closes` (`outcome: "completed"`, `pane: recovered.paneId`) instead
of a Herdr `pane close`, which a Radar child never issues.

| suite | after | before |
|---|---|---|
| `controller-lifecycle.test.ts` | **63/68 (5 fail)**, 29.3 s | 61/68 (7 fail) |
| three-test reproducer | 3/3, 2.0 s | 1/3 |
| `recovery.test.ts` | 92/106 (14 fail) | 92/106 (14 fail), identical names |

Retired: `staged fresh assignment bridges pending start through working` and
`fresh path sessions remain controllable after controller cache loss`. Still
failing (5, all outside this brief): both `cascade close` tests, `recovery
cleanup finishes an idle restored herd without settlement`, and the retained
pair's Herdr disappearance wait.

## Decided: the launch records its bound edge before readiness

Owner chose the strict alternative. `launchRadarWorker` now persists the daemon's
own binding - the bound subject and the pane the daemon recorded - through an
`onBound` callback as soon as the binding wait returns, *before* it waits for the
startup acknowledgment, and `radarChildProvenance` no longer falls back to the
pane a child's mailbox claims. The location comes only from the launch's own
record; a mailbox naming another pane still refuses. A launch that never bound has
no pane at all and reads unproved, while a bound-but-not-ready child leaves an
exact record a reload can hold it by. Rejected: keeping the mailbox trailer as a
stopgap - it is the child's own claim about itself, and it agreed with the
daemon's record only by coincidence.

Binding persistence failure is a launch failure: the callback throwing leaves the
launch unresolved, so nothing is assigned or closed for a child no durable record
names. Readiness stays separate - the binding is written before the acknowledgment
is awaited, and a withheld acknowledgment changes nothing about the record.

Correction this forced, outside the granted file list: `recovery.test.ts`'s
unresolved-launch test asserted the superseded single-record shape
(`records.length === 1`, `stage === "requested"`) for a launch whose child had
bound. It now asserts the two appended records and the daemon's own subject and
pane in the last one.

| suite | after | baseline |
|---|---|---|
| `radar-launch.test.ts` | **23/23**, +3 cases | 20/20 |
| `controller-lifecycle.test.ts` | **64/69 (5 fail)**, 29.2 s | 63/68 (5 fail) |
| `recovery.test.ts` | 92/106 (14 fail), same names | 92/106 (14 fail) |
| whole suite (`scripts/check.mjs`) | 1169 / 1087 pass / **81 fail** / 1 skipped | 1165 / 1083 / 81 / 1 |

The three new launch cases are the daemon's binding reaching the record while the
child never acknowledges, an unrecordable binding leaving the launch unresolved,
and a launch with no recorded pane staying unproved although the daemon reports
one. In the lifecycle file the pre-ready record test now pins the bound subject
and pane, the reload that follows the window, and that nothing is closed; the
mismatched-pane test pins that the record keeps the daemon's pane and never the
pane the child claims; a fourth case injects a refused `appendEntry` for the bound
record and shows an unresolved launch that names only the request, leaves one
`requested` record and closes nothing. The 5 lifecycle and 14 recovery failures
are the ones recorded above, unchanged, and the whole suite's 81 are the baseline
81.

The whole-suite run caught one real regression on the way: `staged fresh
assignment bridges pending start through working` read the overview's `settling`
after the child's mailbox state existed but before the launch had polled the
daemon's binding, a window the removed mailbox fallback had papered over. It now
waits for the launch's record to carry `stage: "bound"` with the daemon's exact
subject and pane before it reads the row - the brief's "the staged launch
progresses after the exact binding persists". Worth knowing alongside it: in the
window between the daemon binding the edge and this process's `spawnGet` poll
observing it (up to the 250 ms cadence), an overview row now reads `unknown`
rather than the mailbox's state. Shortening that cadence in `radar-launch.ts` is
the lever if it ever matters; this slice did not take that timing decision.

## Cascade-close and idle-herd cleanup (this slice)

| suite | after | before |
|---|---|---|
| `controller-lifecycle.test.ts` | **67/69 (2 fail, both retained-worker reuse)**, 29.3 s | 64/69 (5 fail) |
| `recovery.test.ts` | **105/106 (1 fail: retained-worker restart)** | 92/106 (14 fail) |
| `radar-launch.test.ts` | 23/23 | 23/23 |
| whole suite (`scripts/check.mjs`) | 1169 / **1116 pass / 52 fail** / 1 skipped, 33.1 s | 1169 / 1087 / 81 / 1 |

Failing-name comparison against the recorded baseline whole-suite log: 29 tests now
pass and no test fails that passed before. Everything still failing is the
retained-worker reuse family (`continuation reuses an idle retained worker…`,
`concurrent continues of an idle retained worker…`, `a restart reuses a retained
worker in its existing process`), the slice this one excluded. `git diff --check`
is clean.

Two of the three target tests were not production failures at all. Their stimuli
are the mailbox and generation fs hooks (`agentStateReadHook`,
`failNextRequestRemoval`, `failNextMailboxWrite`, `failNextResultRemoval`), and
`support-radar.ts` — added by the Radar migration — imported `mailbox.ts` at
module scope, so `mailbox.ts` evaluated while `support.ts` was still resolving its
own imports, that is before `support.ts` installs its `node:fs` mock. Every
mailbox fs hook was blind in any suite that loads `support.ts`; `support-radar.ts`
now loads the mailbox lazily, which is what the hooks' own contract assumes. The
third target test held a second harness regression: `configureSupportedLaunch`
overwrote `config.json`, dropping the `retainWorkers: false` the suite sets in
`beforeEach`, so a live delivered worker was retained where the test expects it
closed and purged. The fixture now merges its placement into the existing config.

The production change this slice carries: the herd run's idle decision reads each
owned worker's own assignment and delivery facts (the snapshot now carries
`durableState`) instead of its mux or Radar presence, and the restore path awaits
the finish check so the `finished` ledger entry lands before `session_start`
returns.

## Retained Radar worker reuse (verified)

The last three lifecycle/recovery failures were neither a fixture artefact nor
pristine baseline: retention itself had never been implemented for Radar children,
so a delivered Radar worker was closed exactly as before the migration and a
session continuation could only relaunch it. Two production changes and one
fixture capability close it.

1. `resolveIdleWorker` (`index.ts`) proves a Radar worker from its own launch: the
durable `pi-herdsman-radar-spawn` record for that mailbox and run supplies
`radarAgentId` and `radarLaunchGeneration`, and `validateRadarChild` then requires
the child's binding sidecar, its mailbox identity and **its own acknowledgment of
that exact generation**. A pane the daemon still reports and a fresh edge say the
location survived; they are never promoted to proof that the process behind it is
still this generation. *This last step was corrected after review: the startup
acknowledgment proves which launch produced this mailbox, and not that the
process answering now is that one. The addressed acceptance in the next section
is what establishes that.* A child whose own evidence does not prove that is refused
with `target_ambiguous` naming the daemon's diagnostic (`unproved`), never reused
and never relaunched on a guess.
2. Retention ignored Radar: `finalizeDeliveredResult` computed
`retain = presence.kind === "live" && retainWorkersEnabled()`, so a delivered Radar
child was closed even with `retainWorkers` on. It is now
`(live || radar) && enabled`; with retention off the child still closes through its
own launch, unchanged.
3. `support-radar.ts` gains `adoptRetainedChild`: a retained child is a child an
earlier launch of the same session left running, so the fixture gives the daemon
the edge it bound and the child its own binding, mailbox state and acknowledgment —
the facts a retained worker is held by — instead of a mailbox the daemon knows
nothing about.

The three tests now seed that evidence, take their delivery through the daemon's
own child (`stopMailboxConsumer`, because the daemon's child is that consumer),
and carry the configured child command in their launch fingerprint so reuse is not
read as definition drift. The daemon a test registers against is brought up before
the child is adopted, or the adoption lands in a daemon the fixture then replaces.

| suite | after | before |
|---|---|---|
| `controller-lifecycle.test.ts` | **69/69**, 26.1 s | 67/69 (2 fail), 29.3 s |
| `recovery.test.ts` | **106/106** | 105/106 (1 fail) |
| `radar-launch.test.ts` | 23/23 | 23/23 |
| whole suite (`scripts/check.mjs`) | 1169 / **1119 pass / 49 fail** / 1 skipped, 33.1 s | 1169 / 1116 / 52 / 1 |

Failing-name diff against the previous stage's log: the three retained tests now
pass, and **no test fails that passed before**. The remaining 49 are the
migration-stage remainder — `controller-api`'s mux-era retained/relaunch tests, the
`Manager …` family, TUI/widget and agent-runtime cases — and they are not
attributed as a pristine baseline: this slice neither caused nor repaired them, and
only the three tests above changed state. `git diff --check` is clean;
`npm run check` exits non-zero because those 49 fail.

The retention-off arm is unchanged and covered where it was: the branch
`presence.kind === "radar" && !retain` still closes the exact bound pane through
the launch that created it, the explicit-close tests assert it
(`radarDaemon.closes` outcome `completed` with the launch's own pane), and
`agent_list.saved_sessions` guidance is asserted by the existing saved-session
tests.

## Process-addressed retained acceptance (verified)

The oracle's block on the previous increment was right about the rationale, not
the mechanism. `validateRadarChild` reads the *startup* acknowledgment, which
stays valid after the child's process is gone: it proves which launch produced
this mailbox, never that the process answering now is that one. The transport was
already strict - `submit` waits for a request-specific acknowledgment, so a dead
child could not produce a successful reuse - but that acknowledgment named no
process, so a replacement holding the same run, pane, label and session could
answer in the bound child's place.

An assignment to a retained Radar child is now addressed, and acceptance is the
answering process's own statement:

1. `submit` writes `RequestRecord.address` (`{subject, source, incarnation,
   generation}`) from the daemon's own read of the launch's edge - the subject it
   bound, the source and incarnation that child registered under - plus the
   durable launch generation. Evidence for fewer than all three writes no address:
   a fresh launch and a Herdr child keep the managed tuple they always had, and
   their request stays a V5 record. An addressed request is written as V6, which
   requires the address, and its control marker carries that same version.
   `requestRecordBytesFor` estimates the same record, so the pre-flight size check
   stays faithful.
2. The worker compares that address with its own identity before it accepts or
   runs anything: the subject from its binding sidecar, the registration source
   and process-local incarnation (`radarLocalRegistration()`), and the launch
   generation captured from its bootstrap environment. The incarnation comes from that slot and
   never from the record on disk, which is what makes a replacement - same
   mailbox, same run, pane, label and session, another process - refuse instead of
   execute. A mismatch, or an address the process cannot build at all, is
   acknowledged `{accepted: false, code: "identity"}` and the request is left
   unexecuted rather than answered on the replacement's behalf.
3. An accepted request echoes the address it verified in `lastAck.identity`, and
   the owner returns a reuse only when that echo equals the address it wrote. A
   missing or different echo fails closed; a rejected acknowledgement keeps its own
   refusal message. The wait is unchanged - five seconds, then the mailbox's own
   timeout for a child that never answers.

`validateRadarChild` and the startup acknowledgment keep their job - provenance of
which launch produced this mailbox - and are no longer described as process
evidence. Nothing here makes best-effort publication freshness load-bearing, and
no heartbeat or pre-flight challenge was added.

A worker from an older build does not know the addressed version and refuses the
record before it reads the task, which reaches its owner as the same unanswered
request. That is the rollout policy: addressing is established by the version, not
negotiated, so a mixed herd cannot run an addressed assignment on a worker that
would answer for it without checking the process.

The worker's own acceptance is covered by its own suite rather than by the
daemon fixture: `worker-addressing.test.ts` runs the extension's request pump and
input handler in one process (the launch generation is set before the extension
loads, because that is when the process captures it), and asserts that an
assignment addressed to another incarnation of the same tuple is refused with
`identity` and never runs, that an assignment addressed to the worker's own
process is accepted and echoes exactly that address, and that an unaddressed V5
assignment is still accepted with no echo. The address the positive test writes is
assembled from the same evidence the worker uses - the daemon's record of the
subject registered for this incarnation, the process-local incarnation and the
captured generation - so acceptance proves the worker holds itself to exactly
that address.

### Verification

Four tests in `controller-lifecycle.test.ts` drive an adopted retained child (the
`adoptRetainedChild` capability) and flip one fixture fact at a time: the
answering process is a replacement incarnation, the acceptance omits the echo,
the echo names another process, and the consumer never reads the request. Each
asserts that the continuation does not succeed, that the request the child saw
carried the launch's address, that nothing executed and nothing launched anew.
`continueOutcome` accepts both shapes a refusal takes - an operation that reports
`ok: false` and a wait that rejects - so a failure of either kind is still a
failure the test sees.

| suite | after | before |
|---|---|---|
| `worker-addressing.test.ts` | **3/3** (the worker's own acceptance) | - |
| `mailbox.test.ts` | **39/39** | 37/37 (+2 version and gate) |
| `controller-lifecycle.test.ts` | **73/73** | 73/73 |
| `recovery.test.ts` | 106/106 | 106/106 |
| `radar-launch.test.ts` | 23/23 | 23/23 |
| `agent-runtime.test.ts` | 5 baseline failures, none new | same 5 |
| whole suite | 1181 / **1136 pass / 44 fail** / 1 skipped | 1176 / 1126 / 49 / 1 |

No test fails that passed before the addressing work. The failing set is a subset
of the previous stage's: per file it is 35 `controller-api`, 5 `agent-runtime`, 3
`commands` and 1 `control-integration`, all migration-stage remainders on paths
this change does not touch. The five `commands` failures that no longer fail
(`agents` TUI selectors, the lead widget and menu, the coherent status snapshot,
zero-runtime reconciliation) are ones I cannot attribute to this change: nothing
here is on a command or widget path, and they are the known order-sensitive ones
in that file. `git diff --check` is clean; `npm run check` exits non-zero on the
remaining pre-existing failures.

## Decisions to record (keep-the-why)

1. A current topology read of a Radar child's edge reports location freshness and
   observed exit, not process liveness. Provenance and startup readiness are also
   historical facts. Exact process-addressed, request-specific acceptance proves
   which incarnation accepted the assignment; a missing pane is not proof of exit.
2. A managed close acts on durable launch proof, means pane closure only, and an
   unresolved close keeps its operation UUID with no retry, rollback or mux
   fallback.
3. A process publishes the pane its own environment reports; the pane a launch was
   created beside is the one value it may never claim. A spawned child therefore
   delegates like any other owner (restores nested delegation).
4. `child.close` capability refusal belongs to the daemon
   (`backend_unavailable`), not a client-side gate.
5. A Radar child is proved against the durable launch record that bound it, in
   every consumer that rebuilds a runtime from observed state: recovery, the
   control path (`resolveRuntime`) and inspection. Whether an inventory row also
   matched is not evidence and never supplies the identity.
6. A launch's location is the pane the daemon recorded when it bound the edge,
   taken from the durable record; a mailbox naming a different pane refuses the
   child rather than supplying a location, and a launch that never bound has none.
   Rejected: the mailbox's claim as a stand-in while the record is still
   `requested` - a child's own statement about where it runs is not where its
   launch put it.
7. A test fixture's child stand-in must not write state over a child that
   registered under another run: a Radar launch hands the child its run id, and
   rewriting it (with its acknowledgment) invents an identity change the
   controller must then refuse.
8. The daemon's binding is persisted as its own fact, before readiness is
   awaited, through the launch's `onBound` seam: a reload in the pre-ready window
   reads an exact subject and pane instead of inferring one, and a binding that
   cannot be written leaves the launch unresolved rather than assigned. The
   launch's request record is still written before the daemon is dialed, so a
   bound launch leaves two appended records and a reload reads the last.
9. A fixture that needs the mailbox module must load it after `support.ts` has
   installed its `node:fs` mock, so the mailbox hooks observe the mailbox's own
   file access. Rejected: rewriting the hook-dependent assertions, which would
   have removed the only coverage of retention-driven request/result failures and
   of state reads that race a rewrite.
10. A fixture's configuration write merges into the configuration the suite set
    for the test instead of replacing it: `configureSupportedLaunch` had silently
    reset `retainWorkers`, so a worker the test expected closed and purged was
    retained. Rejected: setting `retainWorkers: false` in each affected fixture,
    which duplicates a suite-level fact and leaves the next per-test key to be
    dropped the same way.
11. A herd run's idle decision is made from each owned worker's own assignment and
    delivery facts, not from mux or Radar presence: a worker whose supervision
    cannot be seen is idle once its result is delivered, while pending work still
    holds the run open. The restore path awaits that check, so what a session
    reports straight after a restore is the herd state it actually restored.
12. A retained Radar worker is reused only from its own durable launch record plus
    the child's own acknowledgment of that exact generation (`validateRadarChild`):
    the daemon's pane presence and a fresh edge are location evidence, never proof
    that the process behind the pane is still the generation the mailbox
    describes. Unproved evidence refuses with the daemon's own diagnostic instead
    of reusing or relaunching. Rejected: reading "the pane is there and no exit was
    observed" as aliveness, which would hand an assignment to a dead generation.
    *Corrected by 15: the startup acknowledgment is provenance of which launch
    produced the mailbox. The current acceptance evidence is the answering
    process's own echo of the request address.*
13. Retention applies to any worker whose own supervision proves it, Radar
    children included: `retainWorkers` keeps the child's process, pane, label and
    mailbox for reuse exactly as it does for a mux worker, and with retention off
    the Radar child closes through its own launch as before. Rejected: keeping
    "retention is a mux-worker feature" as a migration stopgap, which silently
    closed the workers an operator had asked to keep.
14. A retained child is modelled in the fixture as what it is: the daemon's own
    store holds the edge it bound, and the child itself writes the binding,
    mailbox state and acknowledgment. Rejected: hand-writing the mailbox while
    leaving the daemon ignorant of the child, which made presence unknown and the
    reuse decision refuse everything.
15. A retained Radar assignment is addressed to the exact process the launch
    bound, and its acceptance evidence is that process's own echo of the address;
    the startup acknowledgment stays provenance. Rejected: reading the startup
    acknowledgment as proof of the answering process, which a replacement
    occupying the same mailbox satisfies just as well.
16. The answering process's identity comes from the process-local slot
    (`radarProcessIncarnation()`), not from the binding sidecar and not from an
    environment value: only the slot distinguishes a process from one that reused
    its mailbox, run, pane, label and session. Rejected: comparing the recorded
    incarnation, which a replacement inherits along with everything else on disk.
17. An addressed request is its own protocol version (V6) that requires the
    address, rather than an optional field of the V5 record: the committed V5
    reader tolerates unknown fields and would read an addressed V5 record as an
    ordinary request and run its task, whereas a version it does not know it
    refuses before the task is reached. Unaddressed requests stay V5 with
    unchanged bytes and semantics, and the state, ask and result records keep
    their version: this is the request protocol only.
18. A request's control marker carries the same version as its record, so an
    addressed request has a V6 marker: the worker checks the two agree, and a
    reader that predates addressing recognises neither. Rejected: sending a V5
    marker for a V6 record, which the version check reads as a mismatched
    pairing.
19. The address names the accepting process, and only one field of it is
    process-local: the incarnation comes from the process-local registration
    slot, the subject from the binding sidecar the child wrote for its own launch
    tuple, and the generation from the bootstrap environment the process captured
    at module load. Rejected: describing the whole address as process-local
    evidence, which overstates what the subject and generation prove.
20. An unresolved launch holds its label durably. The launch record is the only
    trace a possibly dispatched spawn leaves when its child never registered or
    wrote state, so admission refuses a second same-label spawn while that record
    stands: `RADAR_SPAWN_OUTCOME_ENTRY` ends the unknown window with `ready` (the
    mailbox state now proves the label), `refused` (the daemon reported no
    launched child, which a refusal can record after the pane's creation) or
    `closed` (a managed close confirmed the child is gone). Rejected:
    deriving occupancy from mailbox state and unacknowledged requests alone, which
    is what let a second delegation mint a second spawn in one mailbox; rejected:
    releasing the record when the launch fails, which is the same bug one step
    later.
21. Reconciliation is a different operation from admitting a new close. A stored
    close whose outcome was never established (`dispatched`/`unknown`) is replayed
    with its own id and parameters without requiring current pane presence, and
    the mailbox is retired only after the daemon answered that request and the
    existing mailbox-generation and durable-result checks held. Rejected: reading
    a missing pane as a closed child, which cannot tell a lost reply from a
    replacement; rejected: gating the replay on live presence, which is what made
    a confirmed closure unreachable once the pane was removed.
22. The first task of a fresh Radar launch is addressed as well. The bound
    process the daemon names in the same answer that names the child travels
    through the launch into the fresh runtime, so a replacement answering between
    readiness and the first task is refused instead of served. Rejected: keeping
    fresh requests unaddressed as the previous slice did, which left exactly the
    race that retained addressing closes; rejected: taking the address from the
    child's own mailbox claim, which is the child's word rather than the daemon's.
23. Every assignment to a Radar child requires an address. A Radar runtime
    without a provable bound process fails closed (`target_not_found`) rather than
    writing an unaddressed request; unaddressed V5 stays for Herdr and other
    legacy consumers, which have no registration to address.
24. The mux-mailbox fixture's simulated child echoes an address it is given
    (`acceptMailboxRequest`), as the real worker does. Rejected: letting fixture
    children keep acknowledging without an echo, which would model a worker that
    does not implement the protocol the owner now holds acceptances to.

25. A test that expects a launch to succeed does not shrink the production
    launch deadline. The 1.2 s overrides those tests carried made the whole-file
    run fail at 1.2 s and hid the real 45 s outcome; only the test whose subject
    is reaching a deadline keeps one. Rejected: raising the overrides, which still
    measures the fixture's speed rather than the behaviour under test.
26. A simulated child's hooks live for one test: `onChildState` is cleared at the
    existing per-test hook boundary alongside the others, and the test that
    installs a hook restores it. Rejected: relying on each installing test alone,
    which is what leaked a never-resolving `onChildState` into every later test
    and made them read as launch failures.
27. A daemon that replaces a vanished socket does not inherit the predecessor's
    mailbox consumers or simulated children: those are the test's own work, and
    calling them the replacement's resources misstates what a restart carries.
    Rejected: transferring them across the replacement, which passed closures
    that still referenced the superseded daemon.
28. A close the daemon confirmed is durable evidence of physical closure whose
    only outstanding work can be this process's local cleanup. That record - the
    exact mailbox and run - authorizes resuming cleanup and nothing else: no
    request is replayed, no close id is minted, and the launch's `closed` outcome
    is not appended twice. Rejected: keeping `completed` out of the reconciliation
    predicate, which stranded the mailbox and its durable result after one local
    removal failure; rejected: replaying the stored close request, which would
    send a second physical close for a pane the daemon already closed.
29. One question - can this mailbox's close be settled without current presence -
    is answered by two records: `pendingRadarClose` (a dispatched request to
    replay) and `completedRadarClose` (a confirmed closure to finish cleaning up),
    combined in `closeIsReconcilable` for the presence gates of the snapshot
    close, the cascade guard and the result cleanup. Rejected: a separate recovery
    rule per caller, which is how the result cleanup and the close drift apart.

## Verification — durable occupancy, exact close reconciliation, addressed fresh assignments

Five acceptance regressions were added to `extension/controller-lifecycle.test.ts`:
an unresolved launch holds its label against a second same-label delegation
(including across a suspended and restarted session), a refused launch frees its
label for the next attempt, a fresh assignment is addressed to the process its
launch bound, a lost close reply reconciles the same request after the pane is
gone, and a close whose completion could not be recorded stays reconcilable.
Their evidence is the child's own identity echo for the addressed request and
the daemon's answer to the exact stored close, not an assertion about a live pane.

Abort predecessor plus the five: 6/6 pass (exit 0). Whole-file
`extension/controller-lifecycle.test.ts`: 78/78. Shared fixture suites
(`radar-launch`, `recovery`, `mailbox`, `worker-addressing`): 171/171. Whole
`npm run check`: 1186 tests, 1143 pass, 42 fail, 1 skipped, against the
pre-assignment baseline of 1181/1137/43/1 — no failing name is new, and one
baseline failure (`fresh assignment refreshes the widget after validation`)
passes. `git diff --check` is clean.

The order-dependent failure the five regressions showed in whole-file order was a
leaked fixture hook, not a launch defect. The test `an aborted launch ends
without a later lookup or timer` installs a never-resolving `onChildState`, and
its teardown did not restore it; neither the daemon's own `reset()` nor the
per-test `resetRadarState()` cleared that hook, and the replacement path in
`ensureRadarDaemon` copied it into a successor daemon. Every simulated child a
later test started therefore wrote its mailbox state and then awaited that hook,
never reaching `writeStartupAck`, so readiness failed its first condition
(`ack !== undefined`) and a close refused before recording anything — which is
exactly the observed readiness timeout and `pi_herdsman_state_error`. Both earlier
readings are withdrawn: the state was not absent (it is written before the hook is
awaited), and the simulated child's session derivation was never the problem
(readiness compares a child's own state with its own acknowledgment).

Fixed by restoring the hook in that test's teardown and clearing it at the
existing per-test hook boundary. The speculative daemon-resource transfer added
for the disproved cause is removed: a replacement no longer adopts a
predecessor's mailbox consumers or simulated children. The creation-state
baseline stays, because it fixes a separate verified failure (a mid-test settings
change becoming the baseline a later reset restores).

## Verification — completed close cleanup recovery

A close the daemon confirms writes `stage: "completed"` before this process
touches the mailbox, so a local removal failure - the `unlinkSync` of the request
the mailbox is still carrying - leaves a confirmed physical closure whose cleanup
never ran, with no pane left to act on. `pendingRadarClose` excluded that stage,
so the retry refused before cleanup and the mailbox stayed stranded.

Fixed by treating the exact record as authority to resume *cleanup* only:
`completedRadarClose` is keyed by mailbox and run, `closeRadarChildPane` returns
without a daemon request when it finds it, and the presence gates admit it the way
they admit a dispatched close. No close id is minted, no request is replayed, the
launch's `closed` outcome is not appended twice, and a replacement generation -
its own run id - is not covered by the record.

Three regressions, all under `pi-herdsman/extension/`:
- `controller-lifecycle.test.ts`, "a confirmed close resumes its own cleanup after
a cleanup failure": one injected `request-` removal after the completion is
recorded, then the retry after a session restart over the durable entries. The
mailbox is gone, `radarDaemon.closes` still holds one close, and the close
entries still carry one request id.
- `controller-lifecycle.test.ts`, "a confirmed close is never resumed over the
generation that replaced it": while the replacement's own presence is unprovable
the close refuses (`target_ambiguous`), sends nothing and keeps the replacement's
state; with its presence established the close acts on the replacement's own
launch, so the stored record of the generation before it is never the authority.
- `recovery.test.ts`, "a restart finishes the cleanup of a close the daemon already
confirmed": a restored session over durable entries finishes the cleanup and
sends no close at all (`radarDaemon.closes` empty).

Witnessed red before the fix: with `closeIsReconcilable` ignoring the completed
stage, the first regression's retry fails `target_ambiguous` ("Managed agent
presence cannot be proved safely"), exactly the gap this closes; with the
`closeRadarChildPane` short-circuit removed, the restored-session regression sends
a second close.

Results: `controller-lifecycle.test.ts` (80) and `recovery.test.ts` (107):
187/187. Focused Radar suites (`radar-launch`, `mailbox`, `worker-addressing`):
65/65. Whole `npm run check`: 1189 tests, 1146 pass, 42 fail, 1 skipped, against
the recorded baseline of 1181/1137/43/1 - no failing name is new, one baseline
failure passes, and the failing set is the same as before this change plus the
three new tests. `git diff --check` is clean.
