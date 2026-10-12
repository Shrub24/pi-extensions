# Radar migration: remaining test failures and next slice

## Summary

The supplied run reports 1176 tests: 1126 pass, 49 fail, 1 skipped. The strongest migration-causal family is Manager/worktree Lead startup: 26 `controller-api.test.ts` failures plus one `commands.test.ts` failure stop at Herdr alias confirmation. A further seven controller-api failures exercise retained-worker launch/recovery; two other controller-api failures concern request/digest behavior. `control-integration.test.ts` has one retained-worker restart failure. Five `agent-runtime.test.ts` failures were identified in the upstream assignment context as pristine baseline. Seven other `commands.test.ts` failures are menu/TUI/timer harness issues, not evidence of a Radar mux gap.

## Failure ledger (all 49 exact names)

### Manager/worktree Lead startup: 27 (26 controller-api, 1 commands)

All are masked by the same runtime error: `child in pane child-pane did not take the Herdsman alias ...`, thrown from `herdr.ts:1430` while `delegateProjectLeadLocked` calls `startHerdrAgentInPane` (`index.ts:13058`). These are genuine direct-Herdr dependencies, not merely obsolete test expectations. Many tests fail before their intended identity/authority/worktree assertion can execute.

`controller-api.test.ts`:
1. `Manager retry correlates an ambiguous worktree create by persisted branch` (:1095; log :1527)
2. `Manager activates only after mocked Lead-state publication` (:3004; log :1547)
3. `trusted Manager starts its Lead with approval and the assignment session ID` (:3006; log :1571)
4. `untrusted Manager starts its Lead without approval and with the assignment session ID` (:3008; log :1595)
5. `Manager distinguishes Herdr identity and Lead-state bootstrap timeouts` (:3010; log :1619)
6. `Manager reports Pi process without a Herdr session identity` (:3012; log :1640)
7. `Manager waits for a delayed Herdr session identity` (:3014; log :1661)
8. `Manager startup rejects conflicting role promptly` (:3016; log :1685)
9. `Manager startup rejects managed Agent identity without Lead state` (:3018; log :1719)
10. `Manager waits for prospective Lead identity to materialize before success and immediate close` (:3020; log :1753)
11. `Manager rechecks authority after assignment publication on identity-manager-lost-timeout` (:3026; log :1773)
12. `Manager rechecks authority after assignment publication on identity-manager-lost-success` (:3026; log :1807)
13. `Manager preserves assignment and fails closed on identity-timeout` (:3036; log :1841)
14. `Manager preserves assignment and fails closed on identity-zero-byte-timeout` (:3036; log :1875)
15. `Manager preserves assignment and fails closed on identity-unproven` (:3036; log :1909)
16. `Manager preserves assignment and fails closed on identity-mismatch` (:3036; log :1943)
17. `Manager preserves assignment and fails closed on identity-cleanup-mismatch` (:3036; log :1977)
18. `Manager preserves assignment and fails closed on identity-ambiguity` (:3036; log :2011)
19. `Manager rejects a resolvable Herdr session ID that differs from its assignment` (:3038; log :2045)
20. `Manager relaunches the exact lost Lead` (mode loop :3040; log :2079)
21. `Manager reconstructs a vanished worktree with saved Pi cwd` (:3040; log :2103)
22. `Manager reconstructs a vanished worktree without saved Pi cwd` (:3040; log :2127)
23. `Manager reopens a closed worktree workspace` (:3040; log :2151)
24. `Manager adopts a preexisting branch worktree for fresh delegation` (:3063; log :2175)
25. `Manager opens and adopts a closed preexisting branch worktree` (:3065; log :2199)
26. `Manager serializes simultaneous same-branch delegation` (:3076; log :2223)

`commands.test.ts`:
27. `Manager delegate persists an exact worktree Lead assignment` (:1065; log :1357), same Herdr alias error.

### Retained-worker launch/recovery: 7 controller-api failures

These fail launch/reuse assertions in retained-worker paths. The log demonstrates missing expected Herdr launch calls, an unexpected `definition_changed` result, or generation mismatch; it does not establish one shared runtime cause. These are production lifecycle consumers, but the old CLI-call assertions must be replaced by contract-level assertions only when that consumer is migrated.

28. `session continuation inherits the saved label without an override` (`controller-api.test.ts:4601`; log :2240)
29. `definition drift relaunches a retained worker on the same session` (:4863; log :2258)
30. `a changed child command relaunches a retained worker on the same session` (:4932; log :2272)
31. `continuation recovers a worker whose pane is gone` (:5038; log :2286)
32. `assignment response overrides do not relaunch a healthy retained worker` (:5291; log :2302)
33. `a missing launch entry relaunches a retained worker instead of reusing it` (:5395; log :2321)
34. `session continuation keeps explicit definition execution overrides` (:5436; log :2335)

### Other controller-api: 2

35. `assignment retains its request when acknowledgement never arrives` (`controller-api.test.ts:6446`; log :2342): assertion sees 0 rather than 1.
36. `agent_extend defers one worker's next digest and later windows revert` (`controller-api.test.ts:7999`; log :2360): expected one digest, observed 0. These are not evidence of missing Radar mux methods; keep outside the launch slice.

### Control restart: 1

37. `a control restart relaunches an idle retained worker and refuses a busy one` (`control-integration.test.ts:447`; log :1511): expected relaunch is absent (`:470`). This is a real separate process-lifecycle dependency; Radar has no verified process stop, retained-session resume or restart API. Do not fold it into fresh spawn.

### Agent runtime baseline: 5

The prior assignment context identifies these as pristine baseline. Not migration evidence; process-addressed request/ack review is explicitly excluded.

38. `unfinished background work holds settlement through a flush and late work` (`agent-runtime.test.ts:241`; log :90): deep-equality mismatch.
39. `a recovered worker settles with an unretrieved prior-request result named in its answer` (:500; log :91): undefined result at :583.
40. `only unfinished work holds while unreviewed terminal results settle` (:606; log :92): deep-equality mismatch.
41. `settlement publishes an unread terminal result without a post-review response` (:798; log :94): undefined result at :877.
42. `a stray agent variable does not suppress the active Lead tool surface` (:5392; log :157): deep-equality mismatch.

### Commands/TUI: 7

Not physical control-plane failures. Fix/triage independently.

43. `Chief activation replaces the lead widget and overview selection is interactive` (`commands.test.ts:3028`; log :283): menu/result deep-equality mismatch.
44. `plain agents opens the native management menu` (:4084; log :299): menu/result deep-equality mismatch.
45. `agents TUI selectors use stable values and current preselection` (:4154; log :300): selection assertion false.
46. `repeated lead starts replace the widget and ignore old refreshes` (:6359; log :332): expected 1, actual 2.
47. `TUI status refresh consumes the coherent Herdr session snapshot` (:6506; log :333): test timer lacks `.unref()` (`pane-metadata.ts:110`).
48. `zero-runtime reconciliation requests one status refresh` (:6706; log :334): `resolveInitial` is not a function (`:6810`); late timer also throws missing `.unref()`.
49. `fresh assignment refreshes the widget after validation` (:6836; log :335): test timer lacks `.unref()` through metadata publication.

Counts reconcile with the supplied log file totals: controller-api 35 = categories 1 (26) + 2 (7) + 3 (2); commands 8 = Manager item 27 plus seven TUI failures; control-integration 1; agent-runtime 5. Total 49. Detailed diagnostics are in `/tmp/addr-full.log:1271-2373`; TAP failure names are at lines 90-493.

## Manager seam and Radar capability

### Herdsman production path

- Parent location comes from process environment: `radarProcessLocation()` reads `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and deliberately omits location if no pane or if it is the inherited parent pane (`index.ts:1101-1114`). `radarSpawnParent(paneId)` requires the registered subject's pane to exist and exactly equal the chosen launch pane (`index.ts:1126-1150`).
- The launch overlay helper `radarLaunchEnvironment` composes `PI_SUBAGENT_CHILD`, launch generation, optional parent pane, and explicit environment entries (`index.ts:1214-1236`).
- The Manager worktree path chooses a worktree root pane and calls `startHerdrAgentInPane`; then it validates session/coordination before assignment publication (`index.ts:13001-13199`). The start helper invokes Herdr topology, shell readiness, process/terminal ownership capture, `agent start`, and alias confirmation (`herdr.ts:1294-1435`).
- Radar publication/execution are separate: `radar-execution.ts:154-190` supplies process registration, optional location, managed metadata, and the claimed spawn token to `createRadarPublication`; `claimRadarSpawnToken()` reads then deletes `PI_RADAR_SPAWN_TOKEN` (`index.ts:458-462`). Existing registration token plumbing is useful but there is no Manager spawn caller in this failing path.

### Radar's exact parent contract (not an observation resolver)

`agent-radar/src/control_plane/server.rs:2934-3252` shows `execute_spawn`:
1. validates launch command/context;
2. reads the **exact parent registration selected by UUID**;
3. requires that parent's currently published `agent.context` is fresh and its session equals `parent_session_id`;
4. takes parent pane from the registered `location.pane` field;
5. refuses before effects if absent; then creates a nonfocused right split there, launches and records outcomes.

It does **not** resolve the parent from process identity, `observe`, alias, pane title or matching session. Tests explicitly cover absent parent pane (`tests/control_plane.rs:4108-4148`) and stale/mismatched context (`:4152-4201`). The client must gate on the exact process registration and exact persisted location; do not synthesize location from an observation or name.

Radar supports resolved executable + literal argv, optional absolute cwd and env overlay; cwd/env need `child_launch_context_v1` with `creation` and `launch`. The daemon-minted `PI_RADAR_SPAWN_TOKEN` is private, child-captured/removed, and presented during exact child registration. Parent reconciles with the same request UUID and consumes the exact `spawn.bound.agent_id` from `spawn.get`; uncertain spawn is not retried under another ID. See `agent-radar/docs/daemon.md:10-60`, `docs/agent-registration.md` Spawn operation, `docs/mux.md` Launch and binding.

### Readiness: preserve owner semantics, require a child-authored fresh acknowledgment

Today `verifyLeadCandidate` checks Herdr session identity and `readLeadCoordinationState`: role `lead`, exact Pi session ID, and no conflicting managed identity (`index.ts:13001-13026`). That coordination record alone is not proof it was authored by the new child after its required initialization: the test fixture writes it at mocked `herdr agent start` time. The owner-approved predicate is:

> The exact Radar-bound child registration for this spawn generation, plus a fresh acknowledgment authored by that child after required Pi/Herdsman initialization, matching expected run/owner/label/session and physical generation.

Neither binding nor mere presence of mailbox fields suffices. Preserve the existing Manager authority and exact identity checks; establish readiness through a child-owned acknowledgment scoped to launch generation and exact registration/process identity. Search/evidence did not establish that an existing startup-ack API already provides this full contract. Reuse an existing mailbox startup ack only if source proves it is fresh, child-authored, generation-bound and emitted after required hooks; otherwise add that narrow explicit handshake in Herdsman, not Radar. Assignment publication remains after this handshake.

## Smallest next implementation slice

Implement only the **fresh Manager Lead launch** path through Radar spawn, preserving worktree/assignment decisions and the existing post-init identity/coordination validation. Do not combine retained worker recovery, restart, or close.

1. Add typed `spawn` plus `spawn.get`/durable request reconciliation in `radar-client.ts`; negotiate `creation`, `launch`, and `child_launch_context_v1` when context is sent. Persist/reuse one request UUID; no direct-Herdr fallback after possible dispatch.
2. In `delegateProjectLeadLocked`, require current parent's registered agent UUID, exact registered pane location equal to legal spawn parent, and fresh matching parent session context. If any fact is missing, fail before effect. Current `radarSpawnParent` is the appropriate preflight seam; no fabricated pane IDs.
3. Convert the actual Pi executable/argv, assignment session selector, trust-dependent approval flags, resolved worktree cwd, and explicit env overlay without changing meaning. Radar's placement is fixed: right split, unfocused, at exact registered parent pane. Manager worktree target may be a different pane/workspace than that parent. This is a **real placement contract blocker** for cases requiring the chosen worktree root pane; do not silently spawn beside Manager and claim placement parity. Initial cutover must either prove target equals parent pane for every included case, or request a placement extension and defer those cases.
4. Persist spawn request/edge and exact bound child agent ID before the Manager writes assignment instructions. Child captures/removes spawn token through existing registration path. Keep run/owner/label/session assignment metadata and coordination authority in Herdsman.
5. Add/confirm a fresh child-authored, launch-generation-scoped readiness ack after required Pi/Herdsman hooks. Parent accepts only exact spawn-bound child plus matching ack and then existing coordination/session checks; stale preexisting ack, inherited mailbox, token binding, registry presence, or process observation is not readiness.
6. On unknown spawn, reconcile same request and edge; never retry with new ID, fallback or close an unbound/unknown pane. Radar `child.close` may later close only a bound edge's pane under exact live foreground identity; never infer process exit from close or disappearance.

**Files/tests:** `pi-herdsman/extension/radar-client.ts`, `index.ts`, possibly `radar-execution.ts`, `radar-publication.ts`, and narrowly `mailbox.ts`; `radar-client.test.ts`, Manager scenario tests in `controller-api.test.ts:1531-3078`, and `commands.test.ts:1065-1300`. Replace CLI-call expectations with request-envelope, cwd/env, exact parent, same-ID uncertainty reconciliation, token secrecy/binding, no-effect on missing capability/context/location, placement refusal, stale/wrong-generation readiness rejection, and assignment-after-ready assertions. Per repository convention run focused files then declared check. No tests were rerun for this read-only investigation.

## What is not in this slice / blockers

**Herdsman implementation work, not Radar contract gaps:** no spawn use in Manager; current parent registration may omit or inherit a pane; no Manager child readiness acknowledgment meeting the owner-approved predicate; launch conversion and exact-edge persistence are not yet wired. These can use existing Radar spawn, registration token, and registry read contracts subject to location/placement preconditions.

**Actual Radar gaps:**
- Managed spawn supports only right split beside the exact registered parent pane, not arbitrary existing pane/workspace or caller-selected anchor. This blocks Manager worktree placement where the desired pane differs.
- No process stop, retained-session resume, restart, replacement, or post-owner-restart reconciliation. The seven retained launch/recovery tests require separate decomposition and may need more than one contract; the control restart test is explicitly blocked by absent stop/resume semantics.
- `child.close` proves only pane close for exact token-bound child after live foreground identity verification; it is not process stop or assignment completion. It cannot be used as a substitute for missing lifecycle APIs.

## Evidence limits

Read-only investigation; no production edits, test runs, live effects, or commits. Failure facts come from `/tmp/addr-full.log`; source locations and Radar contract were inspected as cited above. Process-addressed request/ack implementation was not inspected per scope. The two non-mux controller-api failures and seven unrelated TUI failures need their own owners/triage; the five agent-runtime failures are reported baseline, not inferred here.
