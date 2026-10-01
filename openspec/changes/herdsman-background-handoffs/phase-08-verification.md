# Phase 08 — final verification and handoff (tasks 6.1, 6.2)

Source checkpoint: jj change `zltswkvvzqxu`, rebased onto `main` (`xlyvuzsxulqt` @ `2450884b68f4`). Gates below ran on the rebased tree at commit `e3155e44f114`; this record is the only later edit. Before the rebase the same gates passed at `e71408846d94` (Herdsman 888/889, 1 skipped; pi-bash-processes 330/330).

Rebase notes: `pi-bash-processes/tests/fixtures/extension-host.ts` conflicted (main added `sendUserMessage`, this change replaced the stub `events` with the real event bus); both are kept. The six `herdsman-herdr-pane-metadata` plan files were restored to main's version, so the diff no longer touches that change. Two agent-runtime tests failed after the rebase because they fired only `session_shutdown` listener `[0]`; all shutdowns in that file now run every listener through one helper.

## Gates (all at the checkpoint above)

| Gate | Command | Status |
| --- | --- | --- |
| Herdsman compile/check/build/audit | `cd pi-herdsman && npm run validate` | exit 0; 896 tests, 895 pass, 0 fail, 1 skipped; package audit 62 files |
| pi-bash-processes full suite | `cd pi-bash-processes && bun test --parallel=4 ./tests ./extensions/__tests__` | exit 0; 333 pass, 0 fail, 94 files |
| OpenSpec | `openspec validate herdsman-background-handoffs --strict` | valid |

Notes:
- The default pi-bash-processes runner keeps one cross-file environment failure (required-intent guard test racing through `startExtensionHost`'s process-global settings). It is pre-existing, documented, and removed by per-file isolation; it was not widened into this change.
- `commands.test.ts` previously hung after its last test. Cause: a test bug — leaf mode registers a second `session_shutdown` listener ahead of the one that clears the leaf status interval, and the test fired only listener `[0]`. The test now runs all listeners; the file exits in about 2 s.
- Several earlier whole-package runs hit the 10-minute wait and were killed; only the completed runs above count.

## Independent review (6.2)

No fresh-context reviewer ran. The configured oracle model is rejected by this account and the operator declined any oracle; the parent performed the review and is the accountable reviewer. It is therefore a self-review, not independent, and should be read as such.

Self-review covered: settlement/hold path and waiting-evidence codec, controller and worker waiting-state guards, brief admission, role/profile selection, response enforcement, provenance.

Finding fixed on the same writer:
- P1 — an idle worker held on background work refused the owner's cooperative steer ("Agent is not accepting steering"), although list, digest and `available_tools` advertised `agent_steer`. `steerAcceptanceAllowed` admits an idle steer only with pending direct-child work. Fix in `pi-herdsman/extension/index.ts`: background waiting also permits an idle steer. Interrupt remains refused first. Covered by the new agent-runtime test.

## Scenario → test map

Body-read means the test body was read and its THEN assertions checked. Title-level means the match rests on the test title and surrounding code; no body-level check was made.

### herdsman-background-work

| Scenario | Test | Check |
| --- | --- | --- |
| Exit before result readiness | agent-runtime "a previously notified terminal task remains waiting until result review" | body-read |
| Notification without retrieval | bash-processes result-resolution "a delivered host wake never resolves the result; the retrieval does" | title-level |
| Reused worker | bash-processes background-work-provider warm-reuse test; agent-runtime retained-worker second assignment | title-level |
| Retention disabled | recovery "unresolved background work remains active with retention enabled or disabled" | title-level |
| Early assistant conclusion | agent-runtime "post-review settlement requires a fresh response in either listener order" | title-level |
| Exit notifications disabled | bash-processes protected-assignment-wakes "protected assignment forces the terminal wake…" | title-level |
| Multiple completions | bash-processes protected-assignment-wakes grouped-wake test | title-level |
| Partial retrieval | result-resolution "a running inspection resolves nothing…" and "a failed CLI handoff stays unresolved…" | title-level |
| Irrecoverable capture | result-resolution "an unrecoverable capture error … resolves as error" | title-level |
| Interrupted waiter | recovery "background-waiting workers keep digest/extend eligibility but reject interrupt"; controller-api waiting-parent interrupt rejection | body-read |
| Owner redirects cooperatively | NEW agent-runtime "a steer reaches a waiting worker without changing its assignment, while interrupt is refused" | body-read (written this phase; exposed the P1) |
| Waiting advisory window expires | recovery same test (digest entry actions `inspect, steer, extend, close`) | body-read |
| Exit races with settlement | agent-runtime post-review order test; late-work path in the notified-terminal test | partly body-read |
| Restart while waiting | agent-runtime worker-recovery waiting test; mailbox waiting-evidence test | title-level |
| Provider unavailable | agent-runtime "registered provider reconciliation errors fail closed at settlement" | title-level |
| No background module | NEW agent-runtime "a worker without a background provider completes through ordinary settlement" | body-read |

### herdsman-delegation-briefs

| Scenario | Test | Check |
| --- | --- | --- |
| Plain task text | briefs "rejects free text, …"; NEW controller-lifecycle "plain task text and unavailable brief context are rejected before lifecycle mutation" (no launch, no mailbox) | body-read |
| Incomplete context | briefs "common fields require explicit context, scope, …" | body-read |
| Small task | briefs canonical `common` example parses (minimal brief) | body-read |
| Review baseline missing | briefs "profile-specific requirements are mandatory…" (review profile rejected without its fields) | body-read |
| Execution acceptance | briefs "canonical examples parse under their supported profiles"; controller-api "validated role-specific brief context reaches worker requests" | body-read |
| Profile downgrade | briefs "profile-specific requirements are mandatory and a task cannot downgrade its worker profile" | body-read |
| Warm continuation | controller-lifecycle "continuation reuses an idle retained worker in its existing process" | title-level |
| Missing referenced context | NEW controller-lifecycle test above (unavailable required input names the path, no launch) | body-read |
| Existing assignment recovery | agent-runtime "recovery fails closed when accepted context snapshots have changed" | title-level |
| Unsupported version | briefs "rejects … unsupported versions …" | body-read |
| Documented example | briefs canonical-examples test | body-read |

### herdsman-response-contracts

| Scenario | Test | Check |
| --- | --- | --- |
| Short inline answer, Required report file, Role default override, Missing artifact, Missing required section, Stale artifact, Permitted reuse | response-contracts / response-validation test files | title-level |
| Invalid final response | agent-runtime "invalid final responses publish one typed failure with diagnostics" | body-read |
| Explicit correction | same test, extended this phase: no automatic repair turn is queued; an owner correction assignment completes against its own contract hash | body-read |
| Claimed identity mismatch | NEW agent-runtime "response text claiming another identity or passing checks stays model-authored" | body-read |
| Claimed test pass | same new test (the claim stays model text; no verified-check field is recorded) | body-read |

## Scope of the diff

- Approved integration files: pi-herdsman extension/docs/ADRs and pi-bash-processes extensions/tests, plus this change's artifacts.
- No files outside the approved set remain; the pane-metadata plan files match main.

## Remaining for the user

- Rows marked title-level above were not checked at body level.
- Runtime smokes are user-owned: a real worker with a live `pi-bash-processes` task through exit → retrieval → settlement; owner steer on a waiting worker in a live pane; restart of worker and lead while waiting; provider-unavailable blocked state visible in the widget.
- No production configuration was changed and no agent-owned live smoke was run.
