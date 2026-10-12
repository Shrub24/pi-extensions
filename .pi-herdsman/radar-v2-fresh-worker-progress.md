# Radar v2 fresh-worker consumer cutover: progress

Status: uncommitted in the shared pi-extensions working copy. The wire port
(previous slice) is untouched by this one except where the consumers needed a
decoded field.

## What this slice completes

The fresh-worker vertical slice: launch, location, readiness, first
assignment/result and eligible close for a Radar-managed child, with no direct
Herdr call on that path.

| Seam | Change |
|---|---|
| Location bootstrap | `extension/radar-location.ts`: the backend and its server are the daemon's negotiated `daemon.ping` facts, the pane is this process's own environment fact, and the daemon's canonical observation must report that exact pane before anything is published. |
| Placement | `physicalPlacement` is this process's own validated pane, and a non-split placement refuses before any placement lookup consults a mux. |
| Registration timing | `initializeRadarPublication` resolves the location before the registration record is built (a registration is immutable) and exposes `radarPublicationReady`; the launch awaits it instead of refusing while the daemon is still answering. |
| Presence inventory | `managedAgentSnapshots` and the supervision refresh read the daemon's canonical fleet observation over the control socket (`radarFleetInventory`). A read that failed, or that this daemon cannot serve, is `unavailable` (unknown presence), not an empty fleet, and there is no environment-gated fallback to a backend CLI. |
| Display metadata | The pane-metadata, awaited-facts, owner and lead publishers and the native-reporter notice are removed, with `extension/pane-metadata.ts` and `extension/awaited-facts.ts` and their fixtures. Assignment facts live in the mailbox and the registry, not in terminal metadata. |
| Close | `already_exited` is a confirmed physical cleanup: the durable record keeps the daemon's word and the edge's exit observation, and the guarded local cleanup proceeds exactly as for `completed`. |

## Withdrawn claim, and the rule it was replaced with

An earlier version of this note claimed that `mux.observe` cannot validate a pane
under a tmux daemon, because the tmux adapter returns `agents: Vec::new()`
(agent-radar `src/tmux.rs:368`, pin
`f87348032a808967c50a4e84b7e1c766a64ebfe3`). The array is real, but the conclusion
was wrong: the canonical `FleetObservation` is
`{workspaces, tabs, panes, agents}`, and the tmux adapter populates the first
three - it leaves only `agents` empty, because tmux carries no agent records. The
previous decoder discarded everything but `agents`, so a tmux inventory looked
empty and the resolver fell back to the environment. Review reproduced the
consequence: a pane the observation did not report was still published, and an
unreadable observation published the environment's pane.

The rule now implemented, and the one the acceptance tests exercise through the
real decoder:

- the backend and `instance` come from `daemon.ping` only;
- the pane is this process's own (`TMUX_PANE` for tmux, `HERDR_PANE_ID`
  otherwise), qualified as `tmux:<instance>:<%N>` for tmux, and a tmux process
  whose own client names no server, or another server, publishes nothing;
- the daemon's canonical observation must report that exact pane, and its pane
  row's own `location` is the containment the registration carries;
- an unreadable observation, a pane the observation does not report, a pane
  reported twice, a tab row that contradicts the pane's workspace, or an
  environment containment that contradicts the observation publishes no location;
- a process with no pane of its own - no pane variable, no Herdr pane, the pane
  its launch was created beside, or a daemon serving no backend - publishes no
  location by fact;
- a *gap* in that evidence (the daemon is not answering, the topology is
  unreadable, the pane is not reported yet) is `pending`, not `absent`: the
  immutable registration record is not written at all, and the next attempt asks
  again.

## Where the location is resolved, and why there

The adapter is still constructed **synchronously at extension registration**, so
its own lifecycle listeners are registered with every other extension's; only
the *registration record* is built later. `createRadarPublication` now writes the
subject record inside `ensureRegistration()` - still before the record is ever
sent to the daemon, and still never rebuilding a stored record - because the
location is the one fact that can still be arriving when the adapter starts. A
store that cannot hold the record leaves the process unregistered and reports
`private storage unavailable` rather than throwing out of a lifecycle event.

Rejected alternative: constructing the adapter after awaiting the location. It
moves the adapter's listeners past the session_start dispatch, which is how the
adapter learns the session it is publishing for; in the fixtures it meant no
registration at all.

The placement pane is resolved on demand (`ensureRadarLocalLocation`) and
memoized against the environment facts it came from. A daemon that is not
answering yet is retried rather than remembered as a process without a pane, and
a process that is described differently is described by a fresh answer.

## Mux reads on the ordinary path

The ordinary path reads exactly one mux: `radarFleetInventory()` calls the
daemon's `mux.observe` and decodes its canonical inventory. The previous
`presenceInventory`/`muxInventoryIsReachable` pair - a Herdr-environment gate
around a Herdr CLI snapshot - is gone, so a process with no Herdr environment is
no longer a process with no inventory, and a daemon that cannot serve the read
leaves presence unproved rather than absent.

`managedAgentPresence` now decides from canonical rows: the pane row proves the
location and its containment, and an agent row proves the child by pane,
workspace, session identity and name - a managed worker's own published label and
run when the source carries them, otherwise the run-scoped alias. A pane whose
occupant does not claim the child is the `aliasUnclaimed` refusal it always was.
A retained pane with no agent on it is `lost` only when the observation reports
agent facts at all (a tmux inventory reports none, so it cannot tell an empty pane
from an unreported one), and everything else stays `unknown`.

## Fixture findings (pre-existing, corrected here)

- `setAgentEnvironment` left the operator's own `HERDR_TAB_ID` in the
  environment, so a registration published a tab belonging to the session that
  ran the tests. The fixture now sets its own tab. Verified pre-existing by
  simulating the pre-cutover resolver: it published `tab: "wQ:t1G"` from this
  session's ambient mux.
- `registeredSubject(1)` in "a launched child publishes the pane it reads"
  assumed the daemon's call log survives `setLeadEnvironment`, but the fixture's
  `reset()` clears it; the registration is now found by the pane it names rather
  than by arrival position.
- The staged-assignment fixture delegates a launch without ensuring a daemon, so
  it only passed when an earlier test in the file had created one. It now calls
  `ensureRadarDaemon()`, as `startRadarSession` does for the session fixtures.
- "fresh assignment refreshes the widget after validation" used a mux snapshot
  call as a proxy for "the validated runtime was refreshed"; a Radar child's
  refresh reads its own launch record, so the test now asserts the absence of a
  mux read in that window instead.
- `FakeRadarDaemon` gained a `reads` log while investigating a hang; it ended up
  with no consumer and was removed again.
- "repeated lead starts replace the widget and ignore old refreshes" held every
  mux inventory read and resolved a fixed number of them. With the startup path
  reading the inventory a little later, a read appeared after those resolutions
  and the second start's recovery awaited it forever. The fixture now answers
  reads once the held ones are released, so the test still proves what it is
  about - what the widget shows for a refresh that has not answered - without
  depending on how many reads a start performs.
- "malformed definitions do not abort ordinary lead startup" used a Herdr
  `api snapshot` call as a proxy for "recovery ran". With no mailbox there is
  nothing whose presence must be proved, so that read no longer happens; the test
  now asserts the session's own controller is ready and the definition error is
  recorded.

- The shared daemon fixture now models the fleet a live daemon would observe:
  this process's own pane, and one pane plus one agent row per mailbox this
  session owns, carrying the managed label, run and session identity the owner
  recorded (`radarObservedFleet` in `support.ts`, exposed as the daemon's
  `observeInventory`). Presence decisions therefore read canonical rows instead
  of the Herdr `api snapshot` replies the old fixtures hand-built, and a test
  that needs a different topology - an absent pane, a contradiction, an
  unreadable backend - sets `radarDaemon.options.inventory` or
  `observeUnavailable` instead of fabricating agent rows.

## Update: live presence identity (Option A), and a withdrawn simplification

Recovery family 1 was the ~11 failures that come from one seam: a child this
process did not launch through Radar is `live` from a canonical observation row,
but the shared path then ran `validateIntegration` (`herdr agent get`) and
`validateIdentity` compared Herdr-only fields (`cwd`, `herdrAlias`, `agent_session`
tokens). A canonical row carries no cwd, so every such child failed with
`cwd=undefined != "/tmp"`.

Decision (owner, Option A with three conditions):

- For a canonical live row, identity is proven by `canonicalAgentProves` alone:
  workspace, pane, session, and label/run-or-alias. cwd and the Herdr alias are no
  longer gates there. `validateIntegration` and the Herdr `agent get` / token reads
  are gone from the shared path. Presentation (task, startedAt, model) comes from
  the launch record; a canonical observation carries none of it, so it stays
  unknown. No Herdr fallback.
- No destructive authority is widened. A child this process did not launch through
  Radar still refuses a physical close with `invalid_request`. The loosening
  affects only non-destructive controls (inspect, steer, reply, extend), and those
  stay gated by the mailbox's own addressing, run/generation guards and v6 process
  addressing.
- The aliasUnclaimed, ambiguous-occupant, duplicate-pane and unreadable-inventory
  refusals are unchanged.
- Option B (migrate fixtures to Radar-bound children) is not used as a workaround.

Result: `recovery.test.ts` 41 pass / 69 fail -> 52 / 58.

Withdrawn attempt: I removed the five per-helper `observeFixtureFleet` installs
and derived the daemon's fleet from the mailboxes (`radarObservedFleet`). That
dropped recovery to 45 / 65, with eight new failures. It is reverted. Diagnosis so
far: one test passes alone and fails in the full file (state leak from an earlier
test); `a restart mid-window` fails alone, its second `mux.observe` gets no reply
within 2000 ms, then ECONNRESET. The fake daemon logs no throw or write error. The
fleet simplification is not retried until that transport loss is diagnosed.

## Update: fake-daemon `mux.observe` reply loss, diagnosed

The reply loss was two causes, both in the transport seam, found by numbering
each client call and logging its dial, write and finish:

1. The client's per-call deadline (`RADAR_CALL_TIMEOUT_MS`) is created through
   `systemScheduler`, which resolved the global `setTimeout` at call time. A test
   that ticks the fake clock (`t.mock.timers.tick(30_000)`) while a real socket
   read is in flight fires that deadline in virtual time, before the reply can
   arrive. `finish` then destroys a socket that has not connected, and the next
   call is reset. Fix: `radarClient` captures the wall-clock timer functions when
   the module loads, so a consumer that fakes the global timers does not move a
   control-socket deadline.
2. A scan that reads the fleet takes several real socket round trips. The
   digest tests waited one `setImmediate` after the tick, which is not enough for
   those round trips. The digest then arrives after the assertion. Fix: a bounded
   `settleUntil(() => softDigests(pi).length === n)` helper in `recovery.test.ts`,
   which yields until the observable outcome holds and fails if it never does. It
   is a condition wait with a fixed budget, not a sleep.

The fake daemon itself is unchanged. Its `ENOENT` seen after the test ended was the
background scanner outliving the test, not the cause.

Diagnostic instrumentation used for this was removed; no `DIAG`/`DEBUG` marker
remains in `extension/`.

## Update: close-family migration progress (owner rule: A by default, B only when legacy-only)

Recipe that works, and is the shape every later migration should copy:

1. `radarChildFixture(label, options)` (in `recovery.test.ts`) starts the lead
   session, delegates through the production `agent_delegate` edge, and returns
   the mailbox state the daemon's own launch wrote plus a `recover()` that runs
   one recovery pass with `fakeContext(pi.entries)`.
   `recordResultEntry` records the durable provenance the lead keeps.
2. Write the result, fire `watchedResultPaths.get(path)?.( {}, {})` to deliver it
   while the assignment is still unresolved, then write the settled state and run
   `recover()` for the cleanup the retry performs.
3. Assert against the daemon (`radarDaemon.closes`, `radarDaemon.options`
   knobs) instead of the Herdr fixture's `lifecycle.closeOrder`.

Migration tally (recovery.test.ts):

- (A) migrated to a Radar-launched child: 4
  - "close returns a structured nonfatal mailbox cleanup warning"
  - "result is removed after agent state reaches completed"
  - "one-shot close failure retains the result for exact cleanup retry"
    (first close refused via `radarDaemon.options.refuseChildClose`, retry after
    the daemon accepts)
  - "retained delivery keeps the worker, pane, and mailbox without the result"
  - "disabled retention still tears the delivered worker down"
- (B) legacy-only conversions: 0.

Red-then-green by mutation, one representative per group:

- result-cleanup group: `resultCleanupReady` forced to return false turns
  "result is removed after agent state reaches completed" red.
- cleanup-warning group: removing `removeAgentMailbox` from the cleanup branch
  turns "close returns a structured nonfatal mailbox cleanup warning" red.

Counts: `recovery.test.ts` 64 pass / 47 fail of 111.

Note on a migration hazard, hit and fixed: replacing a test body by slicing to
the next `test(` deletes any shared helper defined between them. Three helpers
(`deliveredResultFixture`, `emptyInventory`, `listAgentState`) were removed that
way and restored; a later migration must check the file for lost definitions
after any bulk edit.

## Update: close-family migration (owner rule: A by default, B only when legacy-only)

Shared helper: `support.ts` now exports `testBrief` (moved from
controller-lifecycle) and `delegateRadarChild(pi, label, task)`, which delegates
through the production `agent_delegate` launch edge and returns the mailbox state
the daemon's own launch wrote. It fabricates no rows.

Migration tally so far:

- (A) migrated to a Radar-launched child: 1 - "close returns a structured
  nonfatal mailbox cleanup warning". Red-then-green: removing the cleanup branch's
  `removeAgentMailbox` turns it red; restored, it is green. Required passing the
  session entries to the close (`fakeContext(pi.entries)`), because the Radar
  binding is read from the durable spawn entry, not from the mailbox.
- (B) legacy-only conversions: 0.

Remaining close/cleanup family, not yet migrated (all (A) unless noted):
parent close cascades child-first (needs a Radar parent with a Radar child, i.e.
nested delegation through the fake daemon; not yet checked), one-shot close
failure retains the result (needs a daemon close failure, e.g. `dropCloseReply`
or `refuseChildClose`, plus a delivered result), delivered-result cascade,
result removed after completed, retained delivery, disabled retention,
completed/failed one-shot converge, settlement redelivery, recovered no-live
removal, lost close fails closed, completed lost parent cleanup, automatic close,
manual close ownership, cascade revalidation, nested cascades, lost parent
ancestry, matching managed execution, alias-claim close, live result cleanup,
lead recovery shutdown.

### Latest measured (this continuation, sequential `--test-concurrency=1`)

| Suite | Checkpoint table above | Now |
| --- | --- | --- |
| `recovery.test.ts` | 110 tests, 40 pass, 70 fail | 111 tests, **64 pass, 47 fail** |
| `controller-lifecycle.test.ts` | 85 tests, 73 pass, 10 fail, 2 cancelled | 85 tests, **69 pass, 14 fail, 2 cancelled** |
| `extension-contract.test.ts` | 48 tests, 30 pass, 14 fail, 4 cancelled | 48 tests, **28 pass, 16 fail, 4 cancelled** |

The two non-recovery suites are four and two failures worse than the checkpoint
table. That regression is **not yet attributed**: it may predate Option A (the
checkpoint table was measured before it), or Option A's removal of the cwd and
Herdr-alias identity gates may have moved tests that assert a refusal. Candidate
names to check first, because they are identity-shaped:

- `controller-lifecycle`: "session continuation keeps an exact live ID busy
  despite a missing path observation", "…despite contradictory live
  observations", "worker launches store one launch fingerprint of the resolved
  definition".
- `extension-contract`: "lead rejects a remote chief with mismatched physical
  identity", "peer provenance enrichment never replaces the Lead cwd".

Attribution needs a baseline run with the Option A edit reverted, which has not
been done.

## Update: the checkpoint-vs-now regression, attributed (step 1)

Method: both suites were run on the current tree, then again with exactly one
hand revert - the Option A cwd gate restored to `if (!sameCwd(agent.cwd,
runtime.cwd))` in `validateIdentity`, so a canonical row with no cwd fails again.
Nothing else was edited between the two runs.

| Suite | Option A (current) | Option A reverted |
| --- | --- | --- |
| `controller-lifecycle.test.ts` | 85 tests, 69 pass, 14 fail, 2 cancelled | 85 tests, 69 pass, **15 fail, 1 cancelled** |
| `extension-contract.test.ts` | 48 tests, 28 pass, 16 fail, 4 cancelled | 48 tests, **26 pass, 18 fail**, 4 cancelled |

Diff of the failing sets:

- Failing **only** under Option A: none, in either suite.
- Failing **only** under the revert (i.e. Option A fixes them):
  `extension-contract` "delivered owner asks retain the question in visible message
  details" and "registered agent inspect exposes process and recent activity
  evidence"; in `controller-lifecycle` the delta shows as one fewer failure and one
  more cancellation.

Second run, the same method: both suites with only the wall-clock timer capture
in `radar-client.ts` reverted (bg-231). Result: `controller-lifecycle` 69 pass /
14 fail / 2 cancelled and `extension-contract` 28 pass / 16 fail / 4 cancelled -
**identical** to the current tree. So neither of this session's production changes
(Option A, wall-clock deadlines) moves those counts.

Conclusion: **Option A does not cause the checkpoint-vs-now delta.** Reverting the
identity gate makes both suites slightly worse, not better. So the delta came from
earlier cutover work, not from this session's identity change, and no test was
asserting a refusal that the owner's decision removed. No Option-A-removed-refusal
list is owed.

## Update: recovery owned by this pass (scope split)

Scope for this pass: `recovery.test.ts` and `commands.test.ts` only; the other
four suites belong to a second worker.

Batches landed, each with one group run:

| Batch | Sites | Effect |
| --- | --- | --- |
| health/stale first assertion | 7 | recovery 64 -> 67 |
| digest/window message counts | 6 | recovery 67 -> **71** (40 fail) |

Measured: `recovery.test.ts` 111 tests, 71 pass, 40 fail.

Diagnosed cause for the health/stale family, with evidence: a temporary probe at
the stale gate (`index.ts`, since removed) shows the gate is satisfied
(`presence live`, `listed.state working`, `now - lastActivityAt = 601000 >
600000`) and the `settleUntil(() => attempts === 1)` now passes. Running
"stale scanner starts immediately, reschedules, deduplicates, and retries failed
publication" alone shows the **first** assertion now passes and the failure has
moved to the *second*: `t.mock.timers.tick(30_000); await new
Promise((resolve) => setImmediate(resolve)); assert.equal(attempts, 2, "a failed
advisory is retried on the next scan")` gives `1 !== 2`. So this family needs the
bounded settle at **every** post-tick observation, not only the first - the same
socket-round-trip cause, one assertion further along. That is the highest-yield
next edit for the remaining health/stale tests.

The digest batch left four members still failing: "two overdue workers produce one
digest covering both", "a checkpoint covering several Agents offers no single
instruction", "stale attention and a soft-deadline digest are both delivered in
one scan", "a resolved assignment is never included in a later digest". Their
first `settleUntil` now times out, so they are not a pure timing repeat; the
message count they expect is never reached.

`commands.test.ts` was not run in this pass; the 1800 s hang is undiagnosed.

## Update: recovery health/stale and digest slice (bounded)

Scope: `recovery.test.ts` health/stale and digest/window families only.
Measured: `recovery.test.ts` 111 tests, **77 pass, 34 fail** (71/40 at the start
of this slice).

Commands (named groups, `--test-timeout=60000 --test-concurrency=1`):

- health/stale: `--test-name-pattern="stale|attention|unacknowledged|exited by hand"` - 9/19 -> **12/19**
- digest/window: `--test-name-pattern="digest|checkpoint|overdue|consecutive windows|soft-deadline|window"` - 16/20

### Causes found, each by probe rather than by guess

1. **A post-tick observation races a real socket round trip.** A scan that reads
   the daemon's fleet takes several event-loop turns, so a fixed `setImmediate`
   after `t.mock.timers.tick(...)` observes the *previous* scan's state. Applied
   the bounded `settleUntil` on exactly what each assertion asserts, at every
   observation point, not only the first. A mechanical pass converted the sites
   whose assertion is an `assert.equal`; the assertion itself is unchanged, so
   only the waiting changed.
2. **The health/stale fixtures read Herdr for topology the cutover no longer
   asks for.** Probe at the scan loop showed `presence unknown` with the
   diagnostic *"The daemon's fleet observation is unavailable"*, because those
   fixtures install no fleet on the fake daemon at all. Fixed by starting the
   session through `startRadarSession(pi, fakeContext())` (which ensures the
   daemon) in six of them, and by expressing "physical identity cannot be proved"
   through the canonical route - `radarDaemon.options.observeUnavailable = true` -
   in "physical unknown attention is one-shot and fail-closed", which then passed.
3. **A shared fixture `runId` made multi-child presence ambiguous.**
   `managedState` gives every managed child `runId: AGENT_ID`, and
   `canonicalAgentRelated` treats a row whose `managed_run` equals the state's
   `runId` as a candidate claimant, so with a mailbox-derived fleet each child
   made every other one ambiguous: probe showed
   `"Managed physical identity cannot be proved uniquely"` for both children of
   `softDeadlineFixture`. Fixed by giving each child of that fixture its own
   recorded run, as a real launch does.
4. **Each fixture's exec installs its own fleet, so the last installation hid
   every other child.** `softDeadlineFixture` now leaves the daemon observing the
   mailboxes this session owns (`radarDaemon.observeInventory =
   radarObservedFleet`), which proves all of its children. This fixed "two overdue
   workers produce one digest covering both" and "a checkpoint covering several
   Agents offers no single instruction".

### Still failing in these two families, with what is known

- "background-waiting workers keep digest/extend eligibility but reject
  interrupt" projects `working` where it expects `waiting`. Cause identified:
  `agentControlState` returns `working` as soon as the observed lifecycle is
  `working`, before it consults `backgroundWorkTaskIds`; the mailbox-derived fleet
  reports `working` for a waiting child. Omitting `status` from that row did not
  change the projection, so the lifecycle used is not only the row's status.
- "a resolved assignment is never included in a later digest" now reaches a
  close the daemon refuses with `invalid_request` ("was not launched through
  Radar"): the fixture closes a child that is not Radar-bound.
- "agent_extend refuses a non-live worker's recovered window" and "a worker
  exited by hand leaves a shell pane that reads unknown, then lost after the
  startup window" both expect `unknown` and get a proved state
  (`working` / `lost`), i.e. their fixtures still express the missing evidence
  through Herdr rather than through the daemon's observation.

No production file was changed by this slice; every fix is in the tests and the
shared fixture. `git diff --check` clean, no probe markers.

## Update: simplification slice, and the tmux premise correction

Direction for this slice (owner): simplify legacy-shaped tests and contracts
rather than keep them green; the cutover diff must end smaller.

### Applied

- **Production correction, owner-verified against the pinned daemon.** The
  "a backend that reports no agent facts at all" carve-out is removed from
  `managedAgentPresence`'s retained-pane branch: the collector replaces
  `agents` with a registry projection for *every* backend (`collector.rs:375-381`,
  `model.rs:568-575`), so an absent agent row is evidence about the
  registry-presented set, not a property of the backend. `inventory.agents.length
  > 0` is gone and the comment now states the real rule.
- **Stale premise removed from two comments** that asserted a tmux-backed daemon
  reports no agents: the `RadarInventory` decoder doc and the fake daemon's
  `inventory` option doc. Both now state that presented agents always come from
  the registry and that a backend's own records are containment evidence only.
- **Fixture truth fix (F), the four named failures' first item.** The canonical
  fleet row claimed `status: "working"` for every child with an active request, so
  a child waiting on background work was reported as executing a turn.
  `radarObservedFleet` now reports `idle` for that child; "background-waiting
  workers keep digest/extend eligibility but reject interrupt" passes without
  touching `agentControlState`.
- **Three tests deleted (S)** whose only subject is a removed Herdr-era
  mechanism: "stale diagnostic failure refreshes physical state before
  publication" (asserted a Herdr `api snapshot` count after a failed `herdr agent
  get`), "stale scanner keeps one inventory in flight and retries rejection" and
  "stale scanner shutdown invalidates old inventory generation" (both built on
  `herdr agent list` sequencing). 111 tests -> 108.

Measured: `recovery.test.ts` 108 tests, **77 pass, 31 fail** (111/77/34 at the
start of this slice).

### Classification of the remaining 31, from each first assertion

(S) delete, subject is a removed mechanism:

- "manual close retains ownership when live session identity is missing or wrong"
  - expects `target_ambiguous` from a Herdr live-session probe; a legacy child's
  close now refuses `invalid_request` before any identity comparison.

(M) or (R) - the behaviour is still true for a Radar child, the fixture is legacy:

- 15 close/cascade/delivery tests that fail with `invalid_request` ("not launched
  through Radar") or with an empty `closeOrder`, because their parent and child
  mailboxes are hand-written Herdr-era pairs: parent close cascades child-first,
  nested cascades, lost-parent ancestry, cascade revalidation, completed lost
  parent cleanup, automatic close, lost close fails closed, matching managed
  execution, delivered-result cascade, completed/failed one-shot converge,
  settlement redelivery, recovered no-live removal, result removal after
  completed, live result cleanup, conflicting same-request entries.
- "a resolved assignment is never included in a later digest" - its fixture closes
  a child that is not Radar-bound.

(F) invented fixture evidence still to fix:

- "agent_extend refuses a non-live worker's recovered window" and "a worker
  exited by hand leaves a shell pane that reads unknown, then lost after the
  startup window" - both expect `unknown` and are given a proved state; their
  fixtures express the missing evidence through Herdr rather than through the
  daemon's observation.
- "unresolved background work remains active ..." and "a delivered worker with a
  live pane projects idle" - both project `unknown` because the fixture proves no
  presence at all.
- "delegation parent notifies only its direct stale child" and "old unacknowledged
  requests get attention" - the advisory is published over a fleet their fixture
  does not install.
- "stale working parents remain visible while waiting parents project blocked" -
  the lifecycle is asserted from Herdr row mutation.
- "list derives inactivity without changing public state", "a proven lost
  assignment drops agent_extend from available_tools", "delivered owner asks
  repeat without duplicating first delivery", "lead recovery integration
  validation aborts with session shutdown" - same fixture-shape cause.

### Formatting hazard, hit and reverted

Running `prettier --write` over `index.ts` and `radar-client.ts` rewrote them
wholesale (2342 changed lines in `radar-client.ts`), because they are not clean
under the locally resolved prettier (3.9.9) while the rest of that formatting is
deliberate. Both were restored from their pre-format copies and only the intended
edits re-applied, confirmed by diffing against those copies (11 and 17 lines).
Format only the test files; do not run the formatter over `index.ts`,
`radar-client.ts` or `support-radar.ts`.

### Not done

The 15-test (M)/(R) close-and-cascade family is the bulk of what remains. Under
this slice's rule it needs either ~15 compact rewrites onto Radar-launched
children or deletion of that coverage, and that choice changes how much close and
cascade coverage the suite keeps. `commands.test.ts` was not reached.

## Update: rewrite slice - started, template established, not executed

Owner's ruling for this slice: rewrite (R) the 16 close/cascade/delivered-result
tests compactly on Radar-launched children using `delegateRadarChild` (or the
already-present `radarDaemon.adoptRetainedChild` for a mailbox whose launch
already happened), keeping each behaviour's own assertions and dropping the
Herdr-era mailbox pairs and Herdr-shaped assertions; then remove the five
per-helper fleet installs and delete or rewrite whatever only survived on them;
then the 14 (F) fixture-evidence fixes; then delete the one (S); then the
`commands` hang.

I did not execute the rewrite. The slice ended with the tree exactly as the
previous slice left it - `recovery.test.ts` 108 tests, 77 pass, 31 fail, `index.ts`
and `radar-client.ts` hand-edited only, `git diff --check` clean, zero probes -
because starting sixteen rewrites without the budget to verify them would have
left the shared file mid-edit, which is worse than a clean stop.

The template for the rewrite is settled and needs no new machinery:

```ts
setLeadEnvironment();
await ensureRadarDaemon();
const parent = await radarDaemon.adoptRetainedChild({
  label: "cascade-parent", runId: parentRun, ownerSessionId: LEAD_SESSION_ID,
  workspaceId: WORKSPACE, mailbox: parentMailbox, pane: "parent-pane",
});
const child = await radarDaemon.adoptRetainedChild({
  label: "cascade-child", runId: childRun,
  ownerSessionId: parentState.piSessionId, workspaceId: WORKSPACE,
  mailbox: childMailbox, pane: "child-pane",
});
entries.push(parentEntry, childEntry);   // pi-herdsman-radar-spawn
await startRadarSession(pi, fakeContext(entries));
// assert the behaviour, not the Herdr shape: radarDaemon.closes order and the
// surviving mailboxes.
```

Both pieces it needs already exist and are already used in this file
(`radarDaemon.adoptRetainedChild` at the "unresolved background work" fixture and
the `pi-herdsman-radar-spawn` entry push beside it), so the rewrite adds no
helper, no fixture option and no settle wrapper.

Order for the next pass, unchanged: rewrite the cascade group first (parent close
child-first, nested cascades, lost-parent ancestry, completed lost parent
cleanup, cascade revalidation), then the delivered-result group, then remove the
five installs, then the (F) fixtures, then the (S), then `commands`.

## Checkpoint: incomplete (owner-stopped, 2026-02-26)

Implementation was stopped at the owner's request while suite validation was
still red. No acceptance claim is made for this slice. All edits are preserved
uncommitted in the shared pi-extensions working copy; nothing was committed,
pushed or run live.

### Latest counts (all measured this slice)

| Suite | Recorded before this slice | Latest measured |
| --- | --- | --- |
| `recovery.test.ts` | 107/107 | 110 tests, 40 pass, **70 fail** |
| `controller-lifecycle.test.ts` | 84/84 | 85 tests, 73 pass, 10 fail, 2 cancelled |
| `commands.test.ts` | 85/86 (Manager case excluded) | 86 tests, 34 pass, 50 fail, **exit 124 (1800 s timeout)** |
| `extension-contract.test.ts` | 52/52 | 48 tests, 30 pass, 14 fail, 4 cancelled |
| `agent-runtime.test.ts` | 5 pre-existing failures | 91 tests, 83 pass, 8 fail |
| `control-integration.test.ts` | not recorded | 10 tests, 2 pass, 8 fail |
| `radar-location.test.ts` | 11/11 | 16/16 |
| `radar-client` / `radar-launch` / `radar-publication` / `radar-execution` / `mailbox` | 28/23/22/13/39 | 31/23/22/13/39, all green |

The whole-package gate was not run after these edits; the last recorded gate
(1205 tests, 1162 pass, 42 fail, 1 skipped) predates them and must not be quoted
as current.

**These failures are newly introduced, not pre-existing.** `recovery.test.ts`
passed 107/107 and `controller-lifecycle.test.ts` 84/84 at the end of the last
accepted slice, and both are red now with uncommitted edits as the only
difference. `extension-contract`'s count also fell because 12 tests were deleted
deliberately; the rest of the drop is failure.

### Proven cause (fixed)

Every suite's mass failure was one dangling reference left by the publisher
excision: the lead `session_shutdown` handler still called `clearAwaitedFacts()`
and `clearOwnerMetadata()` and awaited a `metadataClear` promise built from them.
The throw was asynchronous, so it surfaced as
`ReferenceError: clearAwaitedFacts is not defined` "after the test ended" and
took `controller-lifecycle` from 58 to 73 passing once removed. Nothing else of
that shape remains (`git diff --check` clean, module parses, no leftover
identifiers).

### Hypothesis (unproven, not investigated further)

The ~70 `recovery` failures look like one systematic cause, not 70 migrations:
rows that should project `live` project recovery-only. Example assertion:
`available_tools` is `[agent_close]` where the test expects
`[agent_inspect, agent_reply, agent_close]`, i.e. presence resolves to `unknown`
for a child the test believes is live. The fixture fleet model
(`observeFixtureFleet` / `radarObservedFleet`) was added to feed the daemon's
canonical observation from the fixture's own rows, and it did not move the
number, so the mismatch is somewhere between the mailbox state a test writes and
the row the daemon reports (identity, run, workspace, session or tab
derivation). `control-integration` (8/8 failing) and the `commands` timeout are
almost certainly the same cause plus tests that count the removed Herdr snapshot
reads (`commands.test.ts:7167` waits for a status refresh that no longer
increments its `snapshots` counter).

### Minimal reproducer

```
cd pi-herdsman
node --experimental-test-module-mocks --import=./scripts/test-env.mjs   --test --test-concurrency=1 --test-timeout=60000 extension/recovery.test.ts
```
Single test: `controller reply submits the normal request and preserves the
assignment` (`extension/recovery.test.ts:1463`) — expects
`[agent_inspect, agent_reply, agent_close]`, gets `[agent_close]`.

### Unresolved ownership and scope questions

1. Whether the remaining red suites are this slice's to migrate at all, or
   whether the presence-routing change should be narrowed so the ~150
   presence-coupled tests keep their existing model.
2. The `commands` suite now times out at 1800 s (exit 124). A hanging suite is
   not a failure count; it needs its own diagnosis before any re-run.
3. The `recovery` test count moved 107 -> 110 between two runs of this slice
   with no test added by me in between; unexplained.

## Decisions to record

1. Location validation requires the daemon's own canonical observation to report
   this process's exact pane, and takes containment from that pane row. The
   environment names *which* pane this process is in; it never substitutes for
   the observation. A pane reported twice, a tab row that contradicts the pane's
   workspace, or an environment containment that disagrees are all ambiguous and
   publish nothing.
2. The backend and its server come from `daemon.ping`; a tmux process whose own
   `TMUX` client names no server, or another server, publishes nothing. The
   daemon's own `spawn.create` remains the authority on whether the parent's
   registered pane is usable.
3. A location that is *pending* - the daemon is not answering, its topology is
   unreadable, or it does not report the pane yet - writes no registration record
   at all. A registration is immutable, so freezing a gap in the evidence would
   disable fresh spawning for the life of the process; the next attempt asks
   again. A location that is *absent* - this process has no pane of its own by
   fact - registers without one, on purpose.
4. A launch waits for the startup registration (`radarPublicationReady`) rather
   than refusing while the daemon is answering. The registration is still
   immutable once written; only the ordering of "resolve, then register" changed.
5. A failed mux read is `unknown` presence, never `lost`: an unreadable
   inventory must not let a close act on a child it never saw leave.
6. `already_exited` is admitted by the same predicate as `completed`
   (`confirmedRadarClose`) for local cleanup only. It never becomes a
   process-exit verdict and never authorizes a relaunch.
7. A mailbox that is not Radar-managed refuses a physical close outright
   (`invalid_request`), and the delivered-result cleanup records
   `pi_herdsman_legacy_close_refused` instead of reaching a mux. This build has no
   record of the pane it would be closing, and guessing one is what the review
   rejected.
8. Terminal display metadata is not an assignment fact. The pane-metadata,
   awaited-facts, owner and lead publishers and the native-reporter notice are
   removed; the mailbox and the registry carry what they used to mirror.
9. Closing the pane a loss record's own launch names is correct, and the lead is
   not the guard for a replacement. `spawn.close` re-proves the occupant's birth
   identity against the edge the launch bound and refuses a mismatch, so the
   daemon owns the replacement guard; the lead asserts only its own half (the
   pane its launch record names, and the replacement's durable state left
   intact). A stronger "never cleans up a replacement" guarantee belongs in the
   daemon's close validation, not in the lead's retry.
10. An *absent* pane and a *contradicting* pane are different facts, and the
   difference is deliberate: an absent pane leaves the child `unknown`, and a
   mailbox this build did not launch through Radar then refuses a physical close
   with `invalid_request` (decision 7); a contradicting pane is ambiguity, so it
   refuses `target_ambiguous`. The cascade tests depend on the second. This is
   the fail-closed rule ADR 0030 states, not an inconsistency.
11. An unprovable identity is ambiguity, not absence: the refusal category is
   `target_ambiguous` when the presence is `unknown` (the record exists and
   something may hold it) and `target_not_found` when it is `lost` (the daemon's
   observation places nothing there). `Managed physical identity cannot be
   proved uniquely` is carried by `target_ambiguous`.
12. `agent_extend`'s non-live liveness guard stays, and it is reachable: a
   Radar-launched child whose launch and acknowledgment prove its generation but
   whose recorded pane the daemon's inventory does not report resolves, and the
   guard is what refuses it. The proof is asserted in
   `recovery.test.ts` (`agent_extend refuses a non-live worker's recovered
   window`).

## Not done here, with the seam

- **Registry-backed fleet status for legacy children**: the ordinary path reads
  the daemon's canonical observation, which reports agent facts only where the
  backend does (Herdr). Under a tmux daemon a legacy child's presence cannot be
  proved at all, so it stays `unknown` and refuses controls. Replacing that
  needs a decision this slice does not make: the registry offers process
  verification and publication freshness, and the contract is explicit that
  neither is a liveness verdict.
- **Retained relaunch** (`restartIdleManagedWorker`) still reads a pane through
  `herdr pane get` and closes a legacy child through `closeManagedAgent`'s
  Radar-or-refuse path. Retained relaunch is excluded from this slice; its own
  slice has to specify physical stop and replacement binding first.
- **Manager paths**: `projectWorkSnapshot`, the lead-start verification and the
  worktree/lead dashboard still read the Herdr inventory and topology directly,
  and `validateIntegration` still asks Herdr for a legacy runtime's agent record
  on the continue path (guarded by `runtime.radarAgentId === undefined`). These
  are the remaining direct Herdr calls, listed by reachability below.

## Verification (focused suites, sequential, `--test-concurrency=1`)

| Suite | Result |
|---|---|
| `controller-lifecycle.test.ts` | 84/84 |
| `commands.test.ts` | 85/86 (the Manager worktree Lead case, outside this slice) |
| `recovery.test.ts` | 107/107 |
| `extension-contract.test.ts` | 52/52 |
| `mailbox.test.ts` | 39/39 |
| `radar-client.test.ts` | 28/28 |
| `radar-launch.test.ts` | 23/23 |
| `radar-publication.test.ts` | 22/22 |
| `radar-execution.test.ts` | 13/13 |
| `radar-location.test.ts` | 11/11 (new) |

Red evidence, each verified by reverting the production half and watching the
test fail:

- `already_exited` admitted by `confirmedRadarClose`: without it, the retry after
  a failed local cleanup refuses `target_ambiguous`.
- Unreadable inventory reported `unavailable`: without it, the close proceeds on
  a child it never saw leave.

## Remaining direct Herdr calls, by reachability

Every remaining `runHerdr`/`herdrSessionSnapshot` call, and what it is for:

- **Manager / worktree / dashboard only** (not reachable from an ordinary
  worker's or a plain lead's delegation, launch, readiness, first task, result or
  close): `projectWorkSnapshot` (`herdr status`, `workspace get`, worktree
  topology), the Manager lead-start verification and its `assertUnoccupied`
  inventory read, the supervised-lead focus fallbacks, and
  `restartIdleManagedWorker`'s `herdr pane get`. These are the paths the plan
  already isolates for Manager removal.
- **`validateIntegration`** (`herdr agent get`): reached only for a runtime with
  no `radarAgentId`, i.e. a child this build did not launch through Radar. The
  Radar path uses `validateRadarChild` instead, and a legacy child's *close* now
  refuses before this point.
- **`watchHerdrLifecycle` / `captureStartupDiagnostic` / `herdrAgentAlias`
  helpers** remain in `herdr.ts`; the ordinary path no longer imports the close
  transport, and `closeHerdrPane` has no caller outside the Manager paths.

No ordinary worker supervision, registration, launch, readiness, first
task/result, close or display path calls Herdr after this change. What is left is
listed above rather than hidden behind an environment gate.

## Full package gate

Before this slice (last recorded gate): 1189 tests, 1146 pass, 42 fail, 1
skipped. After (bg-1423, exit 1 from those failures): 1205 tests, 1162 pass, 42
fail, 1 skipped - the same 42 pre-existing failures (27 Manager/worktree, 7
retained-worker relaunch, 2 other controller-api, 5 agent-runtime, 1
control-integration) and all 16 new tests passing. No newly failing name.

Two failures seen in an intermediate gate run were chased to ground and are not
this slice's:

- `fresh assignment refreshes the widget after validation` failed only in the
  gate: my new assertion forbade *any* mux inventory read in the window, but the
  session's own status refresh legitimately reads one. The assertion now forbids
  a call that names the child, which is the claim that matters.
- `a provider error cannot reach the answer that follows it` is flaky, not
  order-dependent: it asserts `doesNotMatch(JSON.stringify(result), /429/)`, and
  the run's random workspace UUID contained the substring `429`. It passes in
  isolation. Follow-up: match the provider message in the result's own fields.

## Checkpoint: recovery rewrites measured (2026-10-13 03:30)

This is the checkpoint for everything after it. Measured with
`timeout 300 node --experimental-test-module-mocks --import=./scripts/test-env.mjs
--test --test-concurrency=1 --test-timeout=60000 extension/recovery.test.ts`.

| State | Tests | Pass | Fail |
| --- | --- | --- | --- |
| Inherited | 108 | 77 | 31 |
| Now | **105** | **93** | **12** |

Net: +16 passing, -19 failing, -3 tests (the (S) deletion and two cases whose
subject was removed Herdr sequencing).

Failing now, in file order:

1. `conflicting same-request entries do not suppress an exact combined result`
2. `recovery requires the official session and retries one failed delivery`
3. `recovery redelivers an unpersisted child result and then cleans it safely`
4. `settlement redelivers an unpersisted child result in the same session`
5. `recovered no-live result removal retry never cleans up a replacement`
6. `lead recovery integration validation aborts with session shutdown`
7. `delegation parent notifies only its direct stale child`
8. `stale working parents remain visible while waiting parents project blocked`
9. `delivered owner asks repeat without duplicating first delivery`
10. `old unacknowledged requests get attention without being resubmitted`
11. `agent_extend refuses a non-live worker's recovered window`
12. `a resolved assignment is never included in a later digest`

Line deltas against the inherited working copy. `support.ts` is exact (a
pre-edit copy was kept): **270 lines removed, 16 added, 3563 -> 3309, net
-254**. `recovery.test.ts` is 8266 -> 8036 lines, but that baseline is the last
pre-session jj snapshot (01:12:29), which still contains two tests the previous
worker deleted and none of their post-snapshot additions, so -230 is an upper
bound on shrinkage and mixes in their unsnapshotted edits. `support-radar.ts`
was not touched by this pass (its 4/3 in `jj diff` is the peer worker's).

`controller-api.test.ts`'s Manager failures are not this pass's: one of them
(`Manager activates only after mocked Lead-state publication`) fails identically
when `support.ts` is swapped back to the inherited copy.

### What changed to get here

- The five per-helper fleet installs (`leadExec`, `startupExecutor`,
  `cascadeExecutor`, `agentControllerExecutor`, `observeFixtureFleet`) are gone,
  with `observeFixtureFleet` and its row builder.
- `cascadeExecutor`'s dead snapshot branches (two `agent list`, two `pane list`,
  one `api snapshot`, one `tab list`) and the four options that only fed them
  (`paneOnly`, `omitAgentLabels`, `omitPaneLabels`, `mismatchSessionLabel`) are
  deleted, and the seven call sites that still passed those options are cleaned.
  No ordinary path reads a Herdr snapshot any more, so nothing consumed them.
- `clearTestMailboxes` now empties the whole store rather than only `WORKSPACE`.
  A state an earlier test left in another workspace presented itself as a live
  child of the next one once the installs stopped masking it; this was the
  single cause of six soft-window failures.
- One test-local helper, `observeFleet`, replaces the removed fixture options on
  the cases whose subject is "the daemon does not report this pane". It
  consolidated from two helpers after the owner's correction. Net against the
  machinery it replaces is negative (see the deltas above).
- Rewrites to Radar-launched pairs: parent/child close ordering, cascade
  refusal, retained-child adoption, alias loss, foreign occupant, location
  evidence, observe-count hooks, and the stale/unresolved digest cases.
- Run-id collisions fixed where a fixture wrote several children under one run
  id (`list derives inactivity`, `delegation parent notifies only its direct
  stale child`): a shared `runId` makes every worker a candidate claimant of
  every other one's pane, so presence cannot be proved for any of them.

### `(F)` fixture evidence still to correct

Six tests still pass, but no longer for the reason they state. Each passed
`mismatchSessionLabel` to make the daemon report a contradicting session; the
option is gone, so the default fleet now proves those children live and the
refusal they assert comes from somewhere else. They need the same
`observeFleet([{ state, sessionId: other }])` treatment the `agent_extend` case
got, and should be re-checked for a vacuous claim: `recovery.test.ts` lines
2949 (occupant), 5793, 5856, 5920, 6070, 6174.

### Group log (this pass)

| Group | Result |
| --- | --- |
| (1) six vacuous `(F)` sites | Converted to explicit observations. All six green, each for the reason it names. `recovery.test.ts` 93/12 before and after; the six were already passing, now honestly. |
| (2) delivered-result cleanup family | Five of six converted to Radar-launched children (`adoptRetainedChild` + spawn entry) and green: `recovery redelivers an unpersisted child result…`, `conflicting same-request entries…`, `settlement redelivers…`, `recovered no-live result removal retry…`, `recovery retries one failed delivery`. `recovery.test.ts` **105 tests, 98 pass, 7 fail**. |
| (3) the remaining seven | Six fixed, one attributed. `recovery.test.ts` **104 tests, 103 pass, 1 fail** (one test deleted, see below). |

Group (3) detail, each by its first failed predicate:

| Test | Cause, and the fix |
| --- | --- |
| `stale working parents remain visible while waiting parents project blocked` | Run-id collision again: parent and child shared `AGENT_ID`, so neither was uniquely provable and no stale advisory could build on them. Per-child `runId`, the `agentControllerExecutor`/`agent_status` wiring replaced by two explicit observations (`working`, then `idle`). Green. |
| `delegation parent notifies only its direct stale child` | The reminder never arrived because a single `setImmediate` cannot cover a daemon round trip, not because of the daemon. Three waits became `settleUntil`. Green. |
| `old unacknowledged requests get attention without being resubmitted` | `radarDaemon.observeInventory` was installed *after* `startRadarSession`, so the first scan could read the default fleet; the wait was one `setImmediate`. Hook installed before the session start, wait settled on the message. Green. |
| `a resolved assignment is never included in a later digest` | Two states were still legacy: the explicit-close state refused `invalid_request` (decision 7), and the proven-lost state relied on an inline empty Herst snapshot. First became a Radar child, second became `observeFleet([])` with timestamps past the startup window. Green. |
| `agent_extend refuses a non-live worker's recovered window` | Real behaviour change, asserted as it is: identity resolution refuses an unprovable target with `target_not_found` *before* the tool's own `agent_busy` liveness guard, so that guard is unreachable from an unprovable generation. Green; guard reachability left as a question for the owner. |
| `lead recovery integration validation aborts with session shutdown` | **Deleted.** Its subject was the Herdr integration validation (an `agent get` exec held open until aborted); that step is gone, and no fixture knob can hold a daemon reply open, so the abort claim is no longer observable. The claim (shutdown aborts in-flight recovery work) is real but needs a per-scan/per-request signal from the fixture; `extension-contract.test.ts`'s "session shutdown prevents pending peer presence publication" is a different claim, not a replacement. |
| `delivered owner asks repeat without duplicating first delivery` | **Still failing, attributed.** The registering scan reads the clock after its daemon round trip, so `now += 5min` can land before that read; the episode is then registered at the advanced clock and the tick's scan is not yet due. A scan issues several fleet reads (so a read count cannot identify scans) and its completion is observable nowhere, so this needs a fixture signal. Recorded in the test as a `FIXME` naming what retires it. |

### The 12 that failed at the measured checkpoint, attributed

Group (1) detail. Each site now reports the topology its name claims through
`observeFleet`, and each got per-child `runId`s so a shared run cannot make
presence ambiguous for the wrong reason:

| Test | Reported |
| --- | --- |
| `a mailbox representation anywhere suppresses the saved session` | occupant under a contradicting session (unknown) |
| `unknown descendants refuse a lost-parent cascade` | parent absent and past the startup window (lost), child contradicting (unknown) |
| `mixed live and unknown descendants preflight before closing` | one child live, the other contradicting |
| `mixed lost and unknown descendants preflight before removing mailboxes` | one child absent and past the window (lost), the other contradicting |
| `nested unknown descendants refuse the cascade before any mutation` | child and grandchild both contradicting |
| `cascade preflights the parent before closing descendants` | parent contradicting (`target_ambiguous`), child live |

Mutation evidence, representative: reporting the occupant of
`a mailbox representation anywhere suppresses the saved session` under its own
session turns it red (`'settling'` where `'unknown'` is asserted), so the
observation carries the claim rather than the old run-id collision.

One finding from this group: an *absent* pane and a *contradicting* pane are not
interchangeable for the close refusal. Absent gives `unknown`, and a legacy
mailbox then refuses `invalid_request` (decision 7); contradicting gives the
`target_ambiguous` these cascade tests assert. `cascade preflights the parent
before closing descendants` proved this: written with an absent parent it failed
`invalid_request` vs `target_ambiguous`, and passed once the parent was reported
under a contradicting session.

Group (2) detail. All six were the same seam: the child is now proved live, so
the legacy-live branch refuses cleanup. Five are real today for a Radar-launched
child, so each became one; the sixth's first half was legacy.

| Test | Choice |
| --- | --- |
| `recovery redelivers an unpersisted child result and then cleans it safely` | Radar child; green |
| `conflicting same-request entries do not suppress an exact combined result` | Radar child; green |
| `settlement redelivers an unpersisted child result in the same session` | Radar child; green; the close assertion now reads the daemon's recorded pane |
| `recovered no-live result removal retry never cleans up a replacement` | Radar child, **renamed** to `…leaves a replacement's durable state alone`; green |
| `recovery requires the official session and retries one failed delivery` | **renamed** to `recovery retries one failed delivery`; its first half (a second session source that Herdr used to provide) is deleted as legacy, the retry half is a Radar child; green |

Two behaviour boundaries found here, for the owner:

1. The retry for a lost generation removes that generation's result *and* its
   mailbox, and closes the pane its own launch record names. The old claim
   "never cleans up a replacement" is no longer the lead's to make: whether the
   recorded pane is now held by another generation is the daemon's call, which
   holds the spawn record and the pane evidence. The test now asserts the
   lead-owned half (the recorded pane, the replacement's durable state intact).
   If the stronger guarantee is wanted, it belongs in the daemon's close
   validation.
2. A live Radar child's durable result is *retained* until the assignment
   settles; recovery alone does not clean it up. `recovery retries one failed
   delivery` asserts retention for that reason, and the cleanup stays with the
   redelivery tests that settle.

### The 7 that remained at the group (2) checkpoint, attributed

All seven are resolved above except the last row of group (3).

| Case | Cause |
| --- | --- |
| `recovery redelivers an unpersisted child result and then cleans it safely` | New. Needs the "daemon reports no pane" shape; the child is proved live now, so the delivered-result cleanup takes the legacy-live branch and refuses. |
| `conflicting same-request entries do not suppress an exact combined result` | Same family: `waitFor` reports "exact persisted result did not clean up". |
| `settlement redelivers an unpersisted child result in the same session` | Same family. |
| `recovered no-live result removal retry never cleans up a replacement` | Same family, replacement identity; needs an observation override. |
| `recovery requires the official session and retries one failed delivery` | Undiagnosed. The mismatched-session fixture still sends; the old session lever (`leadExec`'s third argument) no longer reaches the code, and an explicit session override did not restore the refusal. |
| `lead recovery integration validation aborts with session shutdown` | Undiagnosed. `assert.ok(integrationSignal)`; the signal came from a Herdr integration read. |
| `delegation parent notifies only its direct stale child` | Partly fixed: the run-id collision that made the advisory an `attention` instead of `stale` is gone. The 5-minute reminder still never arrives. |
| `stale working parents remain visible while waiting parents project blocked` | Undiagnosed; one state, so not a run-id collision. The stale working parent does not notify. |
| `delivered owner asks repeat without duplicating first delivery` | Two states; the second delivery is not observed. |
| `old unacknowledged requests get attention without being resubmitted` | `details.reason` is `undefined` where the test wants `handoff`. |
| `agent_extend refuses a non-live worker's recovered window` | The generation is now `unknown` (as the test wants), but `agent_extend` refuses earlier with `target_not_found`, so the `agent_busy` guard the test asserts is no longer reachable from an unprovable generation. Worth checking whether that guard has any reachable caller. |
| `a resolved assignment is never included in a later digest` | Four states; digest membership. |

Not started: the five `commands.test.ts` fleet-install users and its hang, and
the `(F)`/`(S)` sweeps outside `recovery.test.ts`.

## Update: commands suite (the hang and the fleet-install users), and the last recovery test

Scope of this pass: `commands.test.ts`, the last failing `recovery.test.ts` test,
and the two owner rulings that needed production edits.

### The hang, named and fixed

`commands.test.ts` never exited: after the last test the runner printed no
summary and the process hung. `process._getActiveHandles()` during the hang
showed a listening `Server` on
`<tmp>/pi-herdsman-test-*/radar-control-plane-*/socket/control.sock` with
`_connections: 0` - `fakeRadarControlPlane`'s daemon, which `serveFakeRadar`
hands back to the caller for cleanup. `focusLeadFromOverview` asserts `/1 herd/`
*inside* the helper, so a failing test throws before the daemon is returned and
its `close()` never runs; the server was neither closed nor unref'd, so it held
the event loop open. Fix: `server.unref()` in that helper - "a test daemon must
never be the reason a suite cannot exit", the rule `support-radar` already
follows. The suite now completes and prints its summary. The old 1800 s timeout
was this plus `active Manager supervision refreshes serialize and coalesce
concurrent requests`, which burns its own 45 s test timeout.

### Fleet-install users, migrated onto Radar-launched children

`closedPanes()` (one test-local helper reading `radarDaemon.closes`, leaving out
refused closes) replaces `lifecycle.closeOrder`, and every worker under test is a
real launch (`radarDaemon.adoptRetainedChild` plus a `pi-herdsman-radar-spawn`
entry) with its own session, so no two share a durable identity:

| Test | Change |
| --- | --- |
| `clear idle closes exactly the directly owned idle workers` | five adopted children (idle/working/waiting/foreign) |
| `lead agents stop closes a direct subtree agents-first` | parent and child adopted; `childSession` gives the parent's session to the child it delegated |
| `lead agents stop reports cleanup failures...` | two adopted children, `refuseChildClose` for the whole stop |
| `lead agents stop continues independent leads after a partial cascade failure` | one adopted child and one mailbox-only worker (decision 7 refuses its close); the refusal is armed once the first close lands |
| `lead agents stop scopes its summary to the current lead subtree` | one adopted child and one owned by another session |

Deleted (S): `lead agents stop refuses an agent whose identity changes after
inventory`. A Radar child's close is proven by its launch binding and the
daemon's own re-proof, so an inventory-derived session contradiction cannot
refuse it; the Herdr-inventory identity re-validation is gone. Canonical coverage
for the refusal: `controller-lifecycle.test.ts` "cascade close revalidates the
parent generation under its assignment lock" (`target_ambiguous`, `/changed
before close/`).

### Fixture truth (F) fixes in `commands.test.ts`

- `serveFakeRadar` answered `mux.observe` with `{agents}` alone, which the
  canonical decoder refuses outright ("no canonical fleet inventory"), so every
  user of it failed. It now answers `observedFleet(...)`: workspaces, tabs and
  panes beside the agent rows.
- `observedAgent` now carries the lifecycle `status` a real observation reports.
  Without it `radarLifecycleState` is `unknown`, which is why a *proved* child
  rendered as `? unknown` in the Running menu and the focus tests.
- `Running excludes lost and unknown durable generations` states its topology
  through the daemon (`observeInventory`): an unreported pane past the startup
  window is `lost`, a reported pane with no agent row on it is `unknown`.
- The chief-overview harness waits for the first supervision snapshot to land
  before it returns, and the focus tests fire a turn-start refresh
  (`before_agent_start`), which is when a chief loads the herd. Their "exactly
  one `mux.observe`" became "an observe precedes the focus", which is the claim
  they were making.
- `METADATA_TTL_MS` / `OWNER_METADATA_TTL_MS` were dangling references to the
  removed pane-metadata timers; the filter using them is gone.
- `TUI status widget is registered as a Pi component factory` lost its
  exec-signal half: the lifecycle watch is a socket now, so there is no exec
  signal to abort.
- `TUI status refresh consumes the coherent Herdr session snapshot` -> renamed
  `...consumes the daemon's fleet observation`, asserts the daemon's fleet read,
  and its ~100-line Herdr exec fixture is deleted.
- `ensureRadarDaemon()` in the two Running tests that read the shared daemon
  without starting a session: a `serveFakeRadar` test before them had `delete`d
  `RADAR_CONTROL_SOCKET`, so they dialled a path that no longer existed.

### Owner rulings applied (production)

1. **Category and message agree (ruling 4).** `requireLivePresence` refused an
   unprovable identity with `target_not_found` carrying "Managed physical
   identity cannot be proved uniquely". It now fails `target_ambiguous` for
   `unknown` and keeps `target_not_found` for `lost`; the recovery extend test
   asserts the new pairing and the message.
2. **`agent_extend`'s liveness guard is reachable (ruling 3), so it stays.** The
   proof is in the same test: a Radar-launched child whose launch and
   acknowledgment prove the generation but whose recorded pane the daemon's
   inventory does not report (`radarDaemon.options.locationEvidence = "absent"`)
   resolves, and the tool's own guard is what refuses it (`agent_busy`).

### `recovery.test.ts`: no FIXME, no failure

`delivered owner asks repeat without duplicating first delivery` now advances the
mocked clock in steps: each step advances a full reminder interval and ticks the
scanner, and the registering scan may read the clock on either side of the first
advance, so the reminder is due within two steps either way. No fixture signal
was added.

### Counts

| Suite | Inherited | Now |
| --- | --- | --- |
| `recovery.test.ts` | 104 tests, 103 pass, 1 fail | **104 / 104 / 0** |
| `commands.test.ts` | 86 tests, 34 pass, 50 fail, exit 124 | **84 / 80 / 3, 1 cancelled** |

The commands file now runs to a printed summary in about 55 s; its four named
failures are attributed below (one of them is the cancelled test).

### Remaining `commands.test.ts` failures, attributed

Herdr read gate (2) - the fixture gates a Herdr `api snapshot` the cutover
removed, and the status refresh reads the daemon's fleet now. Migrating them
needs a way to hold one `mux.observe` reply in `support-radar`, which is fixture
machinery this pass is not allowed to add:

- `zero-runtime reconciliation requests one status refresh`
- `lead status refreshes keep one in-flight refresh and one trailing rerun`

Manager paths (2) - the Manager and lead-start paths still read Herdr directly
(the plan's "remaining direct Herdr calls"), and both of these gate a Herdr
`api snapshot` as well:

- `Manager delegate persists an exact worktree Lead assignment`
- `active Manager supervision refreshes serialize and coalesce concurrent requests`
  (its own 45 s test timeout, which is what the old 1800 s exit 124 was made of)

Order-dependent (1): `fresh assignment refreshes the widget after validation`
passes alone and in small batches and fails in the full file, where the stalled
Radar child projects `unknown` instead of `starting`. A presence projection that
depends on file order, not a claim this pass changed.

### Line deltas (this pass, against the 04:02 jj snapshot)

| File | Lines | Delta |
| --- | --- | --- |
| `commands.test.ts` | 7262 -> 7298 | +36 |
| `recovery.test.ts` | 8008 -> 8051 | +43 |
| `support.ts` | 3309 -> 3309 | 0 |
| `support-radar.ts` | 1100 -> 1100 | 0 |

This pass is +79, not negative: what it added is the Radar-side fixture the
migrations need (launch records, a canonical fleet, the daemon's own close
observations, per-child sessions) plus ruling 3's reachability proof, and it
removed less Herdr-era fixture than it added. Cumulatively the cutover is still
much smaller than it was: `support.ts` 3563 -> 3309 (-254), `recovery.test.ts`
8486 -> 8051 (-435); `commands.test.ts` is 7131 -> 7298 (+167) counting the
previous worker's migration of that suite as well. `git diff --check` clean, no
probe markers left in `extension/`.
