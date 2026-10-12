# Relaunch slice: exit observation and saved-session relaunch

Pinned contract: agent-radar `f87348032a808967c50a4e84b7e1c766a64ebfe3`, read with
`git show` (`docs/control-plane.md`, `docs/agent-registration.md`,
`docs/agent-registration.fixture.jsonl`, and `src/control_plane/registry/process.rs`
for the verdict spelling). The canonical checkout has uncommitted files and is not the pin.

## 1. Trace (before any edit)

There are two relaunch entry points. They differ in Herdr dependence.

### (a) Continuation relaunch: `continue` on a saved session

- Decision: `resolveIdleWorker` (index.ts:3983). It returns `relaunch` when the recorded launch fingerprint is missing or differs (definition or child-command drift), and `reuse` when it matches. `recover` is the lost-presence branch; a Radar child never reports `lost` (its presence is `radar` or `unknown`), so `recover` is reached only by mux-era children.
- Continuation block: index.ts:8319–8480. On `relaunch` it calls `closeManagedAgent` (6300), then the fresh launch below it.
- Close: `closeManagedAgent` takes the Radar branch only through `radarObservationFor` (4212) and `radarChildObservations`. A child with no `live` observation is refused with `target_ambiguous` before any close.
- Live observation: `observeRadarChild` (radar-launch.ts:159) reads `spawn.get` once and returns `live` only when the edge is bound to the same `agent_id`, records this launch's pane, has no observed exit, and its freshness says the daemon's inventory currently reports that pane. An observed exit, a missing pane, a foreign binding, or a stale read is `unknown`.
- Pane close: `closeRadarChild` (6418) → `closeRadarChildPane` (6179) sends `spawn.close` with a stored request id. Outcomes: `completed` (pane closed) and `already_exited` (retained pane cleaned up) are both stored as confirmed; `refused` and `unknown` are stored and refused.
- Mailbox retirement: after the close, `closeRadarChild` runs `retireRadarSubject` and `removeAgentMailbox`. Only then does the caller launch the fresh generation (launchRadarWorker, index.ts:8778).
- Replay: `pendingRadarClose` (6127) replays a stored `dispatched` or `unknown` close with the same request id. `confirmedRadarClose` (6150) short-circuits a confirmed close without a new request.

**Herdr calls on this path: none.** The continuation relaunch already closes and launches through Radar.

**Absence proof: none.** Relaunch currently rests on the close outcome alone. A `completed` close is backend pane closure, not proof that the registered process is gone.

### (b) Control `restart`: same-pane relaunch

- Entry: `executeControlRequest` (7157) → `restartIdleManagedWorker` (6940).
- Herdr calls:
  - `runHerdr(["pane", "get", paneId])` at index.ts:7018 (pane identity and tab).
  - `stopHerdrAgentPreservingPane` at index.ts:7077 (stop the process, keep the pane).
  - `startHerdrAgentInPane` at index.ts:7090 (start the saved session in the same pane).
- Radar calls: none.
- Decision: the function refuses a `lost` presence, a non-idle listing, an unrecorded session, a missing or disabled definition, an unretrieved result, and a non-idle-retained decision. It relies on the same Herdr pane identity throughout.
- Tests that exercise it: control-integration.test.ts:324 (refusal only, no physical stop) and recovery.test.ts:3177 (the physical same-pane restart, Herdr-fixtured).

### Exit observation

- Source: `spawn.get.exit_observation`, decoded by `exitAt` (radar-client.ts) into `{state: "unknown"}` or `{state: "exited", code?, signal?, observed_at?}`.
- Consumers: `observeRadarChild` refuses on `exited`; `closeRadarChildPane` records the edge's exit on `already_exited`; `radar-launch.ts` refuses a launch whose edge reports `exited`.
- Contract: under the tmux backend, `exit_observation` is the backend's retained pane-command status, sampled by the daemon. It is never process-group exit, and under Herdr it is always `unknown`. A pane that disappears is `unresolved`, never `exited`.

### Process identity verdict

- `agent.get` is not decoded anywhere in the client. There is no current consumer of a process verdict.
- Wire (pinned fixture line 22 and `process.rs`): `agent.process` is `{claimed: bool, verification: "verified"|"absent"|"mismatched"|"unavailable"}`. An unclaimed registration reports `unavailable`, which the contract defines as no evidence of absence.

## 2. Gaps against the owner's design

- G1. No absence proof before a relaunch. Add `agent.get`, read the bound `agent_id`, and require `absent` or `mismatched`.
- G2. A retry after a completed close is stuck. The live-observation gate in `closeManagedAgent` runs before the close is reconciled, so a relaunch refused after a completed close could never be retried. Fix: when a completed close is stored for this run, skip the observation gate and reconcile.
- G3. `restart` (b) depends on Herdr end to end. See decision D4.
- G4. A dead pane is refused only as a generic "cannot be proved" message. It should name the retained residue.
- G5. The fake daemon answers a dropped close reply with `internal`, not the contract's `outcome_unknown`. The client maps `outcome_unknown` to `unknown`, so behaviour is correct, but the fixture misstates the wire.

## 3. Verdict and outcome table (what each answer decides)

| Input | Decision | Why |
|---|---|---|
| `agent.get` `verified` | Refuse. Mailbox, pane and edge kept | The registered process is still there |
| `agent.get` `absent` | Permit relaunch, after a completed close | Positive absence of the birth tuple |
| `agent.get` `mismatched` | Permit relaunch, after a completed close | The PID exists with another birth identity, so the registered process is gone |
| `agent.get` `unavailable` (timeout, permission, no claim, no procfs) | Refuse and keep unresolved. No retry, no fallback path | Not evidence of absence. The mailbox is kept, so a later attempt can still prove absence |
| `agent.get` `not_found` | Refuse | Ambiguous: it is a gone process or a registration or registry the daemon no longer has, and a daemon that lost its registry would report it for a live process. The contract's "treat as absent" (`control-plane.md` line 177) is for record reads, not process proof (D3) |
| Exit `exited` on the edge | Refuse (already, by `observeRadarChild`) | The edge recorded that the pane command exited |
| Exit `unknown` | Not an absence and not a veto. With a live pane the close and proof run; with the pane gone the process verdict decides alone | An unknown is not an absence, and the weakest presence fact must not veto the strongest proof |
| Pane missing or unreported | Not a permission and not a veto: the process verdict decides. `absent` or `mismatched` relaunches; `verified`, `unavailable` and `not_found` refuse | Missing-pane freshness is not process-exit evidence (`agent-registration.md`, "missing-pane freshness"), so presence can neither prove the process nor refute an absence proof (D1) |
| Close `completed` | Proof, then relaunch | Backend-confirmed closure |
| Close `already_exited` | Not permission and not a veto: the process verdict decides, as for a missing pane. Its stored record is retirement evidence only | The close reports the edge's recorded exit, which the contract says is never proof of process exit (D2) |
| Close `refused` (including the daemon's fence refusal for a dead or unfenced pane) | Still refuses, and the refusal is kept. Residue named. Nothing retired. Open for the owner: the ruling that a close outcome is authoritative in neither direction was stated for `already_exited`, so `refused` is held as a refusal until the owner says otherwise | A positive refusal before any effect. The pane stays as residue, and no close is forced (D5) |
| Close `unknown` / `outcome_unknown` | Refuse. The same request id is replayed later, never a new id | Dispatch may have happened; retrying with a new id could close a different pane |

## 4. Replacement, and why it fits the trace

1. `agent.get` decoder in `radar-client.ts`, reading `agent.process.verification` into the four-verdict type. Rejected alternative: deriving absence from `spawn.get` freshness or a missing pane, which the contract forbids (a missing pane is not an exit, and freshness is not liveness).
2. A relaunch gate in `closeRadarChild`, placed after `closeRadarChildPane` and before `retireRadarSubject`/`removeAgentMailbox`. Placing it there means a refused proof leaves the mailbox, which is the only state a later attempt can use, so an unavailable verdict does not consume the relaunch. Rejected alternative: a check before the close. The process is alive before the close, so only a post-close read can prove absence.
3. A reconciliation path in `closeManagedAgent`. When a completed close is stored for this run, skip the live-observation gate and go to the proof. Rejected alternative: re-deriving the live observation, which cannot succeed after the pane is gone and would strand the retry.
4. Dead-pane policy (G4): unchanged. The refusal is reached through the observation gate; the message names the retained pane.
5. Fake daemon: an `agent.get` reply with a process verdict setting (default `absent` after a close, `verified` before). `dropCloseReply` answers `outcome_unknown`.

## 5. Tests

- radar-client.test.ts: `agent.get` decodes each of the four verdicts; an unknown verdict is a protocol failure; `not_found` passes through.
- controller-api.test.ts: relaunch gate per verdict (absent and mismatched relaunch; verified refuses with the mailbox kept; unavailable refuses with the mailbox kept, and a later absent relaunches, so the refusal consumed nothing).
- controller-api.test.ts: exit `exited` refuses, and exit `unknown` with the pane gone refuses (not an absence).
- controller-api.test.ts: a dead-pane close the daemon refuses leaves pane, edge and mailbox in place and no new spawn is made.
- controller-api.test.ts: a lost close reply replays the same request id (already pinned by controller-lifecycle "a lost close reply reconciles the same request after the pane is gone"; not re-added here).
- Rewritten fixtures: the Herdr-shaped relaunch fixture moves to `radarDaemon.adoptRetainedChild` plus `startRadarSession`, as controller-lifecycle "continuation reuses an idle retained worker" already does.

## 6. Decisions for owner review

Rulings from the owner, applied in the ruling pass (section 12):

- D1. REVERSED. A relaunch is permitted on the process verdict alone, without a reported pane. Presence is the weakest fact and must not veto the strongest. `absent` and `mismatched` are the only permitting verdicts, and an outstanding assignment still refuses (a gone process under a live assignment is a loss, not a silent resume). A refused proof leaves the mailbox, so a later attempt can still relaunch and the mailbox is never stranded.
- D2. REVERSED. A close outcome is authoritative in neither direction. `already_exited` does not permit a relaunch by itself and does not veto a proof of absence. It decides retirement only. (`refused` and `unknown` still refuse; see section 3.)
- D3. CONFIRMED. `agent.get` `not_found` refuses. It is ambiguous between a gone process and a missing registration or registry, and a daemon that lost its registry would report it for a live process. This is what makes D1 safe: the two ambiguous answers, `not_found` and `unavailable`, both refuse.
- D4. RULED: delete the pane-preserving restart and route `restart` through the close-then-relaunch path. Pane preservation is not a behaviour we keep. Done in section 12. `runHerdr(["pane","get"])`, `stopHerdrAgentPreservingPane` and `startHerdrAgentInPane` have no caller in index.ts and stay in place for the Herdr removal slice.
- D5. CONFIRMED. Dead-pane residue stays in place and is reported. No forced close, no ownership reassignment.

## 7. Built, and where it differs from the first design

The first design in section 4 put the proof after the close for every relaunch. Tracing the continuation path in section 1 showed three things that change it:

- `resolveIdleWorker` refuses any Radar child whose presence is not `radar` as `unproved`, before the relaunch gate is reached. A child whose pane is gone therefore never reaches the proof, so a refused proof would strand the mailbox with no way back in.
- A close the daemon already completed leaves the pane gone, so its presence can never be read again.
- A fresh launch is a new generation, so a retry can only reach the gate through the stored close.

The rule as built after the ruling pass (section 12 has the changes):

1. `resolveIdleWorker` sends a bound Radar child to `relaunch`, before its presence check, when its presence is not provable and no assignment is outstanding, or when a close is already stored. The stored close is evidence, not permission. Presence never decides.
2. `closeManagedAgent` takes a `relaunch` flag. A relaunch no longer needs a live observation: a live pane is closed, and a pane the daemon no longer reports has no close sent over it.
3. `closeRadarChild` refuses first when an assignment is outstanding, before any effect. It then closes a live pane (or reconciles a stored close), and runs the absence proof after that and before `retireRadarSubject` and `removeAgentMailbox`. The proof permits only `absent` or `mismatched`. A proof with no close to record writes the launch's `closed` outcome, so the label is released.
4. The proof itself is `relaunchRefusalForChild` in `radar-launch.ts`, typed against `Pick<RadarClient, "agentGet">`. `absent` and `mismatched` pass; `verified`, `unavailable`, an unreadable read and `not_found` refuse.
5. The relaunch reason is `definition_changed` when the recorded fingerprint no longer matches, and `process_lost` otherwise.

## 8. Fake daemon fidelity changes

`support-radar.ts` now models four contract rules it did not before:

- `agent.get` answers the registered process verdict. It is `unavailable` with no claim, `verified` until the pane closes, then `absent`; `processVerdict` overrides it.
- A completed or `already_exited` close stops the bound child's mailbox consumer, as a closed pane's process stops. Before this, the old child kept answering the fresh launch's addressed assignment and refused it as another incarnation.
- `observeUnavailable` makes every recorded location's freshness `stale`, as the daemon reports when the backend inventory cannot be read. Before this, `spawn.get` stayed fresh and an unreadable observation did not refuse.
- A dropped `spawn.close` reply answers `outcome_unknown`, the contract's code, not `internal`.
- `holdNextClose()` holds a `spawn.close` reply and resolves `arrived` when the close lands, so a test can act while the close is unanswered.
- `vanishPane(spawn)` (ruling pass) removes a child's pane with no close record: the edge answers as a missing pane does, and the child's consumer stops, as a pane's process stops.

Contract lines the fake models, checked against the pinned text (`f87348032a80`, not a live daemon):

- `agent.get` verdicts follow "Process identity verification" in `agent-registration.md`: `verified` only on a full boot/PID/start-tick match, `absent` for a known missing process, `mismatched` for a live PID with another identity, `unavailable` with no claim ("No claim is not evidence of absence").
- `spawn.close` `already_exited` carries the exit the edge recorded, and the contract says it is "never relaunch authority" (`control-plane.md`, the close outcome table, and `agent-registration.md`, the close section).
- A dropped `spawn.close` reply answers `outcome_unknown` (`control-plane.md`, the codes table), which the client maps to `unknown`.
- An unknown agent answers `not_found` (`control-plane.md`, the codes table, line 177). The process proof refuses it (D3); the contract's "treat as absent" is for record reads.
- A missing pane is `state: unresolved` on the edge and never process exit (`control-plane.md`, the spawn topology words; `agent-registration.md`, "missing-pane freshness is not process-exit evidence").

## 9. Test population

controller-api, the twelve relaunch and continuation names in the 19-name baseline:

| Baseline name | Now |
|---|---|
| definition drift relaunches a retained worker on the same session | rewritten on Radar fixtures; passes |
| a changed child command relaunches a retained worker on the same session | rewritten; passes |
| clearing the child command relaunches a retained worker | rewritten; passes |
| a missing launch entry relaunches a retained worker instead of reusing it | rewritten; passes |
| the relaunch close holds the session reservation against a concurrent continue | rewritten on `holdNextClose`; passes (was a 60 s timeout) |
| assignment response overrides do not relaunch a healthy retained worker | rewritten; passes. The fixture now records the current child command, which the old one did not |
| validated role-specific brief context reaches worker requests | fixture renamed; passes. Records the current child command as well |
| continuation preserves an unretrieved result instead of overwriting it | rewritten: the refusal happens at the decision step, before any close; passes |
| continuation recovers a worker whose pane is gone | replaced by the refusal test below, because a pane-gone child with no stored close is `unproved` (D1) |
| continuation recovers a worker behind a surviving shell and leaves the shell alone | replaced by the same refusal test (an observed exit) |
| continuation refuses an unprovable identity instead of weakening presence | replaced by the same refusal test (an unreadable observation) |
| session continuation inherits the saved label without an override | rewritten on the Radar spawn argv (a fresh continuation, not a relaunch); passes |
| session continuation keeps explicit definition execution overrides | rewritten on the Radar spawn argv; passes |

New tests with no baseline name: the verdict test (verified and unavailable refuse with the mailbox kept, then mismatched relaunches, which also shows the refusals consumed nothing); the already-exited and refused-close test; and the unplaced-child test (pane absent, observed exit, unreadable observation).

## 10. Measurements

Whole files, `--test-concurrency=1 --test-timeout=60000`, flags before the file, exit captured.

Full set after the rewrite (bg-1177):

| File | Tests | Pass | Fail | Cancelled | Exit |
|---|---|---|---|---|---|
| controller-api | 66 | 60 | 6 | 0 | 1 |
| controller-lifecycle | 75 | 75 | 0 | 0 | 0 |
| recovery | 104 | 102 | 2 | 0 | 1 |
| commands | 78 | 78 | 0 | 0 | 0 |
| extension-contract | 47 | 47 | 0 | 0 | 0 |
| radar-client | 44 | 44 | 0 | 0 | 0 |
| herdr | 74 | 74 | 0 | 0 | 0 |
| control-integration | 7 | 7 | 0 | 0 | 0 |

controller-api's six failing names are the ordinary baseline names (digest and extend, acknowledgement, status normalization, steering, direct-child control and diagnostics). None is relaunch-named. recovery's two are the digest tests that already failed before this change.

Re-run after merging the duplicate `already_exited` check into `closeRadarChild` (bg-1181): controller-api 66/60/6 exit 1 with the same six ordinary names; controller-lifecycle 75/75 exit 0; control-integration 7/7 exit 0; recovery 104/102/2 exit 1, the two digest tests from its baseline. The merge changed no outcome.

Type count (ad-hoc tsc 5.9.3, no tsconfig): 668 before, 658 after, with no added errors, unchanged after the merge. The ten removed errors all sit in the rewritten relaunch region of controller-api.

## 11. Outcome

The relaunch gate is built and tested, with the refusal rules of the design. `index.ts` is hand-edited; `closeRadarChild` is the single place the proof runs. Open items:

- Superseded by section 12: the pane-gone and `already_exited` refusals of the first build (D1, D2) and the Herdr-backed restart (D4) are changed by the ruling pass.
- `refused` closes still refuse and leave the pane as residue (D5); whether `refused` should also stop blocking is open for the owner (section 3).

## 12. Ruling pass: D1, D2 and D4 applied

The owner's three rulings change the first build. Each is applied and measured below.

**D1 reversed: a relaunch needs the process verdict, not a reported pane.** `resolveIdleWorker` sends a bound Radar child to `relaunch` when its presence is not `radar` and no assignment is outstanding. `closeRadarChild` sends no close over a pane the daemon no longer reports, and runs the absence proof on the bound agent. The guards: an outstanding `activeRequestId` refuses before any effect; the permitting verdicts are exactly `absent` and `mismatched`. A proof with no close to record writes the launch's `closed` spawn outcome, so the label is not held by an unresolved launch. A refused proof keeps the mailbox, so the child is never stranded.

**D2 reversed: a close outcome is authoritative in neither direction.** `already_exited` no longer blocks the proof, and it does not license a relaunch by itself. The stored close is retirement evidence only. A stored `completed` or `already_exited` close routes to `relaunch` with the proof deciding.

**D3 confirmed, reasoning recorded.** `agent.get` `not_found` refuses. It is ambiguous between a gone process and a missing registration or registry, and a daemon that lost its registry would report it for a live process. `unavailable` refuses because it is no claim, not evidence of absence. Together these two refusals are what makes D1's relaxation safe.

**D4 applied: `restart` is close-then-relaunch.** `restartIdleManagedWorker` no longer calls `runHerdr(["pane","get"])`, `stopHerdrAgentPreservingPane` or `startHerdrAgentInPane`. It runs the same path as the continuation: `closeManagedAgent` with `relaunch`, a mailbox reset, then `launchRadarChild`, under a new run id, in a new pane. The Radar spawn and launch block moved out of `actionUnsafe` into `launchRadarChild`, and the placement check into `radarFreshPlacement`; both callers use them. The three Herdr calls have no caller in `index.ts` and stay defined in `herdr.ts` for the Herdr removal slice.

**Recovery test at 3177: kept, not rewritten.** Its body does not call the control restart at all: it restarts the lead and runs `continue`, asserting that an idle retained worker is reused without starting a process. It has no Herdr fixture, so the Herdr-removal claim does not apply to it. The positive control restart is now `control-integration`'s "a control restart replaces an idle worker's process by close and relaunch". The refusal test at control-integration 324 stays.

**Fake changes.** `vanishPane` (pane gone, no close record) is added. The fake already held G5 (`outcome_unknown`). The contract lines it models are listed in section 8.

**Test changes.**
- Replaced "a close whose pane had exited or that the daemon refuses never authorizes a relaunch" with "a close outcome decides retirement, never permission on its own": `already_exited` with `verified` refuses, `already_exited` with `absent` relaunches, `refuseChildClose` refuses whatever the verdict.
- Added "a retained worker whose pane is gone relaunches only on a proved absent process" (`verified` refuses with the mailbox kept, then `absent` relaunches as `process_lost` without sending a close). Its fixture records the current child command, so the only reason is the pane.
- Added "a stored close never relaunches a child that has an outstanding assignment": the stored close is evidence, the guard refuses before any effect.
- The verdict test and the unplaced-child test keep their assertions. Only the unplaced-child comment changed, because the proof, not presence, now decides.
- control-integration: added the positive restart test. Its refusal comment now points at that test.

No expectation was rewritten to make a failure pass. Two failures during the pass were implementation regressions and were fixed in code: the verdict test's reason had moved to `process_lost` (now `definition_changed` when the fingerprint drifted, as before), and the pane-gone relaunch was refused by an unresolved launch label (now settled by the proof).

**Measurements** (whole files, `--test-concurrency=1 --test-timeout=60000`, flags before the file, exit captured directly):

| File | Tests | Pass | Fail | Exit |
|---|---|---|---|---|
| controller-api | 68 | 62 | 6 | 1 |
| controller-lifecycle | 75 | 75 | 0 | 0 |
| recovery | 104 | 102 | 2 | 1 |
| control-integration | 8 | 8 | 0 | 0 |
| commands | 78 | 78 | 0 | 0 |
| extension-contract | 47 | 47 | 0 | 0 |
| radar-client | 44 | 44 | 0 | 0 |

controller-api's six failing names are the six ordinary baseline names, matched by name: agent_extend digest, acknowledgement, status normalization, steering, direct-child control and diagnostics. None is relaunch-named. recovery's two are its digest tests from the pre-edit baseline.

**Type count** (ad-hoc tsc 5.9.3 from the Nix store, `--noEmit --allowImportingTsExtensions --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck extension/*.ts`): 658 before the fix, 657 after. The one error removed is the `parent.message` read this pass moved into `launchRadarChild`, now narrowed with `=== false` as family A does. No error was added. `git diff --check` is clean on the touched files.

**Open after this pass**
- The absence proof is verified only against the fake daemon. The disposable tmux acceptance is the live check.
- Control restart moves the pane. The message says "in a new pane", and the effects are unchanged.
- A stored completed close with an outstanding assignment refuses, and the mailbox is kept. Nothing retires it, so the child is stuck until an operator acts. The loss path cannot reach a Radar child, so this is a dead end to report, not fix here.
- `refused` closes still refuse (section 3). The owner's neither-direction ruling named only `already_exited`.
- Pane-gone children of an idle worker are now relaunched only on proof. A child whose pane is gone and whose listing is not idle is still refused by restart's idle gate (`listed.state`), which is unchanged.

## 13. Close-authority pass: one rule, the loss path, restart's gate

**The rule, stated once.** A close outcome is never authority in either direction. Only the process verdict grants permission: `absent` and `mismatched` permit a relaunch, anything else refuses. `completed`, `already_exited`, `refused` and `unknown` all follow it. `refused` keeps its own consequences: the close record names the refusal and the pane it left as residue, and nothing is retired on it.

**Applied to `refused`.** A `refused` close no longer stops a relaunch. `closeRadarChildPane` records the refusal and, on a relaunch, returns to the absence proof. A plain close still refuses. The fake models a refused pane that stays open on a dead shell (`exitProcess`), so the test asserts the residue is left, not closed.

**Applied to the stored completed close with an outstanding assignment (the dead end).** The loss path was keyed on presence `lost`, and a Radar child can never report `lost` (`managedAgentPresence` maps an unproved observation to `unknown`). So the stuck child never reached any notice. The fix:
- `observeRadarChild` is unchanged. Where a child with an outstanding assignment is unproved, `radarChildObservations` hands it to `gonePastUnproved`, which reads `agent.get` once (`readProcessGone`). Only `absent` or `mismatched` turn it into `gone`; every other answer stays `unknown`.
- `gone` maps to presence `lost` with `processGone` set to the verdict. That presence publishes the existing loss notice, which now names the verdict, says the assignment is kept (neither resumed nor retired), and offers no continue or close, because there is no pane to close and no abandon path yet.
- A proven-gone child is excluded from `isLostWorkerOf`, so continuation never recovers it, and `resolveIdleWorker` refuses it while the assignment is outstanding.
- The refusal of the outstanding-assignment case stays in `closeRadarChild` as the guard before any effect.
- Rejected: resuming the assignment or retiring the mailbox. A process gone while work was owed is a loss; the operator decides.
- Open: there is still no abandon path for a proven-gone child with no pane. The notice says so. Retiring it is an operator decision the owner has not made.

**Applied to restart.** The control preflight refused any unknown presence as `target_not_found` before the restart gate ran, so the gate's own unreadable-listing rule was unreachable. The preflight now passes a bound Radar child with unknown presence to `restartIdleManagedWorker` (`restartDecidesPresence`); every other unknown child, and an aliased occupant, keeps the existing refusal, so mux-era categories do not change. The restart gate then applies the continuation rule:
- a positively non-idle listing refuses (existing test: "a control restart refuses a working target and leaves it untouched");
- an unreadable listing (`unknown`) refuses only with an outstanding assignment, and otherwise defers to the proof, so the child relaunches only on `absent` or `mismatched`.

**"In a new pane".** Kept. Restart moves the pane by design. The message is unchanged. Reinstating pane preservation is not done.

**Recovery test at recovery.test.ts:3177.** Kept, and its subject is the continuation path. It restarts the lead and runs `continue`, so it asserts the continuation reuse, not control restart. The positive control restart claim lives in control-integration ("a control restart replaces an idle worker's process by close and relaunch"). Read the kept test as continuation, not as the same-pane restart surviving.

**Tests added or changed**
- controller-api: "a close outcome decides retirement, never permission on its own" — the `refuseChildClose` row now uses the verdict `verified` and still refuses (the old `absent` expectation contradicted the rule); "a refused close is not authority: an absent process relaunches and the refused pane stays as residue" (new); "a proved-gone child with an outstanding assignment publishes a loss and retires nothing" (new, drives the scanner).
- control-integration: "a control restart on an unreadable listing defers to the assignment state" (new, two-sided: an outstanding assignment refuses, a cleared one relaunches with no close over the gone pane).

**Mutation checks** (one per ruling, `index.ts` restored byte-identical with `cmp`):
- M1, refused does not reach the proof → "a refused close is not authority" red.
- M2, restart refuses unprovable presence → "defers to the assignment state" red.
- M3, a gone verdict not mapped to lost → "a proved-gone child … publishes a loss" red.

**Fake changes (support-radar.ts).** `exitProcess(spawn)`: the child's process stops while its pane stays, the consumer stops, and the per-child verdict is `absent`. This models the contract's dead-pane fence case without a global verdict override. `agent.get` reads it per child.

**Type count.** Ad-hoc tsc 5.9.3, the same command as the relaunch pass. 657 after the production edits, with an identical normalised error set. 659 after the test edits: two new `Property 'content' does not exist on type 'unknown'` errors at controller-api.test.ts, both from the new loss test's `notices[0].content` reads, whose `notices` array is not typed. Not fixed in this pass.

**Stored-close expectation.** "a stored close never relaunches a child that has an outstanding assignment" now expects `agent_busy` instead of `target_ambiguous`. The absent verdict makes the child presence `lost`, so the busy branch refuses it. Refusal, no launch and the kept mailbox are unchanged. Its busy message still says to close the exact agent, which close refuses for a proven-gone child. That wording is a follow-up.

**Open after this pass**
- A proven-gone child with an outstanding assignment has no abandon path. It is reported, not resolved. The owner decides how an operator retires it.
- The absence proof is verified only against the fake daemon. The disposable tmux acceptance is the live check, not run here.
- The `refused` residue is recorded in the close entry (stage `refused`, with its reason) and the relaunch proceeds, but nothing surfaces it to the operator. Naming it on the relaunch result needs a channel the brief did not name.

## 14. Abandon path, residue and restart listing: one rule

The rule, applied to five items: a process proved `absent` or `mismatched` is the only evidence that changes the answer. Listing state is mailbox state and does not veto it; a close outcome does not license or veto it.

- **Proven-gone close.** `closeable` in the loss notice now includes a lost child. A control close of a proved-gone child retires its mailbox without a pane close and records the verdict (`closeManagedAgent` already routed it there). Tests: "a control close retires a proved-gone child's assignment without closing its pane" (control-integration) and "a control close refuses a child whose process is not proved gone and keeps its mailbox".
- **Restart, non-idle listing.** A positively non-idle listing refuses only while the process is not proved gone, through the same `processGoneForRelaunch` read continuation uses. Tests: "relaunches only on a proved-gone process" and "refuses while the process is not proved gone" (control-integration).
- **Residue on the relaunch result.** A refused close is named in the result (`residue` on continuation, the restart `message`), by `refusedCloseResidue`. Tests: "names the residue" (controller-api, control-integration).
- **Loss notice, two-field notice type.** `LossNotice = { customType?, content }` replaces the untyped read; the two `content` errors are gone.
- **Abandon judged by the mailbox.** The control close's abandoned-wake condition reads the mailbox's `activeRequestId`, not only the listed state, because an unknown-presence child lists as `unknown`. Without this, a proved-gone close with a live assignment sent no wake. Mutation M2 (judge by listed state only) turns "retires a proved-gone child's assignment" red.

Mutation checks, `index.ts` restored byte-identical with `cmp`: M1 (drop the proof from the restart non-idle gate) turns "relaunches only on a proved-gone process" red; M2 as above.

**Busy hint.** "close its exact agent if abandoning it" is now true for a child whose presence is proved gone or live, because close succeeds for both. It is still misleading for a child whose presence is unproved and whose assignment is outstanding: close refuses there (`target_not_found`, "cannot be proved"). Not changed in this pass; the owner decides the wording for that case.

**Frozen controller-api failing set** (run bg-1340, the reference for every diff from here; the bg-1340 log is `/tmp/kendex-pi-bg/lanes/01a13156-7b69-72c7-8de1-ea00b910cbeb/bg-1340-1791844479631.log`): six names: `agent_extend defers one worker's next digest and later windows revert`; `assignment retains its request when acknowledgement never arrives`; `assignment status normalization fails closed safely`; `lead steers a blocked parent waiting for direct-child work`; `parent controls only direct children and enforces session allowlists`; `parent list omits unrelated unknown mailbox diagnostics`. This run (bg-1385) reproduced exactly those six, no substitution. The earlier 19-name list is not on disk, so it cannot be diffed against.

**Measurement** (bg-1385, whole files, `--test-concurrency=1 --test-timeout=60000`, flags before the file, exit captured per file): controller-api 64/70 exit 1 (frozen six); controller-lifecycle 75/75 exit 0; recovery 102/104 exit 1 (two pre-existing digest names: `a digest entry for a worker awaiting an answer lists reply, not interrupt`, `a resolved assignment is never included in a later digest`); control-integration 14/14 exit 0; commands 78/78 exit 0; extension-contract 47/47 exit 0; radar-client 44/44 exit 0.

**Type count.** Ad-hoc tsc 5.9.3 with the flags of the relaunch pass: 657 total, down from 659. The two removed errors are the `content` reads in controller-api.test.ts, fixed by the notice type. The remaining `content` error is `commands.test.ts(5024)`, outside this pass. The normalised set otherwise matches the 657 recorded at the relaunch close-out.

**Open after this pass**
- The busy hint wording for an unproved child with an outstanding assignment (above).
- The absence proof is still verified only against the fake daemon; the live disposable-tmux check is not run.
- A proved-gone child with an outstanding assignment is still reported, not resolved, by the loss notice; no abandon path was added beyond close.

## 15. Operator hints, the authority record, and the last notice type error

**Baseline, stated plainly.** The 19-name controller-api list was never written to disk. It was cited from a report rather than a file, so it cannot be diffed and is not reconstructed here. The written baseline is the six-name bg-1340 set in section 14. Every diff is against that set.

**Busy hint (fixed).** The continuation's busy refusal told the operator to close the exact agent if abandoning it. For a child whose presence is `unknown` with an outstanding assignment, close refuses, so the hint named an action the system would refuse. The branch now names no action for that case: the registered process cannot be proved absent, the assignment is kept, and nothing can safely be done until the process can be proved either way. The gate is unchanged. Test: "an unproved child with an outstanding assignment names no action it would refuse" (controller-api). Mutation M3 (old hint restored) turns it red; `index.ts` restored byte-identical with `cmp`.

**Other notices on this path, checked and left.** The loss notice offers close only for a proved-gone child, and a proved-gone child is closeable. The restart message "a lost target is close-only" is true for the same reason. The continuation's recover branch offers continue for a lost child with no proof, and continue does apply there. No other hint on this path names a refused action.

**Decision record.** ADR 0035 (`docs/adr/0035-decide-relaunch-and-retirement-by-process-proof.md`) records the rule, the four verdicts plus the `not_found` error, the refusal reasons and the rejected alternatives. It is indexed in `docs/README.md`. The durable half is in `context/`, which did not exist before this pass: `index.md` with the full thirty-six-heading skeleton, `README.md`, and the entry `process-proof-authority.md` (decision, confirmed). Not created: the `AGENTS.md` and `CLAUDE.md` guard files, and a `.keep-the-why` project config. The keep-the-why setup was not run, so the owner decides it.

**Last notice type error (fixed).** `commands.test.ts:5024` read `.content` from an untyped sent message. It now reads through the two-field shape `{ content: string } | undefined` as a cast, not `any`. The local `LossNotice` type lives in `controller-api.test.ts`, so this file carries the shape inline.

**Measurement** (bg-1412, whole files, `--test-concurrency=1 --test-timeout=60000`, flags before the file, exit captured per file):

| File | Result | Exit |
|---|---|---|
| controller-api | 65/71 (6 fail, the frozen six by name) | 1 |
| controller-lifecycle | 75/75 | 0 |
| recovery | 102/104 (the two digest tests) | 1 |
| control-integration | 14/14 | 0 |
| commands | 78/78 | 0 |
| extension-contract | 47/47 | 0 |
| radar-client | 44/44 | 0 |

controller-api 71 tests: 70 before, plus the new unproved-child test. Its six failing names match the frozen set exactly.

**Type count.** Ad-hoc tsc 5.9.3, the same flags as before, against the saved prior log (`/tmp/pi-herdsman-1000/tsc-now.txt`, 657 lines). Now 656. A per-file, per-code diff with paths stripped shows one change: `commands.test.ts` TS2339 4 → 3, the cleared `content` read. Nothing was added. One adjacent error on the same message object remains, `commands.test.ts:5022` (`display` on `unknown`). It was not named in this brief, so it is left.

**Honesty note.** The first tsc run in the measurement script used a wrong compiler path and reported `errors=0`. That run was empty and is discarded. The count above is from the corrected compiler path.

**Open after this pass**
- The `AGENTS.md`/`CLAUDE.md` guard files and the keep-the-why setup for `context/`.
- The `commands.test.ts:5022` `display` error, not in scope.
- The absence proof is still verified only against the fake daemon.

## Correction: the controller-api six and recovery two are cutover regressions

Recorded after the Herdr-free acceptance run, which ran these invocations against a
full export of the parent commit `a53f56746`.

Sections 13, 14 and 15 call the controller-api six an "ordinary baseline" and the
recovery two "pre-existing digest tests". Both claims are wrong: all eight pass at
the parent, as do two further agent-runtime names no earlier pass suspected.

regressions, all passing at `a53f56746`:

- agent-runtime `parent settlement waits for agent delivery and ignores result cleanup lag`
- agent-runtime `a stray agent variable does not suppress the active Lead tool surface`
- controller-api `agent_extend defers one worker's next digest and later windows revert`
- controller-api `assignment retains its request when acknowledgement never arrives`
- controller-api `assignment status normalization fails closed safely`
- controller-api `lead steers a blocked parent waiting for direct-child work`
- controller-api `parent controls only direct children and enforces session allowlists`
- controller-api `parent list omits unrelated unknown mailbox diagnostics`
- recovery `a digest entry for a worker awaiting an answer lists reply, not interrupt`
- recovery `a resolved assignment is never included in a later digest`

Two errors compounded. The six-name set was frozen from a run made *inside* this
tree, and the sections then read that set as evidence of pre-existing failure. A
baseline measured inside the changed tree cannot separate a regression from a
pre-existing failure; only a parent run can, and no pass here made one until the
acceptance slice did.

The four agent-runtime names that do predate the cutover stay red at the parent and
remain attributed to `pi-bash-processes` snapshot semantics.

This section is written so the wrong claim is not repeated. The repair is tracked
separately.
