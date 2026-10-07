# Evidence: transcript-free-refresh focused regressions (tasks 1.2, 1.3, 3.4, 3.5)

Change: `openspec/changes/herdsman-transcript-free-refresh`
Scope of this slice: test-only. No production code changed, no history/working-copy
operations, no task checkboxes ticked, no archive steps.

## Working tree (final)

```
 M pi-herdsman/extension/commands.test.ts
 M pi-herdsman/extension/extension-contract.test.ts
 M pi-herdsman/extension/observation-refresh.test.ts
?? .pi-herdsman/bus-listen-lifecycle-audit.md   (pre-existing/concurrent, not touched here)
```

Diff stat: 3 files changed, 408 insertions(+), 1 deletion(-).

Production untouched — `pi-herdsman/extension/index.ts` byte-identical to HEAD:

```
sha256(worktree)   = be66dc96e99697c44c203fffc94161585a7292ded1d26029507f77210a4b393e
sha256(HEAD copy)  = be66dc96e99697c44c203fffc94161585a7292ded1d26029507f77210a4b393e
```

## New tests and where they live

| Task | Test name | File:line |
|---|---|---|
| 1.2 | `recurring leaf observation keeps malformed and absent coordinator state unknown` | `pi-herdsman/extension/observation-refresh.test.ts:411` |
| 1.3 | `recurring worker-leaf status ticks open no transcript body` | `pi-herdsman/extension/observation-refresh.test.ts:447` |
| 3.4 | `a session replacement clears the queued supervision rerun instead of running it` | `pi-herdsman/extension/extension-contract.test.ts:3643` |
| 3.5 | `lead status refreshes keep one in-flight refresh and one trailing rerun` | `pi-herdsman/extension/commands.test.ts:7017` |

`observation-refresh.test.ts` also gained a shared `startLeafStatusProbe` fixture that
drives the recurring worker-leaf status tick (kind-`path` lead session).

## Assertions by task

- **1.2** absent coordinator record -> `● ? → agent:coordinator-probe` and never
  `unavailable`; malformed record (`{ not json`) -> same; valid record ->
  `● herd → agent:coordinator-probe`. Refresh completes in all three cases.
- **1.3** `SessionManager.open` instrumented; two recurring leaf ticks produce zero
  open delta per tick; breadcrumb `herd` proves the lead was proven from the bounded
  `readPiSessionHeaderId` header read rather than a transcript body.
- **3.4** in-flight supervision refresh blocked in the rpc/chief fixture, a rerun
  queued, the session id replaced, then released -> exactly one
  `refreshSupervisionOnce` entry (the queued rerun did not run) and the superseded
  caller published no supervision message. `isIdle = () => false` suppresses
  health-scan snapshot noise.
- **3.5** one in-flight status refresh then three further ticks -> snapshot delta stays
  1 and `active === 1`; after release exactly one trailing rerun (delta 2),
  `maxActive === 1`.

## Validation commands and results

```
npm test -- --test-name-pattern='coordinator|worker-leaf status ticks|queued supervision rerun|lead status refreshes keep one' \
  extension/observation-refresh.test.ts extension/commands.test.ts extension/extension-contract.test.ts
  -> 4/4 pass, stable over 3 repeats

npm test -- extension/observation-refresh.test.ts extension/extension-contract.test.ts
  -> 53/53 pass

npm test -- extension/commands.test.ts
  -> 81/81 pass

npm test -- --test-name-pattern='bounded|session matching keeps id' extension/herdr.test.ts
  -> 6/6 pass   (bounded-header behaviour preserved)

npm run check   (full suite, background task bg-74, exit 0)
  -> tests 1046 / pass 1045 / fail 0 / cancelled 0 / skipped 1 / duration 92195 ms
     (baseline was 1042; +4 new tests)
```

## Mutation validation (each new test must bite)

Production was patched temporarily with each mutation, the test observed failing, and
production restored byte-identically afterwards (index.ts sha above).

| Mutation | Test that fails |
|---|---|
| A: remove `pendingSupervisionRefresh = undefined` in `clearSupervisionUI` | 3.4 |
| B: remove the `statusInFlight` guard | 3.5 |
| C: reintroduce `SessionManager.open` in the `proveLead` loop | 1.3 |
| D: treat a failed coordinator read as proven lead | 1.2 |

## Notes / risks

- 3.4 isolates loop entries with a stack-frame check (`herdrSessionSnapshot`
  immediately called by `refreshSupervisionOnce`) because one chief refresh fans out
  to three Herdr snapshots (`refreshSupervisionOnce` -> `directReports` /
  `managedAgentSnapshots`); raw snapshot counting cannot separate the queued rerun.
  Documented inline in the test.

## Follow-ups

- None required for 1.2, 1.3, 3.4, 3.5.
- Owner action: tick the four task checkboxes with this evidence; the full-suite gate
  is already green (`npm run check`).
