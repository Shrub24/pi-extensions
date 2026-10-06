# Research: upstream pi-herdsman since our baseline — workflow relevance matrix

Read-only upstream scoping. No production edits, no merge/rebase/cherry-pick, no local
integration-cost experiments (parent owns those). Every classification below comes from
reading the commit diffs, not release prose.

## Summary

Between our adoption baseline `156b1c661a2e147d6bb2ef415abe44dd6b11af2f` (2026-10-01) and
upstream `main` = `330299f4357d8033910992f80cc37d6084bf4bc5` (`v0.21.0`, 2026-10-05) upstream
landed **45 commits** across five releases (v0.19.0 `9789734`, v0.19.1 `14d46b1`, v0.20.0
`ab361f0`, v0.20.1 `9685129`, v0.21.0 `330299f`). Almost all of that is Manager/Lead-project
work and UI consolidation built on an architecture our fork has diverged from; the parts that
matter to our workflows are few and classifiable.

The perf fix (PR #229) is **prerequisite-free**: every code hunk in `extension/index.ts`
except one presentation hunk applies strictly (fuzz 0) to our pristine baseline, so no
intermediate upstream commit is textually required. Two adjacent items are worth taking or
noting — #258's exact-session lookup replacement (our local code is byte-identical to the
code it replaced) and #239's strict-sampling removal (**already matched locally**). The
remaining "improvements" are either conflicts with our local durable formats
(mailbox schema v4→v5, semantic result refs), definition-contract changes that would replace
our Lead/model policy, or a module extraction that would require re-homing our ten
fork-only modules.

## Method and revisions

- Upstream repository: `github.com/boadij/pi-herdsman` (`parent: null`). Full history cloned
  read-only to `/tmp/upstream-herdsman.git` (HEAD = `330299f`), pristine baseline tree
  extracted to `/tmp/base156/` (from `156b1c66`), upstream `main` tree at `/tmp/up-main/`.
- Inventory: `git log --shortstat 156b1c66..main` (45 commits, all accounted for);
  per-file attribution for `extension/{index,support,herdr,presentation,supervision,mailbox,storage,config,agent-definitions}.ts`;
  symbol searches (`-S statusTimer`, `-S herdrSessionSnapshot`, `-S staff_resume`,
  `-S constrainedSampling`).
- Applicability: `git apply --check -v /tmp/pr229.diff` inside a pristine `156b1c66`
  checkout (fuzz 0), plus `patch --dry-run --fuzz=3` against our fork (prior audit).
- Local comparison surfaces: module inventory of `pi-herdsman/extension/`, local docs
  (`docs/reference/{agent-definition-schema,session-organization,herdsman-control,pane-metadata}.md`,
  `docs/guides/recovery.md`), and code greps.

## Relevance matrix

| # | Upstream work (exact revisions) | What the diff actually changes | Local surface | Class |
|---|---|---|---|---|
| 1 | `f4f249a` PR #229 → v0.19.1 (merge `f4f249a2b2c74d2a5c4c960b9705ca9ea6974c80`) | Deletes `isLeadSessionBoundary()` + `persistedSessionName()`; Lead proof becomes `readLeadCoordinationState(supervisionRuntime(), ownerSessionId)` role `"lead"`; `allowTranscriptDefinitionFallback=false` on status/health/supervision callers; supervision refresh serialized + coalesced | `index.ts:2269-2294` (byte-identical), callers `:10897/:10916`, `:12574`, `:16608` | **P0 take** |
| 2 | `7dcc10e` PR #258 → v0.20.1 | Replaces global `SessionManager.listAll()` with the persisted exact `piSessionFile` for Lead session resolution; keeps a one-time lookup only for pathless legacy assignments; `collectOwnedSessionUsage` becomes sync over durable paths | local `index.ts:11650` block is **byte-identical** to the replaced code ("BLOCKS IDENTICAL"); local `collectSessionUsage` (`:1974`) has no managed-Lead aggregation | **P1 take (listAll half only)** |
| 3 | `71a4208` PR #239 | Removes `constrainedSampling: { type: "json_schema", strict: "prefer" }` from tool registrations | Pristine baseline has **16** occurrences; our local `index.ts` has **0** | **Already matched — no action** |
| 4 | `387d232` PR #241 (+31/-4) and `fd71d4d` PR #269 (+298/-141) | Project-message lifecycle: delivered handoffs are not replayed to later Managers; adds `removeProjectMessage` with directory fsync | local project-message/assignment store in `supervision.ts` + `index.ts` | **P2 consider** (inspect local store first) |
| 5 | `5a29780` PR #211 + `9688a33` PR #213 | Durable mailbox schema **v4 → v5** (`__PI_HERDSMAN_AGENT_V5__`, `mailboxes-v5`), new `resultBindings`, new `ambiguous` code, semantic result refs `result:<label>#<index>` reserved in `result-ref-reservations/` | local durable results use `resultRef(requestId)` (`core.ts`, `storage.ts`); local mailbox state carries fork-specific fields | **Conflict — needs local decision** |
| 6 | `e489fe0` PR #247, `df361e0` PR #249, `9e5bbd7` PR #253 | Reserved `managed-lead` definition name; managed project Leads become definition-driven and configurable; `systemPromptMode` **must be `append`** for a managed-Lead definition (throws otherwise); `managed-lead.md` body/policy rewritten | local has **no** `managed-lead` definition (grep empty); local Lead policy lives in the fork's own role/brief/profile code | **Conflict with local model policy** |
| 7 | `4b3747b` PR #238 | Extracts runtime boundaries: `index.ts` 16,145 → **2,284** lines; adds `agent-controller.ts` (7,525), `lead-runtime.ts` (7,277), `managed-agent-runtime.ts` (2,552), `compatibility.ts` (24); rewrites import paths in 17 files | our fork has its own 10 fork-only modules (`control`, `pane-metadata`, `session-metadata`, `awaited-facts`, `background-waiting`, `idle-wake`, `briefs`, `response-contracts`, `response-validation`, `agent-skills`) | **Prerequisite for post-#238 ports; high cost** |
| 8 | `fd2de5a` PR #219 | Adds `runtimeBuild()` = sha256 of the extension file; `requireCompatibleBuild`/`sameRuntimeBuild` gate peer/chief coordination across live instances | local has `HERDSMAN_EXTENSION_PATH` but no build-identity gate | **Decision, not a defect** |
| 9 | `9015413` PR #209, `1094a43` PR #251 | Pi baseline 0.99.2 → 1.0.0 in `package.json` + lock (no code change); smoke enforces package runtime baselines. Upstream `v0.21.0` pins Pi **1.0.1** | local pins 0.99.2; live runtime is pi-1.0.2 | **Runtime baseline change** |
| 10 | Open issue #279 (not merged) | Pi 1.0.4 `--tools` no longer removes MCP tools unless selected explicitly → breaks a source-agnostic allowlist contract | local `docs/reference/agent-definition-schema.md` documents exactly that contract (lines ~150-171) | **Forward risk to thin explicit stacks** |
| 11 | `900f585` #254 (+933/-320), `a819aeb` #259, `335d195` #244, `e154b97` #268, `ee69e58` #272, `1405eb4` #245 (+738), `99a8843` #252, `382a188` #220 (+646/-320) | Operator/supervision surfaces: unified management menus, Lead role in status widget, coordination identity/hierarchy, staff project context, steering active direct reports, optional Manager auto-activation, staff_delegate/staff_resume split | our operator surface is fork-only `herdsman-control/v1` (`extension/control.ts`; absent from upstream `main`); supervisor docs differ | **Low portability / high conflict** |
| 12 | `31e0865`, `6f166a6`, `7595a376`, `3e7692b` (docs), `e9a4766` (#210 tests), `bf5d7c2` (#240 installer, +1108/-2696), `dea67685`, `b6805746`, release commits | Docs, smoke/installer, release plumbing | — | **Not relevant** |

## PR #229 prerequisites and port requirements (diff-verified)

**No upstream prerequisite commits.** In a pristine `156b1c66` checkout, `git apply --check`
(fuzz 0) accepts:
- `extension/index.ts` hunks 1-9, 11-30 (offsets −99 to −228 lines).
- `extension/supervision.ts` hunks 1-2 and `extension/supervision.test.ts` hunks 1-2.

It rejects exactly two hunks, neither a semantic prerequisite:
- `extension/index.ts` hunk 10 — the pane-metadata/name republish block (context at upstream
  ~7464). Its base context comes from a v0.19.0-era change; **which commit changed it was not
  isolated** (candidates `d77655e` #215 or `382a188` #220).
- `extension/commands.test.ts` hunk 5 — test-only context drift.

**Local prerequisites that do exist already:** `readLeadCoordinationState` and
`supervisionRuntime` (local `extension/supervision.ts`, imported at `index.ts:257`), and the
live leads carry coordinator records with `"role":"lead"` (prior audit's follow-up section).
`readLeadCoordinationState` throws on malformed state, so the port needs upstream's
`try/catch` to degrade to `unknown` rather than failing the refresh.

**Port surface (code only, 5 edits):** delete `persistedSessionName` + `isLeadSessionBoundary`;
replace the lead proof inside `managedAgentSnapshots`; add `allowTranscriptDefinitionFallback`
threading to `agentDefinitionForRuntime`/`runtimeForListedAgent` with `false` at the status,
health and supervision callers; coalesce supervision refresh.

**Reach of the fix:** the lead-proof replacement sits inside `managedAgentSnapshots`, so every
`proveLead` caller inherits it — including the worker-leaf status path (`refreshLeafStatus`,
which is *not* named in the patch) and `scanAgentHealth`. That is what makes #229 strictly
stronger than the one-expression local variant in `read-loop-trace.md`.

**Local work the port implies (not covered by upstream hunks):**
- `persistedSessionName` feeds `sessionName` into the supervision snapshot
  (`index.ts:10897`, `:10916` → `supervision.ts:2121`, `:2358-2364`). Upstream's replacement
  (hunk 10) republishes the current Pi session name as the Herdr title and `pi_herdsman_name`
  token. Our fork already defines that token in `pane-metadata.ts` /
  `docs/reference/pane-metadata.md` ("Lead session name"), so the replacement mechanism exists
  locally but must be wired by hand.

## Module extraction assessment (#238)

Real maintainability gain *for upstream's single-layout repo*: a 16,145-line `index.ts`
becomes 2,284 lines with three named runtimes. For our fork it is a near-rewrite, not a
refactor we can absorb: our fork has already grown its own decomposition (10 fork-only modules
listed above), and `#238` additionally rewrote import paths and host dependency-injection
signatures across 17 files (e.g. hosts now pass `sameRuntimeBuild`, `SessionManager`,
`supervisedSessionFile`, `withProjectAssignmentLock`). Consequence for the scoring question:
**any post-#238 commit can only be taken verbatim after adopting #238 or by re-homing it into
our `index.ts`.** Every commit after `4b3747b` in the inventory touches the extracted modules
(`lead-runtime.ts`, `agent-controller.ts`), not `index.ts`.

## Recommended candidate bundle

**Selective bundle (minimal, workflow-justified):**
1. **PR #229 core only** — the burn fix; prerequisite-free, fixes all periodic transcript
   opens (lead, worker leaf, supervision name, dormant legacy fallback). Include the
   supervision-refresh coalescing hunk; hand-wire the pane-metadata replacement. Skip the
   test-file hunks we cannot apply or re-derive them locally.
2. **PR #258 `listAll` half only** — replace the global `SessionManager.listAll()` at local
   `index.ts:11650` with the persisted exact `piSessionFile`. Our block is byte-identical to
   the upstream code that was replaced, and the global call fully parses every session file
   (#256). The stats-collector half depends on #255, which our fork does not have.
3. **No action on #239** — already matched locally (0 occurrences vs 16 in baseline).

**Explicitly defer / decide later:** result-ref and mailbox schema v5 (#211/#213), the
managed-Lead definition contract (#247/#249/#253), build-compatibility gating (#219), and the
Pi 1.0.x baseline including the open #279 tool-selection change.

**Comparison revision for full integration:** `v0.21.0` =
`330299f4357d8033910992f80cc37d6084bf4bc5` (45 commits; module layout after #238, durable
schema v5, definition contract). If the goal is only "the fix plus the least churn", the
minimal revision containing it is `v0.19.1` = `14d46b1280fffd8e395c1975c62fa20085936f32`.
Full integration is effectively a re-fork, not a merge: our fork's durable formats, operator
surface and definition policy are all in the post-baseline divergence.

## Breaking / contract changes to weigh

- **Durable mailbox schema v4 → v5** (#211): new prefix `__PI_HERDSMAN_AGENT_V5__`, new state
  directory `runtime/mailboxes-v5`, added `resultBindings`, added `ambiguous` result code.
- **Durable result identity** (#211/#213): semantic refs `result:<label>#<index>` with
  on-disk reservations, replacing/augmenting id-derived refs.
- **Definition contract** (#247/#253): reserved name `managed-lead`; managed-Lead
  `systemPromptMode` must be `append` (throws otherwise); Lead prompt/policy rewritten.
- **Module/import layout** (#238): all extension internals move; forks must re-home.
- **Runtime baseline** (#209/#251, open #279): Pi 1.0.0/1.0.1 pinned upstream vs our 0.99.2
  pin, and Pi 1.0.4 tool-selection semantics that conflict with our documented
  source-agnostic `tools` allowlist.
- **Cross-instance compatibility** (#219): coordination refuses a live peer with a different
  extension-file hash — deliberate, and neutral inside a homogeneous fork fleet.

## Contradictions

None between upstream sources. One tension with our own prior reasoning: `read-loop-trace.md`
Option 1 (mtime/size cache preserving identity proof) remains a valid *fork-specific* contract,
but upstream rejected a cache outright and removed the periodic identity scan; the two cannot
be combined in the same predicate — a port of #229 supersedes the local one-expression variant.

## Missing evidence / uncertainties

- Which v0.19.0-era commit produced hunk 10's base context was not isolated (`d77655e` vs
  `382a188` are candidates); the hunk's content can be re-derived locally.
- Whether our supervision UI's rendering actually depends on the `sessionName` field after the
  port was not traced (consumers found at `supervision.ts:2358-2364`, impact not measured).
- `#258`'s stats-collector half is assessed as not applicable because local
  `collectSessionUsage(ctx)` (`index.ts:1974`) has no managed-Lead aggregation; I did not audit
  every other local stats path for global discovery.
- Post-#238 classifications rest on file-layout and diff summaries; I did not run upstream
  tests or verify semantic equivalence of the extracted modules.
- Upstream `main` findings are at `330299f`; later upstream commits (if any) are outside this
  audit.

## Sources

- Upstream history: `156b1c661a2e147d6bb2ef415abe44dd6b11af2f..330299f4357d8033910992f80cc37d6084bf4bc5` (45 commits; `git log --shortstat`).
- Perf fix: [PR #229](https://github.com/boadij/pi-herdsman/pull/229), merge `f4f249a2b2c74d2a5c4c960b9705ca9ea6974c80`; [issue #228](https://github.com/boadij/pi-herdsman/issues/228); release [v0.19.1](https://github.com/boadij/pi-herdsman/releases/tag/v0.19.1).
- Adjacent: `7dcc10e` ([#258](https://github.com/boadij/pi-herdsman/pull/258), [issue #256](https://github.com/boadij/pi-herdsman/issues/256)), `71a4208` ([#239](https://github.com/boadij/pi-herdsman/pull/239)), `387d232`/`fd71d4d` (#241/#269).
- Conflicts: `5a29780`/`9688a33` (#211/#213), `e489fe0`/`df361e0`/`9e5bbd7` (#247/#249/#253), `4b3747b` (#238), `fd2de5a` (#219), `9015413` (#209), `1094a43` (#251), open [issue #279](https://github.com/boadij/pi-herdsman/issues/279).
- Local evidence: `pi-herdsman/extension/{index,supervision,storage,core,pane-metadata}.ts`, `docs/reference/{agent-definition-schema,session-organization,pane-metadata,herdsman-control}.md`, module inventory vs `/tmp/base156/extension/`.

## Next steps

1. Parent: decide #229 port shape (full upstream predicate vs local one-expression variant) given the pane-metadata `sessionName` rewiring; the fix reach argument favours the upstream predicate.
2. Parent: assess the `#258` `listAll` replacement as an independent follow-up (it is not part of #229).
3. If a full re-fork is contemplated, treat `330299f` (v0.21.0) as the comparison revision and plan around schema v5, the `managed-lead` definition contract, and re-homing the ten fork-only modules.
