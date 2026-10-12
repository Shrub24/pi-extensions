# Manager orchestration removal: inventory and deletion plan

Status: read-only investigation. No production file, test, or package gate was
changed or run. Evidence is the uncommitted pi-herdsman working copy, the two gate
logs `/var/tmp/herdsman-check-lead.log` (50 test failures, `ℹ fail 50`) and
`/var/tmp/herdsman-gate-lead.log` (59 failing names, `ℹ fail 59`), and the
direction in `radar-herdr-free-cutover-plan.md` ("Manager worktree orchestration
is out of the intended cutover's useful scope"). Line numbers refer to the
working copy as inspected; re-check them when editing, since another worker is
editing `index.ts`, `observation-refresh.test.ts`, `controller-lifecycle.test.ts`
and `commands.test.ts`.

## 1. Summary

- Manager is a project-coordination role layered on Chief/Lead supervision. It is
  activated by `/manager` (`index.ts` 14813), holds a per-workspace lease
  (`supervision.ts` 1610 `claimManagerLease`), and owns project work
  (`staff_delegate`, `staff_stop`, `staff_complete`, `staff_discard`). Its worktree
  orchestration (`worktree create/open/list`, Herdr pane start in a worktree)
  is the part the cutover plan calls out of scope.
- The Manager-only controller-api failures are **27** (of 37 controller-api failures
  in the check log; 27 of 46 across both logs). Removing Manager resolves exactly
  those 27 and leaves **19** controller-api failures in place (12 retained-worker
  relaunch/continuation, 7 ordinary parent/assignment/steering/brief tests).
- Removal also deletes **18 currently passing** controller-api tests whose only
  subject is Manager (they would otherwise be left as dead tests). Count of
  Manager-only tests in controller-api: **45** (27 failing + 18 passing).
- Retained-worker relaunch and saved-session continuation are **not** Manager code.
  They share two Herdr helpers with the Manager paths (`worktreeGroupScope`,
  `stopHerdrAgentPreservingPane`) and must keep them until the planned P2 relaunch
  slice replaces them.
- Chief is not Manager. Chief's direct Lead supervision, `staff_list`, `staff_inspect`,
  `staff_transcript`, `staff_message`, `supervisor_message` and peer presence are
  shared surfaces and must survive. Chief's Manager-report branch goes with Manager
  (see decision D1).

## 2. Failure attribution (from the gate logs, no test run)

Failing names were extracted from the `✖` lines of both logs and attributed to
their declaring file by name lookup, then to a population by reading the test
body or the helper it calls. The check log has two whole-file timeouts
(`extension/commands.test.ts (120024ms)`, `extension/controller-api.test.ts
(120018ms)`); tests that never reported in those runs are not attributed here.

### controller-api.test.ts: failures by population (union of both logs, 46 names)

| Population | Count | Resolved by Manager removal? |
| --- | --- | --- |
| A. Manager-only (worktree, Lead-start, identity bootstrap, recheck, fail-closed) | **27** | Yes |
| B. Retained-worker relaunch and saved-session continuation | **12** | No (its own P2 slice) |
| C. Ordinary parent, assignment, steering, digest, brief tests | **7** | No (must survive) |

Population A, failing (27):

- line 1095 `Manager retry correlates an ambiguous worktree create by persisted branch`
- lines 3004–3020 (9): `Manager activates only after mocked Lead-state publication`,
  `trusted Manager starts its Lead with approval and the assignment session ID`,
  `untrusted Manager starts its Lead without approval and with the assignment session ID`,
  `Manager distinguishes Herdr identity and Lead-state bootstrap timeouts`,
  `Manager reports Pi process without a Herdr session identity`,
  `Manager waits for a delayed Herdr session identity`,
  `Manager startup rejects conflicting role promptly`,
  `Manager startup rejects managed Agent identity without Lead state`,
  `Manager waits for prospective Lead identity to materialize before success and immediate close`
- lines 3026 loop (2): `Manager rechecks authority after assignment publication on identity-manager-lost-timeout` / `…-lost-success`
- lines 3036 loop (6): `Manager preserves assignment and fails closed on identity-timeout`, `identity-zero-byte-timeout`, `identity-unproven`, `identity-mismatch`, `identity-cleanup-mismatch`, `identity-ambiguity`
- line 3038: `Manager rejects a resolvable Herdr session ID that differs from its assignment`
- line 3052 loop (5): `Manager relaunches the exact lost Lead`, `Manager returns a live exact Lead idempotently`, `Manager reconstructs a vanished worktree with saved Pi cwd`, `Manager reconstructs a vanished worktree without saved Pi cwd`, `Manager reopens a closed worktree workspace`
- lines 3063, 3065: `Manager adopts a preexisting branch worktree for fresh delegation`, `Manager opens and adopts a closed preexisting branch worktree`
- line 3076: `Manager serializes simultaneous same-branch delegation`

Population A, passing today but Manager-only (delete with the code, 18 tests):

- lines 643 loop (2): `fresh Manager activation …` (both `reachable` values)
- lines 839–864 loop (4 scenarios): `project assignment delivery …` at line 865, the
  worktree-Lead scenarios (`accepts its branch worktree Lead`, `…prospective session path…`,
  `denies an exact Lead moved to a sibling worktree`, `denies a mismatched prospective session path`)
- line 3040 `Manager recovery waits on existing exact Pi without restarting it`
- lines 3053, 3055, 3057, 3059, 3061: `Manager stop preserves…`, `Manager discard stops…`,
  `Manager complete resolves…`, `Manager retains assignment when exact Lead stop fails`,
  `Manager closes an unassigned direct Lead…`
- lines 3067, 3069: `Manager refuses an occupied worktree…`, `Manager refuses ambiguous multiple Leads…`
- lines 3072 loop (2): `Manager discards when a freshly listed branch pane disappears (not_found / pane_not_found)`
- lines 3074, 3078: `Manager preserves an assignment when a current branch pane may run Pi`, `Manager retains placement when recovery topology is not authoritative`

Population B, failing (12). Attributed from name, and the body reads no Manager,
worktree or staff reference (grep of lines 4601–5570 finds only `SessionManager`):

- 4601 `session continuation inherits the saved label without an override`
- 4933 `definition drift relaunches a retained worker on the same session`
- 5002 `a changed child command relaunches a retained worker on the same session`
- 5086 `clearing the child command relaunches a retained worker`
- 5108 `continuation recovers a worker whose pane is gone`
- 5178 `continuation recovers a worker behind a surviving shell and leaves the shell alone`
- 5214 `continuation refuses an unprovable identity instead of weakening presence`
- 5251 `continuation preserves an unretrieved result instead of overwriting it`
- 5303 `the relaunch close holds the session reservation against a concurrent continue` (times out at 10 s in the gate)
- 5361 `assignment response overrides do not relaunch a healthy retained worker`
- 5465 `a missing launch entry relaunches a retained worker instead of reusing it`
- 5506 `session continuation keeps explicit definition execution overrides`

Population C, failing (7). No Manager reference in their bodies (grep: no matches
in 3692–4160, or in 6500–8300):

- 3849 `parent list omits unrelated unknown mailbox diagnostics`
- 3995 `parent controls only direct children and enforces session allowlists`
- 5399 `validated role-specific brief context reaches worker requests`
- 6516 `assignment retains its request when acknowledgement never arrives`
- 6847 `lead steers a blocked parent waiting for direct-child work`
- 7448 `assignment status normalization fails closed safely`
- 8069 `agent_extend defers one worker's next digest and later windows revert`

### Other suites

- `commands.test.ts` (3 test failures, check log): **Manager-only, resolved**:
  `Manager delegate persists an exact worktree Lead assignment` (line 1061),
  `active Manager supervision refreshes serialize and coalesce concurrent requests`
  (test at line 7024; the failing line is 7105, gate only). **Not Manager, stays**:
  `zero-runtime reconciliation requests one status refresh` and
  `lead status refreshes keep one in-flight refresh and one trailing rerun`. The whole-file
  120 s timeout is not a test. Correction: `fresh assignment refreshes the widget after
  validation` was not a Herdr read-gate failure and is not order-dependent in the sense of
  residual state. Its stalled-row assertion read a timing-sensitive lifecycle label
  (`starting` or `unknown`) and failed alone in 2 of 4 isolated runs as well as in the
  whole file. It now asserts only that the unacknowledged launch is not shown as working.
- `agent-runtime.test.ts` (5), `controller-lifecycle.test.ts` (1,
  `cascade close revalidates the parent generation under its assignment lock`),
  `observation-refresh.test.ts` (4): none is Manager-named. They are outside Manager
  removal and belong to the other worker's suites.

Net effect on the check log (50 test failures): Manager removal resolves **28**
(27 controller-api and 1 commands, `Manager delegate persists…`), and leaves 22 in place.
The gate log adds one Manager commands failure (`active Manager supervision refreshes…`).

## 3. Manager-only production surface (delete)

Ranges are approximate ends where I did not read the closing brace. Check each
boundary when editing.

### 3.1 `extension/index.ts`

- Command and role entry: `/manager` registration 14813–14836 (`activateManager` or
  `leaveManager`); `activateManager` 11478–11545 and `leaveManager` 11546–11587.
- Role state: `managerLease` 9887, `controllerRole` `"manager"` branches in
  `resolveControllerRole` 11428–11477, `reconcileBranchRole` 11770–11803, and
  `failClosedRole` 11743–11769, plus `persistRole("manager")` callers and the
  session-start branches at 17135–17166 and 17214–17235 (`activeManager`,
  `managerLease?.release()`).
- Lookup and authority: `managerForScope` 10460–10472, `currentManager` 10473–10516,
  `currentSupervisor` 10517–10522 (currently `currentManager ?? currentChiefAuthority`,
  so it collapses to the Chief path), `managerClaimsScope` 10829 and
  `projectAssignmentAuthorized` 10832 (Manager-authored project assignment only),
  and the Manager descriptor listing at 10957–10968.
- Project-assignment receive path (Lead side): the `record.kind === "project_assignment"`
  branches at 10849 and 11212–11236 (`pi-herdsman-project_assignment` custom
  message in 11236). Producers are all Manager code: 12650, 12725 (inside
  `delegateProjectLead`) and 13015.
- Project work actions: `stopProjectLead` 12325–12389, `resolveProjectWork`
  12390–12544 (`complete`/`discard`), `delegateProjectLead` 12545–~13095 (its own
  `assertUnoccupied` 12679, `herdrSessionSnapshot` and `startHerdrAgentInPane` call
  at 12895, `stopHerdrAgentPreservingPane` at 12309 and 13049, `assertManagerCurrent`
  at 13005–13070). This is the whole worktree create/open/list family.
- Shared supervision loader's Manager branch: the `worktreeGroupScope` path in
  `loadSupervisionSnapshot` 11959– (group worktree list at 11976–11989, return
  `{ project, work: projectWorkSnapshot(...), openWorkspaces, leads }` at about
  12019). Remove only that branch; the Lead/direct-report snapshot stays.
- Supervision refresh and dashboard: `refreshSupervisionOnce` 13099 and the
  Manager-only parts of `refreshSupervision` 13147–13160; the `activeRole() === "manager"`
  menu and widget branches at 13104–13610, including `managerSupervisionItems`
  call sites at 13471 and 13535 and the stop/delegate/complete/discard menu entries
  at 13520–13575.
- Staff tools: `staff_delegate`, `staff_stop`, `staff_complete`, `staff_discard`
  registrations 15623–15720 (`registerTool` at 15623, 15650, 15677, 15704). In the
  shared `staff` execute at 15193–15330 remove the `delegate`, `stop`, `complete`
  and `discard` actions and their `activeRole() !== "manager"` guards (15218–15230).
  Keep `list`, `inspect`, `transcript`, `message` for Chief (see D1).
- Messaging: `supervisor_message` manager kind at 14985–14995
  (`manager_message` vs `lead_message`), the Manager branch at 15092–15097 in
  `peer_message` (Manager-lease check), and `activeRole() === "manager"`
  `chief_message`/`manager_message` at 15460 and 15492 (keep the Chief arm).
- Imports to drop: `claimManagerLease` 271, `readManagerDescriptor` 272,
  `readManagerDescriptorStatus` 273, `listManagerDescriptors` 274,
  `sameManagerDescriptor` 275, `projectWorkSnapshot` 287, `managerSupervisionItems` 354.

### 3.2 `extension/supervision.ts`

- Manager types and lease: `ManagerDescriptor` 1423, `ManagerIdentity` 1435,
  `ManagerLease` 1444, `ManagerDescriptorStatus` 1449.
- Lease functions: `managerDescriptorPath` 1454, `validManagerDescriptor` 1466,
  `sameManagerDescriptor` 1500, `readManagerDescriptorStatus` 1519,
  `readManagerDescriptor` 1567, `listManagerDescriptors` 1578,
  `claimManagerLease` 1610–~1670.
- Runtime key `managers` in `SupervisionRuntime` (type at 134, paths at 959 and 996).
  Its directory is created only by `claimManagerLease` (1628–1629) and read by
  1461, 1583, 1593, 1665.
- Chief dual-report branch: `SupervisedManager` 2026, `ChiefManagerReportSnapshot`
  2046 and its union at 2139, `managerSupervisedLeadSessionIds` 2328–2373 (used only
  to suppress Chief dual-reporting of Manager-owned Leads).
- Project work projection: `projectWorkSnapshot` 2072–~2115 (single caller is the
  Manager branch in `loadSupervisionSnapshot`).
- Role and kind vocabulary: `"manager"` in `SessionRole` (28), `CoordinatorRole` (29),
  the role check at 97 and 1060, `"manager_message"` in the kind list (149), and the
  `project_assignment` kind (150, 241, 747) if no other producer remains (D2).

### 3.3 `extension/presentation.ts`

- `managerPresentationSnapshot` 569–584 and its branch at 596–600 (`"managers" in snapshot`).
- `managerSupervisionItems` 792–822 (`ManagerSupervisionItem` at 792) and its uses at 870 and in
  index.ts 13471/13535.
- Manager arms of `supervisionContext`/widget at 853–870, 1040–1060 (`role === "manager"` text).
- Message rendering: `case "manager_message"` 2922–2925 and the `project_assignment`
  case at 2930–2941.
- Keep `supervisionCountLabel` (779) for Chief's direct-Lead count. Its `managers`
  argument goes (the Chief label uses 1-arg `leads`).

### 3.4 `extension/herdr.ts`

- `worktreeGroupScope` 380–~430 and `WorktreeGroupScope`: **keep**. Consumers outside
  Manager: `restartIdleManagedWorker` in `index.ts` 7089 (feeds `primaryWorkspaceId` at 7145).
- `startHerdrAgentInPane` 1294–~1330 (primary-workspace guard at 1309–1324): **keep
  until P2**. Callers are retained restart (index.ts 7144) and Manager (12895).
- `stopHerdrAgentPreservingPane` 2441: **keep until P2**. Callers are retained restart (7131)
  and Manager (12309, 13049).
- `closeHerdrPane` 2380: **no production caller exists** (grep of `extension/*.ts`
  shows only its definition; `herdr.test.ts` references it). The progress note
  says it has no caller "outside the Manager paths"; that is inaccurate. It is
  already orphaned. Delete it in the herdr.ts removal slice, not as part of
  Manager, or the orphan will look like a Manager leftover.

### 3.5 `extension/session-metadata.ts`

- `OPERATOR_ROLES` 15 contains `"manager"`. Remove it, but see D3 for durable
  state already written with that role.

### 3.6 Nothing in `support.ts` or `support-radar.ts`

Grep for `manager|worktree` in both fixtures finds only `SessionManager` mock
plumbing. Removal orphans no shared fixture.

## 4. Test removal, by file

### 4.1 `controller-api.test.ts`

- Delete the `runManagerStartupScenario` helper 1531–~2990 (about 1460 lines; its
  fake `herdr worktree create/open/list` exec, `managerAgent` mock and identity
  observation helpers exist only for it).
- Delete tests at 643 (2 loop variants), 839–865 (4 project-assignment scenarios),
  1095, and 3004–3078 (the whole Manager block, 38 tests).
- Net: 45 tests and their helper go; the 12 passing tests in 3004–3078 are included.
- Mixed, amend rather than delete: test 168 `assigned Lead saves supervisor messages
  durably with or without a Manager` (uses `claimManagerLease` at ~186 and a
  Manager `managerDescriptorPath`). Keep the no-Manager Chief/Lead routing half and
  delete the Manager half. Test 311 `unassigned Lead routes supervisor messages
  directly to Chief` stays unchanged.
- Tests at 4470 (`owned continuation…`) and 4552 (`context retirement…`) have no
  Manager reference; no change.

### 4.2 Other test files, Manager-named, by file

- `commands.test.ts`: delete 438 (`root Lead explicitly enters Manager…`),
  730 (`Manager leave retains its lease and role…`), 847 (`Manager leave suspends
  authority…`), 926 (`restored Manager registers supervision tools…`), 1061
  (`Manager delegate persists…`, failing), 7024 (`active Manager supervision
  refreshes…`, failing; the failing line 7105 is inside it). Amend 1468 `Chief staff and ambient supervision include
  Managers and unclaimed Leads` (keep Chief and Lead; drop the Manager report).
  Keep 1625 `a Lead without a Manager routes upward to Chief and keeps peer presence`.
- `presentation.test.ts`: delete 4476, 4511, 4615, 4699, 4915 (all Manager widget or
  context tests). Check the other two broad-pattern matches before deleting (the
  7-count includes `chief`).
- `supervision.test.ts`: delete 765 (`Manager supervision snapshot carries only its
  derived open workspaces`), 1798 (`Manager leases are exclusive…`), 1868 (`Manager
  descriptor status distinguishes…`), 2239 (`project assignment uses durable project
  transport, not Manager message framing`, only if `project_assignment` is removed,
  D2). Amend 1725 (`Chief lead projection supports fallback without dual-reporting
  Manager reports`: keep the Chief fallback, drop the dual-report assertion) and 1758
  (`coordinator state and peer presence admit only Lead or Manager roles`: keep
  Lead, drop Manager).
- `smoke-runner.test.ts`: 24 Manager-named tests and the imports at 15–55 all go with
  the `manager-recovery` smoke scenario (see §5.3). Includes the parse tests at
  442–472 and the diagnostics tests at 476–650.
- `herdr.test.ts` 5072, 5118, 5164 (`worktree group scope…`): **keep**; `worktreeGroupScope`
  stays for retained restart.
- `extension-contract.test.ts` (7 by broad pattern): not enumerated in detail. Read
  each name before deleting; the broad pattern matched `chief` as well.

## 5. Non-code artifacts

### 5.1 Docs (count of Manager mentions, from grep)

- Delete: `docs/guides/project-orchestration.md` (19 mentions; the Manager guide).
- Rewrite or amend (remove Manager sections, keep Chief/Lead text): `docs/concepts/coordination.md`
  (25), `docs/reference/commands.md` (19), `docs/reference/staff.md` (12; the staff
  tools shared with Chief stay), `docs/reference/supervisor.md` (10),
  `docs/coordination-api.md` (10), `docs/reference/status-widget.md` (8),
  `docs/development/smoke-testing.md` (8), `docs/reference/peer.md` (3),
  `docs/getting-started.md` (3), `docs/reference/session-organization.md` (2),
  `docs/development/documentation.md` (2), `docs/README.md` (1, index entry),
  `docs/development/validation.md` (1).
- Root `README.md` lines 28–29 and 86–110 (Manager sections, orchestration bullet),
  and `SKILL.md` 410–472 (Manager tool and project-work guidance).

### 5.2 ADRs (amend, do not delete: keep-the-why)

- `docs/adr/0012-manager-owns-project-assignment-resolution.md` (10 mentions):
  mark **superseded** by a new ADR recording the removal decision and the rejected
  alternative (selected-existing-worktree-pane launch). Do not delete the record.
- `docs/adr/0024`, `0028`, `0033`: one mention each in passing; amend the sentence.
- ADRs 0030 and 0031 are referenced by the cutover plan and by `radar-v2-fresh-worker-progress.md`
  for physical-identity rules that Lead and worker use; none of them needs Manager text
  removed unless a sentence names it. Check when editing.

### 5.3 Smoke and package scripts

- `scripts/smoke.mjs`: the `manager-recovery` scenario and its helpers. Locations:
  scenario list 29; flag parsing 35–37 and 63–94 (`--manager-ready-timeout-ms`,
  `--manager-recovery-diagnostics`); diagnostics 98–110 and 212–220; repository
  prep 519–556; READY evidence 686–812 and 969; leave command 1365; prompts
  1461–1500; `runManagerRecoverySmoke` 2061–~2900; cleanup 3177–3220; diagnostics
  3095–3125; dispatch 1557–1573.
- `AGENTS.md` line 106 (`npm run smoke -- manager-recovery`). Remove the line
  when the scenario goes.
- `package.json` contains no Manager key (grep).

### 5.4 Config

- `config.ts`, `agent-definitions.ts`: grep finds no Manager key. No config
  removal is required.
- Runtime state directory `<runtime>/managers/` (supervision.ts 959, 996) holds
  lease descriptors. Stop creating it. Decide whether an existing directory is
  left in place or removed (D3).

## 6. Shared code that would be orphaned (remove with the Manager surface, so no dead exports remain)

Verified by grep of `extension/*.ts` (non-test) for each name:

- supervision.ts: `ManagerDescriptor`, `ManagerIdentity`, `ManagerLease`,
  `ManagerDescriptorStatus`, `managerDescriptorPath`, `validManagerDescriptor`,
  `sameManagerDescriptor`, `readManagerDescriptorStatus`, `readManagerDescriptor`,
  `listManagerDescriptors`, `claimManagerLease`, `SupervisedManager`,
  `ChiefManagerReportSnapshot`, `managerSupervisedLeadSessionIds`, `projectWorkSnapshot`.
  Check whether `readProcessLockStatus`, `ProcessLockOccupiedError`, `fsyncDirectory`
  remain used by the Chief lease before deleting any of them; the Chief lease at
  supervision.ts 1300 (`ChiefDescriptor | ManagerDescriptor`) shares the same helpers.
- presentation.ts: `managerPresentationSnapshot`, `managerSupervisionItems`,
  `ManagerSupervisionItem`.
- index.ts: `managerForScope`, `currentManager`, `managerLease`,
  `activateManager`, `leaveManager`, `assertManagerCurrent`, `delegateProjectLead`,
  `stopProjectLead`, `resolveProjectWork`, `directReports`' Manager branch.
- Keep (still used by retained restart until P2): `worktreeGroupScope`,
  `startHerdrAgentInPane`, `stopHerdrAgentPreservingPane`, `restartIdleManagedWorker`.
- Already orphaned, not Manager: `closeHerdrPane` (herdr.ts 2380) with zero
  production callers. Delete in the herdr.ts removal slice.

## 7. Behaviour that must survive removal

- **Lead ownership and controls**: `agent_*` tools on direct children, the
  registered-lead explicit live controls (controller-api 6549), `agent_extend` and
  its digest and window behaviour (8030–8282), steering of a blocked parent (6847),
  parent list and allowlist controls (3849, 3995, 3809).
- **Worker launch, readiness, first task, result**: `agent_delegate` (launch via the
  Radar edge), the startup acknowledgment, assignment request retention (6516),
  assignment status normalization (7448), and the response-contract result path.
- **Cascade close and assignment locking**: `cascade close revalidates the parent
  generation under its assignment lock` (controller-lifecycle), and the close
  family in `recovery.test.ts`. Neither depends on Manager, so the existing code paths
  must not be cut to remove Manager.
- **Supervision for Chief and Lead**: Chief direct-Lead listing and messaging
  (`staff_list`, `staff_inspect`, `staff_transcript`, `staff_message`), `chief_message`,
  `lead_message`, peer presence and peer messages (`peer_list`, `peer_message`), the
  unassigned-Lead route to Chief (controller-api 311; commands 1625), and the Chief
  preflight (controller-api 519).
- **Retained-worker relaunch and continuation**: the 12 population-B tests stay for
  the P2 slice; do not change their Herdr-backed code while removing Manager.

## 8. Deletion order

Tests first, so each step shows a measured effect:

1. Delete the Manager-only tests and helper (controller-api 45, commands 6,
   presentation 5, supervision 4, smoke-runner 24 with its imports). Amend the four
   mixed tests (controller-api 168, commands 1468, supervision 1725 and 1758).
   Expected: the 27 controller-api failures and the Manager commands failures (1 in the
   check log, 2 in the gate log) disappear with their tests.
   This step is the only one whose effect on the failure count is directly measurable.
2. Remove entry points: `/manager` command (14813), `activateManager`/`leaveManager`
   (11478–11587), `managerLease` state, `controllerRole` `"manager"` branches
   (11428–11477, 11743–11803, 17135–17235), peer Manager check (15092–15097).
3. Remove the Manager action surface: `staff_delegate/stop/complete/discard` (15623–15720
   registrations, 15218–15230 guards), `delegateProjectLead`, `stopProjectLead`,
   `resolveProjectWork`, `assertManagerCurrent`, the Manager dashboard menu items.
4. Remove the Manager projection: `loadSupervisionSnapshot`'s worktree branch,
   `projectWorkSnapshot`, `managerSupervisionItems`, `managerPresentationSnapshot`,
   `refreshSupervision` Manager parts, `managerSupervisedLeadSessionIds`, Chief
   `managers` report branch.
5. Remove the Manager lease and vocabulary: supervision.ts 1423–~1670 and the
   `managers` runtime key, `"manager"`/`"manager_message"` vocabulary, `OPERATOR_ROLES`,
   `project_assignment` (only if D2 says so).
6. Remove the smoke scenario and its test helpers (`scripts/smoke.mjs`), and the
   `AGENTS.md` line.
7. Docs and ADRs: supersede ADR 0012, amend 0024/0028/0033, rewrite the docs in §5.1,
   delete `project-orchestration.md`, record the removal in a new ADR.
8. Re-run only the affected suites (controller-api, commands, supervision,
   presentation, smoke-runner) and regenerate the failure ledger. Do not claim a
   pristine baseline.

Do not run `prettier --write` on `index.ts` or `radar-client.ts` (cutover constraint
#5071). Format test files only.

## 9. Decisions for the lead

- **D1. Chief after Manager removal.** Chief is documented as "an optional runtime-wide
  supervisor above Managers" and "can directly supervise its ordinary Leads"
  (README 95–96). This plan keeps Chief's direct-Lead supervision and drops only its
  Manager-report branch. That is the reading that keeps Chief scope explicit. If Chief
  should go too, it is a separate removal and a separate ADR.
- **D2. `project_assignment` transport.** Every producer is in Manager code
  (index.ts 12650, 12725, 13015). Its Lead receiver (10849, 11212–11236) and
  `supervision.test.ts` 2239 are the only consumers. Confirm it has no other
  producer before deleting the kind; otherwise keep the kind and remove only its
  Manager producer.
- **D3. Durable state written under Manager.** Persisted `controllerRole` entries
  of `"manager"`, and the `<runtime>/managers/` lease descriptors, outlive the code.
  Choose: (a) map a persisted `"manager"` role to Lead and leave the directory
  alone, or (b) also delete the directory and its entries. Option (a) matches the
  existing fail-closed handling in `resolveControllerRole`; state it in the ADR.
- **D4. Smoke scenario.** The `manager-recovery` smoke is the only end-to-end check of
  the Manager path. Removing it means no live Manager acceptance remains. Confirm
  that is intended.
- **D5. Failure ledger.** After removal the check log should show 22 failures in
  place: 8 relaunch and 2 ordinary parent controller-api tests, 2 commands Herdr
  read-gate tests, 5 agent-runtime, 1 controller-lifecycle, 4 observation-refresh.
  The gate log adds 4 relaunch and 5 ordinary controller-api failures that Manager
  removal does not touch. These counts are an inference from the attribution above,
  not a measured run.

## 10. Risks and limits

- The two whole-file timeouts (`controller-api`, `commands`, 120 s each in the check
  log) mean some tests in those files may not have reported. The attribution above
  covers reported names only. The gate log ran without the file-level timeout and
  is the better source for controller-api.
- Attribution used name lookup and body reads, not a test run. Line ranges for the
  end of `delegateProjectLead` (≈13095) and `loadSupervisionSnapshot`'s worktree
  branch (≈11976–12026) were not read to the brace.
- `closeHerdrPane` has no production caller. Its deletion is correct and is not
  part of Manager removal; it is noted here so the herdr.ts slice removes it.
- Nothing here was validated by running tests. Every "passes today" claim comes
  from the absence of the name in the failure logs, not from a fresh run.

## 11. Status after the supervision, presentation and docs pass

Measured with `node --experimental-test-module-mocks --import=./scripts/test-env.mjs
--test --test-concurrency=1 --test-timeout=60000`, whole files, exit captured directly:

| File | Before (this pass) | After |
| --- | --- | --- |
| supervision.test.ts | 51 tests, 50 pass, 1 fail (D3) | 51 pass |
| presentation.test.ts | 68 pass | 68 pass |
| session-metadata.test.ts | 7 pass | 7 pass (unchanged, see blocked) |
| commands.test.ts | 78 pass (`zero-runtime` flaky) | 78 pass |
| controller-api.test.ts | 65 tests, 46 pass, 18 fail, 1 cancelled | 65 tests, 46 pass, 18 fail, 1 cancelled |

Corrections to this document:

- `verifyLiveChief` is not unused. The inbox drain passes it (`inboxOptions(false, true, ...)`
  and `inboxOptions(active, active, ...)`), so it stays.
- `managerDiagnostic` is renamed `leadDiagnostic` (env `PI_HERDSMAN_LEAD_DIAGNOSTICS`,
  log tag `pi-herdsman-lead-diagnostic`). It instruments Lead inbox drains and is gated on
  Lead scope, so the Lead name is the owned one. No document named the flag.
- The `supervision.test.ts` peer tests read the machine's live peer registry (agent
  directory, not isolated). They passed only while no Lead was live. Fixed by isolating
  `PI_CODING_AGENT_DIR` at the top of that file; no assertion changed.
- `zero-runtime reconciliation requests one status refresh` no longer uses a fixed
  settle loop. It waits for the held status read to reach the daemon (wrapping
  `observeInventory`), asserts the widget does not show the agent at that point, then
  asserts it appears after release.
- `index.ts:1383` (`pi` in `acknowledgeRadarLaunch`) is fixed by passing `pi`. The
  identifier was a runtime `ReferenceError` on the startup-acknowledgment failure path.

Blocked, awaiting owner release of excluded files:

- `claimManagerLease`, the Manager descriptor family, the `managers` runtime key and
  `writeDescriptor`'s Manager type stay. `extension-contract.test.ts` imports
  `claimManagerLease` at line 16 (unused there).
- The project-assignment and project-message store stays. `controller-api.test.ts`
  imports `writeProjectAssignment` and `listProjectMessages` (line 24-25) and asserts
  `listProjectMessages` at line 245.
- `session-metadata.ts` `OPERATOR_ROLES` still contains `"manager"`. That file is not in
  the allowed list. `session-metadata.test.ts` lines 113 and 117 still treat it as a valid
  operator role, so that test is unchanged.
- Radar type names still missing from `index.ts`: `RadarInventory` (3440, 3444, 4297),
  `RadarLocationResolution` (1027, 1030, 1053) and `RadarObservedSession` (4287). The
  definitions exist: `RadarInventory` at `radar-client.ts:222`, `RadarLocationResolution` at
  `radar-location.ts:17`. These are type-only, so they break `tsc` but not the running
  extension. `radar-client.ts` and `radar-launch.ts` type errors belong to the Radar work.
- `index.ts` `paneId` on `HerdrStartPlacement` (8761) sits in the Radar spawn path, owned
  by that work.

## 12. Lease, store and operator-role removal (closing pass)

Removed: the Manager lease family and `managers`/`assignments` runtime keys in
`supervision.ts` (30 declarations by ast-grep rule, verified before applying); the
project-assignment and project-message store with its two store tests; the
`"manager"` operator role in `session-metadata.ts`; `retainSupervisionSelection`
in `presentation.ts` (test-only); the `readProcessLockStatus` import.

D3 holds: a persisted `manager` role reads back as `lead` in `session-metadata.ts`
(new test) and in the three supervision readers (existing test). The `managers/`
directory is no longer created or read.

Radar type imports: `RadarInventory` (radar-client.ts) and `RadarLocationResolution`
(radar-location.ts) are now imported in `index.ts`; both resolve. Remaining Radar
errors are reported separately, not stubbed.

Measured, whole files, package flags, `--test-concurrency=1 --test-timeout=60000`,
exit captured directly (`bg-502` for the first five; extension-contract re-run alone
after its expectation fixes):

| File | Result |
| --- | --- |
| supervision.test.ts | 49/49 pass, exit 0 (was 51; two store tests removed) |
| session-metadata.test.ts | 8/8 pass, exit 0 (one D3 test added) |
| extension-contract.test.ts | 47/47 pass, exit 0 (was load failure; 4 stale Manager-tool expectations fixed) |
| controller-api.test.ts | 65 tests, 46 pass, 18 fail, 1 cancelled, exit 1 (unchanged population, see below) |
| commands.test.ts | 78/78 pass, exit 0 |
| presentation.test.ts | 68/68 pass, exit 0 |

controller-api's 19 failing names are the attributed 12 retained-worker relaunch and
continuation tests plus 7 ordinary tests. The cancelled test is the relaunch-close
test at the 60 s timeout. No Manager-named failure remains.

Open, not closed by this pass:

- `zero-runtime` oracle is not mutation-sensitive. Breaking the hold (writing the held
  `mux.observe` reply without waiting on the gate, in `support-radar.ts`) left the test
  green. The negative assertion runs one microtask after the read arrives, before the
  reply can cross the socket, so the widget cannot have changed by then. The mutation
  was reverted; `support-radar.ts` is byte-identical to its pre-mutation copy and is
  outside this pass's allowed scope. Making the oracle red needs a "reply written"
  signal from the fixture: a decision for the owner.
- `RadarObservedSession` (index.ts 4281) is not imported. `radar-client.ts:178` exports
  it, so this is an import fix, not a missing definition. Not applied, per the brief.
- `paneId` on `HerdrStartPlacement` (index.ts 8755) is reachable: `physicalPlacement`
  (index.ts 1753) only ever returns `{kind: "split"}`. The error is the declared union
  return type, not a runtime bug. Fix is a narrowed return type, not applied.
- `RadarInventory` still mismatches at index.ts 11362 and 11661 and in radar-client.ts
  1341. Those are type mismatches in Radar work, not missing names.
- ADR 0034 cites "Option A of the child-identity decision". No such decision is recorded
  in `docs/adr` or the scope documents; it needs to be recorded or the reference reworded.
- `moveSupervisionSelection` (presentation.ts) is also test-only. Not removed; same rule
  applies if the owner wants it.

## 13. Closing pass: oracle, type defects, ADR reference, helpers

Done in this pass:

- `zero-runtime` is mutation-sensitive. `support-radar.ts` now reports whether the held
  `mux.observe` reply has been written (`replyWritten()`). The test asserts the reply is
  not written while the read is held, the widget has not reconciled, then the reply is
  written after release and the widget reconciles. Under the broken-hold mutant (the
  reply written without waiting on the gate) the test fails on the first assertion
  ("the status reply was written while its read was held"). Unmutated it passes. The
  fixture was restored from a pre-mutation copy and is byte-identical (sha256 af1c644e).
- `RadarObservedSession` is imported as a type from `radar-client.ts`. Its errors at
  index.ts 4281 are gone.
- `paneId` at index.ts 8755 is fixed by narrowing `physicalPlacement`'s declared return
  to `Extract<HerdrStartPlacement, { kind: "split" }>`. The function has one success
  return (`{kind: "split", paneId}`) and every failure path calls `fail(...)`, which
  throws. No branch returns a tab placement, so the narrowing is exact and no guard or
  cast was needed.
- ADR 0031 has a "Legacy child identity (Option A)" clause. ADR 0034 cites it by name.
- `moveSupervisionSelection` and its test block are removed. The selection test keeps its
  rendering assertions. `peerRecordPath` is removed; it had no caller.

Measured, whole files, package flags, `--test-concurrency=1 --test-timeout=60000`, exit
captured directly:

| File | Result |
| --- | --- |
| commands.test.ts | 78/78 pass, exit 0 |
| presentation.test.ts | 68/68 pass, exit 0 |
| supervision.test.ts | 49/49 pass, exit 0 |
| session-metadata.test.ts | 8/8 pass, exit 0 |
| extension-contract.test.ts | 47/47 pass, exit 0 |
| controller-api.test.ts | 65 tests, 46 pass, 18 fail, 1 cancelled, exit 1 (same 19 names as section 12, none Manager-named) |

`git diff --check` is clean across the touched files. No Manager vocabulary remains in
production code except the two D3 normalisers (`supervision.ts` and `session-metadata.ts`),
which read a persisted `manager` role as `lead`.

Open, not closed by this pass:

- `physicalPlacement`'s narrowing is a signature change. Callers outside index.ts 8613 were
  not audited because there is one.
- The three lead-snapshot `paneId` errors at index.ts 11698, 11955 and 11961 predate this
  pass. `SupervisedLeadSnapshot` has no `paneId` on HEAD either. They belong to the Radar
  work and were not touched.
- ADR 0031's Consequences section repeats the paragraph "The refusal is not parsed for an
  incumbent handle...". That duplicate predates this pass and needs a one-line removal by
  the owner.
- `RadarInventory` mismatches at index.ts 11363 and 11662 and radar-client.ts 1341 are the
  next slice, not touched.
