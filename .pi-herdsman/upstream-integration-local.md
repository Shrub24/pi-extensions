# Local compatibility and integration cost: selective upstream periodic-read port vs broad take

Read-only scoping plus isolated `/tmp` applicability experiments. No production
edits, no working-copy merge/rebase/bookmark changes, no gates. Upstream relevance
(issues/PRs/releases) is the researcher's `upstream-perf-audit.md`; this file owns
the **local** delta, conflict shape and behaviour preservation.

## Verdict in one paragraph

The fork is a **whole-tree import of `156b1c66` (upstream #196, "make project
lifecycle manager-owned")** into a jj-managed monorepo, then **97 files / +24,772 /
−3,699** of local work. That divergence is architectural, not cosmetic: local splits
new behaviour into 22 local-only modules while upstream `main` went the other way
and **extracted its ~18k-line `index.ts` into `agent-controller.ts`, `lead-runtime.ts`,
`managed-agent-runtime.ts`, `compatibility.ts`** (#238). Normal merge/rebase against
upstream is therefore not the adoption mechanism — the repository's own convention is
a path-rewritten mirror plus per-commit cherry-pick (`scripts/upstream.sh`). The
**selective perf fix is tractable** (index.ts 26/30 hunks strict, +3 via fuzz, 1
bespoke; `supervision.ts` 2/2; upstream test hunks 10/10), while a **broad take is a
near-total runtime replacement** and would discard local contracts. Recommended shape:
**port the #229 core by adaptation, not by mechanical apply**, and do not take the
upstream module layout.

## Adoption mechanism (evidence)

- `scripts/upstream.sh` documents the convention: a pristine mirror
  `~/.pi-ext-mirrors/upstream/pi-herdsman.git` plus a path-rewritten mirror
  `~/.pi-ext-mirrors/ns/pi-herdsman.git` (`--to-subdirectory-filter pi-herdsman`),
  reached as `upstream-pi-herdsman`; "take one commit" is `git cherry-pick -n <sha>`,
  and rebasing is a scratch-clone job.
- Recorded take: `FORKS` line
  `pi-herdsman|pi-herdsman|https://github.com/boadij/pi-herdsman.git|.|156b1c66…`.
- Monorepo import commit on HEAD's ancestry: `ec901b83c Import pi-herdsman as a fork
  of boadij/pi-herdsman at 156b1c66` (other `Import …` objects are jj `keep` copies).
  `git diff --shortstat ec901b83c HEAD -- pi-herdsman` → **97 files, +24772/−3699**.
- The `import-pi-herdsman` branch (184 commits, tip `0a42962c0` = the rewrite of the
  take) is **not** an ancestor of HEAD; the import happened from the pristine take.
- `remote.upstream-pi-herdsman` is **not in git config** — only stale
  `refs/remotes/upstream-pi-herdsman/*` exist (main `0a42962c0`, 2026-10-01). The
  rewrite mirror predates #229 (merged 2026-10-02) and v0.19+. So the first port step
  is to run `scripts/upstream.sh pi-herdsman` (network; refreshes pristine + rewrite);
  the #229 commit must then be cherry-picked from the rewrite, not from the
  researcher's unprefixed `/tmp/pr229.diff`.

**Does the architecture support subtree adoption rather than merge/rebase?** Yes, and
it is the only practical route. Ordinary rebase is *mechanically* possible (HEAD
descends from the import commit) but replays 97 files / 24.7k lines onto a runtime
that upstream has since modularised differently; the fork even renumbered ADRs into
different decisions (below), so a textual merge has no common intent to preserve.

## Major local-only contracts vs upstream baseline and current main

Absent from upstream `main` (22 local-only extension files):

| Domain | Local files | Contract (ADR / spec) |
|---|---|---|
| Retention | — | ADR 0013-retain-workers-across-assignments; spec `herdsman-retained-workers` |
| Control | `control.ts`, `control-integration.test.ts`, `herdsman-control-fixture.test.ts` | ADR 0024 control-requests-as-files-with-a-claim; openspec change `herdsman-control`; `docs/reference/herdsman-control.md` + fixture |
| Metadata | `pane-metadata.ts`, `session-metadata.ts` | ADR 0017 pane facts, 0025 session classification, 0026 target-cwd session storage, 0027 foreign-record handling; spec `herdsman-pane-metadata` |
| Background | `background-waiting.ts`, `awaited-facts.ts` | spec `herdsman-background-work`, `herdsman-awaited-facts`; ADR 0021 |
| Model policy | — | spec `herdsman-model-policy` |
| Skills | `agent-skills.ts` | spec `herdsman-agent-skills`; upstream instead ships `skills/pi-herdsman-agent-definitions/SKILL.md` |
| Briefs / contracts | `briefs.ts`, `response-contracts.ts`, `response-validation.ts` | ADR 0015/0016; specs `herdsman-delegation-briefs`, `herdsman-response-contracts` |
| Soft deadline / wake | `idle-wake.ts` | spec `herdsman-soft-deadline`; ADR 0014/0020 |
| Hierarchy | — | spec `herdsman-agent-hierarchy` |

- ADR sets diverged after 0012: local 0013–0027 are local-only; upstream 0013–0016 are
  **different decisions at the same numbers**. There is no common numbering to merge.
- `openspec/` (11 `herdsman-*` specs, changes `herdsman-control`,
  `herdsman-session-organization`) is **local-only**; upstream has no `openspec/`.
- Upstream-only modules local lacks: `agent-controller.ts`, `lead-runtime.ts`,
  `managed-agent-runtime.ts`, `compatibility.ts` (the #238 extraction).
- Shared non-test sources diverge heavily (changed lines vs upstream `main`):
  `index.ts` ~18,255 (monolith 18,445 vs thin 2,342), `support.ts` 325, `mailbox.ts` 498,
  `presentation.ts` 469, `supervision.ts` 299, `herdr.ts` 244, `core.ts` 223,
  `config.ts` 154, `storage.ts` 100, `agent-definitions.ts` 513, `lock.ts` 48,
  `errors.ts` 1.

## Selective perf-fix conflict surface (PR #229, measured)

`/tmp/pr229.diff` = 5 files, **42 hunks**. `/tmp/pr229-core.diff` restricts to the two
runtime files (32 hunks). Per-hunk strict `git apply --check`, then per-hunk
`patch --fuzz=3`:

| Tree | `extension/index.ts` (30 hunks) | `extension/supervision.ts` (2) | test hunks (10) |
|---|---|---|---|
| take `156b1c66` | 28 strict; h10 @fuzz3, h18 @fuzz2 → **30/30** | 2/2 strict | (not local) |
| **local `HEAD`** | **26 strict**; h5/h9/h18 @fuzz3; **h10 hard-fail even fuzz3** | **2/2 strict** | **10/10 strict** |

Hunk roles (from hunk headers/added lines):

- **Burn-fix core**: h1 deletes `persistedSessionName`+`isLeadSessionBoundary`;
  h2–h4 `managedAgentSnapshots` `allowTranscriptDefinitionFallback` + lead proof via
  `readLeadCoordinationState(supervisionRuntime(), ownerSessionId)` with the live
  agent/pane guards kept and a `try/catch` → "unknown"; h5 threads the flag through
  `agentSnapshotView`; h6–h8 `agentDefinitionForRuntime`/`runtimeForListedAgent`
  return `"unknown"` instead of opening legacy transcripts; h11–h20 supervision
  coalescing; h21–h30 periodic callers pass `false`.
- **Presentation/name**: h9 + h10 (`leadName`, `--token pi_herdsman_name=…`,
  "Pi Herdsman lead"). These are the only hard local conflict.

Conflict classification:

- **Textual only** (context shifted, semantics compatible): h5 (local
  `agentSnapshotView`/`managedAgentSnapshots` already carry extra
  `allWorkspaces`/`suppliedInventory` params), h18 (local `refreshSupervision` is a
  single async fn at `index.ts:11943`; upstream introduces
  `refreshSupervisionInFlight`/`pendingSupervisionRefresh`).
- **Bespoke local replacement required**: h10. Local has **no**
  `--token pi_herdsman_role=` launch-arg code (0 matches); local publishes role/name
  through pane metadata (`pi_herdsman_role` at `index.ts:8938`,
  `pi_herdsman_name`/`leadMetadataName` at `:8939`). Local also uses
  `persistedSessionName` at `:10897` inside `loadSupervisionSnapshot`, which h1
  deletes — that naming must be sourced locally.
- **Prerequisite drift vs v0.19.0**: h10 strict-fails and h18 needs fuzz 2 even on
  the **take**, so #229 was generated against a v0.19.0 `index.ts` whose
  pane-metadata/session-name and supervision-refresh regions moved. The take is not
  the PR base.
- **Semantic prerequisites present locally**: `readLeadCoordinationState`,
  `supervisionRuntime`, `retiredManagedSession`, `sessionAgentIdentity`,
  `runtimeForListedAgent` (`:4960`), `agentDefinitionForRuntime` (`:4776`). Live lead
  coordination state exists (role `lead`) for all live lead owners
  (`read-loop-trace.md`), so the coordination-state predicate keeps breadcrumbs.

**Can #229 be ported coherently without v0.19 prerequisite changes?** The burn-fix
core yes: dropping presentation h9/h10 leaves **26 of 28 core hunks** (24 strict +
h5/h18 fuzz, hand-reviewed), and `supervision.ts` 2/2. The v0.19 drift is confined to
the names/presentation and supervision-coalescing regions, which are exactly the
hunks that need local adaptation anyway. A mechanical `git apply` is **not** coherent;
a hand-adaptation of ~6 hunks plus the local `persistedSessionName` consumer is.

## Correction to the retrieved base snapshot

`/tmp/up-base-index.ts` is **byte-identical to the take's `index.ts`** (`cmp` clean,
15,554 lines), not the v0.19.0 PR base. Any statement that "up-base == the PR base"
is wrong; the true v0.19.0 base is not present locally, which is why h10/h18 fuzz on
the take. Δ analysis should treat `156b1c66` as the take, not as the base.

## Broad upstream take: conflict cost

- Upstream `main` runtime = `index.ts` 2,342 + `agent-controller.ts` 7,568 +
  `lead-runtime.ts` 7,852 + `managed-agent-runtime.ts` 2,551 + `compatibility.ts` 65
  ≈ **20,378 lines across 5 modules**. Local = `index.ts` **18,445** + 10 local
  modules. The layouts are disjoint; adopting the upstream modules means rewriting the
  local monolith around them.
- Local-only modules are imported from `index.ts`; the upstream modules do not know
  them. A broad take therefore touches every local contract at once and cannot be a
  patch — it is a re-fork of the runtime.
- Constraint honoured: do **not** transplant the #238 runtime extraction. If upstream
  modules are ever wanted, they must be a separate, reviewed restructure.

## Required behaviour-preservation list (regressions to keep when porting)

Each maps to a local ADR/spec and its code; none exist upstream:

- **Retention** — retained workers across assignments (ADR 0013, `herdsman-retained-workers`).
- **Control/ownership safeguards** — file-carried control requests with a claim
  (ADR 0024, `control.ts`, `herdsman-control`), owner-close/restart semantics, exact
  old session resume paths (ADRs 0025–0027, `session-metadata.ts`,
  `herdsman-session-organization`).
- **Metadata** — pane facts (ADR 0017, `pane-metadata.ts`), session classification
  (ADR 0025), target-cwd storage (ADR 0026), foreign-record pre-validation (ADR 0027).
- **Background** — `background-waiting.ts`, `awaited-facts.ts` (`herdsman-background-work`,
  `herdsman-awaited-facts`), held-settlement recovery (ADR 0021).
- **Briefs/response contracts** — `briefs.ts`, `response-contracts.ts`,
  `response-validation.ts` (ADR 0015/0016).
- **Model policy** — `herdsman-model-policy`.
- **Skills** — `agent-skills.ts` (`herdsman-agent-skills`) vs upstream's
  `skills/pi-herdsman-agent-definitions/SKILL.md`; local keeps `SKILL.md` (492 lines)
  and `AGENTS.md` (138) — a skills-layout reconciliation is its own task.
- **Soft deadline / idle wake** — `idle-wake.ts`, ADR 0014/0020.
- **Hierarchy** — `herdsman-agent-hierarchy`.
- #229 itself preserves `sessionAgentIdentity`/`sessionContextRetired`/
  `retiredManagedSession` on explicit/continuity paths; those local rules must stay.

## Recommended integration shape

1. **Selective port of the #229 core, adapted — not applied.** Run
   `scripts/upstream.sh pi-herdsman` to refresh the mirrors, locate the rewritten
   #229 commit, then port the core hunks by hand onto local `index.ts`:
   delete `persistedSessionName`/`isLeadSessionBoundary`; add
   `allowTranscriptDefinitionFallback` to local `managedAgentSnapshots`/
   `agentSnapshotView`; replace the lead-proof body (keep the live-agent/pane guards,
   add the `readLeadCoordinationState` predicate with `try/catch`); make
   `agentDefinitionForRuntime`/`runtimeForListedAgent` return `"unknown"` on periodic
   paths; pass `false` from `loadStatusSnapshot`, `scanAgentHealth`, supervision.
   Reasons: smallest change that removes every periodic transcript open, keeps local
   contracts, and does not import the module layout.
2. **Handle the two local blockers explicitly.** h10 has no local analog — decide
   whether local's `leadMetadataName`/pane-metadata publishing already covers naming
   (it appears to) and drop h9/h10; replace `persistedSessionName` at `index.ts:10897`
   with a local source.
3. **Add supervision coalescing** (`refreshSupervisionInFlight` +
   `pendingSupervisionRefresh`) as a local-shaped adaptation of h11–h20 (local
   `refreshSupervision` at `:11943` already returns a generation guard).
4. **Keep the upstream test hunks** (10/10 strict) but re-run/adjust the local status,
   controller-lifecycle and supervision suites; local tests carry extra cases.
5. **Do not take the #238 module extraction or any broad upstream branch.** If/when
   upstream value beyond perf is wanted, scope it as a separate restructure with the
   retention/control/metadata/background/model/skills list above as the acceptance set.

Alternative if the fork deliberately wants to keep the transcript identity proof
rather than move the source of truth: the one-expression lead-scope bound already
validated in `read-loop-trace.md` (lead tick opens 2→0, breadcrumb/rows unchanged,
79/79 + 66/66) removes the measured lead burn with no semantic change, leaving the
worker-leaf and supervision reads. It is compatible with either decision and does not
conflict with a later #229 port except at the same `loadStatusSnapshot` argument.

## Limits

- Applicability is per-hunk `git apply --check` + `patch --fuzz=3` on `/tmp` copies;
  it measures **textual** fit, not semantic correctness. Fuzz-applied hunks (h5, h9,
  h18; and h10/h18 on the take) still need hand review.
- `/tmp/up-base-index.ts` is the take, not the v0.19.0 base (corrected above); the
  exact v0.19.0 base and the intermediate 15 commits were not fetched.
- `scripts/upstream.sh pi-herdsman` was **not** run (it mutates mirrors and needs
  network); the rewrite mirror is therefore stale at the take and does not contain
  #229 — the cherry-pick path is described, not demonstrated.
- Message/commit-history provenance is from local git/jj refs and `scripts/upstream.sh`;
  upstream change prioritisation remains the researcher's.
- No full gates were run.

---

# Addendum: grounding corrections and the #258 listAll half

Added after the researcher's `.pi-herdsman/upstream-integration-research.md`
(upstream scope). Corrects two compat claims that must follow local behaviour, not
naming, and folds in the recommended second upstream change.

## ManagedAgentState is already v5 (the `mailboxes-v4` directory name is stale)

Do **not** describe a v4→v5 schema gap as absent local work. Local is already on the
v5 mailbox protocol and accepts v4 as legacy:

- `extension/mailbox.ts`: `MAILBOX_PROTOCOL_VERSION = 5` (`:140`),
  `ManagedAgentState.version: 5` (`:29`), `LEGACY_MAILBOX_PROTOCOL_VERSION = 4`
  (`:173`), type unions `version: 4 | 5` (`:75,90,103`), and explicit migration at
  `:994,1000,1025,1111,1162,1179`.
- The storage directory constant is still `join(herdsmanDataRoot(), "runtime",
  "mailboxes-v4")` (`:190`) — a **name**, not the schema version.
- Upstream `main` (`/tmp/up-main/extension/mailbox.ts`) uses `mailboxes-v5` (`:142`)
  with `version: 5` only (`:26,75,90,104`) and no legacy union/migration in that file.

So local already migrated the payload while keeping a legacy directory label; a
port must not "add v5" or migrate again. Any mailbox merge must instead reconcile
**lineage**: upstream only reads v5, local reads both and migrates. That is a real
local-only safeguard to preserve (ADR 0002 persist-intent/derive-state; session
classification ADR 0025).

## Semantic result refs exist locally; the delta is the reservation mechanism

The advertised `result:<agent>#<index>` grammar is **present locally**, not an
upstream-only feature:

- ADR `0001-keep-semantic-result-references-model-facing.md` makes it the
  model-facing identity.
- `extension/core.ts:79` `resolveResultReference` and `extension/storage.ts`
  `resultRef`/`RESULT_PREFIX` implement `result:<label>#<index>`; completions
  advertise it at `extension/index.ts:3999`, `presentation.ts:2960`.
- **Allocation differs**: local computes the next index from session entries
  (`nextAgentResultIndex`, `index.ts:3875` — scan matching entries, `max + 1`).
  Upstream adds an immutable persistent reservation,
  `reserveSemanticResultRef` (`/tmp/up-main/extension/storage.ts:82-135`,
  `result-ref-reservations/<label>/<index>` with `wx` write + fsync), plus
  `parseSemanticResultRef`/`SEMANTIC_RESULT_REF`.

So the genuine upstream delta is the **reservation semantics** (crash-safe,
label-scoped index), not the ref shape. A port touching result identity would be a
new local change with its own failure analysis (reservation dir lifecycle, cleanup),
not a transplant of an absent feature. It is out of #229's scope.

## #258 `listAll` half: local is the pre-#258 shape at one site

- Local has exactly **one** `SessionManager.listAll()` call: `index.ts:11650`, in
  the delegate/manager unresolved-worktree path (enclosed by the top-level
  `async function action(` at `:8132`), filtering by `assignment.id` and reading
  `saved[0]?.cwd`.
- That is the **replaced** (pre-#258) block. Upstream `main`'s replacement lives at
  `extension/lead-runtime.ts:4103-4130` after the #238 refactor and is *not* a
  byte-identical target — it was rewritten around exact session file paths
  (`saved[0].path`, `"Persisted project session identity does not match"`,
  `"Legacy project session has no exact file path"`). Local (pre-#258) has no such
  path-identity checks.
- Consequence: the #258 listAll change can be ported as a **small separate change**
  against `index.ts:11650`, but the upstream replacement is entangled with session
  path identity rules local does not have; take the *intent* (drop global
  `listAll()` full-store discovery from this path) and re-derive against local
  `assignment.id`/`cwd` handling rather than applying upstream's rewritten hunk.
- #258's stats half still opens selected sessions via
  `openOwnedAssignmentSession` (`index.ts:1897`, used from `collectSessionUsage`
  `:1974`), which is the pre-existing manager-stats behaviour the researcher flagged
  as separate.

## Qualifying the "no prerequisites" finding

The researcher's applicability result is **strict textual applicability**, not proof
that every semantic prerequisite is present:

- `/tmp/up-base-index.ts` is byte-identical to the take (`cmp` clean), so it is
  **not** a v0.19.0 base; h10 strict-fails and h18 needs fuzz 2 even on the take,
  i.e. #229 was generated against a later `index.ts` than the take. That is a
  missing-snapshot limitation, not evidence of no prerequisites.
- h5/h9/h18 land only with fuzz on local; h10 hard-fails. Textual fit there must not
  be read as semantic equivalence — local `agentSnapshotView`/
  `managedAgentSnapshots` carry extra parameters, local `refreshSupervision`
  (`:11943`) has a different shape, and local has no `--token pi_herdsman_role=`
  launch path at all (0 matches).
- Shared-file divergence (support.ts 325, mailbox.ts 498, presentation.ts 469,
  supervision.ts 299 changed lines vs upstream `main`) means each ported periodic
  caller must be re-verified against the local contract, not assumed equivalent from
  hunk success.

Net: selective #229 core plus a separate #258 listAll adaptation is the right shape;
"no prerequisites" should be recorded as "no *textual* prerequisites proven, semantic
prerequisites verified per local contract (coordination state, callers, pane
metadata) and remaining unverified where the v0.19.0 base was not available".

## Addendum evidence commands

```
wc -l extension/index.ts                       # 18445 (monolith)
wc -l /tmp/up-main/extension/{agent-controller,lead-runtime,managed-agent-runtime,compatibility,index}.ts
                                               # 7568 + 7852 + 2551 + 65 + 2342
grep -n 'SessionManager.listAll' extension/index.ts   # sole site: 11650
grep -n 'MAILBOX_PROTOCOL_VERSION|mailboxes-v4' extension/mailbox.ts   # 5, dir still v4
cmp /tmp/up-base-index.ts /tmp/x3/take/extension/index.ts   # identical (take, not base)
```
