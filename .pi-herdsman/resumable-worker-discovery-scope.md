# Durable discovery of closed-but-resumable workers — scope (recon, no implementation)

Read-only investigation of this fork at `b27bf1dfd`. No production or
test edit, no mailbox/runtime mutation, no commit. All anchors are symbol-anchored
so they survive line drift; line numbers are from `b27bf1dfd`.

Scope: what a lead can discover about a *deliberately closed* (delivered,
retention-off) generation, and the smallest change that exposes safe
continuation. Out of scope: retention redesign, mux migration, transcript
scanning, force-close, alias repair, new lifecycle queues.

## 1. Premise verdict

**The plan premise is correct in effect, but the stated reason is wrong, and one
part of the capability is already built.**

| Plan claim | Verdict | Evidence |
| --- | --- | --- |
| "a delivered worker no longer appears in the inventory" | Correct in effect, wrong mechanism. The listing is built from **durable mailboxes**, not from the Herdr inventory; retention-off delivery **deletes the mailbox record**, which is why the worker disappears. | `list()` (`index.ts:3910-3933`) projects `agentSnapshotView` ← `managedAgentSnapshots` ← `listAgentStates()` (`mailbox.ts:277-282`); retention-off cleanup calls `removeAgentMailbox(mailbox)` (`index.ts:4356-4369`) |
| "a lead that would have continued it respawns instead" | **Not what happens today.** `agent_continue` already resumes a mailbox-less session: with no record, the representation check is skipped and the launch runs with `--session <recorded path>` under the inherited label. | `index.ts:7282` gates the whole decision block on `representations.size === 1`; `assignment.workspaceId` and `sessionArgs` (`index.ts:7126, 7229`) |
| "the capability survives in the mailbox and session" | **Half wrong.** It survives in the **session** (the caller's own durable result entries + the saved Pi session file). The mailbox is gone. | `ownedAssignmentResult` reads the caller's `pi-herdsman-agent-result` entries (`index.ts:1812-1849`, parser `core.ts:24-45`) |
| "nothing advertises it" | Correct. No listing surface, no wake-message nudge when retention is off, and the documented behaviour contradicts the implementation. | `retentionNudge` is emitted only when `retainWorkersEnabled()` (`index.ts:4150-4153`); `SKILL.md:96-101` says retention-off workers are "not reused" |

Consequence for the slice: the work is **advertisement + guidance**, not a new
resume capability. Any design that adds a resume path would duplicate one that
already exists and is already exercised (`controller-lifecycle.test.ts:79-104`
fabricates exactly the durable entry shape; `:4537-4605` continues a session with
no live worker).

## 2. What durably survives retention-off delivery

Observed in source, in order of trust:

1. **The caller's own session entries.** Delivery appends a
   `pi-herdsman-agent-result` custom entry with
   `details { runId, requestId, ownerSessionId, workspaceId, agentLabel, paneId,
   cwd, piSessionId, piSessionFile, agentDefinition, status, sessionRetired,
   resultRef?, resultIndex?, elapsedMs?, contextUsage, truncated, … }`
   (`index.ts:4160-4216`). This satisfies `ownedAssignmentResult`'s required
   fields (`index.ts:1812-1849`) and is the only *discovery-grade* record that
   survives. A second writer of the same entry type reports operator-abandoned
   assignments (`index.ts:5662-5697`).
2. **The saved Pi session file** on disk, with its own header (`cwd`) and the
   agent identity entry (`pi-herdsman-agent-definition`). Opened and validated
   by `openOwnedAssignmentSession` (`index.ts:1937-1952`).
3. **The label lineage**: the label is inherited, not re-mintable
   (`resolveAssignmentSession` → `resumed.label`, `index.ts:2106-2112`;
   `SKILL.md:80-83`).
4. **The mailbox directory is removed.** `removeResult` then
   `removeAgentMailbox` (`index.ts:4356-4369`), pinned by
   `recovery.test.ts:3380-3430` ("disabled retention still tears the delivered
   worker down") which asserts `readAgentState(mailbox) === undefined` and
   `closeOrder === [label]`. Test-wide default is retention off
   (`recovery.test.ts:78`).

So the durable source for discovery is the **caller's own entries**, exactly the
source `ownedAssignmentChildren(entries, ownerSessionId)` already trusts
(`index.ts:1905-1935`) — not the mailbox, not Herdr, not transcripts.

## 3. How `agent_list` projects records today

- `managedAgentSnapshots` scans **all** mailboxes and filters by workspace:
  `allMailboxes.filter(state => state.workspaceId === currentWorkspaceId)` where
  `currentWorkspaceId = process.env.HERDR_WORKSPACE_ID ?? ctx.cwd`
  (`index.ts:3021-3035`).
- Per record: `presence = managedAgentPresence(state, inventory)`; projected
  state is `settling` (pending result / result error) → `lost` (pane proven gone)
  → `unknown` (unprovable, `recovery_only: true` + diagnostic) → otherwise the
  live projection (`index.ts:3101-3134`).
- Ownership: `visibleAgentSnapshots` keeps `state.ownerSessionId ===
  ownerSessionId` as direct, then adds descendants whose unique durable parent is
  visible (`index.ts:3675-3712`).
- `listedAgentRecord` builds `available_tools` (`index.ts:3712-3800`):
  - `lost` + direct → `transcript`, `close` (never `continue`);
  - `live` + `idle` → `inspect`, `transcript`, `close`;
  - `live` + working → `inspect`, `transcript`, `steer`, `interrupt`, `extend`,
    `close` as applicable;
  - `unknown` → none, `recovery_only: true`.
- Synthetic rows already exist as a precedent: `unknownAgentRecords()` projects
  malformed-mailbox diagnostics as `{state: "unknown", available_tools: [],
  managed: true}` rows appended by `list()` (`index.ts:3901-3908`).
- Public record fields include `pi_session_id` and `pi_session_path`
  (`index.ts:3123-3126`), so a session selector is already surfaced for records
  that exist.

**Net current behaviour:** a closed delivered generation has no row at all. A
*proven lost* generation has a row, is labelled "lost", advertises
`transcript`/`close`, and its guidance says loss is unresolved — while the same
record is in fact resumable via `agent_continue --session <id>` (the
`recover` branch, `index.ts:7310-7345`).

## 4. `agent_continue` on a closed generation, today

Resolution is entry-driven and needs no mailbox:

1. `resolveAssignmentSession(ctx, p.session)` accepts only an exact `.jsonl`
   path or full UUID (`assignmentSessionSelector`, `index.ts:1769-1800`) and
   walks the caller's owned children, defaulting to **completed-result
   provenance** (`includeReceipts = false`, `index.ts:1905-1935`). It re-opens
   the session and requires the recorded definition+label to match
   (`index.ts:2061-2137`).
2. Session-identity checks: cannot continue the caller's own active session
   (`index.ts:7225-7230`); retired sessions are refused when
   `contextRetirement` is on (`index.ts:2099-2105`).
3. Representation check (see §5 for its scope bug): with zero mailbox records the
   `representations.size === 1` block is skipped entirely (`index.ts:7282`).
4. Launch path: `requestedLabel = resumed.label`, `agentCwd = resumed.cwd`,
   `sessionArgs = ["--session", resumed.path]`, no `relaunched` field in the
   response (`index.ts:7129-7135, 7229, 7805-7822`).

Inference (not executed): a lead that passes the session id from the delivery
message gets exactly the desired outcome today — same label, same session file,
new process — with no `relaunched` marker to say so. This is the behaviour the
slice should make discoverable and explicit rather than invent.

## 5. Answering the remaining investigation questions

**Can `agent_continue` resume a closed generation across a workspace change
safely?** Partly, with two sharp edges found in source:

- The listing is workspace-filtered (`index.ts:3029-3035`) but the representation
  check is **not**: `listAgentStates().filter(state => state.piSessionId ===
  resumed.id || samePersistedSessionPath(state.piSessionFile, resumed.path))`
  (`index.ts:7248-7256`) scans every mailbox in every workspace.
- The new assignment takes the **current** workspace
  (`workspaceId: process.env.HERDR_WORKSPACE_ID ?? ""`, `index.ts:7126-7127`),
  not the recorded one.
- Therefore a surviving record in another workspace can silently decide the
  outcome: one `lost` record → `recover` and `closeManagedSnapshot` retires a
  mailbox in the other workspace (`index.ts:7313-7345`); one `live` record →
  `reuse` and the assignment is submitted into a worker in the other workspace
  (`index.ts:7477-7500`); one `unknown`/`aliasUnclaimed` record → a hard
  `target_ambiguous` refusal naming that foreign pane (`index.ts:7294-7309`).
- Related hygiene risk: `clearTestMailboxes()` deletes only paths whose *record*
  workspace matches `WORKSPACE` (`support.ts:1019-1023`), so a fixture whose
  state carries `workspaceId: \`${WORKSPACE}-replacement\``
  (`recovery.test.ts:4658`) leaves a directory that the unfiltered scan at
  `index.ts:7248` can still match. This is a fixture-cleanup gap, not a
  production path, but it can skew any global-state test.

**What distinguishes the states?** (all read from source)

| Condition | Evidence | Continuation outcome |
| --- | --- | --- |
| Active assignment | mailbox record with `activeRequestId` | `agent_busy` "already represented by active managed work" (`index.ts:7315, 7360-7371`) |
| Unread durable result | mailbox record + `hasDurableResult` (result file present for `completedRequestId`/`activeRequestId`/handoff) (`index.ts:2928-2956`) | `agent_busy` "has an unretrieved result … retrieve it before continuing" (`index.ts:7321-7335`) |
| Proven lost | mailbox record, `presence.kind === "lost"`, same label and `ownerSessionId` (`isLostWorkerOf`, `index.ts:3539-3549`) | `recover`: shared lost-close seam retires the mailbox, relaunch same session, `relaunched: process_lost` (`index.ts:7313-7345`) |
| Uncertain occupant | mailbox record, `presence.kind === "unknown"` (`aliasUnclaimed`) | `target_ambiguous` refusal with `{label, paneId}`; ADR 0030 forbids advertising or acting |
| Deliberately closed | **no** mailbox record; caller entry with `status: completed|failed` | falls through to a fresh launch on the same session/label, unadvertised and unreported |
| Multiple representations | >1 distinct workspace+label+run+pane (or a live agent whose session matches and whose pane is not represented) | `target_ambiguous` (`index.ts:7276-7281`) |

Note the asymmetry that must be preserved: lost/unknown are *mailbox* facts;
resumable-closed is an *entry* fact. Nothing may treat an absent mailbox as
authority about liveness (ADR 0030 rationale) — the entry proves only "this
caller owned that session and its assignment resolved", never "that process is
gone".

**What authority can discovery provide?** Only "this caller owns a session whose
assignment already resolved, and the session file is openable with matching
identity". It is not liveness, not process authority, not a claim that the
generation is closed *by us* rather than still running unrepresented. That
distinction is why resume eligibility should require the absence of any mailbox
representation for the same session/label, and why the projected state must be a
new durable-only kind rather than reusing `lost`, `idle`, or `unknown`.

## 6. Smallest proposed change

Two parts; part A is the behavior change, part B is guidance only. No Herdr call,
no mailbox schema change, no new lifecycle queue.

**A. Project owned closed generations as resumable, from the caller's entries.**

1. Add a derivation next to `visibleAgentSnapshots` that yields, for the calling
   controller, the set of owned assignment children from
   `ownedAssignmentChildren(ctx.sessionManager.getEntries(), ownerSessionId)`
   whose session file opens through `openOwnedAssignmentSession`
   (identity + existence proven) and whose id/path is **not** represented by any
   mailbox record in scope (reuse the `representations` identity key from
   `index.ts:7242-7246`, but computed against `managedAgentSnapshots`'s
   workspace-filtered mailbox list so listing and continuation agree).
2. Project each as one synthetic row appended by `list()` beside
   `unknownAgentRecords()` (`index.ts:3916-3933`), with a new durable-only state
   (proposal: `"closed"`) and no destructive tools:
   `{ label, kind: "pi", state: "closed", managed: true, owner_session_id,
   agent_definition, pi_session_id, pi_session_path, last_result: { requestId,
   status, resultRef?, completedAt } , available_tools: [] }`.
   Rationale for `available_tools: []`: no existing tool binds to a label for
   continuation (`agentContinueParameters` takes `session`, `index.ts:8723-8736`),
   and `available_tools` must keep meaning "currently eligible operations"
   (`SKILL.md:84-88`). If the owner wants an explicit signal instead of an empty
   list, a read-only marker such as `resumable: true` is enough; do not add a
   label-addressed tool to the destructive list.
3. Keep the row out of `managed`-identity claims that assume a mailbox: it must
   never be a `close`, `inspect`, `transcript`, `steer`, `interrupt`, `extend`,
   or control-subsystem target. `agent_close` and
   `agent_transcript` resolve through `agentSnapshotView` (`index.ts:6965-6995`),
   so a synthetic row that is not a `ManagedAgentSnapshot` cannot leak into them.
4. Deduplicate by session against existing records: if any mailbox record in
   scope already carries the same `piSessionId`/`piSessionFile`, that record wins
   (live idle, lost, unknown, active, or unread-result) and no `closed` row is
   emitted. This is the guard that keeps `unknown` from being advertised as
   resumable (ADR 0030) and keeps the listing consistent with the continuation
   decision at `index.ts:7248-7282`.
5. Do not scan transcripts or the mailbox filesystem for history: one pass over
   the caller's entries plus a validated session-file open per candidate is the
   whole cost, and it happens only when `agent_list` runs.

Bounded caveat to state in the change: opening a session file per candidate is
I/O in a listing path. Bound it (e.g. only candidates whose entry is in the
current session branch, as `resolveResultReference` already does at
`core.ts:100-112`) or accept the existing cost — an owner decision, not a design
unknown.

**B. Guidance corrections (text only).**

- `SKILL.md:96-101` currently says a retention-off worker "is cleaned up at
  delivery and is not reused". The exact session remains continuable; the
  sentence should distinguish "no live process/pane is retained" from "the
  session is not resumable".
- `SKILL.md:59-76` should name the closed case beside the lost case ("continue
  the exact session returned with the result; a proven lost or already-closed
  generation relaunches the same session in a new process").
- `presentation.ts:3216-3240` renders "Close this lost generation before
  replacing or continuing it" — stale since the no-close-first recovery landed
  and directly contradicted by `AGENT_UNRESOLVED_GUIDANCE`
  (`index.ts:532`: "Use `agent_continue` with the exact saved session to replace
  a lost generation, or `agent_close` to abandon it") and by the tool
  description pin (`controller-lifecycle.test.ts:186-192`).
- `agent_continue`'s tool description (`index.ts:16453-16458`) mentions only
  recovery of a "proven-stopped worker"; add the deliberately closed case.
- When retention is off, `retentionNudge` is `undefined` (`index.ts:4150-4153`),
  so the delivered result message gives no continuation hint at all even though
  it carries `session=<piSessionId>`. Emitting a retention-off nudge that names
  the same session is the cheapest single improvement.

## 7. Regression boundaries

Add (herdsman suite), keeping existing ones green:

1. **Closed generation is advertised.** Retention off; deliver a result to
   completion; assert the label's row is `closed` with the exact
   `pi_session_id`/`pi_session_path`, `available_tools: []`, and no `close`.
   Baseline today = no row (contrast with `recovery.test.ts:3380-3430`).
2. **Advertised row is actionable.** Continuing with the advertised session id
   yields `ok: true`, a new process, the same session path and label; and the
   row disappears while the new generation's live row appears.
3. **Unknown is never advertised as closed.** `aliasUnclaimed` fixture: the row
   stays `unknown`/`recovery_only`, no `closed` duplicate; `agent_continue`
   still refuses `target_ambiguous` (existing ADR 0030 tests,
   `recovery.test.ts:6173-6286` are the neighbours).
4. **Lost keeps its own shape.** A mailbox record with a gone pane still projects
   `lost` with `transcript`/`close`, and continuation still reports
   `relaunched: process_lost` (`recovery.test.ts:5556-5705`).
5. **Unread result still refuses.** Record + pending result file → `agent_busy`
   on continue, and no `closed` row (there is a mailbox representation).
6. **Retired session stays refused.** `contextRetirement` on and a retired
   session → the recovery refusal text, and the row must not advertise resume
   (`recovery.test.ts:3030-3080` is the nearest existing pin).
7. **Ownership.** A foreign `ownerSessionId` entry yields no row for this
   controller (`visibleAgentSnapshots` semantics, `index.ts:3680-3690`).
8. **Workspace agreement (new pin).** A session represented by a mailbox record
   in another workspace must not be advertised as `closed` in this workspace,
   and the continuation decision must agree with the listing — this is the
   §5 asymmetry; decide behavior first (see decisions) then pin it.
9. **No transcript scan.** A listing on a closed generation performs no
   transcript read (assert via the existing fs/exec fakes).

## 8. Changed-file scope

- `extension/index.ts` — the derivation + `list()` row + guidance strings.
  Largest blast radius; keep the new code in one function pair (derive → project)
  near `visibleAgentSnapshots`/`listedAgentRecord`.
- `extension/presentation.ts` — the stale "close before replacing or continuing"
  text and any new state label in the `/agents` surface
  (`presentation.ts:266, 536, 3216-3240`).
- `pi-herdsman/SKILL.md`, `docs/guides/handoffs.md`, and the tool-description
  pins in `controller-lifecycle.test.ts:186-192` if the lead contract changes.
- Tests: `recovery.test.ts` (delivery/listing), `controller-lifecycle.test.ts`
  (continuation eligibility), `presentation.test.ts` (row rendering).
- Not touched: `mailbox.ts` (no schema change needed), `herdr.ts` (no new call),
  `control.ts`, `config.ts`.

## 9. Unresolved owner decisions

1. **State name and advertisement surface.** `closed` (durable-only) versus
   `resumable`; and `available_tools: []` + a boolean marker versus listing the
   session id only. The slice must not imply liveness either way.
2. **Workspace scope of discovery and of the continuation check.** Do we make
   `index.ts:7248` workspace-filtered (aligning continuation with the listing,
   at the cost of refusing a genuine cross-workspace resume), or keep the global
   scan and add a cross-workspace refusal with a diagnostic? Recommended:
   filter, then refuse explicitly rather than silently acting on a foreign
   record.
3. **Retention-off nudge.** Whether the delivery message should name the session
   for continuation when retention is off (recommended: yes, text only), or
   whether closing at delivery should stay silent to discourage post-delivery
   continuation.
4. **Session-file I/O bound** in the listing path (branch-scoped candidates
   versus all owned children).
5. **Fixture hygiene** — whether to fix `clearTestMailboxes`
   (`support.ts:1019-1023`) to clean by path rather than by record workspace in
   the same change.

## 10. Owner scope disposition (proposal, not implementation approval)

The initial slice should advertise **saved sessions**, not assert that an absent
mailbox proves a closed process. Use a durable-only `saved` state (or a separate
saved-session section if the public state type cannot accommodate it), exact
session selector, definition, label and latest owned result provenance. Keep it
out of live-control targets. Explain that continuation revalidates eligibility;
do not promise `resumable: true` from history alone. A delivery nudge should name
`agent_continue` and the exact session selector even with retention off.

Deduplicate against matching mailbox representations **globally**, not only the
current workspace. Current-workspace live/lost/unknown/unread rows remain
unchanged; a foreign representation suppresses the saved-session advertisement.
Do not narrow the continuation scan to the current workspace: that would hide a
real live execution and could permit duplicate launch. Cross-workspace refusal
or reuse policy is a separately scoped decision, not necessary for the first
discovery slice.

The proposed session-file validation and zero-transcript-read regression above
are inconsistent: `openOwnedAssignmentSession` opens a session. Discovery should
use the caller's own branch-scoped result provenance without reopening child
transcript bodies. Exact identity and file validation stay at `agent_continue`,
which already owns that check. A missing or changed file may therefore make a
saved-session candidate fail continuation; the row is a discovery hint, not an
execution proof. Any cheap existence check must not grow into history scanning.

Scope the first slice to advertisement, result nudge, and directly contradictory
continuation guidance. No retention redesign, cooldown, new mailbox persistence,
new resume route, mux migration, or general fixture-cleanup change. Tests should
pin discovery from owned results, session deduplication (including other
workspaces), no additional transcript-body opens, and continuation through the
existing exact-session path. Preserve existing safety regressions rather than
replicating their entire matrices. All proposals require final owner approval
before production edits.

## 11. Verification limits

- No test was executed: the suite writes into the real mailbox root
  (`agentMailboxPath` → `herdsmanDataRoot()/runtime/mailboxes-v4`,
  `mailbox.ts:185-204`, used by `resetAgentMailbox` in tests), which the brief
  put out of bounds. Every claim above is a source-read claim; the "resume works
  today" conclusion is an inference from the guard structure at
  `index.ts:7282`, not an observed run.
- Line numbers are from `b27bf1dfd` and will drift; `index.ts` is ~19k lines and
  held by other work, so re-resolve by symbol before editing.
- ADR 0013 and ADR 0030 were read as context and are consistent with the above;
  they do not themselves establish current code behaviour and were not treated as
  proof.
