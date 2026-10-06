# Pre-extraction local adoption scope

Read-only scoping completed by the owner after the replacement worker failed with provider 503 ALL_TARGETS_SKIPPED. No production source edits, integration, or full gates. This report uses prior agent evidence plus a new isolated three-way file comparison.

## Targets and provenance

- Adoption baseline: upstream `156b1c661a2e147d6bb2ef415abe44dd6b11af2f`.
- Maximal pre-extraction target: `6f166a67e997791a6bc25d38cbcf4dcea14ce470`, parent of #238 (`4b3747b`).
- Target is v0.19.1 plus two documentation commits. Runtime integration cost is the same as v0.19.1; changed paths from release to boundary are AGENTS.md, docs/README.md, docs/adr/0014-use-integration-agnostic-orchestration-primitives.md, docs/development/product-philosophy.md.
- Upstream history/relevance evidence: `.pi-herdsman/pre-extraction-upstream-scope.md`.
- Prior local delta and selective applicability evidence: `.pi-herdsman/upstream-integration-local.md`.

## Measured textual integration surface

Method: enumerate tracked files in upstream baseline and target using `/tmp/upstream-herdsman.git`. For every upstream-changed path, compare actual local package bytes with base and target. Where both sides changed text, invoke `git merge-file -p local base upstream` on copies in a private /tmp directory. No merge into the repository and no broad package replacement.

Artifact: `/tmp/pre-extraction-scope-wi8jgxy4/report.json`; per-file three-way outputs are sibling numbered directories. Local snapshot is the working-tree content at probe time, not a claim about every historical local commit.

| Classification | Upstream-changed files |
|---|---:|
| Local equals base: upstream change can be taken textually | 28 |
| Both changed: textual three-way merge succeeds | 11 |
| Both changed: textual conflicts | 19 |
| Total | 58 |

156 conflict blocks across all files. Six production extension sources contain 59 blocks:

| File | Blocks |
|---|---:|
| extension/index.ts | 35 |
| extension/mailbox.ts | 8 |
| extension/support.ts | 8 |
| extension/core.ts | 6 |
| extension/herdr.ts | 1 |
| extension/presentation.ts | 1 |

Remaining conflicts are tests, docs and package artifacts. Conflict-block counts are not effort estimates: one block can combine several behaviors, and a clean textual merge can still break semantics. Files unchanged upstream and local-only modules are outside this changed-path count; their integration hooks must still be tested.

Unlike latest upstream, this target does not relocate controller/Lead/worker runtime into extracted files. It therefore avoids re-homing the local modules merely to adopt this baseline.

## Stage 1: urgent, independently landable performance repairs

1. Adapt upstream #229 as one coherent periodic-observation change: remove full-transcript lead-boundary/name reads, use coordination state for breadcrumb proof, disable legacy transcript fallback on periodic paths, reuse local pane-name facts, and serialize/coalesce supervision refresh.
2. Preserve explicit transcript/continuation identity checks, unknown/lost distinctions, settlement/recovery, and existing generation guards. Missing/malformed coordinator evidence must remain unknown; do not promise identical breadcrumbs for legacy leads lacking coordinator records.
3. Verify no SessionManager.open calls during unchanged lead/worker/supervision refreshes; verify legacy definition behavior without silently retaining an unknown definition as authoritative cached identity.
4. Full package validation, followed by live before/after idle read-rate sampling and session reload. Tests alone do not establish actual deployed CPU/RSS improvement.
5. Scope #258's global listAll elimination separately. It is post-extraction; port intent at the single local unresolved-worktree lookup using exact persisted-path evidence and fail-closed identity checks. Do not import unrelated stats aggregation. This is an explicit-action performance issue, not the measured idle timer bug.

No broad durable schema, tool-definition, Pi baseline, or module-layout change belongs in Stage 1.

## Stage 2: adopt pre-extraction upstream with explicit local overlays

Goal: adopt upstream behavior wherever compatible, rather than cherry-picking only convenient lines. Preserve intentional differences as named overlays with narrow call sites and tests. Do not falsely claim a complete target adoption if commits were skipped without recording those deviations.

Suggested integration process:

1. Freeze original upstream target SHA and its path-rewritten mirror identity using repository adoption tooling. Use an isolated integration tree. Never rewrite the actual working copy to run a baseline.
2. Carry upstream changed files and reconstruct local overlays against that target, using three-way results as evidence, not automatic acceptance.
3. For each semantic conflict, decide upstream behavior vs retained local override and attach its regression. Drop duplicate local implementations when upstream provides the same behavior and compatibility is demonstrated.
4. Keep patch groups explicit in commits/provenance. Record local file, hook, invariant, upstream counterpart, and test for each retained override. Advance adoption baseline only after reconciliation, not merely because #229 was ported.
5. Treat #238 extraction as a later separate architectural step. The target improves baseline comparability but later runtime patches still require extracted modules or manual re-homing.

## Local patch groups and seams

These are proposed grouping/interface goals, not claims that new interfaces have been implemented.

| Overlay | Existing modules or code | Intended seam and rule |
|---|---|---|
| Definition and launch policy | agent-definitions.ts, config.ts, agent-skills.ts | Resolve/validate effective launch inputs once before argv construction; preserve modelScopes, disabledDefinitions, field provenance, skill roots and preloaded skills. Keep provider discovery explicit. |
| Persistent-worker lifecycle | lifecycle/continue/close code in index.ts | Share exact-generation validation and locked lifecycle actions; retention/reuse remains an intentional behavior override. Avoid separate implementations for model tools and operator controls. |
| Delegation and response contracts | briefs.ts, response-contracts.ts, response-validation.ts | Validate admission and result construction at their real seams. Preserve launch-profile fallback, typed rejection surface, correction limits and tool-call/empty-generation distinctions. |
| Background settlement | background-waiting.ts, idle-wake.ts, settlement code | Provider evidence and assignment completion drive hold/recovery; metadata must never decide correctness. Preserve result certification, wake semantics, retry backstop and prior-request recovery. |
| Operator controls | control.ts | File transport/admission invokes shared lifecycle actions; identity and assignment checks stay under the same lock. Do not let UI controls bypass those actions. |
| Pane/awaited facts | pane-metadata.ts, awaited-facts.ts | Publish snapshots from state-change hooks. Fact publication is best-effort and cannot fail a model turn or acquire ownership authority. Preserve local token contract instead of introducing a second publisher. |
| Session organization | session-metadata.ts plus fresh-launch argv hook | Fresh worker path selection only; resume/restart uses exact saved path. Metadata tied to exact own session ID remains discovery-only. Operator storage follows deployed policy, not the historical now-reverted global sessionDir switch. |
| Mailbox/results compatibility | mailbox.ts, storage.ts, core.ts | Preserve legacy read/migration and long-lived-owner request compatibility. Reconcile upstream result reservations without treating v5 or semantic refs as absent local features. |

Most local modules already exist. The important new work is concentrating their integration call sites and making intentional overrides visible, not creating a generic plugin/hook framework.

## Decisions required in broader adoption

- Upstream build-equality gate (#219): desirable mixed-build diagnostics versus refusal of intentional long-lived mixed-version participants. Adopt only with explicit compatibility policy.
- Project Lead coordination/prompt changes (#201/#220/#224): upstream staff_delegate/staff_resume split and orchestration-first policy versus local role/brief guidance. Preserve role ownership and approved tool surface; do not conflate this with agent_continue.
- Durable result reservations (#211/#213): new disk-backed allocation semantics must preserve local lineage, legacy migrations and published ref stability.
- Project-assignment payload bounds (#217): distinct from local inline/mailbox limits; integrate configuration and refusal semantics coherently.
- Worktree retirement (#226): retirement should terminalize correct project work without defeating retained worker recovery or deleting its resumable session.
- Pane/supervision status (#215): integrate presentation improvements through the existing local metadata publisher.
- Pi package baseline (#209): changing tests from 0.99.2 to 1.0.0 requires tool-surface/runtime verification; no hidden runtime upgrade in urgent fix.
- Docs/ADRs: upstream and local use some same ADR numbers for different decisions. Preserve provenance and distinguish filenames/ownership in the index rather than silently overwriting decisions.

## Validation gates

- Periodic transcript-free regressions for lead, worker leaf, health and supervisor paths; malformed/missing coordination state; legacy definitions.
- Retained worker reuse/relaunch; proven lost versus unknown; generation replacement race; exact old/new saved session paths.
- Old owner/new worker request compatibility; real rejection reason and durable rejection acknowledgement; result ref uniqueness/recovery if reservations adopted.
- Background result capture/certification, held settlement and recovery; no mid-tool settlement; provider errors not incorrectly reported as successful work.
- Model/definition/skills behavior and deployed thin-stack tool surface.
- Operator close/restart path and metadata/session fork isolation.
- Complete package gate and strict OpenSpec validation; live launch/continue/control and idle-read smoke on deployed builds.

## Limits

No semantic merge, full package gate, or actual implementation was performed. Whole-target comparison measures textual fit only. Proposed patch groups are architectural scope, not audited equivalence of every changed function. Prior selective #229 tests ran on an isolated copy only. Provider failure left no replacement-worker report; this owner-produced artifact does not claim that agent completed its assignment successfully.
