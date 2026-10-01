# Tasks

Tasks 1.1–1.2 and 2.1–2.3 are complete. `phase-01-result.md` records the interface delivery; `phase-02-result.md` records parent acceptance of the staged provider; `phase-03-parent-result.md` records binding/result-resolution acceptance and the zero-added-diagnostics compiler gate (not a clean strict compile). Task 2.4 remains open for the already-consumed-notification case with the Herdsman waiting consumer. Group 3 is not implemented. Integration provenance and the green test baseline are in `phase-02-provenance.md`. All agent gates are compile/type checks, deterministic tests and logic review. The user owns actual runtime smokes. Use one sequential implementation writer; do not concurrently edit the shared lifecycle modules.

## 1. Dependency integration and baseline

- [x] 1.1 Integrate the current canonical declared-background-task lifecycle into the implementation workspace through the agreed workspace/history process, preserving unrelated work. Record source commits/hashes and verify the integrated background-tasks/types/task-result sources match the chosen prerequisite, then run both packages' existing checks and full test suites to establish the baseline.
- [x] 1.2 Add the dependency-light public background settlement interface and registration/query lifecycle, with bounded session/request/revision/task-ID snapshots and explicit absent/reconciling/error states. Verify tests for presence, absent provider, stale/disposed registration, wrong-session queries and reconciliation failure. Document the interface and ownership rules in pi-bash-processes.

## 2. Background assignment binding and result resolution

- [x] 2.1 Bind newly spawned tasks to the active accepted assignment in the existing task snapshots, refuse binding another request while unresolved, and reconcile restored ownership. Verify tests for warm assignment reuse, previous completed history, wrong-request events and unassociated restored running tasks; document snapshot/migration behavior.
- [x] 2.2 Add a durable result-resolution observation distinct from exit-notification acknowledgment. Route certified foreground/get/wait/declared-CLI/confirmed-stop delivery through it; leave running inspections, notifications and failed handoffs unresolved. Verify tool/CLI parity, flush-before-ready, early pipe closure and notification-without-retrieval regressions while existing wake-ack tests stay green.
- [x] 2.3 Support explicit delivered unrecoverable-error resolution without certifying capture or changing notification obligations. Verify incomplete/missing capture cannot falsely resolve as success and cannot trap an assignment forever after its failure is actually delivered; document error handling.
- [ ] 2.4 Route mandatory resolution wakes for protected waiting assignments through the existing wake scheduler, including notifyOnExit:false and progress reminders. Verify coalescing, held-wake cancellation after get/stop, queued-wake races and disabled ordinary notifications without duplicate model messages; update wake/lifecycle docs.

## 3. Herdsman automatic waiting

- [ ] 3.1 Add persisted per-assignment waiting evidence and strict mailbox decoding/limits, bind/query the provider on acceptance/recovery, and gate every result-construction/persistence path. Verify retention true and false, running/flushing/unretrieved tasks, no-provider behavior, registered-provider errors and stale identities through public runtime handlers; document the worker lifecycle and paired protocol migration.
- [ ] 3.2 Invalidate the pre-wait completion candidate, resume via existing provider wakes and require a post-review final response before exactly-once publication. Verify both extension listener orders, simultaneous exit/get/settle, task spawn during the final response, failed retrieval, and model termination before a final post-review response. No blocking agent_settled await or new polling loop.
- [ ] 3.3 Add waiting to core control projection, agent_list/renderers/widget, recovery, unresolved-herd accounting and soft digest/extend eligibility. Verify waiting is never idle or continuation/Clear idle eligible; list and direct-call paths reject interrupt; steer and pending-ask reply retain their rules; restart revalidation cannot prematurely publish. Update controls, advisory and retention docs/ADR with those tests.

## 4. Mandatory incoming delegation briefs

- [ ] 4.1 Implement versioned Markdown/frontmatter parsing, normalization and strict common schema in a small briefs module using existing parser/runtime schema facilities. Verify missing/empty/wrong-type/unknown fields, unsupported version, explicit empty lists, bounded bytes and a minimal valid assignment. Test fixture construction must validate rather than bypass admission; document canonical schema/examples.
- [ ] 4.2 Add supported common/investigation/research/execution/review briefing profiles to definition validation/composition and built-in definitions. Verify role-required context, custom-definition common fallback, invalid profiles, profile-downgrade rejection and documented examples; include profile/default policy changes in resolved launch fingerprints and test retained drift handling.
- [ ] 4.3 Enforce validated briefs and required context snapshots before delegation side effects and revalidate them at worker admission. Persist the accepted brief with request identity. Verify invalid delegate creates no pane/request/window; warm continuation and eligible interrupt replacement need fresh briefs; steer/reply are unaffected; changed/missing context and recovery cannot silently alter accepted requirements. Update tool guidance, SKILL and all delegation examples/fixtures with those tests.

## 5. Separate outgoing response contracts

- [ ] 5.1 Implement an independently typed, versioned response contract with role defaults and explicit per-assignment orchestrator overrides for inline/artifact/both, text/Markdown, required sections/registered metadata schema and declared artifact path/reuse permission. Verify incompatible combinations, one-line inline/no-file responses, required reports and overrides that cannot weaken the briefing schema; document the distinct incoming/outgoing contracts.
- [ ] 5.2 Freeze the effective response contract at acceptance and expose it in the worker request. Verify recovery uses accepted defaults, warm assignments do not inherit earlier overrides, definition default drift relaunches, and per-assignment overrides do not relaunch a healthy retained worker; update request metadata and protocol fixtures.
- [ ] 5.3 Validate the requested inline/file target before successful publication, using actual Markdown structure and safe bounded artifact reads. Verify required sections/metadata, missing/nonregular/escaped files, stale artifacts, explicit reuse, byte limits, artifact-only output without inline duplication and identity replacement races; document accepted artifact/evidence behavior.
- [ ] 5.4 Add one-shot typed failed-result diagnostics for invalid responses and framework-owned contract/identity/artifact metadata. Verify no successful-result acceptance or automatic repair loop on failure, explicit correction through validated admission, request-identity spoof rejection, artifact hash observations and model check claims remaining unverified unless execution evidence exists. Update result docs and ADRs in this group.

## 6. Final agent gate and user-owned smoke handoff

- [ ] 6.1 Run both packages' compile/type/check commands and full deterministic suites, plus strict OpenSpec validation. Record exact commands, terminal statuses, counts and source checkpoints; map every scenario in the three specs to a test and confirm only approved integration files changed.
- [ ] 6.2 Obtain fresh-context read-only independent logic review covering lifecycle ordering/recovery, mandatory brief admission, role selection, configurable response enforcement and provenance. Resolve actionable findings on the same writer, reverify affected/full gates, and deliver the final handoff with remaining runtime questions/resources explicitly identified. Do not run an agent-owned live smoke harness or switch production configuration.

## User-owned runtime smoke (not an agent completion gate)

After the compiled/tested implementation is delivered, the user can exercise background waiting/completion, notification-disabled wake behavior, warm reuse, advisory extend, invalid brief/response errors and required output files in real sessions. This is not a checked implementation task or a claim that those scenarios passed.
