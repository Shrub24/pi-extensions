# Upstream lifecycle coverage — do the pinned upstream refs fix our worker-lifecycle defects?

Read-only investigation, 2026-10-07. No fork working-tree, history, or runtime state
was changed; upstream was inspected in throwaway clones under `/tmp`.

**Pinned target (the only ref treated as "upstream" here):** `6f166a67e997791a6bc25d38cbcf4dcea14ce470`
= `v0.19.1-2-g6f166a6`, the parent of `4b3747b` (#238, the extraction commit), i.e.
v0.19.1 (`14d46b1`) plus two docs commits (#233, #234). Re-verified locally:
`git describe` = `v0.19.1-2-g6f166a6`; `git log -6 4b3747b` shows `6f166a6` as its parent.
Fork baseline for comparison = `156b1c66` (the take; `scripts/upstream.sh` FORKS table).

**Method.** `git clone --bare https://github.com/boadij/pi-herdsman.git /tmp/upstream-ph.git`;
worktree `/tmp/up6f166a6` at the pinned target (spot checks on `main` = `05eec19` in
`/tmp/upmain`). Each defect was located in the target's code and read; no claim from
`.pi-herdsman/pre-extraction-adoption-plan.md` was reused without re-reading. Nothing was
executed, so every verdict is a code-read verdict, not an observed one.

**Verdict vocabulary.** fixed = the target's code prevents the defect; partially fixed =
the target removes part of the failure class or narrows it but the defect survives;
absent = the target contains the same defect; not comparable = the target has no
equivalent mechanism to fix (usually because the feature is fork-only).

## Coverage table

| # | Defect | Verdict | Upstream ref (pinned target `6f166a6`) | What upstream actually does |
|---|---|---|---|---|
| 1 | Leaked session-activation reservation (post-claim throw leaks the lock forever) | **partially fixed** — same class, much narrower window | `index.ts:846-864` (claim), `6075` (claim site), `6076-6126` (try/catch that releases), `6296` → `6685-6698` (outer try/finally that releases) | The launch/resume body IS wrapped: outer `try` at 6296 with `finally` at 6685-6698 releasing the lock (`6696`), plus explicit releases at 6123, 6220, 6225, 6246, 6276. But between the claim at 6075 and the outer try there is an unchecked window: `if (requestedLabel && labels.has(requestedLabel)) fail("agent_label_exists", …)` (`6128-6133`), `if (!validAgentLabel(label)) fail("invalid_request", …)` (`6136-6141`), and `await placementSettings(ctx)` / `await physicalPlacement(...)` (`6186-6194`) — none of these releases. A throw there still leaks the reservation for the owner's lifetime. Later upstream (`main`, `agent-controller.ts:5347-5581`) keeps the same explicit-release topology. |
| 2 | Stale generation advertised idle/reachable while continue and close fail `agent target <label>_<hash> not found` | **absent** (unreachable half shared); the "idle" half is fork-only | `index.ts:2051-2062`, `3014-3021`, `3143-3201`, `4931-5000`, `6106-6121`; `herdr.ts:120-131`, `2072-2110`, `2214-2245` | `herdrAliasMatchesIfReported` still accepts an agent whose `name` is absent (`aliases.length === 0 || …`, 2051-2062), while the close chain requires `herdr agent get <alias>` to resolve (`herdr.ts:2072-2084`, entered via `closeHerdrPane` 2214-2245). `agent_not_found` is special-cased nowhere and maps to `internal_failure` (`herdr.ts:120-131`); `normalizeCloseFailure` rewrites the operation to `close` (`index.ts:4778-4795`). Identical to our behaviour. Difference: upstream's listing never emits `idle` — `agentControlState` returns only `working/blocked/settling/unknown` (`core.ts:388-409`) plus `lost` (`index.ts:3014-3021`); our `delivered → idle` rule (`core.ts:541`) is the fork's addition by which a no-request worker can be advertised idle. Also, upstream's continue refusal for a session a stale mailbox still represents is `agent_busy "The exact Pi session is already represented by active managed work"` (`6106-6121`), not a close attempt. |
| 3 | Mailbox whose workspace generation no longer exists returns busy instead of lost/recover, and is never retired | **absent** | `index.ts:6085-6121`, `13422-13445`, `3920-3987`, `4990-4995` | No recover/relaunch path exists upstream. The continue path still matches `listAgentStates()` on `piSessionId`/`piSessionFile` (not workspace-filtered), so a vanished generation still yields `representations.size === 1` → `agent_busy` (`6106-6121`). Its only lost handling is informational: the `pi-herdsman-agent-lost` reminder telling the operator to `agent_close` before replacing or continuing (`13422-13445`). Automatic retirement exists only for a *delivered* result (`finalizeDeliveredRoot`, `3920-3987`) and for explicit close (lost branch `4990-4995`). |
| 4 | `agent_list` reports a mid-turn worker as idle; one busy value conflates several conditions (not visible in this workspace, label mismatch, owner mismatch, listed state not idle) with "still settling" as a fifth | **partially fixed** (vocabulary only) | `core.ts:388-436`; `index.ts:3014-3021`, `2807-2821`, `15676-15737`; `mailbox.ts:43-52` | The projection cannot report `idle` (see row 2), so half of the defect is structurally absent upstream. The refusal vocabulary is genuinely broader than ours: upstream's ack codes are `busy\|idle\|invalid\|identity\|delivery\|ambiguous\|incompatible` (`mailbox.ts:43-52`) and the controller maps the new ones to `target_ambiguous` / `incompatible_build` (`2807-2821`) — our fork still has `busy\|idle\|invalid\|identity\|delivery` (local `mailbox.ts:52`; `index.ts:16786`). Those two additions came with #211/#219 after the take (the take's union, `156b1c6:extension/mailbox.ts:39`, equals ours). The five conditions named in the defect are still one `busy` code with different messages (`15676-15737`); upstream has no mid-turn-vs-idle distinction, and our `"Agent assignment is still settling"` and delivered-`idle` variants (local `index.ts:17496-17512`, `core.ts:541`) have no upstream counterpart. |
| 5 | Ownership recorded at result persistence, not launch → a worker whose result never persisted cannot be resumed by its own lead | **absent** (byte-similar) | `index.ts:1660-1682` (`ownedAssignmentChildren`), `1809-1875` (`resolveAssignmentSession` + refusal) | Upstream's ownership tree is built from `ownedAssignmentResult` entries in the caller's session (the `pi-herdsman-agent-result` records), so continuation requires completed-result provenance — the source comment says so (`1666-1668`). `resolveAssignmentSession` fails `invalid_request "Assignment source is outside the caller's proven session ownership tree"` (`1872-1875`). Our `ownedAssignmentChildren` (local `index.ts:1898-1920`) and refusal (local `2126`) are the same shape; the only local delta is the catch that keeps an unopenable child. Nothing to adopt. |
| 6 | Provider error dropped: a 429 publishes `A nonempty inline response is required` with no provider text | **absent** | `index.ts:15967-15996`; `mailbox.ts:114` | No upstream code reads a provider error (zero hits for `stopReason`, `message.error`, `errorMessage`, `statusCode`, `429` in `extension/`). The only empty-text failure is `error.code: "empty_result"`, message `"Agent produced no assistant text"` (`15983-15996`; code union `mailbox.ts:114`). Still true on `main` (`managed-agent-runtime.ts:1479-1480`). There is no response-validation module upstream, so our `response-validation.ts:574` string has no counterpart. |
| 7 | Empty final answer after real progress publishes failed while the work is complete on disk | **absent, and deliberately different** | `index.ts:15989-15996`, `15305-15330`, `1841-1848`; `config.ts:23,30` | Upstream's settle is `status: latest ? "completed" : "failed"` with `empty_result` when no assistant text exists (`15989-15996`) — the same outcome as ours. Its answer to *context pressure* is retirement rather than compaction: `session_before_compact` cancels a threshold compaction, appends `pi-herdsman-agent-context-retired`, and the `context` hook injects a retirement instruction (`15305-15330`), with `contextRetirement` defaulting to **true** (`config.ts:30`; already true at the take) and continuation refused as retired (`1841-1848`). Our fork defaults it false (local `config.ts:62`) and compacts instead (ADR 0028). Upstream has no background-work handling at all (no `background`/`backgroundWaiting` extension code), so our background-final-response recovery has no upstream source. |
| 8 | Retention: a delivered worker's pane and idle entry both disappeared while `retainWorkers` was true | **not comparable** — upstream's design is the opposite | `index.ts:3920-3987` | Upstream has no `retainWorkers` config (only `contextRetirement`; `config.ts:23-30`). `finalizeDeliveredRoot` always closes a live delivered agent (`closeLiveManagedExecution`, `3953-3966`) and then `removeResult` (`3975`) + `removeAgentMailbox` (`3984`). Our fork gates exactly that function with `const retain = presence.kind === "live" && retainWorkersEnabled()` (local `index.ts:4243`). So the disappearance is our gate being bypassed, not something upstream fixes; upstream would make the cleanup unconditional. |
| 9 | Compaction continuation not request-bound → orphan turn after the assignment settled | **not comparable** — mechanism absent | `index.ts:15967-15976` (settle guard), `16115-16125` (`agent_settled`), `15305-15330` | The pinned target has no worker context budget, no `compactManagedContext`, no continuation send, no `awaitingContinuation`/`contextCompactionInFlight`, and no response-correction budget (zero hits for each). Settlement is driven by the `agent_settled` event and guards on `activeRequestId` / `pendingAskId` / `pendingResult` / `pendingStateTransition` / undelivered child work (`15967-15976`) — upstream settles only at a real settle boundary. Its only `compact` handlers are the retirement cancel (`15305`) and Lead presentation (`14333`). Nothing upstream to port; the defect is entirely inside the fork's feature. (The fork landed its own guard during this investigation: commit `a2da5b9e3`, "Withhold a compaction continuation once its assignment has settled" — commit message and diff show the continuation is now withheld unless the requesting request id is still active, with a `pi_herdsman_state_compaction_continuation_skipped` diagnostic.) |
| 10 | Mailbox keeps only singular `activeRequestId`/`completedRequestId`, so "no active request" means both settled and lost | **absent** (identical shape) | `mailbox.ts:20-58`, `388-409` | `ManagedAgentState` `version: 5` with optional singular `activeRequestId`/`completedRequestId`; validation rejects the invalid combinations (`388-409`). No request history anywhere. Our fork adds `legacyAcceptedRequestIds` (local `mailbox.ts:42`, written at `995-1001`), but that is v4-read/migration compatibility, not history, so the ambiguity is unchanged in both. |

## Defects where our local fix conflicts with the upstream shape

1. **#8 retention vs `finalizeDeliveredRoot` (hard conflict).** Upstream closes the
   delivered agent and deletes the mailbox unconditionally (`index.ts:3920-3987`); our
   retention gate lives inside the same function (local `index.ts:4243`). Taking
   upstream's version verbatim deletes `retainWorkers`. Any curation of this region must
   keep the `retain` branch, and the local config defaults (`retainWorkers: true`,
   `contextRetirement: false`; local `config.ts:62-63`) must not be overwritten by
   upstream's `config.ts` block.
2. **#7/#9 context-pressure handling (design conflict).** Upstream cancels threshold
   compaction and retires the session (`index.ts:15305-15330`, `config.ts:30` default
   true); the fork compacts and continues (ADR 0028). Adopting upstream's
   `session_before_compact`/`context` hooks or its config default removes the fork's
   compaction behaviour; conversely, the fork's compaction is why the request-bound guard
   (#9) must exist. These cannot both be adopted.
3. **#2/#4 observation surface (structural conflict).** `core.ts:agentControlState` is
   6-arg/4-state upstream and 8-arg/6-state in the fork (adds `idle`, `waiting`; local
   `core.ts:512-546`), and the surrounding launch/snapshot code was reshaped for retention
   (`resolveIdleWorker`, local `index.ts:3449-3505`; `isLostWorkerOf`, `3511`). This is
   the plan's §2 label-2 collision on `core.ts`; any upstream take touching control state
   or the listing projection must be re-derived, not textually applied.
4. **#10 vs plan items #211/#213 (record-identity conflict).** Upstream's lineage and
   reservation work lands on the same mailbox records the fork has extended
   (`briefProfile`, `acceptedAssignment`, `backgroundWorkProvider`, `backgroundWaiting`,
   `legacyAcceptedRequestIds`; local `mailbox.ts:20-52`). The ack-vocabulary gain in row 4
   is only reachable through that same record surface.
5. **#1 (structural only).** Our fix (`try` immediately after the claim, local
   `index.ts:7162-7163`, catch `7877-7887`, commit `99b898c1d`) is strictly wider than
   upstream's, but it wraps the same region upstream restructures, so the two cannot be
   merged line-wise.

## Defects upstream does not cover — these stay ours

- **#1** — already fixed locally (`99b898c1d`); upstream still leaks in the window
  between the claim and its outer try, so the local fix must survive any baseline curation.
- **#2, #3** — lost-generation detection/recovery and the presence-vs-lookup asymmetry
  are shared with upstream and unresolvable there.
- **#5** — ownership at result persistence is upstream's own rule.
- **#6** — provider-error propagation does not exist upstream at all.
- **#7** — the empty-answer rule is upstream's own rule; the background-progress case is
  fork-only.
- **#8** — retention is a fork override of upstream's unconditional cleanup.
- **#9** — compaction continuation is entirely fork-internal (local fix `a2da5b9e3`).
- **#10** — mailbox request singularities are upstream's own shape.
- **#4 (residual)** — upstream supplies only two extra ack codes; the five conflated busy
  conditions and the mid-turn/idle projection remain ours.

Net: **no defect in the list is fixed by the pinned target.** One (#4) is partially
narrowed by vocabulary added in #211/#219; one (#1) has a narrower upstream variant of the
same leak.

## Limits and residual uncertainty

- Local anchors were re-resolved twice: fork HEAD moved from `1863bc41b` to `a2da5b9e3`
  during the run (peer-held, dirty tree). All local line numbers cited here are from
  `a2da5b9e3`. The brief's `index.ts:6273` claim is now `7162`; the plan's warning that
  every local line number is stale applies.
- Verdicts are code-read only. #1 in particular was decided from release topology, not by
  forcing a throw; the leaking statements identified are the label-exists fail, the
  invalid-label fail, `placementSettings`, and `physicalPlacement` — everything else in
  the `6127-6295` span is inside the `while (true)` retry blocks, which do release.
- Only the ten listed defects were checked; the plan's §3 adoption rows and the
  #229/#238 regions were not re-verified here.
- `main` (`05eec19`) was consulted only to test whether a later release fixes these; it
  does not (same `empty_result` settle, same `agent_settled` settlement, same
  activation-release topology). Upstream main is not the pinned target and was not audited
  defect-by-defect.

## Provenance

- Upstream: `https://github.com/boadij/pi-herdsman.git` → `/tmp/upstream-ph.git` (bare,
  full history, tags to v0.21.3); worktree `/tmp/up6f166a6` at `6f166a6`; worktree
  `/tmp/upmain` at `05eec19` (`main`). Fetched 2026-10-07 (UTC).
- Fork: `/home/saurabhj/Projects/dev/custom/pi-extensions/pi-herdsman`, HEAD `a2da5b9e3`
  (read-only; working tree dirty from peer work: `extension/index.ts`,
  `extension/agent-runtime.test.ts`, docs, and sibling packages). No fork file was
  modified by this investigation.
- Evidence snapshots supplied with the task: `.pi-herdsman/pre-extraction-adoption-plan.md`
  (pinned refs and classification), `.pi-herdsman/bus-listen-lifecycle-audit.md` (defect
  detail and anchors).
