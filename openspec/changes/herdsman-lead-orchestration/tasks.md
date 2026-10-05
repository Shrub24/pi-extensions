# Tasks

All paths are under `pi-herdsman/`. Tests run with `npm test` (node test runner) from `pi-herdsman/`. The upstream baseline is 776 pass / 1 skipped / 0 fail; every group ends with the full suite green.

## 1. Configuration keys

- [x] 1.1 Add `softTimeoutMs` (integer 0..2147483647, default 300000, `validSoftTimeout`) and `retainWorkers` (boolean, default false) to `HerdsmanConfig`, `DEFAULT_CONFIG`, `CONFIG_KEYS`, `parseRawConfig` and `updateConfig` in `extension/config.ts`. Verify that new `config.test.ts` cases cover the defaults, valid overlays, rejection of `-1` / `1.5` / `"300000"` / non-boolean, and update/reset round-trips.
- [x] 1.2 Document both keys in `docs/reference/configuration.md` (schema block, defaults table, one paragraph each). Verify the documented defaults match `DEFAULT_CONFIG` via a `config.test.ts` assertion on `readConfig()` with no file.

## 2. Soft windows: arming, durability, recovery

- [x] 2.1 Append `pi-herdsman-soft-window` lead-session entries when `submit` observes an accepted task acknowledgement (arming at that moment with `softTimeoutMs`; skip when 0). Keep an in-memory `softWindows` map keyed by `requestId`. Verify with a `controller-api.test.ts` case: delegate → ack → one entry with `armedAt` and `windowMs: 300000`; with `softTimeoutMs: 0`, no entry.
- [x] 2.2 Drop a window when its assignment resolves (result delivered, `agent_close`, proven `lost`). Verify with `recovery.test.ts` cases for each path asserting the map no longer holds the `requestId`.
- [x] 2.3 Rebuild `softWindows` in `recoverControllerRuntimes` from the last entry per unresolved `requestId`, falling back to `state.lastAck.acknowledgedAt`. Verify with `recovery.test.ts` cases: a restart mid-window keeps the remaining time; a restart after delivery does not redeliver; a window that expired while the lead was down is due at the first scan.

## 3. Soft-deadline digest

- [x] 3.1 Add the trailing soft pass to `scanAgentHealth`: collect every due window for directly owned working assignments, independent of `published`. Revalidate each with `currentOwnedState`; include `currentAvailableActions`, elapsed time and definition per entry. Re-arm each delivered window (append the delivery entry). Verify with `recovery.test.ts` cases: two overdue workers produce one digest; a busy lead gets none and receives it after idling; stale attention and the digest are both delivered in one scan; three consecutive windows produce three digests; and the existing "at most one attention per scan" test still passes unchanged.
- [x] 3.2 Register the `pi-herdsman-agent-soft-deadline` message type and `renderAgentSoftDeadlineMessage` in `presentation.ts` (advisory wording; the choices keep waiting / steer / interrupt / extend / close, filtered by each entry's controls). Verify with `presentation.test.ts` snapshots: one entry, multiple entries, an entry with a pending ask (reply listed, interrupt absent), and annotations.
- [x] 3.3 Emit `pi-herdsman:soft-deadline` on `pi.events` before delivery with mutable `annotations`, catching listener throws. Verify with `recovery.test.ts` cases: a listener annotation appears in the delivered digest, and a throwing listener does not block delivery.
- [x] 3.4 Document the soft deadline as an advisory checkpoint, distinct from health conditions, in `docs/concepts/lifecycle.md`, `docs/reference/agent-states.md` and `docs/guides/recovery.md`. Document the event channel and payload in `docs/reference/agent.md`. Verify each doc names `softTimeoutMs`, the scan-granularity lateness, and periodic re-arming, and that no sentence still says the health conditions are the only owner wakes.

## 4. `agent_extend`

- [x] 4.1 Register `agent_extend` with the strict schema `{agent, windowMs}` and an `"extend"` action in `actionUnsafe`. It replaces the worker's window from now and appends an entry; later windows revert to `softTimeoutMs`. Verify with `controller-api.test.ts` cases: a successful extend defers the next digest; an extra field is rejected; a non-owned, idle or resolved worker fails with no window change.
- [x] 4.2 List `agent_extend` in `available_tools` only for directly owned records with an armed window. Verify with `recovery.test.ts` / `controller-api.test.ts` `agent_list` assertions (present while working with a window; absent with `softTimeoutMs: 0` and after resolution), and update `agent-cutover.test.ts:221` and `extension-contract.test.ts` for the tenth tool.
- [x] 4.3 Document `agent_extend` in `docs/reference/agent.md` and `docs/coordination-api.md`, and in `SKILL.md`'s control guidance. Verify the documented schema matches the registered one through an `extension-contract.test.ts` schema assertion.

## 5. Retention after delivery and the `idle` projection

- [x] 5.1 In `finalizeDeliveredRoot` (and therefore `closeManagedAgentCascade`'s delivered-root path), when `retainWorkers` is on and the root is live: skip `closeLiveManagedExecution` and `removeAgentMailbox`, still `removeResult`, and keep the runtime cache. Verify with `recovery.test.ts` cases: with retention on, the pane stays and the mailbox `state.json` stays with no result file; with it off, the existing teardown tests pass unchanged; a recovery that repeats cleanup retains and never closes.
- [x] 5.2 Add the `delivered` input to `agentControlState` (`core.ts`) returning `idle` for a live idle or done lifecycle. Wire it through `managedAgentSnapshots`, and give `idle` records exactly `inspect` / `transcript` / `close` in `listedAgentRecord`. Verify with `core.test.ts` cases for the new branch and the unchanged `settling` cases, plus a `recovery.test.ts` `agent_list` case asserting state `idle` and its exact `available_tools`.
- [x] 5.3 Exclude `idle` from stale attention, soft windows, and the `maybeFinishHerdRun` open-herd check. Verify with `recovery.test.ts`: an idle worker for 30 simulated minutes gets no attention or digest; a `controller-lifecycle.test.ts` case shows the herd run finishes when all workers are idle.
- [x] 5.4 Child admission: treat "`completedRequestId` set and its result file absent" as admissible for a new `task` request. Verify with an `agent-runtime.test.ts` case where a retained child accepts a second task, clears `completedRequestId`, and settles exactly one new result; a child whose result file still exists keeps rejecting with `busy`.
- [x] 5.5 Add the `idle` state to `docs/reference/agent-states.md` and `docs/reference/status-widget.md` (glyph `○`). Rewrite the one-assignment sentences quoted in `context.md` B11 in `docs/concepts/lifecycle.md`, `docs/concepts/agents.md`, `docs/reference/agent.md` and `SKILL.md` to cover retention. Verify each quoted upstream sentence is either qualified by `retainWorkers` or replaced.

## 6. Same-process continuation and definition drift

- [x] 6.1 At launch, compute the definition launch fingerprint from the resolved inputs (expanded body including `@file` contents, `systemPromptMode`, model, thinking, effective tools/skills/extensions, context inheritance) and append `pi-herdsman-worker-launch {runId, label, fingerprint}` to the lead session. Verify with a `controller-lifecycle.test.ts` case asserting one entry per launch, and that the fingerprint changes when the model or an `@file` body changes.
- [x] 6.2 In `agent_continue` admission, when the session's single representation is a directly owned `idle` worker with a matching fingerprint, bypass the busy and label-collision rejections and `submit` the task into the existing runtime; the result reports `reused: true`. Verify with `controller-lifecycle.test.ts` / `controller-api.test.ts` cases: no new pane is spawned, the same label/pane/session become `working`, and the result is reused. Also verify that `working` sessions still fail busy and that the existing tests at `controller-lifecycle.test.ts:3469`, `:3558` and `controller-api.test.ts:4619`, `:5230` still pass.
- [x] 6.3 On fingerprint mismatch or a missing launch entry, close the idle worker via `closeManagedAgent` and continue as a fresh generation on the same session, returning `relaunched: "definition_changed"`. Verify with `controller-api.test.ts` cases for a model change and a missing entry, each asserting the old pane closed, a new pane launched on the same session, and the result flag.
- [x] 6.4 Restore retained workers in `recoverControllerRuntimes` as `idle` when the process is still verified live, reusable by `agent_continue`. Verify with a `recovery.test.ts` case: restart with one live retained worker → `idle` in `agent_list` → `agent_continue` reuses it.
- [x] 6.5 Document reuse and drift relaunch in `docs/reference/agent.md` (`agent_continue`) and `docs/guides/handoffs.md`, and redefine "generation" as process lifetime in `docs/concepts/agents.md`. Verify `agent_continue`'s doc lists the reused / relaunched / fresh outcomes.

## 7. `/agents` menu

- [x] 7.1 Add `Retain workers  on|off` (toggle), `Soft timeout  <value>` (presets 2/5/10 min, off, custom, reset) and `Clear idle…` (confirmation; closes only directly owned `idle` workers; reports the count) to `openAgentsMenu`. Verify with `commands.test.ts` cases for each item, including a `Clear idle` run with two idle workers and one working worker that closes exactly two.
- [x] 7.2 Update `docs/reference/commands.md`'s root-menu enumeration and describe the three items. Verify the documented order matches the menu order asserted in `commands.test.ts`.

## 8. ADRs and fork delta

- [x] 8.1 Write `docs/adr/0013-retain-workers-across-assignments.md` (D6–D9) and `docs/adr/0014-advisory-soft-deadline-checkpoints.md` (D1–D5), each naming the upstream sentences it supersedes. Index them in `docs/README.md`. Verify the ADR index lists 0013 and 0014.
- [x] 8.2 Extend the "Fork delta" section of `pi-herdsman/README.md` with both features and the upstream functions they touch (`finalizeDeliveredRoot`, `agent_continue` admission, `agentControlState`, `scanAgentHealth`, `maybeFinishHerdRun`, child task admission). Verify every function named there contains a fork-guarded branch (`retainWorkers` or `softTimeoutMs`).

## 9. Integration

- [x] 9.1 Run the full `npm test` and `npm run check` in `pi-herdsman/`. Verify 0 failures and that the pass count is at least the baseline plus the new tests.
- [x] 9.2 Obtain fresh-context read-only logic review against this change's proposal/design/specs, covering soft-window persistence, digest/extend eligibility, retained reuse/fingerprints, recovery and idle cleanup guards. Resolve actionable findings and reverify affected checks. Compile/tests and sound logic are the agent acceptance gate; an agent-run runtime smoke is no longer required.

  Review ran 2026-10-05 against `main` `54dd4748` (`omniroute/coder-high`, read-only, three-invariant scope); the report and parent triage are in `logic-review.md`. Verdict: merge, no P0/P1. Two P2s are recorded rather than resolved: F1 (`agent_extend` has no liveness guard, so a `lost` worker's recovered window stays extendable until the health scan drops it) and F2 (a failed durable re-arm write can make the digest fire twice after a restart). Invariant 2 had no finding.

## User-owned runtime smoke

Per the user's revised acceptance decision, the former live-smoke task is user-owned and is not an agent completion gate. With `retainWorkers: true` and `softTimeoutMs: 120000`, the user can verify retained short-task delivery, same-process continuation, a real advisory digest, `agent_extend` deferral and `/agents` → Clear idle. Existing retention/continuation observations remain in `smoke.md`; the unrun digest/extend/Clear idle scenarios are not claimed as passed. No further agent-owned smoke harness run is planned.
