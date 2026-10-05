# Herdsman awaited facts — worker handoff

Status: COMPLETE.

Settlement recovery: the final gate result was first read from its log file
instead of being acknowledged through the task handle, which left the run looking
unsettled. `bg-129` was then retrieved with `bg_task get …output:full`
(completed, exit 0, immutable snapshot) and acknowledged; no background task was
still running and none needed stopping. No source edit or rerun was involved in
this recovery.

## Objective
Publish `pi_herdsman_awaited` on every Herdsman-published pane through the
existing metadata lifecycle (30 s TTL, 15 s refresh while non-empty, cleared and
timer-stopped when empty), leaving `pi_herdsman_state` and all control decisions
unchanged.

## Scope
- Allowed: `pi-herdsman/`, `openspec/changes/herdsman-awaited-facts/`, this file.
- Excluded: `pi-bash-processes/`, `pi-reqcap/`, other OpenSpec changes, VCS
  mutations, Radar, and the owner's slices (`agent-definitions.ts`,
  `agent-definitions.test.ts`, the `deniedDiscoveryModelError` call-site near
  `index.ts:6638`, definition-schema docs). `extension/herdr.ts` and
  `extension/herdr.test.ts` are the sibling's; neither is touched here.

## Seam recon (confirmed)
- Pane publishers (extension/pane-metadata.ts): `createMetadataPublisher(send, ttlMs)`
  keeps one latest snapshot per source, coalesces, retries, refreshes at
  `ttlMs/2`, and `clear()` is terminal (aborts in-flight, sends `--clear-token`
  for the snapshot's own keys only).
- Three existing publication paths in `extension/index.ts`: worker pane
  `reportMetadata` (~2494) source `pi-herdsman:<runId>` TTL 1 h; lead pane
  `publishLeadRole` (~8083) source `pi-herdsman:lead` TTL 1 h; owner pane slot
  `publishOwnerStates` (~7460) source `pi-herdsman:owner:<runId>` TTL 30 s.
- `pane report-metadata` applies `--ttl-ms` per updated key and does not isolate
  publishers, so a 30 s fact needs its own report and its own source slot.
- Orchestration projections reused: `directChildStates`, the per-child
  outstanding predicate formerly inlined in `hasPendingDirectChildWork`
  (resultError, active request, or pending undelivered result),
  `listAgentStates()`, and `state.pendingAskId`.

## What changed
- `extension/awaited-facts.ts` (new): `awaitedTokenValue` (cap 8 entries, 80
  Unicode characters, terminal-safe, null when empty) and
  `createAwaitedFacts({paneId, send})` — one report per fresh set in source
  `pi-herdsman:awaited` with TTL 30 s, refresh at `ttlMs/2` = 15 s; the publisher
  is created with the first non-empty set and dropped with the last, so an empty
  set clears the key and stops the timer. A set that arrives while a clear is in
  flight is republished after it rather than racing it. A failed report is
  swallowed and retried by the next refresh, so it cannot fail a model turn.
- `extension/index.ts`:
  - `refreshAwaitedFacts` module hook, assigned by the extension closure, nudged
    from the pane's own facts publication (`reportMetadata` for workers,
    `publishLeadRole` for the Lead).
  - `paneAwaitedEntries(ctx)`: outstanding direct children of the pane's own
    durable state (Lead: its workers; worker: its nested children), sorted
    `agent:<label>` entries, plus `owner` while the pane's own durable state has
    `pendingAskId` (Lead: `leadMetadataAsk`).
  - `directChildWorkPending(path, agent)` extracted from
    `hasPendingDirectChildWork` so the control projection and the awaited set
    share one predicate.
  - `clearAwaitedFacts()` at session shutdown (both roles) and reset in
    `preparePaneMetadata`, mirroring the existing metadata lifecycle.
- `extension/awaited-facts.test.ts` (new): module tests (value bounds, empty set
  holds no timer, membership + refresh + clear, clear race, failure retry) plus
  two production-path tests: a Lead advertising one outstanding worker and never
  a retained one, clearing when it resolves; a worker advertising a nested child
  and its own pending `ask_owner`, clearing when both resolve.
- `docs/reference/pane-metadata.md`: `pi_herdsman_awaited` row, the awaited-facts
  section, the derivation rule for consumers, the `pi-bg-*` co-publisher facts
  (pi-bash-processes), the short-lived source-slot paragraph, updated key-count
  headroom, and the "no child lists" claim qualified to allow the awaited set.
- `docs/reference/pane-metadata.fixture.json`: awaited slot on the Lead and
  worker panes, background-facts slot on the worker pane, and the matching
  flattened records in `expected.agent_list` and `expected.owner_source_expired`.
- `openspec/changes/herdsman-awaited-facts/{tasks,design,specs/.../*.md}`:
  checkboxes to verified state; D3/D4/D6 and the spec requirement wording aligned
  to the implemented contract (outstanding rather than live children; the full
  derivation rule; the awaited source slot).

## Additional approved requirement (owner, same slice)
Managed worker panes also publish `pi_herdsman_label` with the runtime label
(`state.agentLabel`) under the existing worker metadata source, next to
`pi_herdsman_role`: the same name an owner's `agent:<label>` awaited entry uses.
Root panes invent none. The key is part of the worker report, so the pane clears
it with the other names that source owns, and the report is 13 of the 16-key
limit. The requirement is recorded in the change's `proposal.md` (What
Changes/Impact), spec (`Managed worker panes advertise their runtime label`),
`tasks.md` 1.5, the reference table and the fixture (p2 `researcher-1`, p3
`worker-1`, p1 none), with one behavioural assertion in the worker metadata test
(`pi_herdsman_label=registered-agent`) and the existing exact key-set assertion
in `startup and completion metadata preserve available model and thinking values`
updated to the 13-key set.

## Resolution of the open wording question
The brief's acceptance criteria (outstanding direct children; retained idle and
resolved children excluded) govern over the plan's "live workers" shorthand. The
plan wording is now aligned in design D3 and the spec requirement, and a worker
test proves a retained child is not awaited.

## Findings
- Herdr applies `--ttl-ms` per updated key, so the awaited set must be its own
  report under its own source (`pi-herdsman:awaited`). Folding it into the pane's
  one-hour report would expire between refreshes; putting it in the same source
  as the pane's tokens would refresh those tokens every 15 s.
- `pi-bash-processes` publishes the same panes' background facts under source
  `pi-bash-processes` (`pi_bg_running` exact count, `pi_bg_tasks` comma-separated
  ids capped at 6, `pi_bg_started` oldest ISO start, 30 s TTL / 15 s refresh,
  cleared on the last exit). Both facts sets are now documented as one union.
- The harness's `fakeContext()` reports the Lead's session id even for worker
  tests, so a worker pane can read its own durable state as its own child. The
  awaited set resolves its parent identity from the pane's own durable state
  (`state.piSessionId`, matching `hasPendingDirectChildWork`) and never lists the
  pane's own mailbox, so production semantics do not depend on the fixture.
- The pi-herdsman suite is environment-sensitive: `extension-contract.test.ts`
  "the documented agent_extend schema matches the registered tool" requires a
  plain Herdr pane env. Run from inside a managed worker (inherited
  `PI_HERDSMAN_MAILBOX`, `HERDR_ENV`) the session resolves as a managed agent and
  the controller-scoped tools are never registered. Same failure on pristine
  `git archive HEAD` with the inherited env, passing there with
  `PI_HERDSMAN_*`/`PI_SUBAGENT_*` unset — pre-existing, not a regression.

## Decisions to record (proposed for keep-the-why)
1. The awaited set is published in its own source slot `pi-herdsman:awaited`
   (one key, 30 s TTL) rather than in the pane's report, because Herdr applies
   `--ttl-ms` per updated key. Rejected: folding it into `pi-herdsman:lead` /
   `pi-herdsman:<runId>` (expires in 30 s but refreshes on the pane's 30-minute
   cadence) and reusing one source for both value classes (would refresh the
   pane's session/role tokens every 15 s).
2. A pane's awaited membership is derived from the existing direct-child
   projection (`state.piSessionId` parent identity, outstanding = active
   request, result error or undelivered result) instead of a parallel registry.
   Rejected: a per-pane in-memory subscription list (a second source of truth
   for child liveness, and it cannot see children that died).
3. `owner` is read from the pane's own durable `pendingAskId` (the evidence every
   other projection uses) rather than a local variable.

## Validation log
- Full suite (`npm test`, sanitized env, frozen tree with the awaited facts and
  the label): **945 tests, 944 pass, 0 fail, 1 skipped**, 86.5 s. Source
  checkpoint: git `5b778a0429c33395728d83d2dcf039cb22f13fce`, jj
  `wtkylqrrmmqknqzvyysrlrqypnuslyru` (@).
- `npm run package:audit`: passed (111 files).
- `openspec validate herdsman-awaited-facts --strict`: valid.
- Focused (`awaited-facts`, `pane-metadata`, `agent-runtime`,
  `extension-contract`): 124 pass, 0 fail. An earlier full run without the label
  addition was 945/944/0/1 as well.
- `extension/awaited-facts.test.ts` + `extension/agent-runtime.test.ts` +
  `extension/extension-contract.test.ts` + `extension/pane-metadata.test.ts`
  (sanitized env): 122 pass, 1 fail — the pre-existing `agent_extend` env case.
- Probe (`/tmp/awaited-probe.test.ts`, scratch): the metadata-outage scenario
  emits exactly 3 herdr calls with and without awaited-facts wiring.

## Environment note for the gate
`npm test` inherits this worker's own `PI_HERDSMAN_*`/`PI_SUBAGENT_*` env. Run
it with those removed (HERDR_* kept): otherwise role-sensitive tests resolve the
runner as a managed agent and fail (e.g. `extension-contract.test.ts`
"the documented agent_extend schema matches the registered tool"). Verified
pre-existing: the same test fails identically on pristine `git archive HEAD`
with the inherited env and passes there with the vars removed.

## Remaining
- Task 2.4 (tell the Radar session the key, item shape and derivation rule) is the
  owner's cross-session message.
- No live Herdr smoke: the awaited report and the label token are exercised
  through the harness's `pi.exec` surface only.
- Known bound: the 8-entry cap drops the trailing entries, so a pane with eight
  or more outstanding children plus an owner question does not list `owner`; the
  derived activity state is unaffected.
- Adjacent, not done here: `docs/reference/agent-states.md` still describes
  `waiting`/`blocked` only as the owner's control projection; the pane reference
  now states that the sidebar state is derived.
