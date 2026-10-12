# Incarnation flake in `fresh assignment refreshes the widget after validation`

## Rates

| Run | Scope | Result |
|---|---|---|
| Current tree, whole `commands.test.ts`, 6 runs | file | 3 of 6 failed; always this test |
| Current tree, that test alone, 6 runs | test by name | 3 of 6 failed |
| Current tree, that test alone, instrumented, 8 runs | test by name | 3 of 8 failed (probe runs 2, 7, 8) |
| Parent `a53f56746` export, whole file, 6 runs | file | 0 of 6 failed |

The parent export is byte-identical to `a53f56746` for `commands.test.ts`. Caveat: the parent test body is Herdr-era, so the parent result shows the file is stable there, not that this assertion is stable.

## Cause

The test delegates a second child for the same label after resetting the mailbox. The first child's mailbox consumer kept polling that mailbox, because nothing had retired it. Two consumers then answered one request:

- The second child's consumer accepted the request (`accepted=true`).
- The first child's consumer refused it as addressed to another incarnation (`accepted=false`, same request id, about 9 ms later).
- Both write `lastAck` on the one mailbox state. The refusal landed last, so the delegate failed with `target_not_found`.

Instrumented output from a failing run (`pane` is the consumer's own pane; `t` is milliseconds):

```
PROBE-INC consumer pane=startup-pane   request=8c0afe31 accepted=true   t=...108887
PROBE-INC consumer pane=startup-pane-2 request=cf50eaae accepted=true   t=...109172
PROBE-INC consumer pane=startup-pane   request=cf50eaae accepted=false  t=...109181
```

Two production lines make the refusal correct, so nothing in production changes:

- `extension/index.ts:16806` compares `request.address` with `localAssignmentAddress()` (derived at `index.ts:16220`). A process whose incarnation differs from the address is not the addressed child, so it must refuse.
- A real session cannot have a live first child on a reset mailbox. The race is a fixture artifact, not a stale generation in production.

## Fix

The test now retires the first child through the lead's `agent_close` before the reset and the second delegate. The close stops the first child's consumer with its pane (the fake's close path already calls the mailbox stop), so only the new child answers the reset mailbox. The test asserts the close returned `ok`.

The precondition is production-reachable: `agent_close` is the lead's own tool, and a retired label can be delegated again. No fake-daemon hook or wait was added, and the fake is unchanged from HEAD.

Assertions were kept. The second delegate still asserts `ok`, two spawns, and one message.

## Validation

- Single test, after the fix: exit 0, 1 pass, 0 fail.
- Five whole-package `npm run check` runs: see the result section below.

## Result of the five-run package check (bg-1879, settled)

All five `npm run check` runs exited 1. Counts are 1101 tests.

| Run | Pass | Fail | Failing names |
|---|---|---|---|
| 1 | 1095 | 5 | the four pre-cutover names, plus `lead herd runs start once and stay open through intermediate settlement` (controller-lifecycle.test.ts:1457) |
| 2 | 1096 | 4 | the four pre-cutover names |
| 3 | 1095 | 5 | the four pre-cutover names, plus `lost result cleanup keeps a later request owned by the mailbox` |
| 4 | 1096 | 4 | the four pre-cutover names |
| 5 | 1096 | 4 | the four pre-cutover names |

The four pre-cutover names are `a recovered worker settles with an unretrieved prior-request result named in its answer`, `only unfinished work holds while unreviewed terminal results settle`, `settlement publishes an unread terminal result without a post-review response` and `unfinished background work holds settlement through a flush and late work`.

Run 1's extra failure has the same signature as this flake: `Request was addressed to another Radar process incarnation` on a second delegate. It is in `controller-lifecycle.test.ts`, outside this slice's scope, and is not fixed here. Run 3's extra failure is an `agentLabel` mismatch (`lost-result-race-request`) and is not diagnosed.

The bar (five runs showing only the four pre-cutover names) is not met. Three of five runs were clean.

## Second pass: the two extra failures

**`lead herd runs start once and stay open through intermediate settlement` (controller-lifecycle.test.ts:1397).** Not reproduced in the package check. Run alone, it fails on every attempt at line 1435 ("this process's own pane is not in the daemon's topology yet"), before any second delegate, so the isolated run is not evidence for the race. The whole file passed 8 of 8 with the consumer probe on. Five package runs with the probe on showed only the four pre-cutover names. Its single extra failure in the earlier run stays unexplained; the "addressed to another Radar process incarnation" signature was seen in that run only.

**`lost result cleanup keeps a later request owned by the mailbox` (recovery.test.ts:3548).** Not reproduced in five probed package runs. Its one failing assertion (line 3646) expects the mailbox state to be gone after cleanup, and it was still present. The likely cause is a cleanup that has not finished when the test reads, after 8 `setImmediate` turns. That is a hypothesis, not shown by instrumentation. It is also outside this slice's allowed files, so no change was made to it.

**Probed package runs.** Five `npm run check` runs with the consumer probe on: each exited 1 with 1101 tests, 1096 passing, and only the four pre-cutover names failing. The probe was removed afterwards; `support-radar.ts` matches HEAD. At this checkpoint, a final unprobed set of five runs was still needed.

**Unresolved causes:** the lead-herd and lost-result failures are unreproduced, and the cleanup-timing cause is unproven. The final checks below do not establish either cause or prove those flakes impossible.

## Final unprobed integration checks

After the footer status, permission bridge and session-count changes, plus the provider fixture repairs, the lead ran five consecutive unpiped `npm run check` invocations. No consumer probe was present. Task `bg-1332` completed; its harness exited 0 because the baseline-only acceptance condition held, not because the package gate was green.

| Run | Tests | Pass | Fail | Skipped | Package exit | Extra failures |
|---|---|---|---|---|---|---|
| 1 | 1113 | 1108 | 4 | 1 | 1 | none |
| 2 | 1113 | 1108 | 4 | 1 | 1 | none |
| 3 | 1113 | 1108 | 4 | 1 | 1 | none |
| 4 | 1113 | 1108 | 4 | 1 | 1 | none |
| 5 | 1113 | 1108 | 4 | 1 | 1 | none |

Every run failed only the four pre-cutover names listed above. None hit the suite deadline or cancelled a test. The five-run baseline-only bar is met; the full gate remains red on those four tests.

The harness hashed the bytes and paths of a fixed, sorted manifest from `git ls-files --cached --others --exclude-standard pi-herdsman pi-bash-processes`. Every before/after hash matched `49aeaed925c0e91e14a5b05cf547d13fb7cc8440ae52a3f484a8d4ac53682696`. This verifies the manifest's files stayed unchanged; it does not monitor files newly introduced after the manifest was captured.

Raw per-run stdout/stderr and the machine-readable summary are in `/var/tmp/herdsman-status-check-439lnelr/`; the harness is `/var/tmp/herdsman-status-repeat-check.py`. These are local validation artifacts, not committed source.

The earlier independent provider run failed 53 tests because seven extension fixtures lacked mandatory `pi.events`. Adding Pi's real `createEventBus()` to those fixtures, without production guards, cleared all 53: worker result `result:status-line#4` records the complete provider suite at 394/394, exit 0. The package audit passed with 149 files. No commit or deployment is implied by these checks.
