# Radar cutover type defects: inventory before fixes

Status: inventory only, written before any edit in this pass. Herdsman's package
gate never runs `tsc` (no tsconfig, and tests run through the module-mock loader),
so these defects were invisible to every green suite. This file is the ground
truth the fixes below are measured against.

## Method

- Compiler: `typescript@5.9.3`, `lib/tsc.js`, from the nix store (the same one the
  earlier passes used). Command, identical for both trees:
  `tsc --noEmit --allowImportingTsExtensions --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck extension/*.ts`
  run from `pi-herdsman/`. Script: `/tmp/mgr-rm/tsc-check.sh <tree> <log>`.
- Baseline: `git archive HEAD pi-herdsman pi-bash-processes` extracted to
  `/tmp/rd-head`, with `node_modules` symlinked from the working tree so only the
  source differs between the two runs.
- Comparison: each error normalised to `file | code | message` (line numbers
  removed, since most test-file errors shift), then compared as multisets.
- Counts before any fix: working tree **764**, HEAD **822** (raw, including
  `pi-bash-processes`). Multiset diff: **115** errors present only in the working
  tree, **173** present only at HEAD.
- Caveat: the `--target es2022` flag makes `Promise.withResolvers` (an ES2024 lib
  member) report TS2550 in `support-radar.ts`. That is a flag artefact, present in
  both runs' method, and the fixture is not part of the cutover contract. It is
  counted, not hidden.
- Caveat: HEAD's `index.ts` has the Manager vocabulary the removal deleted, so the
  HEAD-only column mixes resolved Manager errors with resolved Radar errors.

## Origin split (working tree only: 115 errors)

These exist in the working tree and not at HEAD. The Radar cutover (protocol-2
port, consumer cutover, untracked `support-radar.ts`) introduced them unless
marked otherwise.

### A. Radar cutover, `RadarResult` narrowing (about 60)

`call()` returns `Promise<RadarResult<unknown>>` (`radar-client.ts` 916). That
signature is HEAD's (HEAD 373–376). The cutover's typed wrappers around `call()`
(`withCapability`, `probe`, `observe`, the `spawn.*` and `registry.*` methods)
return that `unknown` straight through, so they do not match their declared
`RadarResult<T>`. Every caller that reads `.code` or `.message` off the wrapper
result then fails. Sites:

- `radar-client.ts` 734, 1015, 1080, 1101, 1116, 1140, 1157, 1176, 1205, 1211,
  1241, 1253, 1265, 1270, 1283, 1341, 1391, 1413, 1424–1426
- `radar-launch.ts` 177, 321, 489
- `radar-location.ts` 165, 192
- `radar-publication.ts` 605–616, 657–661, 972–982, 1339–1340, 1350–1351
- `index.ts` 6251, 6255, 11662, 11671–11673, 8757
- test-only mirrors in `radar-client.test.ts` (12)

Cause: the wrappers were typed against `RadarResult<T>` but the body returns
`call()`'s untyped result. Runtime is correct because each wrapper validates the
reply before returning; the gap is only that the TypeScript return type of the
validator is `unknown`.

### B. Radar cutover, `RadarLaunchOutcome` vs `BoundChild` (about 8)

`radar-launch.ts` 429–492: `RadarLaunchOutcome` is returned where `BoundChild` is
declared. Cause: the launch outcome union was added in the cutover; the return
annotation was not updated.

### C. Radar cutover, `RadarInventory` shape (3)

- `index.ts` 11363: `HerdrSessionSnapshot` passed where `RadarInventory` is
  declared. The caller (`loadSupervisionSnapshot`, 11344) takes
  `suppliedInventory?: HerdrSessionSnapshot` but `refreshSupervisionOnce` passes
  the Radar inventory. Cause: the parameter type was not updated when
  `refreshSupervisionOnce` moved to `radarFleetInventory()`.
- `index.ts` 11662 and `radar-location.ts` 192: `.code`/`.message` read on
  `RadarResult<RadarInventory>` (family A).
- `radar-client.ts` 1341: `observe()` declared `RadarResult<RadarInventory>`,
  implementation returns `RadarResult<unknown>` (family A, the wrapper).

### D. Radar cutover, the lead-snapshot field reads (index.ts 11691, 11698–11700, 11943, 11954–11962, 11973; presentation.ts 908–910)

Fields read: `instanceId`, `paneId`, `tabId`, `workspaceId`, `agents`.
`projectSupervision` (`supervision.ts` 1669–1700) writes all of them onto
`SupervisedLead`, and `SupervisedLead` declares them (1461–1476). But
`supervisionPresentationReports` (`presentation.ts` 565) returns
`SupervisedLeadSnapshot[]`, a narrower presentation type with none of those
fields. The `focusSupervisedLead` (11680–11700) and peek/inspect (11937–11962)
paths read them at runtime, and they feed the live pane and tab checks that verify
a lead before focusing it. So the reads are live, not leftovers. HEAD has the same
narrow `SupervisedLeadSnapshot`, so the narrowing predates the cutover, but the
reads that rely on the dropped fields are cutover-era code paths (the focus
verification was rebuilt on Radar).

Note: this is **not** a case for deleting the reads (the brief's default), because
the value is produced at runtime and consumed by live verification code. It is a
type-only gap: the return type of `supervisionPresentationReports` should carry
the `SupervisedLead` fields its producer writes.

### E. Radar cutover, `RadarObservedSession`/`HerdrStartPlacement` (already fixed in the prior pass)

Not in the current list. Recorded for completeness: both were fixed in the Manager
removal closing pass (type-only import; narrowed `physicalPlacement` return).

### F. Radar cutover, other (about 15)

- `index.ts` 8729 (`ResolvedAssignmentSession` vs `boolean`) — not in HEAD; new
  call-site from the cutover. Not investigated in this pass beyond recording.
- `radar-client.ts` 1140, 1157, 1176 and `1205`, `1211`, `1283`, `1391`:
  argument-type mismatches in the `RadarSpawnEdge`/`RadarRegistry` method
  signatures against the wrapper (family A's sibling).
- `support-radar.ts` 1062: `Promise.withResolvers` (target-flag artefact, see Method).
- `support.ts` 368–412, 801–808, 2274, 2293, 2479, 2503 (test fixture; several are
  present at HEAD as well, the new ones are the `ExtensionAPI` widening).
- `radar-publication.ts` 972–982 and 1339–1351: family A.

### G. Manager removal, gate-missed (working tree, not HEAD)

The Manager removal changed signatures the callers still use. The gate missed
these because it never type-checks. Found by the comparison, not yet fixed:

- `presentation.ts` 492: `StatusDisplayRow` does not declare `paneId`, but the row
  builder writes it. HEAD has the same write (HEAD 497), so this is HEAD-era, but
  the working tree surfaces it.
- `index.ts` 8755–8757 region: none new from the Manager removal.

Manager-removal-specific new errors: none found in the working-tree-only list.
The removal's own edits compile; the Manager-era errors are HEAD errors that the
removal deleted (see HEAD-only).

## Errors HEAD already had (working tree still has them)

These are in both trees. Listed by file, not fixed in this pass unless they block
the Radar import or the paneId fix:

- `index.ts` 1966, 2960, 2991 (`FileEntry`/`SessionEntry`, `string[][]` tuple): HEAD.
- `index.ts` 3829 (`SkillResolution.reason`): HEAD.
- `index.ts` 5890 (`AgentControlState` missing from `core`): HEAD.
- `index.ts` 7077, 7258, 8735–8736 (`ManagedWorkerLaunchPlan.error/stage`,
  `ControlOwnerStart.reason`): HEAD.
- `index.ts` 8257, 9347, 9498–9535, 10341, 10639 (TS1064), 10750–10757, 11174,
  11547, 12057–12064, 12294, 12639, 12678, 12764, 12820, 13493–13494, 13562–13635,
  14812, 14968, 15009–15045, 15347–15576, 16909, 17297, 17563, 17848
  (`triggerTurn`, `CustomMessage`, `ExtensionContext` vs command context, tool
  registration widening, `inactive`/`active` comparisons): HEAD.
- `presentation.ts` 2391 (`Component` vs `WidthSafeText`): HEAD.
- `response-validation.ts` 156, 358; `session-metadata.ts` 171; `support.ts`
  368–2503 (except noted above): HEAD.
- `pi-bash-processes/extensions/background-work.ts` 613, 646: HEAD (package outside
  herdsman, shared tree).

## Missing type imports (fixed in the prior pass, now verified)

- `RadarInventory` (radar-client.ts 222) and `RadarLocationResolution`
  (radar-location.ts 17): imported in `index.ts` by the Manager closing pass.
- `RadarObservedSession` (radar-client.ts 178): imported in this pass's earlier
  edits; its `index.ts` 4281 error is gone.

## HEAD-only (resolved in the working tree): 45 production, the rest test

Resolved by the Manager removal and the cutover together: the `index.ts` Manager
lead/`role` field reads (`role?: "lead"|"manager"`), `managers`/`instanceId` on
the manager report, the `"lead"` vs `"manager"` comparison, `AgentControlState`
(now absent from the call site), and the presentation `session/branch/display_name`
row shape.

## Decisions this inventory sets up

1. **`RadarInventory` mismatch (index.ts 11363, 11662, radar-client.ts 1341).**
   Compare Radar's pinned shape against our decoder before choosing a side. See
   the result section appended after the check.
2. **Lead-snapshot reads (D).** Type-only: `supervisionPresentationReports` should
   return the fields `projectSupervision` writes. Not a deletion.
3. **`RadarResult` family (A).** The wrappers should narrow `call()`'s `unknown`
   with their own validator, not change `call()`'s signature (which is HEAD's).
4. **Runtime behaviour.** Any fix in family A that changes a return value stops
   and is reported, per the brief.

## Result: RadarInventory contract check (pinned Radar tree)

Pinned tree: `/tmp/radar-head` (not a git repo; its `docs/agent-registration.fixture.jsonl`
is byte-identical to our vendored copy, sha256 `8ebf41b3`, which is the strongest
pin evidence available; the commit `f8734803` cannot be confirmed from the tree).

- Radar `src/model.rs` 551–556: `FleetObservation { workspaces: Vec<Workspace>, tabs: Vec<Tab>, panes: Vec<Pane>, agents: Vec<AgentObservation> }`.
- Radar `Workspace`: `workspace_id, label?, number?`. `Tab`: `tab_id, workspace_id, label?, number?`.
- Our `RadarInventory` (radar-client.ts 222): `workspaces, tabs, panes, agents` with the entry types
  `RadarObservedWorkspace {workspace_id}`, `RadarObservedTab {tab_id, workspace_id}`, the pane and agent types.
- Shapes match on keys and on the fields the decoder reads. The decoder builds
  exactly `RadarInventory`. **Our decoder is not stale.** The defect is the
  `observe()` wrapper's return type (family A), and the caller at index.ts 11363
  (family C), which still passes the old `HerdrSessionSnapshot` type.

## Changes made in this pass (after the inventory above)

Type and dead-branch changes only, each checked by the same compiler command.

1. `presentation.ts`: `supervisionPresentationReports` now returns `SupervisedLead[]`
   (the type `projectSupervision` writes). Already imported as a type from
   `supervision.ts`, so no new edge. Clears the lead-field reads at index.ts
   11691, 11698–11700, 11943, 11954–11962, 11973 and presentation.ts 908–910.
2. `presentation.ts`: removed the dead `leadCounts` and nested `leads` fields from
   `SupervisedLeadSnapshot`, and the rendering that read them (the widget child
   rows, the `lead_counts` and `descendant_leads` lines, and the direct-lead
   count clause). Nothing wrote either field after the Manager removal; HEAD's only
   writer was the removed `managers` report (`index.ts` HEAD 11522) and
   `SupervisedManager` (`supervision.ts` HEAD 2036). No test set either field, and
   `presentation.test.ts` passes 68/68 after the deletion.

Result: 764 → 751 errors (−13), no new errors. Those 13 are the lead-field reads
above; the rest of the diff is unchanged.

## Attempted and reverted

- Family A (`RadarResult` pass-through): I tried copying the failure arm at
  `radar-client.ts` 1015, 1080 and 1101 (`return { ok: false, code, message }`).
  It added six errors on the same lines and did not narrow. A standalone probe of
  the same union shape narrows correctly, so the cause is specific to our file and
  I did not reproduce it. Reverted; the error set is back to 751 with no difference.
  Family A is still open and needs its own look at the `call()`/`withCapability`
  typing.

## Open, reported and not changed

- **`index.ts` 11363 (`RadarInventory` vs `HerdrSessionSnapshot`) is a behaviour
  change, not a type fix.** `refreshSupervisionOnce` (index.ts 11467–11477)
  passes the Radar inventory into `loadSupervisionSnapshot`, whose parameter is
  typed `HerdrSessionSnapshot`. Inside that function `live = inventory.agents`
  feeds a `flatMap` that keys on Herdr fields: `herdrSessionId` and `isPiAgent`
  read only `agent.agent_session` (index.ts 2670–2672, 2571–2573). A Radar
  `RadarObservedAgent` has no `agent_session`, so every entry is dropped and the
  live lead list is empty on the supervision refresh path. Changing the parameter
  to `RadarInventory` would make the type match but would not fix that; it would
  silently keep the empty result. The right fix is to rebuild the live-agent list
  from the Radar inventory or the registry, which is a behaviour change and needs
  its own brief.
- **`radar-client.ts` 1341 and `index.ts` 11662 / `radar-location.ts` 192:**
  these are family A. The decoder itself matches Radar's `FleetObservation` (see
  the result section above), so the defect is only the wrapper typing.
- **`index.ts` 8729 `ResolvedAssignmentSession` vs `boolean`:** new from the
  cutover, not investigated beyond recording.
- **`presentation.ts` 492 (`StatusDisplayRow.paneId`) and 2391 (`Component` vs
  `WidthSafeText`):** HEAD-era; not touched.

## Count summary (same command, same HEAD export)

| Point | Errors | Notes |
| --- | --- | --- |
| Before this pass (working tree) | 764 | includes test files |
| After presentation.ts changes | 751 | −13, no new errors |
| HEAD (for comparison) | 822 | includes pi-bash-processes |
| After commands.test.ts Radar-fixture pass | 748 | unchanged; the normalised error set is identical to the previous pass (zero added, zero removed). The one error in the new controller-api test (line 422, the untyped `session_shutdown` call) still stands, following the file's existing pattern |
| After supervision live-agent fix | 748 | −3 vs 751: `ResolvedAssignmentSession`/8722 fixed (type-level, `resumed !== undefined`); the `HerdrSessionSnapshot` vs `RadarInventory` error (11363) removed with the signature change; two `supervision.test.ts` `tokens` reads removed with the fields. +1: the `session_shutdown` call in the new controller-api test, the same untyped-hook pattern the file already has |

## Supervision live-agent fix (this pass)

The live-agent drop is fixed; the trace is `supervision-live-agent-fix.md`. The
fix is a source change, not a type change: the Chief's supervision list now reads
the Radar observation instead of `herdr api snapshot`, and `herdrSessionSnapshot`
no longer feeds it. `ResolvedAssignmentSession` at index.ts 8722 was a type-level
error (`resumed` is a boolean in the launch builder; it passed the object), fixed
with `resumed !== undefined`, the truthiness the code already used.

Still open, not touched here: family A (the `RadarResult` wrappers) and the
`ManagedWorkerLaunchPlan` `stage`/`error` reads at index.ts 8728–8729 (HEAD-era).
Four `commands.test.ts` tests now fail because their Chief/focus fixtures put Leads
in `herdr api snapshot`, which the supervision path no longer reads; that file is
not in this slice's scope and needs a Radar-fixture rewrite.

