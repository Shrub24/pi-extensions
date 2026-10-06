# Pre-extraction upstream adoption plan (decision draft)

Status: **planning draft, not an adoption approval.** No production edit, merge,
cherry-pick, rebase or gate was run to produce it, and nothing in it settles a
material behaviour choice. The urgent #229 port is a **separate approved change**
(`openspec/changes/herdsman-transcript-free-refresh`) owned elsewhere; this file does
not re-analyse or re-implement it.

Recommended defaults are labelled *(recommended)* with reasons and the rejected
alternative. Anything else is an open decision for the operator (§5).

## 0. Provenance of the evidence used (and what is stale)

| Snapshot | Identity | Freshness |
|---|---|---|
| `/tmp/upstream-herdsman.git` (full mirror) | HEAD `330299f` = v0.21.0; contains target `6f166a6` and `v0.19.1` = `14d46b1` | fetched 2026-10-06 21:42 |
| `/tmp/base156` | single commit `56fefa9` ("base"); **tree verified equal** to take `156b1c66` tree | 2026-10-06 21:42 |
| `/tmp/v0190` | single commit `1495cd7` ("base"); **tree verified equal** to `9789734` (= v0.19.0) tree `42439a21adf1f195424b7dae7840a4dc1d957239` | 2026-10-06 21:57 |
| `/tmp/pre-extraction-scope-wi8jgxy4/report.json` | measured three-way surface, base `156b1c66` → target `6f166a6` | 2026-10-06 22:03 |
| `~/.pi-ext-mirrors/{upstream,ns}/pi-herdsman.git` | **STALE**: pristine `main` = `156b1c6` (2026-10-01) with no v0.19+ tags; rewrite tip `0a42962` and `cat-file -t f4f249a` → not found | as of this check |

Corrections to earlier artifacts, verified here:

- `/tmp/v0190` **is** the true v0.19.0 tree (tree hash equality), so the
  `upstream-integration-local.md` addendum limitation "the true v0.19.0 base is not
  present locally" no longer holds. The claim that `#229` was generated against a
  later `index.ts` than the take stands, and is now checkable against a real base.
- `scripts/upstream.sh pi-herdsman` has **not** been run: there is no
  `upstream-pi-herdsman` remote in this repo and both mirrors predate v0.19.0. Any
  cherry-pick path is described, not demonstrated.
- Local working tree is held by a peer and moved during planning (monorepo HEAD
  `88c436bdf` at check time, `3d53bcb54` earlier). Every `index.ts:<line>` here comes
  from a saved snapshot and must be re-resolved before use.

## 1. Target and import mechanism (mechanical)

- **Target:** `6f166a67e997791a6bc25d38cbcf4dcea14ce470` = `4b3747b^` (#238),
  `describe` = `v0.19.1-2-g6f166a6`, 20 commits from the take. It is *not* v0.19.1
  (`14d46b1`) and *not* post-extraction; v0.20.0/v0.20.1/v0.21.0 are all downstream.
- **Mechanism = the repository's own convention, not merge/rebase.** `scripts/upstream.sh`
  maintains two out-of-tree mirrors: a pristine mirror, and a path-rewritten copy
  (`git filter-repo --to-subdirectory-filter pi-herdsman`) published as
  `upstream-pi-herdsman`. A take is `git cherry-pick -n <sha>`; a rebase is a
  scratch clone (`git clone --shared . /tmp/rebase`). Graph roots differ between the
  two spaces, so **ids are not portable between mirrors** — resolve every pivot per
  space.
- **Step 0, before any curation:** run `scripts/upstream.sh pi-herdsman` (network) and
  confirm the rewrite contains `6f166a6`. Until then treat the two `/tmp` mirrors and
  `report.json` as read-only evidence, and never rewrite the working copy to run a
  baseline — integration happens in an isolated tree.

## 2. Classification rule (and what "the same name" must not imply)

Measured surface: 58 upstream-changed paths — 28 local-equals-base (textually
takeable), 11 clean three-way, 19 with conflicts; 156 blocks total, 59 of them in six
production sources (`index.ts` 35, `mailbox.ts` 8, `support.ts` 8, `core.ts` 6,
`herdr.ts` 1, `presentation.ts` 1). Block counts are **not** effort estimates.

Four labels, used consistently below:

1. **Upstream-identical text** — local bytes equal the take; the upstream change can
   be replayed mechanically (the 28 paths).
2. **Shared mechanism, unproven equivalence** — a same-named local feature is not
   evidence of equivalent semantics, so collapse a duplicate only after the equivalence is
   named and tested. Demonstrated equivalent: mailbox protocol is already v5 with legacy-v4
   read/migration (`mailbox.ts:29`, `:140`, `:173`). Demonstrated **not** equivalent: the
   `result:<label>#<index>` grammar is local (ADR 0001, `core.ts:85`) but its allocation is
   branch-scoped (`index.ts:3881`) and it transports no lineage, unlike upstream's reserved
   and transported identity (`pre-extraction-contract-deltas.md` §2).
3. **Deliberate local override** — local contracts upstream does not have: retention
   (ADR 0013), control requests (ADR 0024, `control.ts`), pane/session metadata
   (ADR 0017/0025/0026/0027, `pane-metadata.ts`, `session-metadata.ts`), background and
   awaited facts, briefs/response contracts (ADR 0015/0016), model policy, skills
   (`agent-skills.ts`), soft deadline/idle wake, hierarchy, and the whole `openspec/`
   tree. Preserve as named overlays with their regressions.
4. **Unresolved mapping** — textual fit known, semantics unreviewed: `#229`'s h5/h9/h18
   (fuzz-applied on local) and h10 (hard-fail, needs local re-derivation); upstream's
   post-#238 stats/lead-runtime replacements that assume exact-session-path identity
   rules local lacks.

**Rule: never infer schema semantics from a directory or file name.** The mailbox
payload is v5 while its directory is still literally `mailboxes-v4`
(`mailbox.ts:190`); a port must not "add v5" or re-migrate. Same for
`result-ref-reservations/<label>/<index>` — that path describes a mechanism, not a
schema obligation.

## 3. Per-behaviour adoption order

Ordered semantics-preserving first, policy-laden last; `#229` is excluded (owned by
the other change) and §6 states its interaction.

| # | Commit | Upstream benefit | Local equivalent / override | Conflict seam | Validation |
|---|---|---|---|---|---|
| 1 | `b38a6d3` #221 | Pre-turn context ordered before the user message | Same call shape exists (`index.ts:10176`, `:13373`); ordering unverified | `pi.sendMessage` ordering in the turn path | assert order in the local turn fixture |
| 2 | `e75a7dd` #223 | File-handoff guidance consistency | Local has its own handoff policy text | prompt docs vs `docs/reference/*` | prompt/snapshot text test |
| 3 | `ad403ad` #226 | Retire project work on worktree removal | Local retention/continuation must survive retirement | `herdr.ts` worktree hooks + lifecycle lock | worktree-removal scenario; retained-worker resume still works |
| 4 | `01f9b27` #217 | Bounded project-assignment payloads | Local has only inline/mailbox limits | assignment construction + delivery | oversized-payload refusal test |
| 5 | `40cb1a2` #216 | Project-message rendering restored | Local `presentation.ts` diverges (469 lines) | presentation render | project-message render test |
| 6 | `d77655e` #215 | Supervision/Lead-status surface via `--token` | Local publishes through `pane-metadata.ts` (`index.ts:8938-8939`) | `leadMetadataQueue` / metadata publisher | metadata fixture equality |
| 7 | `fd2de5a` #219 | Build-equality gate for live peers | none — no local fingerprint at all; only `HERDSMAN_VERSION` (`index.ts:328`) | new `compatibility.ts`, mailbox/ack validators, 16 refusal + 5 authorization sites | refusal scope is an operator choice: deltas §1 |
| 8 | `5a29780` #211 | Transported lineage (`resultBindings`), conflict rules | Grammar yes, lineage transport no (`core.ts:85`) | mailbox/core/supervision records | which half to adopt is an operator choice: deltas §2 |
| 9 | `9688a33` #213 | Crash-safe, globally monotonic per-label reservation | Local `nextAgentResultIndex` reads only branch entries (`index.ts:3881`), so a fresh branch restarts at 1 | `storage.ts` allocator + its unpruned directory | growth policy is an operator choice: deltas §2 |
| 10 | `5909f7d` #201 | Supervisor state + Manager handoff symbols | Local has no equivalent; collides with local coordinator role state | supervision core | **decision first** |
| 11 | `382a188` #220 | `staff_delegate` (task) / `staff_resume` (branch) split; **removes** `staff_complete`/`staff_discard` (both present in the take and documented locally, `docs/reference/staff.md:8,127`) | Local resumes through branch-only `staff_delegate` (`index.ts:11439-11449`) — same underlying path, different surface | staff tool registrations only | interface is thin; the tool **removals** are the operator choice: deltas §3 |
| 12 | `85a4ddf` #224 | Orchestration-first Lead prompt | Local lead/brief/profile policy | prompt policy text | **decision first** |

`9015413` #209 (Pi baseline 0.99.2 → 1.0.0) and `e9a4766` #210 / `3e7692b` #212 /
release+docs commits need no curation beyond the decision on #209.

## 4. Patch groups and hook seams (no new abstraction layer)

Each group concentrates one behaviour at a call site that already exists. These are
seams, not a plugin/hook framework: no registry, no generic dispatcher, no speculative
interfaces.

1. **Definition and launch policy** → `agent-definitions.ts`, `config.ts`,
   `agent-skills.ts`. Resolve/validate effective launch inputs once before argv
   construction; keep modelScopes, disabledDefinitions, field provenance, skill roots.
2. **Persistent-worker lifecycle** → lifecycle/continue/close code in `index.ts`, under
   the existing lifecycle lock. One implementation shared by model tools and operator
   controls.
3. **Delegation and response contracts** → `briefs.ts`, `response-contracts.ts`,
   `response-validation.ts`. Validate at admission and result construction.
4. **Background settlement** → `background-waiting.ts`, `idle-wake.ts`, settlement
   code. Provider evidence decides correctness; metadata never does.
5. **Operator controls** → `control.ts`. File transport/admission invokes the shared
   lifecycle actions; identity and assignment checks stay under the same lock.
6. **Pane/awaited facts** → `pane-metadata.ts` (single publisher, `createMetadataPublisher`),
   `awaited-facts.ts`. Publication is best-effort and cannot acquire ownership authority.
7. **Session organization** → `session-metadata.ts` plus the fresh-launch argv hook.
   Fresh selection only; resume/restart uses the exact saved path.
8. **Mailbox/results compatibility** → `mailbox.ts`, `storage.ts`, `core.ts`. Preserve
   legacy read/migration; reconcile upstream reservation semantics without treating v5
   or semantic refs as absent.

Periodic-observation seams used by the other change — `agentDefinitionForRuntime`
(`index.ts:4776`), `runtimeForListedAgent` (`:4960`), `refreshSupervision`/
`currentSupervisionGeneration` (`:11943`), the `persistedSessionName` consumer
(`:10897`), `readLeadCoordinationState` — are deliberately **not** re-scoped here.

## 5. Mechanical integration vs operator decisions

Mechanical (do not need approval in principle, only a decision to proceed): mirror
refresh; per-commit cherry-pick into an isolated tree; replay of the 28 takeable paths
and the 11 clean three-way results; handing ADR-number collisions by filename/provenance
(local 0013–0027 and upstream 0013–0016 are *different decisions at the same numbers* —
record, never overwrite); re-running local suites that carry extra cases.

Requires an explicit operator decision — recommended default given, but **not settled
here**:

1. **Build gate / mixed live versions (#219).** Warp: the gate is evaluated on
   interaction boundaries, not timers, so idle peers keep running and stay visible. Options
   with demonstrated cost (`pre-extraction-contract-deltas.md` §1): adopt the refusal as
   upstream does; adopt the fingerprint + record-identity comparisons but downgrade the
   interaction refusal to a warning; or keep status quo, which retains no identity and
   leaves mixed-version parse errors unexplained (`Unknown mailbox field`). Note the
   fingerprint is the entry-file sha, so local-only edits to `index.ts` change the build id
   by construction.
2. **Durable result reservations and lineage (#211/#213).** Options are separable
   (`pre-extraction-contract-deltas.md` §2): bindings only (transported lineage, no new
   durable state); reservations only (per-label global uniqueness, index gaps after a
   crash); both (upstream); or neither. Demonstrated gap if neither: a fresh branch restarts
   at index 1, so `result:<label>#1` can denote different canonical results across branches,
   and a handoff ref resolves only on a branch that saw the delivery. Upstream leaves the
   reservation directory unpruned; a local GC would be a local addition with its own
   allocation-race argument.
3. **Staff interface split, tool removals, and prompt policy (#201/#220/#224).**
   `pre-extraction-contract-deltas.md` §3 separates them: adding `staff_resume` is a thin
   registration over local's existing branch-only resume path and does not touch briefs,
   roles, the manager lease or worktree rules; **removing** `staff_complete`/`staff_discard`
   is a capability change with no upstream name-for-name replacement (`staff_stop` preserves
   work; #226 retirement covers worktree removal). Options: split + keep the two local
   tools, split + remove them, or keep the single polymorphic tool. #201/#224 are prompt and
   awareness text (`SUPERVISOR_STATE_TYPE`, `latestLeadResponseSince`) and are separable from
   the interface.
4. **Worktree retirement (#226).** *(recommended: adopt, with retained-worker
   acceptance)* Retirement must terminalize the right project work without defeating
   retained-worker recovery or deleting a resumable session. Unverified: whether upstream
   retirement covers the abandon/complete cases, which is now entangled with choice 3.
5. **Payload limits (#217).** *(recommended: adopt the bound, name the config to local
   conventions)* Keeps refusal semantics coherent with local inline/mailbox limits.
6. **Pi baseline (#209).** *(recommended: not in the same step as behaviour adoption)*
   The moved tests change the tool surface; it needs its own runtime verification.
7. **Supervision surface (#215).** *(recommended: integrate through the existing local
   publisher)* Do not introduce a second publisher or a parallel `--token` path.

## 6. Effect of landing #229 first; #258 out of baseline

- Landing the #229 port first removes the measured idle burn and **pre-reconciles the
  same regions** the baseline contains (`persistedSessionName`/`isLeadSessionBoundary`
  deleted, periodic fallback off, supervision coalescing). During curation, treat the
  local port as this window's version of `f4f249a` and skip that commit rather than
  re-applying it; the baseline take must not resurrect either reader.
- The baseline does **not** otherwise depend on #229, and #229 does not depend on the
  baseline: `readLeadCoordinationState`, `supervisionRuntime`, `retiredManagedSession`
  and `sessionAgentIdentity` all exist locally.
- **#258 is post-extraction (v0.20.1) and outside this baseline.** Local has exactly
  one `SessionManager.listAll()` (`index.ts:11650`, the delegate/manager
  unresolved-worktree path), which is the pre-#258 shape; upstream's replacement lives
  in `lead-runtime.ts` after #238 and is entangled with exact-session-path identity
  rules local does not have. Take the intent as a separate local change; the stats
  aggregation half is not part of this surface.

## 7. Bounded OpenSpec outline (skeleton, **not** ready)

Do not author this yet; it is recorded so the shape is agreed before work starts.

- **One baseline-alignment change with staged, independently revertible commits**, not one
  change per behaviour: the three deep contracts share one mechanism (identity carried in
  the same records) and one review seam, and over-splitting them creates merge pressure
  without isolating risk. Split out only a genuinely incompatible choice — removing
  `staff_complete`/`staff_discard`, or introducing a reservation-directory GC. Each stage
  must stand alone: adopt, verify its stage tests, and be revertible without unpicking the
  previous stage.
- Proposal: why the fork's patches should be separable against a genuine upstream
  revision; capability naming per group (e.g. a supervision/handoff capability for
  #201/#215, a results-identity capability for #211/#213) — names to be fixed only
  after §5 decisions.
- Design: mirror mechanism (§1), per-group conflict seam and retained-override list
  (§4), the acceptance set of local contracts that must survive (§2 label 3).
- Tasks: per-commit curation in §3 order, each with its regression, plus the isolated
  tree and gate tasks in §8.
- Blocked on: items 1, 2, 3, 6 of §5. Until those are answered, an OpenSpec change here
  would be a process document, not a settled runtime contract.

## 8. Exact missing evidence and next tests

Missing evidence (specific, not "explore"):

- A refreshed rewrite mirror containing `6f166a6` (network; `scripts/upstream.sh pi-herdsman`).
- Semantic review of the unresolved-mapping regions: `#229` h5/h9/h18 (fuzz-applied on
  local) and h10 (hard-fail) — including whether local pane metadata already covers
  #215's naming intent.
- The current content of the peer-held `pi-herdsman/extension/index.ts` and
  `extension/agent-runtime.test.ts` (line numbers and upstream test expectations drift as
  the peer works).
- Whether a take-era reader actually rejects a `build`-bearing record
  (`pre-extraction-contract-deltas.md` §1 inference, test 6 settles it).
- Whether the worker-side request pump also checks the build, and whether local durable
  artifacts embed semantic refs that a new allocator must keep stable.
- Whether upstream ADR 0013–0016 map 1:1 onto local decisions or require renaming.
- Resolved since the last draft: the true v0.19.0 base **is** present (`/tmp/v0190`, tree
  verified), and #219 has **no** local analogue (§1 of the deltas).

Next tests, in order:

1. Per-commit dry run in an isolated tree: `git cherry-pick -n` (or `git apply --check`
   with fuzz reporting) for each of the 12 rows in §3, recording strict / fuzz / hard-fail.
2. Three-way replay of the 11 clean paths (`git merge-file -p local base upstream`) and
   a diff review — evidence, not automatic acceptance.
3. Local contract suites for every touched override: retained-worker reuse/relaunch,
   control close/restart, exact old/new saved session paths, background settlement,
   briefs/response contracts, model policy, skills loading, pane/session metadata.
4. `npm test` and `npm run validate` on the isolated tree (plus strict
   `openspec validate` for any change authored from §7).
5. Live smoke (launch/continue/control, and idle read rate) only after the tree is
   accepted — never as a substitute for 1–4.

## 9. Limits

Textual classification comes from measured three-way runs on saved snapshots, not from
semantic merge; conflict-block counts are not effort. The mirror state is stale, so the
import mechanism is described rather than demonstrated. Every local line number predates
the peer's current edits. Nothing here approves adoption, and item-level behaviour
choices in §5 remain open.
