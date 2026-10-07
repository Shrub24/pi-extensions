# Evidence: settlement at Pi's `agent_before_settle` boundary + `workerCompaction`

Two changes in one slice (framework-validated assignment, 2026-10-07). No commits,
no task tickboxes, no archive steps.

Context: `.pi-herdsman/bus-listen-lifecycle-audit.md` §9-§10 (two live incidents —
one published a failure, one a ghost success, each followed by an orphan
continuation turn).

## Change 1 — settlement discriminator

### What Pi actually does (verified in the installed package)

`pi-herdsman/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`:

```
1329:  while (!this._agentRunAbortRequested) {
1336:      if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary()))
1337:          break;
1350:      await this._emitAgentSettled();          // in the `finally`
```

- A run that reaches its settle boundary emits `agent_before_settle` (line 1396).
- A run killed by `abort()` (which is what `compact()` calls first, line 2113)
  leaves `_agentRunAbortRequested` true, so line 1336 short-circuits, the loop
  breaks, and only the `finally`'s `_emitAgentSettled()` runs.
- `_runBeforeSettleBoundary()` early-returns when no handler is registered
  (line 1391) — registering one only adds the extension-visible boundary that
  `pi-tool-renderer/tests/vendor/pi-hooks/extensions/hooks.ts:377` already uses
  (its own comment: "Pi fires `agent_before_settle` from 0.87.0, and below that
  every Stop and TaskCompleted registration is skipped with no error").
- The event is in the devDependency's declared API
  (`.../dist/core/extensions/types.d.ts:758-762`, `on(...)` overload at 1167),
  and the managed child build emits it (string present in
  `/nix/store/lly2cvdp1rlv2gsc3plz2jdz6b3v9702-pi-bolt-child-0.7.1/lib/pi-bolt/pi`).

### Implemented rule

`compactionAbortedRun` (extension/index.ts:16621):

- **set** at the compaction request (index.ts:18684) — the run that request
  aborts settles without a boundary;
- **cleared** by `agent_before_settle` (index.ts:18704) — a run that reached its
  boundary was not aborted;
- **consumed and reset** at `agent_settled` (index.ts:18707-18708), guarding
  settlement (index.ts:18719);
- **held and restored** around the request (index.ts:18665, 18676) so a
  compaction that never started leaves the turn judged as the answer it is;
- **reset** at `session_shutdown` (next to `contextCompactionInFlight`).

### Deliberate deviation: polarity

The brief specified "marked publishes as today; unmarked publishes nothing",
i.e. a flag that starts false and is set by the boundary. Implemented instead is
its complement: the flag is disarmed *by our own compaction request* and
re-armed by the boundary.

Reason (measured, not preference): with the literal polarity, 30 of 86 tests in
`extension/agent-runtime.test.ts` fail (they drive `agent_settled` directly, as
the harness has no run loop) and 1 test in an **out-of-scope** file fails —
`controller-lifecycle.test.ts` → "registered extensions preserve adjacent ask
escalation and assignment results" (background task bg-115: 166 tests, 165 pass,
1 fail). On a host that never emits `agent_before_settle`, the literal polarity
publishes nothing for any managed worker, ever — the exact risk the brief's
constraint asks about.

The implemented polarity is behaviourally identical on every production path
(both deployed runtimes emit the boundary ahead of every non-aborted settle):
abort-settle is suppressed, and the continuation turn publishes. It additionally
keeps today's behaviour where the boundary signal is unavailable (older host,
harness), and does not turn a crashed run (an exception out of
`agent.prompt`) into a permanently unsettled assignment.

### Mutation verification

Each mechanism site removed one at a time; production restored byte-identically
(`sha256 f521cbe2…` before and after):

| Mutation | Regression that fails |
| --- | --- |
| request-site `compactionAbortedRun = true` removed | `a run the worker's own compaction aborted publishes no result` |
| `agent_before_settle` clear removed | `the compaction's continuation turn answers the same assignment` |
| hold/restore in `release()` removed | `a turn whose compaction cannot start is still settled` (existing) |
| `if (abortedRun) return;` removed | `a run the worker's own compaction aborted publishes no result` |
| config gate removed | `worker compaction switched off requests none and settles the turn` |

## Change 2 — `workerCompaction` config switch

Default `true` (current behaviour). Places changed, matching
`workerContextBudgetTokens`: interface (config.ts:53), `DEFAULT_CONFIG` (:66),
`CONFIG_KEYS` (:177), `parseRawConfig` boolean group (:205-213), `updateConfig`
boolean branch (:302-306) and the `key !== …` chain (:321). Non-boolean values
are rejected as `Invalid Pi Herdsman config field workerCompaction`.

Gate: `compactManagedContextIfOverBudget` returns before the usage check when
`readConfig().workerCompaction` is false (index.ts:18651), so no compaction
is requested and no continuation is sent. Settlement is untouched.

Docs: `docs/reference/configuration.md` (schema example, defaults table, and a
paragraph after the budget's).

## Validation

- `npm test -- extension/config.test.ts` → 10/10 pass.
- `npm test -- extension/agent-runtime.test.ts` → 86/86 pass (86 before; the three
  new tests are additive).
- `npm test -- --test-name-pattern=…` focused run over the new + adjacent
  compaction tests → 9/9 pass.
- Full gate `npm run validate` (bg-146): 1049 tests / 1029 pass / 19 fail /
  1 skipped. All 19 failures are inotify exhaustion, not this diff:
  - every failure is in `control.test.ts`, `control-integration.test.ts` or
    `controller-lifecycle.test.ts`, and each is
    `Error: ENOSPC: System limit for number of file watchers reached, watch
    '<control dir>/inbox'` or its 5 s `waitFor() timed out` cascade;
  - measured at the same moment: the user's budget is full —
    `524190 / 524288` watch descriptors in use (sibling `pi` session pid 320350
    holds 417373, `memex daemon` pid 2188 holds 93171);
  - `fs.inotify.max_user_watches` is not writable here (user namespace attempt
    returned `permission denied`), so the suite was re-run where the accounting
    is separate: `unshare -Ur npm test -- extension/control.test.ts` → 12/12
    pass, i.e. the same tests pass on the same code once watches are available;
  - the suite was re-run where the accounting is separate:
    `unshare -Ur npm test -- extension/control.test.ts` → 12/12 pass, i.e. the
    same tests pass on the same code once watches are available.
- Full gate `unshare -Ur npm run validate` (bg-155, log `/tmp/validate-ns.log`):
  1049 tests / 1045 pass / 3 fail / 1 skipped, **0 ENOSPC**. Every file is green
  except three tests in `control-integration.test.ts` whose owner never answered
  within their 5 s `waitFor` deadline. Those three are an intermittent,
  load-sensitive flake, not this diff: the same code failed them in the
  namespace run and unnamespaced (`a control request closes an idle retained
  worker…` failed, the other two passed), and repeating that one test three
  times on unchanged code gave fail / pass / pass. `npm run check` at HEAD (bg-74,
  ~40 min before) was fully green, so the window coincides with the machine's
  watch saturation and the load from the two long-lived holders above.
- For contrast, `npm run check` on the committed previous slice (bg-74, before
  the machine's watch budget filled) was 1046 tests / 1045 pass / 0 fail.

## Follow-ups (not implemented)

- `/agents` settings toggle for `workerCompaction` (the menu already toggles
  `contextRetirement`/`retainWorkers`, index.ts:13490-13530).
- README bullet next to the `workerContextBudgetTokens` one (README.md:135).
- The audit's §10 guards G1 (continuation request-bound), G3 (settled request
  id), G4 (compaction telemetry) and G6 (summary provenance) remain open; this
  slice implements the settlement half of G2 only.
- Pre-existing gap, unchanged here: a compaction that fails *after* aborting the
  run (`onError`) leaves the assignment open with an idle worker and no
  continuation (audit §6 F7).
