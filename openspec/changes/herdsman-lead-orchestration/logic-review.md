# Herdsman Lead Orchestration — Read-only Logic Review

Read-only review of `openspec/changes/herdsman-lead-orchestration/` task 9.2.
Repo: `/home/saurabhj/Projects/dev/custom/pi-extensions` @ main (`54dd4748`).
No files were modified; no jj/git commands were run.

Scope: three invariants only — (1) soft-deadline window persistence, (2) retained-worker reuse identity, (3) digest/extend eligibility.

## Examined

Checkpoint: created before investigation; findings appended as confirmed. Budget: ~35 tool calls.

Files / functions read (all in `pi-herdsman/extension/index.ts` unless noted):

- Soft window state and helpers: `SoftWindow`, `softWindows`, `SOFT_WINDOW_ENTRY`, `softWindowsEnabled`, `dropSoftWindow`, `recordSoftWindow`, `armSoftWindow`, `softWindowFromEntries` — lines 655–790.
- Arming call site: `armSoftWindow(...)` on accepted task ack — line 2724.
- Delivery re-arm: digest success path re-arms each due window — lines 14531–14582.
- Recovery: `recoverControllerRuntimes` — lines 13602–13707.
- Digest eligibility + send + re-arm: `scanAgentHealth` trailing pass — lines 14431–14582; lost-worker window drop — line 13985.
- Extend: `agent_control` extend handler — lines 6956–7022; `resolveRuntime` — lines 4586–4680.
- Advertised controls: `currentAvailableActions` — lines 3251–3308.
- Retention/reuse: `retainWorkersEnabled` (698), `recordedLaunchFingerprint` (3042–3062), `resolveIdleWorker` (3080–3135), spawn-path reuse decision (6182–6300), reuse submission branch (6361–6389), launch fingerprint write (6585–6726).
- Reuse identity inputs: `resolveAgentLaunchInputs`, `agentLaunchFingerprint` — `pi-herdsman/extension/agent-definitions.ts:840–880`.
- `submit` request-record construction (runId source) — lines 2602–2625.
- Accepted assignment prompt incl. response contract — `formatAcceptedAssignmentPrompt`, lines 5683–5767.
- Clear-idle command — lines 12540–12580.

## Findings

### F1 — `agent_extend` has no liveness/state guard; a `lost` worker's recovered window is extendable (P2, confirmed in code)

`pi-herdsman/extension/index.ts:6956` (guard) vs `pi-herdsman/extension/index.ts:3270` (advertised) and `pi-herdsman/extension/index.ts:13985` (scan drop).

Invariant broken: 3 (a worker in the wrong state — `lost` — must not be extendable).

The extend guard checks only that `softWindowsEnabled()` and that the caller's cached `runtime.activeRequestId` has an armed window with a matching `runId`, then re-reads the mailbox and requires `extendedState.activeRequestId === requestId`:

- `const armed = softWindowsEnabled() && requestId ? softWindows.get(requestId) : undefined; if (!requestId || !armed || armed.runId !== runtime.runId) fail(...)` (6959–6968)
- no `presence.kind === "live"` and no `listed.recovery_only` check.

By contrast, the advertised-controls gate only offers `extend` inside the `presence.kind === "live" && !listed.recovery_only` branch (3273, 3290–3298), and `resolveRuntime` (4586–4680) does **not** reject a `lost`/`recovery_only` agent — it only checks label uniqueness, owner session, and identity.

Concrete failure: `recoverControllerRuntimes` restores a window for any directly-owned runtime with an `activeRequestId`, including one whose presence is `lost` (`presence.kind === "live"` is required only on the `validateIdentity` branch, not on the arming branch — 13625–13638, 13666–13688). The window is dropped for lost unresolved workers only by the *health scan* (`dropSoftWindow(state.activeRequestId)` at 13985), which runs on the `STALE_SCAN_MS` timer. Between recovery and that scan — and whenever a `lost` agent is inspected after a restart — `agent_extend` succeeds, rewrites the window for a dead assignment, and appends a durable `pi-herdsman-soft-window` entry with `extended: true` (6997–7011). The fix is a liveness/`recovery_only` precondition in the extend branch, mirroring the digest's `agent.presence.kind !== "live"` filter at 14458.

Impact is bounded: the lead is not *offered* `agent_extend` for a lost worker, so this is enforcement/advertised divergence rather than a likely user-triggered path.

### F2 — the digest can fire twice for one window if the durable re-arm entry fails (P2, inferred)

`pi-herdsman/extension/index.ts:705` (`recordSoftWindow` catch), `pi-herdsman/extension/index.ts:14557` (re-arm), `pi-herdsman/extension/index.ts:758` (`softWindowFromEntries` replay).

Invariant at risk: 1 ("must not fire twice").

After a successful digest delivery the window is re-armed in memory and *then* persisted:

- `recordSoftWindow` sets `softWindows.set(...)` first and calls `pi.appendEntry(...)` inside a `try` whose `catch` only records a durable error (703–712).
- recovery rebuilds the window exclusively from durable entries: `softWindowFromEntries(entries, runtime.activeRequestId)` takes the latest matching `pi-herdsman-soft-window` entry and falls back to `state.lastAck?.acknowledgedAt` (758–790, 13666–13688).

If `appendEntry` fails for a re-arm (the state-error path explicitly tolerated at 709–711), the in-memory anchor advances but the durable anchor still holds the *pre-digest* `armedAt`/`windowMs`. On restart, recovery restores the stale anchor, `elapsedMs >= windowMs` is immediately true, and the same window's checkpoint is delivered a second time. Inference level: the failure branch exists and is reachable; I did not construct a failing `appendEntry` to observe the double delivery. The comment at 14557 ("Re-arm only after a successful delivery, so a failed send retries") shows at-least-once is intended for a failed *send*; the failed *persist* case is not covered by that reasoning.

### Invariant 2 — no finding

Reuse identity is sound at the level the invariant asks about. Verified in code:

- The fingerprint covers definition defaults that reuse must not drift: `briefProfile` (`frontmatter.briefProfile ?? "common"`) and `responseContract` (`frontmatter.responseContract ?? DEFAULT_RESPONSE_CONTRACT`) — `agent-definitions.ts:840–870`.
- Both sides of the comparison are computed through the same projection: the reuse check uses `resolveAgentLaunchInputs(fingerprintDefinition, { cwd })` (3096–3097) and the launch records `resolveAgentLaunchInputs(fingerprintDefinition, { cwd: agentCwd })` (6585–6587, appended at 6724), with `fingerprintDefinition = projectAgentDefinition(definition, definitionScope)` on both paths (6187–6190).
- Drift or missing launch evidence forces a `relaunch` (3099–3100; closes the process and continues the same session in a new one — 6275–6287), so a reused process never adopts a changed definition.
- A per-assignment response-contract/brief override is not inherited: the reuse branch submits the freshly prepared `formatAcceptedAssignmentPrompt(acceptedAssignment)` (6360–6389, prompt built at 5683–5767), and the worker re-validates the brief against its own `state.briefProfile` (16182–16188), which the fingerprint has already pinned to the definition.
- The reused runtime deliberately keeps its original `runId` (`submit` writes `runId: runtime.runId` at 2622, and the reuse branch never re-appends a launch entry), and every consumer I read keys on `runtime.runId`/`state.runId` consistently (digest runId match at 14467, extend at 6959/6979, `currentAvailableActions` at 3298) — so no stale-identity leak.

## Not verified

- `closeManagedSnapshot` / Close-idle internals (12540–12572): the Clear-idle filter is `ownerSessionId === owner && presence.kind === "live" && listed.state === "idle"` and correctly excludes `waiting`/`working`/`lost`, but I did not read `closeManagedSnapshot` to confirm it cannot close a worker that transitions to non-idle between the list snapshot and the confirmed close. The window is effectively nil because the same session is blocked on the confirm dialog, so I did not pursue it.
- `agent_continue` admission and child-task admission (the other fork-guarded seams named in tasks.md 8.2) were not in the three-invariant scope and were not read.
- The `prospectiveAssignmentFits` byte accounting for reused workers (6345) was read only at the call site; I did not verify that using the new `assignment!.runId` there while `submit` records the retained `runtime.runId` is byte-neutral in every case (both are UUIDs, so lengths match).
- `agentControlState` in `core.ts` (imported at index.ts:112) was not opened; I relied on its call site (2896) and the projected states consumed by the digest (14458) and Clear-idle (12542).
- No runtime execution: no tests were run, and no failing `appendEntry` was simulated (F2 stays inference-level).
- Not reached at all: soft-deadline event/message rendering, `agent_extend` schema validation for extra fields, the config validators (`validSoftTimeout`), and the docs/ADR claims in tasks.md 3.4/8.x.

## Verdict

**Merge.** No P0/P1 findings. Both invariants 1 and 2 hold as implemented; invariant 3 has one advertisement-vs-enforcement gap (F1, P2) and one at-least-once edge (F2, P2) that are hardening, not release blockers — F1's UI surface already refuses to offer `agent_extend` for the affected `lost` state, and F2 requires a durable-write failure to manifest. Recommend tracking F1 as a one-line precondition in the extend branch (mirror the digest's `presence.kind === "live"` filter) and F2 as an explicit statement of at-least-once semantics (or a durable re-arm retry) rather than changing delivery behaviour now.

---

## Parent triage (2026-10-05)

Verified against `main` at `54dd4748`.

**F1 — `agent_extend` has no liveness guard (P2, confirmed).** `index.ts:6956-6985` gates on `softWindowsEnabled()`, an armed window whose `runId` matches, the mailbox `activeRequestId`, and `validateIdentity` — but never on presence, while the digest pass requires `agent.presence.kind === "live"` and a working/waiting/blocked projection (`index.ts:14457-14463`). The advertised-controls gate only offers `extend` for a live, non-recovery agent (`index.ts:3273-3298`), so this is enforcement-versus-advertisement divergence: a direct call can extend a `lost` worker's recovered window until the health scan drops it. Recorded, not fixed here; the fix is a one-line precondition mirroring the digest filter.

**F2 — the digest can re-fire when the durable re-arm write fails (P2, inference).** `recordSoftWindow` sets the in-memory window before `pi.appendEntry` inside a `try` whose `catch` only records a durable error (`index.ts:703-712`), while recovery rebuilds exclusively from durable entries (`softWindowFromEntries`, `index.ts:758-790`). A failed persist therefore leaves the durable anchor at the pre-digest `armedAt`, so a restart re-arms an already-delivered window. Not reproduced: no failing `appendEntry` was simulated. Recorded: either state the at-least-once semantics explicitly or retry the durable write.

Invariant 2 (retained reuse identity) had no finding. The reviewer traced both fingerprint projections through `resolveAgentLaunchInputs` and confirmed that per-assignment overrides are not inherited by a reused worker.
