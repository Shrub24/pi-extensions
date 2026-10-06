# Pre-extraction upstream scope: exact boundary, window inventory, two-stage adoption

Read-only upstream scoping plus evidence reuse from the prior audits. No production edits,
no merge/rebase/cherry-pick, no local conflict experiments (tracer's), no package gates.

## Summary

The latest upstream revision before the #238 module extraction is
**`6f166a67e997791a6bc25d38cbcf4dcea14ce470`** — the documented parent of `4b3747b` (#238),
`git describe` = **`v0.19.1-2-g6f166a6`**, i.e. the **v0.19.1 release commit `14d46b1` plus two
docs commits** (`31e0865` #233, `6f166a6` #234). It is *not* v0.19.1 itself, and it is *not*
v0.21.0; every release after v0.19.1 (v0.20.0 `ab361f0`, v0.20.1 `9685129`, v0.21.0 `330299f`)
is post-extraction.

The window `156b1c66..6f166a6` is **20 commits** (versus **45** to v0.21.0), and it **already
contains the perf fix** `f4f249a` (#229) as a normal commit. So the urgent fix is not a port
target of the boundary adoption — it is what the boundary adoption would deliver; porting it
*alone* is the tracer's adaptation plan, and that plan is unaffected by this boundary.

Corrections carried forward from the tracer's local artifact: the mailbox protocol is **already
v5 locally** (the `mailboxes-v4` directory is a stale label) and the semantic result-ref grammar
**already exists locally** (ADR 0001); upstream's deltas there are lineage and reservation
semantics, not absent features. New evidence in this file: **#229's diff applies strictly (fuzz 0)
to its declared base `9789734`**, and the one hunk that refuses to apply to our take does so
because of `d77655e` (#215), which restructured the pane-metadata `--token` block.

## 1. Exact boundary and release context (verified)

```
$ git rev-parse 4b3747b^                 -> 6f166a67e997791a6bc25d38cbcf4dcea14ce470
$ git log --oneline 4b3747b^..4b3747b    -> 4b3747b refactor(runtime): extract extension runtime boundaries (#238)
$ git describe 4b3747b^                  -> v0.19.1-2-g6f166a6
$ git rev-list --count 156b1c66..4b3747b^ -> 20
```

- Coldest/isolation check: only `4b3747b` sits between the boundary and the extraction, and the
  extraction itself is a single commit (the `#238` refactor was not spread over several PRs).
- Release context inside the window: `9789734` = **v0.19.0**, `f4f249a` = PR #229 (the perf fix),
  `14d46b1` = **v0.19.1** (release notes describing #229), then two docs commits.
- Timeline: window ends 2026-10-03 12:04 +02:00; `#238` is dated 2026-10-03 18:19 +02:00 — the
  boundary is roughly six hours before the extraction, not a later release.
- `f4f249a` also touches only files that exist in the pre-extraction layout
  (`extension/{index,supervision}.ts` + tests), so the fix and the boundary are aligned.

## 2. Window inventory: baseline → `6f166a6` (20 commits, oldest first)

Classes: **match** = already satisfied locally by different mechanism; **adopt** = behaviour we
lack and could take; **conflict** = upstream behaviour replaced by a local contract;
**decision** = policy choice with no implementation content; **skip** = docs/tests/release.

| Commit | PR | What the diff changes (verified) | Benefit for our workflows | Class |
|---|---|---|---|---|
| `5909f7d` | #201 | Adds `SUPERVISOR_STATE_TYPE` (`pi-herdsman-supervisor-state`), `latestLeadResponseSince()`, `projectAssignmentPath`; Lead prompt rewritten; `index.ts` +445/−; `support.ts` | Automated Manager handoff + supervisor awareness (local has neither symbol) | adopt/decision |
| `3e7692b` | #212 | docs only (7 lines) | — | skip |
| `e9a4766` | #210 | live-smoke harness hardening (+1627/−672, tests) | — | skip |
| `9015413` | #209 | Pi baseline 0.99.2 → 1.0.0 in `package.json` + lock; **no code** | Needed only if we adopt the window wholesale | decision |
| `5a29780` | #211 | Mailbox payload: `resultBindings`, `ambiguous` result code, storage `ResultBinding`; index/supervision/mailbox/core churn (26 files) | Local already v5 + refs; delta is reservation/lineage | decision (see §5) |
| `9688a33` | #213 | `reserveSemanticResultRef()`: crash-safe `result-ref-reservations/<label>/<index>` with `wx` + fsync | Crash-safe label-scoped index (local computes from session entries) | decision (see §5) |
| `40cb1a2` | #216 | Restores project-message rendering (presentation +5 lines in index) | Small rendering fix in the project-message UI | adopt (if touched area exists locally) |
| `d77655e` | #215 | Supervision/Lead-status alignment: `presentation.ts` +112, `supervision.ts` +22, `herdr.ts` +14, `index.ts` +50; adds `--token`/`--clear-token` for `pi_herdsman_herd_run_started_at` / `pi_herdsman_context_percent`; restructures `leadMetadataQueue` | Richer supervision status; **and the chronological prerequisite for #229 hunk 10** | adopt (surface overlaps local `pane-metadata.ts`) |
| `01f9b27` | #217 | `projectAssignmentBytes` config, assignment identity checks before delivery, bounded payloads (`index.ts` +117/−) | Bounded project-assignment payloads (local has only inline/mailbox limits) | adopt/decision |
| `382a188` | #220 | Splits `staff_delegate` / `staff_resume` (`index.ts` +456/−, staff docs 50) | Cleaner resume-vs-delegate contract | conflict (local has `staff_delegate`/`staff_stop`/`staff_complete`, resumes via `staff_delegate` + branch, `index.ts:11443`) |
| `fd2de5a` | #219 | `compatibility.ts`: extension-file sha256 build identity, `requireCompatibleBuild` gating peer/chief coordination (18 files) | Fleet refuses mismatched live builds | decision |
| `b38a6d3` | #221 | Places pre-turn synthetic context before the user message: `pi.sendMessage(..., { triggerTurn: false })` ordering | Correct prompt ordering; local uses the same call shape (`index.ts:10176`, `:13373`) — ordering must be checked locally | adopt/verify |
| `e75a7dd` | #223 | File-handoff guidance consistency across roles (docs + `index.ts` +33/−) | Prompt-guidance alignment with local file-handoff policy | adopt (low risk) |
| `85a4ddf` | #224 | Orchestration-first Lead prompt (`index.ts` +47/−) | Prompt/policy for managed Leads | conflict (local lead/brief/profile policy) |
| `ad403ad` | #226 | Retires project work on Herdr worktree removal: `retireRemovedProjectWork()`, `RemovedHerdrWorktree`, `herdr.ts` +39 | Project lifecycle correctness on worktree removal | adopt |
| `9789734` | #176 | release 0.19.0 | — | skip |
| `f4f249a` | #229 | The periodic-read fix (see prior audits) | Removes the measured idle burn | **adopt (urgent)** |
| `14d46b1` | #230 | release 0.19.1 | — | skip |
| `31e0865` | #233 | docs: product philosophy (100 lines) | — | skip |
| `6f166a6` | #234 | docs/ADR: integration-agnostic orchestration primitives (98 lines) | — | skip |

Substance count: 13 behavioural commits (+ 2 releases, 3 docs/tests, 2 more docs commits inside
the boundary). Nothing in the window touches the 2 s cadence or the Herdr snapshot path except
the `#238` refactor itself (verified earlier with `-S statusTimer` / `-S herdrSessionSnapshot`),
so **#229 remains the window's only periodic-read fix**.

## 3. Already matched locally vs upstream behaviour to adopt

Already matched (do not re-implement):

- #239's removal of `constrainedSampling: { strict: "prefer" }` — post-extraction anyway, and
  local `index.ts` has **0** occurrences against 16 in the take.
- Mailbox protocol v5 with legacy v4 acceptance (tracer: `MAILBOX_PROTOCOL_VERSION = 5`,
  `LEGACY_MAILBOX_PROTOCOL_VERSION = 4`, directory still named `mailboxes-v4`).
- `result:<label>#<index>` ref grammar and model-facing advertisement (ADR 0001, `core.ts`,
  `storage.ts`).
- Pane-metadata publishing incl. `pi_herdsman_role` / `pi_herdsman_name` (`index.ts:8938-8939`,
  `pane-metadata.ts`) — the mechanism #215/#229 hunk 10 builds upstream.
- Retained workers, control requests, session metadata, awaited facts, soft deadline — local
  contract set that upstream does not have at all.

Behaviour to adopt from the window: #229 (urgent), then #221/#223 (ordering and guidance),
#226/#217 (lifecycle + bounded payloads), #215 (supervision surface), #219 (build gate),
#201/#211/#213 (coordination + durable identity, each with its own failure analysis),
and #216 (small rendering fix).

Compatibility decisions that are not implementation: #209 Pi baseline, #219 fleet gate,
#201/#220/#224 coordination and prompt policy, #217 config naming, #211/#213 durable-identity
lineage.

## 4. Stage 1 — urgent fix-first bundle (before any broader adoption)

Contents (per the tracer's hunk mapping; upstream `f4f249a`, adapted not applied):

1. Delete `persistedSessionName` + `isLeadSessionBoundary` (local `index.ts:2269-2294`).
2. Replace the Lead proof inside `managedAgentSnapshots` with
   `readLeadCoordinationState(supervisionRuntime(), ownerSessionId)` role `"lead"`, keeping the
   existing live-agent/pane guards and a `try/catch` → "unknown".
3. Thread `allowTranscriptDefinitionFallback` through `managedAgentSnapshots` /
   `agentSnapshotView`; make `agentDefinitionForRuntime` / `runtimeForListedAgent` return
   `"unknown"` instead of opening legacy transcripts.
4. Pass `false` from `loadStatusSnapshot`, `scanAgentHealth`, and the supervision snapshot.
5. Serialize/coalesce supervision refresh.

Boundaries: periodic observation only — no module layout change, no durable format change, no
definition-contract change, no Pi-runtime change, no operator-surface change.

Prerequisites: **none semantic** (`readLeadCoordinationState`, `supervisionRuntime`,
`retiredManagedSession`, `sessionAgentIdentity` already exist; live leads carry `role:"lead"`
coordinator records). The one *mechanical* prerequisite is chronological: `d77655e` (#215)
is what makes hunk 10 apply — we re-derive hunk 10 against local pane metadata instead of
adopting #215.

Verification (bounded, not full gates): upstream test hunks (10/10 strict on local per tracer),
`extension/commands.test.ts` (status-refresh coherence), `extension/controller-lifecycle.test.ts`,
`extension/supervision.test.ts`. Acceptance: lead tick `SessionManager.open` count 2 → 0, worker
leaf 2 → 0, supervision name reads 0, breadcrumb/rows byte-identical.

Optional companion, not part of #229: the `#258` intent (drop the single global
`SessionManager.listAll()` at local `index.ts:11650`) — post-extraction, so re-derived locally,
not cherry-picked; upstream's replacement is entangled with session-path identity rules we do not
have.

## 5. Stage 2 — broader catch-up to `6f166a6`, and what it does/does not buy

**What it buys**

- The 20-commit window stops being "drift we carry": our local patches can be diffed against a
  revision that is genuinely upstream's, which is the precondition for the user's goal of making
  local patches explicit and separable.
- Backports from the v0.19.x line apply without rebasing across an unknown gap.
- The divergence-control argument that matters most: after adopting the boundary, **`#238`'s
  parent is in our history**, so the extraction stops being a from-scratch port and can later be
  taken or rejected as one reviewable unit. That is where minimal divergence has real leverage.

**What it does not buy**

- Cheap cherry-picking does **not** extend past `4b3747b`. All 25 post-extraction commits live in
  `lead-runtime.ts` / `agent-controller.ts` / `managed-agent-runtime.ts` / `compatibility.ts`,
  which we do not have; adopting the boundary changes nothing about their applicability until the
  extraction (or a re-homing) happens.
- Wholesale adoption is not advisable: the window contains the durable-identity work
  (#211/#213) and the coordination/prompt work (#201/#220/#224) that collide with local
  contracts, plus a Pi baseline bump (#209). Reconciliation, not import, is the shape.

**Suggested adoption order** (semantics-preserving first, policy-laden last): #229 → #221/#223 →
#226/#217 → #219 (decision) → #215 → #211/#213 (own failure analysis) → #201 → #220/#224
(decide with local staff/lead policy). This is an ordering by blast radius, not a claim that newer
is better.

## 6. Correction of earlier claims (per tracer + new evidence)

- **Mailbox "v4 → v5 gap" was wrong.** Local is already on v5 with legacy v4 read/migration; the
  `mailboxes-v4` directory is a label (`mailbox.ts:190`). The real decision is lineage: upstream
  `main` reads v5 only.
- **Result refs were not absent.** Local carries the `result:<label>#<index>` grammar (ADR 0001,
  `core.ts:79`, `storage.ts`); upstream's delta is the crash-safe reservation directory
  (`reserveSemanticResultRef`) versus local's entry-scan `max + 1`.
- **#229's prerequisites are textual and attributed.** The diff applies strictly to its declared
  base `9789734`; on our take, hunk 10 fails because `d77655e` (#215) introduced the
  `pi_herdsman_herd_run_started_at` / `pi_herdsman_context_percent` token block and moved
  `leadMetadataQueue` into hunk 10's context. hunk 18 needed `fuzz 2` on the take; that context
  drift was **not** attributed (bounded uncertainty).
- **Boundary precision.** The prior artifacts treated v0.19.1 as the fix-containing revision
  (correct) but left open whether it was the pre-extraction target: it is not — two docs commits
  (`31e0865`, `6f166a6`) follow it, and the extraction's parent is `6f166a6`.

## Contradictions

None between upstream sources. One tension worth recording: adopting the pre-extraction boundary
does **not** by itself reduce cherry-pick cost for anything after `#238`; its leverage is (a) a
clean, ownable local-vs-upstream diff up to that point and (b) making the extraction the single
next decision. Presenting it as "divergence solved" would overstate it.

## Missing evidence / uncertainties

- `h18`'s drift cause on the take is unattributed; the conclusion (fix is prerequisite-free
  semantically) does not depend on it.
- Local conflict experiments and measured hunk pass/fail rates are the tracer's; I cited, not
  repeated them.
- Whether local pane-metadata publishing already satisfies #229 hunk 10's naming intent is the
  tracer's finding (appears yes); not re-verified here.
- The two docs commits are counted as part of the boundary but their content was not reviewed.
- Relevance of post-extraction work beyond the prior audit (e.g. #241/#269 project-message
  lifecycle, #258) was not re-scoped; §5 relies on the prior matrix.
- Window commits `#210`/`#212` were not read in detail (tests/docs).

## Sources

- Boundary: `6f166a67e997791a6bc25d38cbcf4dcea14ce470` = `4b3747b^`; extraction
  `4b3747b` ([PR #238](https://github.com/boadij/pi-herdsman/pull/238)); `git describe` = `v0.19.1-2-g6f166a6`.
- Window commits (oldest first): `5909f7d` (#201), `3e7692b` (#212), `e9a4766` (#210),
  `9015413` (#209), `5a29780` (#211), `9688a33` (#213), `40cb1a2` (#216), `d77655e` (#215),
  `01f9b27` (#217), `382a188` (#220), `fd2de5a` (#219), `b38a6d3` (#221), `e75a7dd` (#223),
  `85a4ddf` (#224), `ad403ad` (#226), `9789734` (v0.19.0), `f4f249a` ([#229](https://github.com/boadij/pi-herdsman/pull/229)),
  `14d46b1` (v0.19.1), `31e0865` (#233), `6f166a6` (#234).
- Applicability evidence: `git apply --check -v /tmp/pr229.diff` in a `/tmp/v0190` checkout of
  `9789734311843b893a7e4722b0dbe850b04d665e` (exit 0, all five files), versus the same diff on the
  take tree (`/tmp/base156`), where `extension/index.ts:7464` fails and the expected context is the
  `--clear-token "pi_herdsman_context_percent"` block introduced by `d77655e`.
- Local evidence: `pi-herdsman/extension/{index,mailbox,core,storage,pane-metadata}.ts`,
  `docs/reference/{agent-definition-schema,pane-metadata,staff}.md`, plus
  `.pi-herdsman/upstream-integration-local.md` (tracer's corrected protocol/result-ref findings).

## Next steps

1. Decide Stage 1 now (upstream predicate vs the one-expression bound); it is independent of any
   boundary adoption and removes the measured burn either way.
2. If Stage 2 is wanted, run it as per-commit curation in the §5 order, starting from the
   boundary definition in §1 so the scope is fixed and reviewable.
3. Treat `4b3747b` (#238) as the next single decision after Stage 2 — not as work to slip into it.
