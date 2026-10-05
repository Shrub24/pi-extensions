# Herdsman Background Handoffs — Read-only Logic Review

Repo: /home/saurabhj/Projects/dev/custom/pi-extensions @ main (54dd4748)
Scope: (1) waiting & settlement, (2) brief admission & response-contract enforcement, (3) protected-assignment wakes & notification acknowledgment.
Read-only: no edits, no repo writes, no VCS commands were run.

## Examined

Checkpoint: main @ 54dd4748. Change: `openspec/changes/herdsman-background-handoffs/` (specs `herdsman-background-work`, `herdsman-delegation-briefs`, `herdsman-response-contracts`).

Files and windows read:
- `pi-herdsman/extension/index.ts` — settlement guard `settleCurrentAgent` (16737–16960), withholding/reporting tail (16897–16935), waiting-evidence revalidation `refreshBackgroundWaitingEvidence` (16669–16721), change subscription `watchBackgroundWorkChanges` (16722–16736), admission guards at request pump (16320–16490), owner-side accepted-assignment admission (16178–16200), interrupt/control exposure guards (2880–2930, 3270–3300, 7020–7060), `settleCurrentAgent` call site in `agent_settled` (17218–17232), `backgroundWaiting` declaration (15510).
- `pi-bash-processes/extensions/background-work.ts` — provider contract and snapshot type (88–200), `queryBackgroundWorkSnapshot` incl. reconciliation→state mapping (690–740), `bindBackgroundWorkAssignment` (740–775), `protectBackgroundWorkAssignment` (779–820), `subscribeBackgroundWorkChanges` (824–842), registration/notifyChange/protect-channel wiring (560–690).
- `pi-bash-processes/extensions/background-tasks.ts` — settlement provider `snapshot`/`bind`/`protect` (395–500), `recordResultResolution` / `exitWakeIsMandatory` / `classifySettlementTasks` (305–390), stop paths `stopTaskForBridge` (1178–1201) and unconfirmed-stop rejection (1082–1086).
- `pi-bash-processes/extensions/task-result.ts` — `resultIsResolved` (409–417), `resultResolutionForDelivery` (434–443), `selectPrunableFinishedTasks` (445–470).
- `pi-bash-processes/extensions/lifecycle.ts` — `sendExitWakeLifecycle` (108–118), `replayMissedExitsLifecycle` (160–175).
- `pi-bash-processes/extensions/registrations.ts` — unconfirmed-stop reporting (233–236, 377–379).
- `pi-herdsman/extension/briefs.ts` — profile/field normalization (1–140, 262–335).
- `pi-herdsman/extension/response-contracts.ts` — full (216 lines): `resolveResponseContract` (204–214), `normalizeResponseContract` (118–198), `DEFAULT_RESPONSE_CONTRACT` (68–75).
- `pi-herdsman/extension/mailbox.ts` — persisted-state accepted-assignment validation (445–460), V5 request accepted-assignment validation (612–632).

What the traced code does — invariant by invariant:

1. Waiting and settlement. `settleCurrentAgent` revalidates the bound provider at *every* settlement (`bindBackgroundWorkAssignment` → `protectBackgroundWorkAssignment(...,true)` → `queryBackgroundWorkSnapshot`, index.ts:16760–16814), folds `reconciling`/`error`/non-empty-`outstanding` into a waiting evidence record (16847–16870), and returns before validation whenever the settlement is not clean (16910–16934), clearing `latest` so a pre-wait completion candidate cannot be used. Pre-wait text is discarded (`latest = ""` at 16931). Completion is only computed after the clean-settlement gate (16938 onward). `reconciliation: "error"` from the provider is surfaced as query `state: "error"` (background-work.ts:729–736), so "provider unavailable" cannot look like zero tasks (spec scenario honoured).
2. Brief admission / response contracts. `resolveResponseContract` (response-contracts.ts:204–214) is a full-replacement resolver: the role default is always normalized even when an override is supplied, there is no deep merge and no inherited fields, and `normalizeResponseContract` rejects unknown fields and briefing-requirement keys by allowlist (118–125). Briefing requirements are structurally separated from response policy. Profile-downgrade enforcement exists (`briefs.ts:129–131`) and is applied with the role's profile at both the persisted-state validator (`mailbox.ts:456`) and worker admission (`index.ts:16188`). (One boundary is weaker — Finding 1.)
3. Protected wakes and notification acknowledgment. `task.resultResolution` is the *only* input to `resultIsResolved` (task-result.ts:409–417, 434–443), and it is written only at delivery sites via `resultResolutionForDelivery` (background-tasks.ts:888, 1006, 1637, 2404, 2450, 2919). The exit-wake/notification paths (`lifecycle.ts:108–118`, 160–175) settle through `acknowledgeCompletion`/`exitNotified` and never touch `resultResolution` — a delivered notification cannot resolve a result. Unconfirmed stops are rejected rather than reported as stopped (`background-tasks.ts:1084–1086`, `registrations.ts:236, 379`; `stopTaskForBridge` returns `confirmed: false` when no signal was sent or termination timed out, 1189–1200).

## Findings

### P2 — Worker-side mailbox request validation hardcodes `minimumProfile: "common"`, so the profile-downgrade guard is absent at that boundary

- Path:line — `pi-herdsman/extension/mailbox.ts:626-632` (the `validateAcceptedAssignmentContract(v.acceptedAssignment, { requestId: assignmentRequestId, minimumProfile: "common" })` call inside V5 request validation).
- Invariant broken — invariant 2 ("mandatory common brief requirements must not be weakened by a role/profile default or a per-assignment override"); spec `herdsman-delegation-briefs`, "Role-specific briefing requirements": *"An assignment MUST NOT bypass its definition's profile by claiming a weaker one"*, and "Context snapshots and admission consistency": *"Owner-side and worker-side admission SHALL agree on the validated contract."*
- Concrete failure — `minimumProfile === "common"` makes the equality check at `briefs.ts:129` a no-op, so *any* profile including `"common"` is accepted for that field. A request whose `acceptedAssignment` brief claims `profile: common` for a worker whose role requires `review` passes this validation, while the same value is rejected by the persisted-state path at `mailbox.ts:456` and by worker admission at `index.ts:16188`, both of which pass the role's `briefProfile`. The two boundaries therefore do not agree, contrary to the spec sentence above.
- Severity rationale — this is not a demonstrated admission bypass: `index.ts:16188–16203` revalidates the assignment with `state.briefProfile` and acknowledges-and-discards on failure, so the effective admission decision still enforces the role profile. It is reported as P2 because the weaker check is the *only* profile check on any reader of a V5 request that does not go through that pump boundary, and because it is exactly the bypass the spec forbids at the boundary it names.

### P2 — The held-marker clearing condition is unrelated to settlement readiness, so a settled worker can still publish while carrying `backgroundWaiting`

- Path:line — `pi-herdsman/extension/index.ts:16897-16908` (`const settled = …` then `if (settled && state.backgroundWaiting && latest.trim()) { … backgroundWaiting: undefined … }`), with the projection read at `pi-herdsman/extension/index.ts:2904`.
- Invariant — invariant 1's "must keep its assignment active / resume exactly once" reported-state half: the waiting marker is the public evidence that the assignment is held.
- Concrete failure — the marker is cleared only when `latest.trim()` is non-empty. A waiting worker resumed through the wake that answers a contract with `target: "artifact"` or `"both"` and produces no inline text validates on the artifact (`resultText` falls back to the validated-artifact text, index.ts:16945–16965) and publishes a completed result while `state.backgroundWaiting` is still persisted. Until `finalizeStateTransition` clears it (index.ts:16629–16641), `agentControlState(..., !!state.backgroundWaiting)` (index.ts:2904) projects the worker as held/waiting even though a completion result is being published, and `index.ts:3287`/`7035` continue to suppress `interrupt` and treat it as waiting.
- Severity rationale — P2: the window is bounded by the result-write/state-transition pair and the work is genuinely resolved at that point, so no result is published for unresolved work. It is listed because the guard's condition and the settlement gate are different predicates over the same evidence, and the inconsistency is reachable on the ordinary artifact-contract path, not only in a race.

### P2 — A withheld settlement has no retry trigger: recovery depends entirely on a provider wake

- Path:line — `pi-herdsman/extension/index.ts:16910-16934` (withhold + `latest = ""` + `return`), `pi-herdsman/extension/index.ts:17218-17232` (the only `settleCurrentAgent` call site, `agent_settled`), `pi-herdsman/extension/index.ts:16669-16721` (`refreshBackgroundWaitingEvidence`, the change-subscription listener, which rewrites evidence only).
- Invariant — invariant 1: "must resume through the existing wake delivery exactly once" — the *exactly once* half assumes the wake arrives.
- Concrete failure — when the guard holds, it clears `latest` and returns with no timer armed and no self-re-invocation. `settleCurrentAgent` runs only on `agent_settled`; the change notification callback (`watchBackgroundWorkChanges` → `refreshBackgroundWaitingEvidence`) updates `backgroundWaiting` evidence and calls `requestStatusRefresh` but never re-runs settlement. So after a hold, the assignment is resumed *only* by the provider's exit/change wake. If that wake has been consumed as notified without delivery (the condition the `protect` re-entry guard at `pi-bash-processes/extensions/background-tasks.ts:472-497` is written to avoid), or the provider snapshot stays `missing`/`error` after a restart, the worker remains held indefinitely with a single durable `background settlement withheld completion` record and no pending wake.
- Severity rationale — P2: I did not construct a reachable lost-wake sequence; the design's `protect` re-entry and `exitNotified`-covers-queued-wakes argument looks sound. Reported as a robustness gap with the concrete trigger absent, and it is the main reason the verdict below is conditional.

## Not verified

Everything below was outside the ~6-minute / ~26-call budget and is *unchecked*, not cleared:

- End-to-end "wake reaches the waiting worker exactly once" (`herdsman-background-work`, scenarios "Exit notifications disabled" and "Multiple completions"). I read the provider-side protect/re-entry queue logic only; I did not read the wake placement/delivery path itself (`pi-bash-processes/extensions/wake-events.ts`, the deferred/`idleExitBatch` maps in `background-tasks.ts:1400-1600`, and the host idle-wake mechanism) to confirm dedup across a held wake plus protect re-entry, or coalescing of simultaneous completions.
- Double resolution of the same assignment (settlement published twice, or a result written after the worker is reused). I did not trace `pendingResult` assignment sites, the `flush`/`retryTimer` result-write loop (index.ts:~17100-17230), or `finalizeStateTransition` against a concurrent `agent_settled`.
- Restart-while-waiting recovery (scenario "Restart while waiting") — `settlementRestore`, quarantine admission, and `settlePersistedResults` were read only as declarations.
- Response-contract *runtime* enforcement: artifact presence, regular-file check, symlink-escape and stale-artifact rejection, and per-section validation (`response-contracts.ts` is shape-only; the validator lives in the response-validation module, which I did not open).
- Whether `validateResponse` failing yields a bounded failed-result record with typed errors and no automatic repair turns (response-contracts spec, "Failure is explicit and repair is owner-driven").
- Framework-owned provenance envelope fields (request/run/worker-session identities, artifact hashes).
- The remaining control-surface restriction matrix for a directly-invoked waiting worker (index.ts:2840-2960, 3260-3320, 7010-7060 were read only in the interrupt/steer slices).
- I read no test files, so I have no evidence about which of these paths are covered.

## Verdict

Merge-conditional. No P0 or P1 was found in the paths I examined: the three invariants hold in the code that implements them — pre-wait completion candidates are discarded before the settlement gate, provider-unavailable states are fail-closed to `error`/`missing` rather than empty success, response contracts are full replacements with no merge path, and notification/acknowledgment is structurally separated from result resolution with unconfirmed stops rejected. The three P2s above are non-blocking as written.

The verdict is conditional rather than unconditional because the wake-exactly-once and double-resolution paths — the two things invariant 1 most needs proven — are in the "Not verified" list, and Finding 3 names a plausibly reachable stall if a wake is lost. Fix-first is not warranted on current evidence; check the unverified wake-delivery path next.

---

## Parent triage (2026-10-05)

Independently verified against `main` at `54dd4748`.

**Finding 1 — profile guard at the V5 request boundary (P2, accepted as written).**
Confirmed at `mailbox.ts:627`, which passes `minimumProfile: "common"` while the persisted-state validator at `mailbox.ts:454` passes the role's `briefProfile`. `normalizeBriefFields` skips its profile check entirely when the minimum is `"common"` (`briefs.ts:129`), so that boundary has no profile requirement. The request record does not carry the role's profile, so that boundary cannot make the same check; the effective admission decision is the pump at `index.ts:16184`, which does enforce it. Left open: either the request record should carry the profile, or the spec's "owner-side and worker-side admission SHALL agree" sentence should be read as applying to admission only.

**Finding 2 — the held-marker clear condition (P2, accepted, re-characterized).**
The reviewer read this as "publishes a completed result while `backgroundWaiting` is still persisted". Reading the flush path, the actual behaviour is worse and narrower: the completed result is *discarded*.

- `settleCurrentAgent` clears the marker only when `settled && backgroundWaiting && latest.trim()` (`index.ts:16904`).
- An artifact-target contract does not require inline text (`response-validation.ts:571`), so a resuming turn with an empty final assistant message validates on the artifact and produces a completed result with `text: "Artifact validated: <path>"`.
- `flush` then hits `if (currentState.backgroundWaiting && !latest.trim())` (`index.ts:17100`) inside the bound-provider block, and sets `pendingResult = undefined`, clears the retry timer, rewrites the waiting evidence and returns. No result is written.
- Settlement only runs on `agent_settled` (sole call site `index.ts:17218`), so nothing retries: the worker stays held with the assignment open and its completed work unpublished.

Reachable when a worker is bound to a background-work provider, held, then resumes under an artifact-only contract without emitting text. The existing resume tests always supply inline text (`agent-runtime.test.ts:391`), so the path is uncovered. This is the one finding worth fixing before adoption.

**Finding 3 — no retry trigger after a withheld settlement (P2, accepted).**
Confirmed: the hold at `index.ts:16910-16934` clears `latest` and returns with no timer, and the change subscription only rewrites evidence (`refreshBackgroundWaitingEvidence`). It compounds finding 2 into a permanent stall. No reachable lost-wake sequence was demonstrated, so it stands as a robustness gap rather than a defect with a known trigger.
