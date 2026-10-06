# Research: upstream pi-herdsman — idle full-transcript reread (status/supervision polling)

Read-only upstream audit. No production edits, no commits, no local runtime work.
Scope: issues, PRs, releases, commit diffs in the upstream repository. Local
patch-scope analysis is the parent's; this file only adds upstream facts and their
compatibility implications.

## Summary

Upstream is **`github.com/boadij/pi-herdsman`** (not a fork of anything; `parent: null`).
Our local package is upstream at take **`156b1c661a2e147d6bb2ef415abe44dd6b11af2f`**
(2026-10-01, upstream `main` at that moment, one commit after tag `v0.18.0`), with a
local fork delta; the lead-boundary/lifecycle code we measured is **byte-identical**
to that baseline.

Upstream independently identified the exact defect we traced and fixed it:
**issue #228 → PR #229**, merged `f4f249a2b2c74d2a5c4c960b9705ca9ea6974c80`
(2026-10-02), shipped in **v0.19.1** (`14d46b1280fffd8e395c1975c62fa20085936f32`).
The fix **deletes `isLeadSessionBoundary()` and `persistedSessionName()` entirely**
and derives Lead authority from Herdsman's own Lead coordination state instead of
opening transcripts. It is still in place at upstream `main` = `330299f4357d8033910992f80cc37d6084bf4bc5`
(= `v0.21.0` release commit), and no open upstream issue or PR asks for further
periodic-read work.

Note the shape of the upstream fix: it is **not** the cache (our Option 1) and **not**
a bounded-read shortcut (Option 3). It removes the transcript-identity check from the
periodic path and moves the source of truth to coordination state.

## Findings

1. **Upstream identity and our baseline (direct evidence, high).**
   - `pi-herdsman/package.json` `repository.url` = `git+https://github.com/boadij/pi-herdsman.git`;
     `CHANGELOG.md` compare links all point at `boadij/pi-herdsman`.
   - `scripts/upstream.sh` line 56: `"pi-herdsman|pi-herdsman|https://github.com/boadij/pi-herdsman.git|.|156b1c661a2e147d6bb2ef415abe44dd6b11af2f"` — the adoption take.
   - `gh api repos/boadij/pi-herdsman` → `parent: null`, default branch `main`, 121 stars, pushed `2026-10-05T23:34:24Z`, 13 open issues. Not itself a fork.
   - Provenance check: `pi-herdsman/extension/index.ts` lines 2269-2294 (`persistedSessionName` + `isLeadSessionBoundary`) are byte-identical to
     `156b1c66:extension/index.ts` lines 1952-1977 (sha256 `bd85fdac…cea8b` both). The local caller at
     `pi-herdsman/extension/index.ts:3159-3163` is the same conditional as `156b1c66:extension/index.ts:3013-3022`.
   - Local `package.json` version is `0.18.0`; upstream has since released v0.19.0, v0.19.1, v0.20.0, v0.20.1, v0.21.0.

2. **Upstream issue matches our local trace exactly (direct evidence, high).**
   - [#228 "perf: periodic status and supervision still parse full Pi transcripts"](https://github.com/boadij/pi-herdsman/issues/228), opened 2026-10-02T17:48:38Z by `@cray-com`, closed 2026-10-02.
     Its "Current paths in 0.19.0" block is the same chain our trace proved:
     `status timer (2 s) → refreshStatus → loadStatusSnapshot → agentSnapshotView(proveLead=true) → managedAgentSnapshots → isLeadSessionBoundary → SessionManager.open(path).getSessionId() / .getEntries()`,
     plus supervision `→ loadSupervisionSnapshot → persistedSessionName → SessionManager.open(path).getSessionName()`.
     It also notes the supervision refresh lacked the status loop's in-flight guard.
   - Reporter benchmarks (v0.19.0 release commit `9789734`, pinned Pi 1.0.0 dev dep): transcripts 63,028,987 B / 3,723 entries and 193,010,896 B / 19,503 entries;
     lead-boundary pattern (two opens + entries) 1.89 s / 10.82 s wall, peak RSS 379 / 769 MiB. This independently corroborates our ~38 MB and ~230 ms per open.
   - Maintainer reply (`@boadij`, 2026-10-02T18:49:11Z): confirmed against v0.19.0 source that the status path "can still reach `isLeadSessionBoundary()`, which full-loads the owner transcript", labelled `perf` / `P1`, and scoped the fix to "eliminating repeated full-transcript loads from periodic metadata refreshes while preserving the current identity and fail-closed ownership checks".
   - The reporter's numbers were not reproduced upstream ("The exact benchmark numbers have not been reproduced here") — upstream accepted the mechanism from code + Pi `SessionManager` behaviour.

3. **The fix PR (direct evidence, high): [#229 "perf: make periodic status and supervision transcript-free"](https://github.com/boadij/pi-herdsman/pull/229).**
   - Merged 2026-10-02T21:27:44Z; merge commit `f4f249a2b2c74d2a5c4c960b9705ca9ea6974c80`; head `8050084e2f8c0a66aa30821a27bb34ea583ec9f0`;
     base `9789734311843b893a7e4722b0dbe850b04d665e` (v0.19.0). Two commits: `bf3b553c` plus follow-up `8050084e` "fix: keep Chief supervision refresh transcript-free".
   - Files: `extension/index.ts` (125+/57-), `extension/supervision.ts` (0+/4-), `extension/commands.test.ts`, `extension/extension-contract.test.ts`, `extension/supervision.test.ts`.
   - Diff facts I read directly (patch of `extension/index.ts`, 30 hunks):
     - **Deletes** `persistedSessionName()` and `isLeadSessionBoundary()` outright (hunk 1, upstream lines 1952-1977).
     - `managedAgentSnapshots` gains `allowTranscriptDefinitionFallback = true`, threaded to `agentDefinitionForRuntime` / `runtimeForListedAgent`; with the fallback disallowed these return `"unknown"` instead of calling `stateAgentDefinition(state)` (the legacy full-transcript open).
     - Lead proof replaced by `readLeadCoordinationState(supervisionRuntime(), ownerSessionId)` with `(state.role ?? "lead") === "lead"`, in a `try/catch` so "Missing or invalid Lead authority stays unknown".
     - Periodic callers pass `allowTranscriptDefinitionFallback=false`: the status path `loadStatusSnapshot(..., false)`, `scanAgentHealth`, and the supervision snapshot.
     - Supervision refresh serialized: `supervisionRefreshInFlight` + `pendingSupervisionRefresh` give exactly one coalesced trailing rerun (the overlap risk our trace Q3 raised).
     - `persistedSessionName`-derived naming removed from `loadSupervisionSnapshot`; Lead re-entry republishes the current Pi session name as Herdr title + `pi_herdsman_name` token.
   - PR body: "No cache, parser, storage format, dependency, configuration, migration, or new ADR is introduced"; "Full Pi transcript parsing is reserved for operations that actually require transcript contents."

4. **Release lineage (direct evidence, high).**
   - [v0.19.1](https://github.com/boadij/pi-herdsman/releases/tag/v0.19.1) published 2026-10-02T21:39:39Z, tag `14d46b1280fffd8e395c1975c62fa20085936f32`; `compare/f4f249a...14d46b1` reports `ahead_by: 1, behind_by: 0` (release commit directly on top of the fix).
   - Release notes state the fix explicitly, quote the 63 MB / 193 MB measurements and "could even take longer to inspect than the refresh interval itself", list the new authority sources (mailbox state, Lead coordination state, Herdr evidence, direct/bounded-header identity), and attribute: "**Reported by:** @cray-com · **Issue:** #228 **Fixed by:** @boadij · **PR:** #229".

5. **Still fixed at upstream `main` (direct evidence, high).**
   - `main` HEAD at fetch time = `330299f4357d8033910992f80cc37d6084bf4bc5` ("chore(main): release 0.21.0 (#264)", 2026-10-05T23:34:07Z).
   - `isLeadSessionBoundary` and `persistedSessionName` are **absent from the whole `extension/` tree** at that revision. The chained `#238` "extract extension runtime boundaries" refactor moved code into modules, so the fix now lives as `readLeadSessionIds()` in `extension/lead-runtime.ts:4802-4859`, which filters owners via `matchesExpectedSession` (bounded header) and then `readLeadCoordinationState(...)` role `"lead"` — i.e. no transcript open.
   - Periodic timers at `main`: status `extension/agent-controller.ts:372` (`setInterval(..., 2000)`), supervision `extension/lead-runtime.ts:3414` (`setInterval(..., 2000)`).
   - Remaining `SessionManager.open` sites at `main`, all non-periodic on my reading of their immediate context:
     `extension/agent-controller.ts:1507` (`openOwnedAssignmentSession`), `:1763` (`stateAgentDefinition` fallback, reachable only with `allowTranscriptFallback=true`), `extension/index.ts:556` (`collectOwnedSessionUsage`, Manager stats command), `:906` (`sessionRetired` evaluation at result delivery), `extension/lead-runtime.ts:4100` and `:4120` (`staff_resume` / worktree rebuild).
     Caveat: I inspected each site's enclosing context, not every caller transitively; the `#238` refactor means these paths do not exist in our fork in this layout.

6. **Related-but-separate upstream work — do not conflate with the matching fix (direct evidence, medium-high).**
   - [#155](https://github.com/boadij/pi-herdsman/issues/155) "continue can stall on large Pi session stores" → fixed by [PR #159](https://github.com/boadij/pi-herdsman/pull/159) (2026-09-27), i.e. **before** our take, so our fork already has it. Not the idle-read loop.
   - [#256](https://github.com/boadij/pi-herdsman/issues/256) "Manager session stats can take seconds on large managed trees" → fixed by [PR #258](https://github.com/boadij/pi-herdsman/pull/258) (merge `7dcc10ecae85aeb49abd2d28bc6151c8f98d74ec`, in v0.20.1). It removes global `SessionManager.listAll()` session discovery from the stats hot path and explicitly states "No relevant-tree traversal optimization … was added" — the stats path still opens the selected Lead/agent sessions (`openOwnedAssignmentSession`). Different trigger (explicit stats command), separate from the 2 s timer burn.
   - #256's body also cites Pi-side issues `earendil-works/pi#8683` and `#8762` (`SessionManager.listAll()` / session listing fully parses every file) as closed "not planned" — i.e. no upstream Pi optimisation to wait for. **Secondary evidence**: I did not open those Pi issues myself.

7. **Compatibility implications for our identity/conflict checks (researcher interpretation, labelled).**
   - The fix changes the *source of truth* on periodic paths: lead authority moves from "owner transcript's session id matches and has no conflicting `sessionAgentIdentity` entry" to "Herdsman Lead coordination state says role lead". So the periodic path no longer validates the owner transcript's identity at all. This is the semantic our read-loop-trace predicted a header-only shortcut could not preserve; upstream resolved it by removing the check from the periodic path, not by weakening it in place.
   - `sessionAgentIdentity` / `sessionContextRetired` / `retiredManagedSession` all survive upstream (e.g. `main`: `retiredManagedSession` at `extension/index.ts:518-527`, identity check at `extension/agent-controller.ts:1509-1511`); they are just no longer reached unconditionally every 2 s. So "preserving identity and fail-closed ownership checks" is true for explicit validation and continuity paths, not for the breadcrumb.
   - The `allowTranscriptDefinitionFallback=false` pattern is the direct answer to our Option-1 note about the dormant `stateAgentDefinition` fallback: periodic paths report `"unknown"` instead of opening the legacy transcript. Our fork has the identical dormant fallback (`pi-herdsman/extension/index.ts:1473-1485`, reached from `agentDefinitionForRuntime` ~`:4781-4784`).
   - Removal surface locally is small: `isLeadSessionBoundary` has one caller and `leadSessionIds` feeds only the herd/`?` breadcrumb (per `read-loop-trace.md`). The upstream predicate needs a locally-present `readLeadCoordinationState(supervisionRuntime(), ownerSessionId)` — both exist in our tree (`pi-herdsman/extension/index.ts:257`, `:9282`…). Whether our local lead mailboxes actually carry that coordination state so the breadcrumb stays correct is a local check the parent still owns.

8. **Mechanical applicability probe onto our fork (bounded, disclosed limits; interpretation, low-medium).**
   - `git apply --check` (strict) of the PR #229 `extension/index.ts` diff against `pi-herdsman/extension/index.ts` fails at hunk 5 (our fork's `agentSnapshotView`/`managedAgentSnapshots` region is textually different; strict apply aborts there).
   - `patch -p1 --dry-run --fuzz=3` over the same 30 hunks: **29 succeeded, 1 failed** (hunk 10, the pane-metadata / session-name republish block around upstream 7464 — our fork changed that area). Offsets are large (up to ~1655 lines), and several hunks only matched with fuzz, so this is a signal that the *semantic core* (hunk 1 deletion, hunks 2-4 lead-session replacement) lands, not proof that a mechanical cherry-pick is safe. Failed hunk 10 is the optional presentation part (republishing the Pi session name), not the burn fix.
   - Prerequisites present locally: `readLeadCoordinationState`, `supervisionRuntime`, `retiredManagedSession`, `sessionAgentIdentity`. PR #229's base is v0.19.0, which is 15 commits ahead of our take; I did not check whether any of those 15 commits are semantic prerequisites for the non-core hunks.

## Contradictions

None found between upstream sources. One point worth recording: the local fork's
open question ("which bounding option preserves conflict/retire semantics?") is
contradicted in spirit by upstream's answer — upstream concluded no cache or bounded
read is required, and intentionally removed the periodic identity scan instead
(PR #229: "No cache … is introduced"). Our `read-loop-trace.md` options 1/2 remain
valid local choices if the fork wants to keep the identity proof; upstream chose a
different contract.

## Missing evidence

- Automated `source_check` on "v0.19.1 removed the full-session opens" returned **`unclear`** with irrelevant hits (pi.dev news, an unrelated changelog, getdory.dev release notes) — generic web search does not index this repo's data well. Validation therefore rests on direct primary-source inspection via the GitHub API (PR diff, release body, `main` tree, commits), not on that check. Disclosed as a validation limitation.
- `earendil-works/pi#8683` / `#8762` were not opened directly (only via #256's body).
- I did not trace every caller of the six remaining `SessionManager.open` sites at `main`; "non-periodic" is based on their immediate enclosing context.
- Not verified: whether our local fork's Lead mailboxes carry coordination state such that `readLeadCoordinationState(supervisionRuntime(), ownerSessionId)?.role` yields `"lead"`; and whether any local consumer beyond the breadcrumb depends on transcript-proven lead identity. Parent's local scope.
- Upstream `main` at `330299f` is the v0.21.0 release commit; there may be commits after my fetch (2026-10-06) — the fix's absence/presence was checked at that exact revision.

## Search scope performed

Primary sources only, all via `gh api` against `repos/boadij/pi-herdsman`:
repo metadata; all issues 180-279 (list, plus targeted reads of #228/#229/#155/#256/#258/#279);
`search/issues` for `performance`, `CPU`, `memory`, `reread`, `polling`, `transcript`, `SessionManager`, `perf in:title`;
all releases v0.19.0→v0.21.0 and tag SHAs; `compare/156b1c66...main` (45 commits) and the whole `main` tree, checked to confirm the fix is semantically unchanged since #229 — the only later structural change to this path is the #238 runtime-boundary refactor, which moved the predicate into `extension/lead-runtime.ts` without altering it; PR #229 metadata/files/commits/full diff; PR #258 files/body;
full `main` tarball tree grep for `SessionManager.open`, `isLeadSessionBoundary`, `leadSessionIds`,
`allowTranscriptDefinitionFallback`; local mirror `156b1c66` blob greps and byte comparison.
Open-issue/perf sweep found no open item requesting further transcript-read reduction.

## Sources

Kept:
- Repository: [boadij/pi-herdsman](https://github.com/boadij/pi-herdsman) — `parent: null`, pushed 2026-10-05T23:34:24Z.
- Matching fix: [#228](https://github.com/boadij/pi-herdsman/issues/228) (report + maintainer confirmation), [PR #229](https://github.com/boadij/pi-herdsman/pull/229) (merge `f4f249a2b2c74d2a5c4c960b9705ca9ea6974c80`).
- Release: [v0.19.1](https://github.com/boadij/pi-herdsman/releases/tag/v0.19.1) (tag `14d46b1280fffd8e395c1975c62fa20085936f32`).
- Related, separate: [#155](https://github.com/boadij/pi-herdsman/issues/155)/[#159](https://github.com/boadij/pi-herdsman/pull/159), [#256](https://github.com/boadij/pi-herdsman/issues/256)/[#258](https://github.com/boadij/pi-herdsman/pull/258).
- Local baseline evidence: mirror `156b1c66:extension/index.ts:1952-1977` vs `pi-herdsman/extension/index.ts:2269-2294`.

Rejected: `source_check` web results (pi.dev news page, `getdory.dev/en/docs/release-notes/v0-19-1`, unrelated changelogs) — no coverage of this repository; automated assessment unavailable.

## Next steps

1. Parent (local scope): confirm our lead mailboxes carry Lead coordination state and that only the breadcrumb consumes transcript-proven lead identity — that decides whether porting #229 verbatim preserves our controls, or whether we instead bound the read while keeping the identity proof (the fork may deliberately differ from upstream here).
2. If porting: take the core hunks (delete `isLeadSessionBoundary`/`persistedSessionName`; lead proof via `readLeadCoordinationState`; `allowTranscriptDefinitionFallback=false` on periodic paths; supervision refresh coalescing) and hand-review the fuzz-matched hunks; hunk 10 needs our own pane-metadata equivalent.
3. Optional: check whether v0.19.0's 15 intermediate commits contain prerequisites for the presentation hunks.
