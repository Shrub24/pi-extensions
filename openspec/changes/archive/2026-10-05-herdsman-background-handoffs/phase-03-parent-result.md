# Group 2 — parent acceptance of binding and result resolution

## Decision

Tasks **2.1–2.3 accepted**. Task **2.4 remains open**: protection/coalescing/reminder machinery is implemented, but the already-consumed-notification case must be closed and tested with the Herdsman waiting consumer. No claim of automatic waiting or full Group-2 completion is made.

Source checkpoint before this acceptance document: `c956f671a5fd2a7c4e94600f87b121ad3006a7b0`, jj change `zltswkvvzqxuyzoxyqqtpoonollxpuls`, workspace `/home/saurabhj/Projects/dev/custom/pi-extensions-herdsman`.

## Functional delivery

The provider binds newly spawned work to an assignment, restores that association, rejects conflicting rebinding and quarantines unassociated unresolved restored work. Durable delivered/error resolution is separate from notification acknowledgment. Certified foreground/get/wait/CLI/stop delivery resolves work; running/flushing inspections, notifications and failed handoffs do not. Actually delivered uncertifiable captures resolve as error, not successful capture. Retention and clear preserve assignment-owned unread results.

The protected scheduler handles suppressed and held wakes, coalescing and progress reminders. It still skips already-notified tasks during protect: an earlier notification can have been consumed without result retrieval. That is not a completed waiting/review path and is explicitly carried into the next integration gates.

## Parent verification

Pinned TypeScript **5.9.3**, identical strict compiler/options/dependencies against frozen phase-02 (`ce37f8e843db93607cc3e321256413d4d3f12349`) and current snapshots. Current includes all six Group-2 test entrypoints; baseline includes the counterparts that existed then. First comparison exposed four new test-only narrowing diagnostics. Parent applied three structural guard changes in two test files without removing assertions or casting away types.

Corrected comparison: baseline **23 diagnostics / exit 2**, current **23 diagnostics / exit 2**, **zero added normalized diagnostic lines**. This is a non-regression gate, **not a clean strict compile**. Exact commands, source hashes and raw diagnostics are retained in the workflow output directory as `phase-03-parent-comparison.json`, `phase-03-parent-baseline-typecheck.log` and `phase-03-parent-current-typecheck.log`. Harness: `/tmp/herdsman-phase03-accept-typecheck.py`; frozen comparison root `/tmp/herdsman-phase03-accept-q669c_7n`.

Parent rerun after guard fixes:

`cd pi-bash-processes && bun test tests/background-work.test.ts tests/background-work-provider.test.ts tests/result-resolution.test.ts tests/protected-assignment-wakes.test.ts tests/result-resolution-rules.test.ts tests/assignment-evidence-retention.test.ts`

**71 pass / 0 fail**, exit 0, 291 assertions. Complete output: `phase-03-parent-corrected-focused.log` in the workflow output directory.

The earlier writer full suite is **326 pass / 0 fail**, explicit `EXIT=0`, preserved `phase-03-full-suite.log` SHA-256 `016e46cb14f8b40483c50844800ab993e18dd33b0fcca0af317959a999bd4944`. That suite preceded the three parent test-guard corrections; the affected tests were rerun above. It is not represented as a fresh parent full-suite run. The initial writer report still says 312 and carries old log hashes; retain it as the earlier submission, not current acceptance evidence.

Workflow output directory:
`/home/saurabhj/.pi/agent/sessions/--home-saurabhj-Projects-dev-custom-pi-extensions--/subagent-artifacts/outputs/d5c74a48-2e40-4cbc-9a95-a00308e31512/outputs/`.

## Boundaries

No `pi-herdsman` production changes yet. No worker/runtime smoke, dependency installation, unrelated compiler cleanup or VCS history mutation. Fresh independent final review remains outstanding. Task 2.4 and all of Group 3 stay unchecked until their complete requirements are verified.

Next increment: a codec-only waiting-evidence slice under a fixed two-source-file brief. The parent owns protocol/lifecycle integration, all command verification, acceptance and subsequent assignments.
