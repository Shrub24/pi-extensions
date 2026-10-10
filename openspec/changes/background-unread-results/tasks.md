# Tasks

## 1. Provider: an unretrieved result is advisory, dismissible and reminded (pi-bash-processes)

- [x] 1.1 Make `clear` accept specific task ids and remove only those, keeping its existing refusal to remove running work; verify a focused test clears one of three finished tasks by id and asserts the other two and any running task survive.
- [x] 1.2 Let `clear` discard a terminal task whose result was never retrieved, recording the discard as its own resolution kind (distinct from `delivered` and `error`) so it is neither reported as a handoff nor counted as outstanding; verify a red-first test that clears an unretrieved result, asserts the resolution record is distinguishable from a delivery, and asserts the task no longer classifies as outstanding.
- [x] 1.3 Keep an unretrieved terminal result protected from retention until it is delivered or discarded, and confirm the review reminder covers terminal results and not only running soft windows; verify a test in which a terminal unretrieved task outlives the finished-task bound and still produces a reminder.
- [x] 1.4 Update the task-surface guidance and the `pi-bash-processes` README where they describe clearing as refusing to remove unretrieved results; verify the prose matches the implemented behaviour.

## 2. Provider: wakes report result status, batched included

- [x] 2.1 Add per-task result status to the single completion wake — outcome, and whether the result is still unretrieved; verify a focused test on the single-wake text.
- [x] 2.2 Carry the same per-task detail in the batched wake instead of a count plus a truncated command; verify a test with three tasks in mixed states (running, terminal unretrieved, terminal retrieved) asserting each task's state and outcome appear.
- [x] 2.3 Make the progress and reminder wakes use the same per-task shape; verify the existing wake tests are extended rather than duplicated, and that the reminder text for an unretrieved result says what is owed.

## 3. Provider: the capture is not named to the model

- [x] 3.1 Remove the capture/artifact path from `formatTaskResultText`'s model-facing text and keep `details.fullOutputPath` for the operator surface; verify a test asserting the text of a full read contains no filesystem path while the details still carry one.
- [x] 3.2 Confirm no other model-facing surface names a capture path (spawn, list, get, log, stop, wake, guidance); verify against the assembled texts rather than by grepping source.
- [x] 3.3 Create capture files owner-only; verify a test asserting the created mode.
- [x] 3.4 Record in the package documentation that the capture path is an operator detail, that retrieval is the sanctioned reader, and that enforcement beyond this change (a capture daemon or a capture with no path until delivery) is deferred.
- [x] 3.5 Audit the managed `bash` tool's model-facing `structuredContent`: `full_output_path` carried the task capture path, so leave it unset (the declared schema field stays for shape parity with Pi's own bash) and verify with tests that neither the structured result nor the bounded text names a capture path while `details.task.logFile` keeps it. This is disclosure control only, not a barrier against same-user shell access.

## 4. Consumer: settlement waits only on unfinished work (pi-herdsman)

- [x] 4.1 Narrow the settlement hold and the `waiting` projection to unfinished work (running, flushing, uncertified captures) and stop treating certified `awaiting-result-review` as blocking; verified a red-first test in which the worker settles with a certified unread result while an entry marked `captureCertified:false` remains held. `node --test … agent-runtime.test.ts` passed 100/100; package gate passed 1119/1120 (one skipped).
- [x] 4.2 Kept the bounded provider re-query and durable withhold record while unfinished work holds; stopped the hold when settled. Verified by existing held-settlement tests and `agent-runtime.test.ts` (100/100), plus package gate 1119/1120 (one skipped).
- [x] 4.3 Verified ordinary controls including interrupt are available after settling with certified unretrieved results; running/uncertified holds still refuse interrupt. `node --test … background-waiting.test.ts control-integration.test.ts pane-metadata.test.ts` passed 32/32.

## 5. Consumer: the delivered result names unreviewed results

- [x] 5.1 Appended each unreviewed terminal task identity and outcome to the published assignment result; regression verifies naming and exactly-once settlement. `agent-runtime.test.ts` passed 100/100.
- [x] 5.2 Verified pane facts count only live processes while retaining unretrieved terminal tasks in the listed set; settled workers no longer project `waiting`. `pane-metadata.test.ts` passed within the focused 32/32 background-waiting/control/pane suite.

## 6. Records and verification

- [x] 6.1 Wrote ADR 0032 with the rationale, rejected alternatives, accepted tradeoffs, and deferred distinct-user capture daemon; indexed it in `pi-herdsman/docs/README.md` and marked the relevant clauses in ADRs 0021/0023 as superseded.
- [x] 6.2 Updated `pi-bash-processes/README.md`/`DEVELOPMENT.md` and Herdsman `agent.md`, `agent-states.md`, and `herdsman-control.md` for capture-path details, `waiting`, and certified/unverified result guidance.
- [x] 6.3 Ran both package gates and strict OpenSpec validation with nix openspec 1.14.1. Herdsman `npm run validate`: 1119 passed, 0 failed, 1 skipped; package audit passed (144 files). Provider `bun test --parallel=4 ./tests ./extensions/__tests__`: 381 passed, 1 failed; the sole failure is `tests/identity-probe-live.test.ts` (`/bin/bash` absent on NixOS). Focused lane-retention test passed 1/1; focused capture-path/Bash suite passed 29/29; strict OpenSpec validation passed.
- [ ] 6.4 Live check after deployment: a worker that ends its turn with a terminal result unretrieved must still deliver its answer, with that task named in the delivered result and no `waiting` on its pane.
