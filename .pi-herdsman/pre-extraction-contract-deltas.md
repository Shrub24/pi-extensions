# Pre-extraction contract deltas: #219, #211/#213, #201/#220

Independent, read-only comparison of three pre-extraction upstream contracts against
local behaviour. Companion to `.pi-herdsman/pre-extraction-adoption-plan.md`, which it
corrects. No production edit, no OpenSpec edit, no merge/cherry-pick, no gate, no
experiment in peer-held files. Urgent #229 is untouched.

Evidence base:

- Upstream target `6f166a67e997791a6bc25d38cbcf4dcea14ce470` (`4b3747b^`, `v0.19.1-2-g6f166a6`),
  read as blobs from the fresh mirror `/tmp/upstream-herdsman.git` into `/tmp/deltas/t-*.ts`
  (2026-10-06 22:5x +02:00). Commit diffs read with `git show <sha>`.
- Local: `pi-herdsman/extension/*` read at bounded windows, monorepo HEAD `88c436bdf`
  (2026-10-07 00:0x +02:00). `extension/index.ts` and `extension/agent-runtime.test.ts` are
  peer-held: read only.
- Every claim below is marked **[demonstrated]** (I read the code path) or **[inferred]**.

## 1. #219 build compatibility (`fd2de5a`, `extension/compatibility.ts`)

### Exact fingerprint inputs [demonstrated]

`extension/compatibility.ts` (41 lines at target) is the whole module:

- `runtimeBuild(version, path)` → `{ version, sha256: sha256(readFileSync(path)) }`.
- `isRuntimeBuild(value)` → **exactly two keys**, `version` a non-empty string ≤128 chars,
  `sha256` matching `/^[0-9a-f]{64}$/`.
- `sameRuntimeBuild` compares **both** fields; `formatRuntimeBuild` renders `v<version> · <sha12>`.

Wired at target `index.ts:296-300`:
`HERDSMAN_VERSION = packageMetadata.version`; `HERDSMAN_EXTENSION_PATH = fileURLToPath(import.meta.url)`;
`export const HERDSMAN_BUILD = runtimeBuild(HERDSMAN_VERSION, HERDSMAN_EXTENSION_PATH)`.

So the fingerprint is **package version + sha256 of the extension entry file the module
was loaded from**. Consequence [inferred]: any edit to that file changes the build id,
including edits that do not change behaviour; two runs of the same published version
from different paths can differ. The sha is of the *entry* only — not of the whole
package, not of a bundled artifact set.

### What is refused, and where [demonstrated]

`requireCompatibleBuild(remote, operation, target)` (`index.ts:233-253`): returns when a
remote build exists and equals local; otherwise `fail("incompatible_build", …)` with two
distinct messages — mismatch (`Pi Herdsman build mismatch for <target>: local …, target …`)
or **no build identity at all** (`Cannot establish Pi Herdsman build compatibility for
<target>; the target predates the current runtime identity contract`) — plus
`nextAction` restart guidance, and `details: { localBuild, remoteBuild | null }`.

Refusal/deny sites (16 `requireCompatibleBuild` calls plus 5 boolean authorization checks):

| Site (target `index.ts`) | Context |
|---|---|
| 2744 | request/ack handling |
| 4414 | `ask` — `Agent <label>` |
| 6373 | close/stop lifecycle |
| 8017, 8022, 8396, 8401, 8431, 8460, 8477 | lead/coordination actions |
| 10206, 10222 | `Lead <id>` operations |
| 10439, 10535, 10617 | manager/staff project actions |
| 12888 | additional action guard |
| 7848 | lead coordination state generation check → `throw "Lead coordination state changed; retry the action"` |
| 8326, 8513 | peer message / chief record authorization → `false` |
| 8994 | chief record rejected → `ui.notify("Rejected Pi Herdsman coordination from …; local build is … Restart the stale Pi session.")` |
| 15578 | inbound control request → `acknowledgeAndDiscard(..., "incompatible", "Owner build … does not match local …")` |

Supporting additions: ack code `"incompatible"` in the mailbox acknowledgement union and
error category `incompatible_build` (`index.ts:2817-2818`, `errors.ts`); `build` accepted
(and shape-validated) on `state`/`request` mailbox records (`t-mailbox.ts:326-333`) and as
an optional field of chief/peer message records (`t-supervision.ts:210`, `:229`).

### Idle workers vs active workers [demonstrated for placement, inferred for consequence]

The only intervals at target are status `2000 ms` (`index.ts:14107`), supervision
`2000 ms` (`:10894`), request pump `250 ms` (`:15476`) and the leaf-status timer
(`:14937`, `:15505`). No `requireCompatibleBuild`/`HERDSMAN_BUILD` symbol appears inside
those timer bodies (symbol inventory above) — the gate is evaluated on **interaction**
boundaries, not on a timer. [inferred] So an idle mismatched peer keeps running and keeps
being displayed; the refusal arrives when a manager/lead tries to interact with it, when a
coordination record from it is authorized, or when it is asked to do something. It is not
a startup check.

Record-equality sites make build part of identity [demonstrated]:
`samePeerLeadRecord` (`supervision.ts:1075`), `samePeerLeadGeneration` (`:1098`),
`sameChiefDescriptor` (`:1326`) all include `sameRuntimeBuildEvidence(actual.build,
expected.build)`; `claimChiefLease` (`:1341`) requires `isRuntimeBuild(identity.build)`.
[inferred] A record written by a different build therefore fails generation/liveness
comparisons — which is a second, independent effect from the refusal messages.

### Existing local compatibility/fingerprinting [demonstrated]

Local has **no** runtime fingerprint: no `compatibility.ts`, no `RuntimeBuild`,
no `HERDSMAN_BUILD` (`grep -n 'HERDSMAN_BUILD\|runtimeBuild' extension/*.ts` → none).
Local `sha256` occurrences are handoff-artifact and message hashes
(`index.ts:921,955,996,6648,6951`; `mailbox.ts:198,777,785`), not identity.
Local does have the version string (`HERDSMAN_VERSION = packageMetadata.version`,
`index.ts:328`), so only the file-hash half is new. Local acknowledgement codes are
`["busy","idle","invalid","identity","delivery"]` (`mailbox.ts:633`) — **no
`"incompatible"`** — and local has no build field in any mailbox record.

### Mixed-version reality [demonstrated mechanism, inferred consequence]

Both the take and local reject unknown mailbox fields (`Unknown mailbox field`,
local `mailbox.ts:399`; the target keeps the same list check at `t-mailbox.ts:329`).
[inferred] Adding `build` to written records is therefore **not wire-neutral for current
local readers**: an old reader parses a new record containing `build` as an error rather
than ignoring a new field. If that inference holds, the #219 gate does not create the
mixed-version break; it replaces an "Unknown mailbox field" parse error with a named
refusal that states the recovery action. Testable in one fixture (§4.1).

### Adoption cost vs override cost

- **Adopt (recommended direction, not a decision):** add `extension/compatibility.ts`
  (41 lines), the `HERDSMAN_BUILD` constant, the ack code + error category, the `build`
  field on the two record kinds and the optional message field, and the refusal calls at
  interaction boundaries. Local wire lists already exist and are additive; the peers of
  the change are the mailbox/supervision validators and the action guards.
- **Override:** keeping today's behaviour means no fingerprint, so a mixed fleet has no
  identity to compare and no recovery message — but see the inference above: it also does
  not have silent interop, it has unexplained parse errors.
- **Cost that is not free:** the entry-file sha makes *any* edit to `index.ts` a build
  change, so local-only patches to that file invalidate comparisons with upstream builds
  by construction [inferred from the input choice].

### Plausible regression tests

1. Two mailbox fixtures written by different `{version, sha256}` differ → interaction
   refused with `incompatible_build`, `nextAction` present, and no record mutated.
2. A record with no `build` → the "predates the current runtime identity contract"
   message, still refused, still no mutation.
3. New writer always emits `build`; `claimChiefLease` with a missing/malformed build refuses.
4. Peer-lead record with a different build → `samePeerLeadGeneration` false, so liveness
   comparison does not treat it as the same generation.
5. Idle status/supervision refresh for a mismatched-build peer still renders a row (the
   gate is not on the timer path).
6. A take-era reader given a `build`-carrying record: record the actual outcome
   (`Unknown mailbox field` vs accepted) — this test settles the inference in §1.

### Material operator choices

- **Refuse or advise.** Adopt the refusal as upstream does, or carry the same fingerprint
  and comparisons but downgrade the *interaction* refusal to a warning, keeping hard
  refusal only where a wrong-build record would be acted on (control requests, project
  actions). Evidence for the split: the record-identity comparisons already exist
  independently of the refusal calls.
- **What the fingerprint covers.** Entry-file sha (upstream) vs a value that tolerates
  local-only edits to `index.ts`. This is a local-only consequence of the fork's monolith:
  upstream's file was 2.3k lines post-#238 and theirs; ours is 18.4k and edited often.

### Missing facts

- Whether the worker-side request pump (`index.ts:15476`, leaf path) also checks the build
  or only the owner-side guard does — not read.
- Whether an older reader truly rejects a `build`-bearing record (inference above), and
  what an older *writer* does when it receives one.
- Whether any local consumer (control requests, radar publisher) would need its own build
  field to stay consistent.

## 2. #211/#213 durable semantic result refs and lineage

### What upstream adds [demonstrated]

`storage.ts` at target (138 lines) holds all of it:

- Grammar unchanged: `SEMANTIC_RESULT_REF = /^result:([a-z][a-z0-9_-]{0,31})#([1-9][0-9]*)$/`,
  canonical refs still `result:<requestId>` (`isCanonicalResultRef`), `resultRef`,
  `resultPath`, `resolveResultRef` as before.
- `ResultBinding = { ref, canonicalRef }`, validated by `isResultBinding` (exactly two
  keys, `ref` parses as semantic, `canonicalRef` is canonical).
- `reserveSemanticResultRef(agentLabel, minimumIndex = 1)`:
  namespace `<herdsmanDataRoot()>/result-ref-reservations/<agentLabel>/` (dir `0700`);
  index starts at `max(minimumIndex, maxReserved + 1)` over numeric filenames; claim by
  `writeFileSync(<index>, "reserved\n", { flag: "wx", mode: 0o600, flush: true })`;
  on `EEXIST` increment and retry; then `fsync` **the directory** (skipped on win32);
  returns `{ index, ref }`.

Concurrency and crash properties [demonstrated]: the claim is an exclusive create, so two
processes racing the same index produce one winner and one retry; the file is flushed and
the directory fsynced **before** the ref is returned; `EEXIST` is expected, not fatal;
`index` overflow past `Number.MAX_SAFE_INTEGER` throws
(`Semantic result index exhausted`).

### Index namespace, durability timing, retention [demonstrated]

- Namespace is **per agent label, global across sessions/processes/hosts sharing the data
  root** — not per branch. At target there is exactly **one** call site:
  `index.ts:3771`, `reserveSemanticResultRef(result.agentLabel,
  nextBranchResultIndex(entries, result.agentLabel))`, memoized per delivery in
  `resultDeliverySemanticRefs`. The branch-derived value is only a *floor*; the
  reservation raises it. Commit `9688a33` is titled "allocate semantic result refs
  globally" — consistent with the directory, and the directory name is not the schema:
  take semantics from the code above.
- Became durable at allocation, i.e. before the ref is advertised in a completion; a crash
  after reservation leaves a permanent gap (an index never reused), never a reuse.
- **Retention/cleanup: none.** `git grep 'result-ref-reservations' <target> -- extension
  docs` returns only `storage.ts:91` and two test files; no pruning, TTL or compaction
  exists. [inferred] Growth is one small file per delivered result per label, unbounded by
  design.

### Legacy/reference compatibility [demonstrated]

`ref`/`canonicalRef` semantics, `resolveResultRef`, `resultPath` and the model-facing
grammar are unchanged; `resultBindings` is an added optional field on ask records
(`t-mailbox.ts` allowed list) and on chief message records (`t-supervision.ts:210`).
So the change is additive to references, and old canonical refs keep resolving.

### Lineage transport and conflict handling [demonstrated]

- `importResultBindings(pi, ctx, bindings, operation)` (`index.ts:3633-3670`) is called on
  handoff receipt (e.g. `ask_owner`, `:4322`). It fails closed on: an invalid binding
  (`internal_failure: Invalid result binding`); two imported bindings for the same `ref`
  disagreeing (`target_ambiguous: Result ref … has conflicting imported bindings`); and a
  receiver branch whose existing canonical refs for that `ref` disagree or are multiple
  (`target_ambiguous: Result ref … conflicts with the current branch`).
- [inferred] This is the property local lacks: the semantic ref becomes a *transported*
  identity — the canonical mapping travels with the handoff and is validated against the
  receiver's branch, instead of being re-derived from whatever the receiver happened to see.

### Local entry-scan assumptions [demonstrated]

- Allocation: `nextAgentResultIndex(entries, agentLabel)` (`index.ts:3881-3898`) walks the
  **current branch's entries** and returns `max + 1`; used at `:3999-4000` when a
  completion carries a `resultRef`, and cached per evidence key.
- Resolution: `resolveResultReference(input, branch, operation)` (`core.ts:85-136`)
  matches entries on the branch by `agentLabel` + `resultIndex`; no match →
  `target_not_found`; more than one distinct canonical ref → `target_ambiguous`;
  malformed → `invalid_request`. `canonicalResultRef` (`core.ts:47`) derives the canonical
  ref from the entry details.
- Local has **no** `ResultBinding`, `resultBindings`, `importResultBindings`,
  `isCanonicalResultRef`, reservation directory or cleanup
  (`grep` over `extension/*.ts` → none).
- [inferred, and the crux] Because allocation reads only branch entries, a **fresh session
  or branch starts at index 1 for the same label**, so `result:label#1` can denote
  different canonical results in different branches; and a ref received via handoff is only
  resolvable if that branch previously saw the delivery. Reservations fix the first;
  bindings fix the second. Adopting one without the other leaves a gap — see the operator
  choices.

### Adoption cost vs override cost

- **Bindings only** (transport lineage): touches `storage.ts` (types + validator),
  `mailbox.ts`/`supervision.ts` (optional field, allowed lists), `core.ts`
  (`importResultBindings` equivalent + the `target_ambiguous` rules), and the handoff call
  sites. No new durable directory, no new crash semantics.
- **Reservations only** (global uniqueness): adds the allocator, its directory and its
  fsync discipline, plus the call-site floor; no new conflict rules.
- **Both** (upstream): the two compose naturally — uniqueness makes a transported binding
  unambiguous; the binding makes a foreign ref resolvable.
- **Override (status quo):** cheapest, and it keeps `resolveResultReference`'s strict
  branch-scoped failure mode; the cost is the cross-branch collision above and no
  transport of lineage.
- Accepted cost of reservations: an immutable, unpruned directory under the data root.

### Plausible regression tests

1. Two sessions (or a fresh branch) deliver results for the same label → indices differ;
   the second delivery is not `#1` when `#1` is reserved.
2. Two concurrent allocators (two processes, same data root) → distinct indices, no
   duplicate; simulate `EEXIST` and assert the retry loop.
3. Crash between reservation and delivery → next allocation skips the reserved index.
4. Handoff carrying `resultBindings` resolves on the receiver's branch without the
   receiver having observed the delivery.
5. Conflicting imported binding → `target_ambiguous`; conflicting branch resolution →
   `target_ambiguous`; unknown ref → `target_not_found`; malformed → `invalid_request`.
6. Unwritable reservation directory → explicit failure, never a silent reuse of an index.
7. Legacy canonical `result:<uuid>` refs and existing semantic refs keep resolving.

### Material operator choices

- **Which half to adopt** (evidence per option above): both, bindings only, reservations
  only, or neither. The dependency to note is that reservations alone do not make a
  foreign ref resolvable, and bindings alone do not stop a fresh branch from reusing
  index 1.
- **Growth policy for the reservation directory**, which upstream leaves unbounded; a
  local GC would be a local addition with its own correctness argument (a deleted index
  can be reallocated by a race unless allocation is monotonic by other means).

### Missing facts

- Upstream's own test expectations for these contracts live partly in
  `agent-runtime.test.ts`, which is peer-held and was not read/run.
- Whether any *local* consumer (radar publisher, control fixtures) embeds semantic refs in
  a durable artifact that a new allocation scheme must keep stable.
- No usage data on whether local cross-session ref collisions occur in practice.

## 3. #201/#220 staff delegate/resume and supervisor awareness

### Interface vs prompt, separated [demonstrated]

**#220 tool surface** (target `index.ts:7189-7221` schemas, `:13040-13118` registrations):

| Tool | Parameters | Description (verbatim) | Dispatch |
|---|---|---|---|
| `staff_delegate` | `task` (required, `\S`), `branch?`, `base?`, `files?` | "Start new project work. Reuses an unoccupied Herdr worktree when available." | `{ action: "delegate", ...p }` |
| `staff_resume` | `branch` (required, `\S`) | "Resume existing unresolved project work by its exact Git branch." | `{ action: "resume", branch }` |
| `staff_stop` | `session` (exact Pi session id) | unchanged | `{ action: "stop", session }` |

Both staff project tools route into one internal action (`staffTool.execute`) with an
`action` discriminator; the discriminator name appears in errors
(`operation.action === "resume" ? "staff_resume" : "staff_delegate"`, `:10143`).

**#220 also removes tools**: `extension-contract.test.ts:284` asserts
`["staff_close", "staff_complete", "staff_discard"]` are absent at target, and the diff of
`382a188` adds those names to that assertion. The take `156b1c66` had `staff_complete`
(`index.ts:12585`) and `staff_discard` (`:12613`) — both inherited by our fork, which still
registers them (`index.ts` `MANAGER_TOOLS` `:376-379`; registrations `:14447` and
following) and documents them (`docs/reference/staff.md:8`, `:127-135`).

**#201 is not a tool-surface change** [demonstrated]: its `index.ts` diff contains no
`registerTool`/`name: "..."` addition; the only registration-adjacent change is a lock file
name (`{ name: "project assignment lock" }`). Its substance is
`SUPERVISOR_STATE_TYPE = "pi-herdsman-supervisor-state"` custom messages,
`latestLeadResponseSince()` and `projectAssignmentPath`, i.e. manager-owned project
assignment resolution plus supervisor awareness, with prompt/docs edits.

**#224** is prompt/policy only (`SKILL.md`, `docs/concepts/*`, `docs/guides/*`, and +47
lines in `index.ts` prompt strings).

### Resume/resolution rules at target [demonstrated]

Inside `activateProjectLeadLocked` (`:10135-10175`), under an active manager lease and a
`worktreeGroupScope` primary-workspace check:

- `readProjectAssignment(runtime, manager.repoKey, operation.branch)`; an assignment in
  another repo is refused.
- `delegate` with an existing assignment → `Work already exists on <branch>; resume it
  with staff_resume.`
- `resume` with no existing assignment → `No existing work was found on <branch>; start it
  with staff_delegate and a task.`
- Resume reuses the existing assignment id; `>1` Herdr worktree matching the branch →
  `Multiple Herdr worktrees match branch <branch>`.

### Can it coexist with local briefs/roles and resume rules? [demonstrated + inferred]

Local already has the underlying behaviour, expressed through one tool:
`readProjectAssignment`/`writeProjectAssignment` exist (`index.ts:246`, `:9406`, `:11204`,
`:11262`, `:11355`, `:11439`); the delegate path looks up `unresolved` work at `:11439` and
refuses with `Work already exists on <branch>; resume it with staff_delegate using only
branch.` (`:11449`); the local prompt says "…with branch only to resume existing work"
(`:394`); `projectAssignmentPath` already exists (`supervision.ts:1646`).

[demonstrated] Therefore `staff_resume` can be added as a thin registration over the
existing branch-only delegate path — a `branch`-only parameter object dispatching to the
same code — without touching briefs, role resolution, the manager lease, the worktree
uniqueness rule or any local contract. What cannot be adopted without a capability
decision is the **removal** of `staff_complete`/`staff_discard`: upstream's replacement
story is `staff_stop` (pause, preserving work/session/branch/worktree) plus #226's
`retireRemovedProjectWork`, and no upstream tool matches "complete/discard fulfilled
project work" as such [inferred from the absence of a replacement name in the target
registrations and from `docs/reference/staff.md` at target listing only
`staff_delegate`, `staff_resume`, `staff_stop`].

Overlap with local role/brief policy [demonstrated]: local publishes role/brief/profile
through its own modules and `SUPERVISOR_TOOLS = ["supervisor_message"]`
(`index.ts:363`); upstream's #201 adds internal awareness messages rather than tools, so it
can sit beside local roles — the collision risk is in the *prompt text* (orchestration-first
Lead policy, `:85a4ddf`), not in interfaces.

### Plausible regression tests

1. `staff_resume` on a branch with no assignment → refusal naming `staff_delegate`.
2. `staff_delegate` onto an existing branch → refusal naming `staff_resume`.
3. Branch-only `staff_delegate` (the current local call shape): assert the chosen behaviour
   (accept as alias, or refuse and require `staff_resume`).
4. `staff_resume` with an extra `task` field → rejected by `additionalProperties: false`.
5. Assignment in another repo, and `>1` worktree on the branch → each refusal preserved.
6. Tool-surface assertions: if complete/discard are adopted as removed, assert absence the
   way upstream does; if kept, assert presence and document the divergence.
7. Supervisor awareness: a manager action emits the `pi-herdsman-supervisor-state`
   custom message once and `latestLeadResponseSince` reflects a later Lead reply.

### Material operator choices

- **Interface split yes/no, and what happens to complete/discard.** Options with evidence:
  (a) add `staff_resume`, keep `staff_complete`/`staff_discard` as local overlays — no
  capability loss, surface differs from upstream; (b) adopt upstream exactly, removing both
  and relying on `staff_stop` + #226 retirement — maximum alignment, but the local
  capability disappears unless the operator accepts `stop`/retirement as the replacement;
  (c) keep the single polymorphic `staff_delegate` — divergence retained with no adopter
  benefit beyond the refusal message wording.
- **Prompt policy (#224/#201 text) is separable** from the interface choice: it can be
  adopted, kept local, or merged, independently of whether `staff_resume` exists.
- **Supervisor awareness (#201)**: adopt the custom-message awareness while keeping local
  role/brief publication, or defer until local roles are re-examined.

### Missing facts

- Whether local `staff_complete`/`staff_discard` have deployed users; local docs describe
  them but usage is not observable from source.
- Whether upstream's post-#226 retirement covers the abandon/complete cases in practice
  (would need the #226 diff read end-to-end, not done here).
- `agent-runtime.test.ts` and `controller-api.test.ts` cases for these tools are peer-held
  and were not run; the target's own test files were read only for the assertions quoted.

## 4. Corrections this forces in the plan

1. **"Equivalent local behaviour → do not port; collapse the duplicate"** was too broad.
   Equivalent *feature names* are not equivalent semantics: local resume-by-branch exists
   but under a different tool surface with different refusals, and local semantic refs
   exist but with branch-scoped allocation and no lineage transport. Collapse a duplicate
   only after the equivalence is named and tested (the tests in §3.1-3.3, §2.1-2.7).
2. **"One OpenSpec change per behaviour"** over-split: these three contracts share one
   mechanism (build/format identity carried in the same records) and one review seam.
   One baseline-alignment change with **staged, independently revertible commits** is
   the better shape; split out only a choice that is genuinely incompatible (e.g.
   removing `staff_complete`/`staff_discard`, or a reservation-directory GC).
3. **Blanket "keep local" defaults** are replaced by the option sets above, each with its
   demonstrated cost. No option is marked adopted here: (#219 refusal scope), (#211/#213
   which half plus growth policy), (#201/#220 complete/discard fate and prompt policy)
   remain operator decisions.

## 5. Limits

Blob-level reading of `6f166a6` plus `git show` diffs; local reads were bounded windows of
peer-held files. Behavioural statements about *mixed-version* fleets are labelled
inferred and each has a cheap settling test (§1.6). No test was executed, no gate run, no
mirror refreshed, and nothing in this file approves adoption.
