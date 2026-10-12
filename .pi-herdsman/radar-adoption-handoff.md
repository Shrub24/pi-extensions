# Herdsman → Radar adoption handoff

## Status

Radar registry publication and mutable session context are committed/pushed (`f5eedd29`, `016bbf656242`). Focus and ordinary managed-worker lifecycle migration are implemented in the shared working copy, but **uncommitted and not deployed**. The reviewed worker lifecycle slice has no remaining known safety blocker; this is not acceptance of the whole migration.

Latest retrieved full gate: **1189 tests, 1146 passed, 42 failed, 1 skipped**. The 42 failures remain migration work, not a certified pristine-HEAD baseline. Independent final close review: `result:radar-lifecycle-diagnosis#8`. Worker validation: lifecycle 80/80, recovery 107/107, launch/mailbox/worker-addressing 65/65. Commands previously 85/86, with Manager worktree launch remaining.

## Implemented behavior

### Committed publication

- Generic in-process Pi execution reporting, including ordinary/operator sessions loading Herdsman, is separate from owner-authored assignment reporting.
- Radar subject identity represents a process incarnation, survives extension reload, and changes with a new process. Private child binding correlates assignment publication to the exact subject.
- Mutable `agent.context` publishes session UUID only, explicit null to clear, newer sequence on changes, same writer generation, and periodic renewal. No session-file paths in this channel.
- Private publication state persists pending payload before send, replays exact bytes after lost acknowledgment, and honors daemon writer fencing. Identical replay warnings do not reset the local lease clock.
- Reporting remains best-effort: unavailable daemon/private-store errors must not break delegation or settlement. Physical Radar launch requirements are deliberately different: they fail closed when required registration or contract is unavailable.

Files: `pi-herdsman/extension/radar-client.ts`, `radar-publication.ts`, `radar-execution.ts`; ADR 0031.

### Uncommitted focus migration

Supervised-Lead focus consumers use Radar `observe` and durable `focus`, retaining exact session/ownership checks. Uncertain dispatch does not authorize fallback or a replacement operation. ADR 0033 documents this slice.

### Uncommitted ordinary managed-worker lifecycle

- Radar `spawn` transports the child command, cwd/environment and registration token under the parent's actual registered pane. No invented parent location and no Herdr fallback after uncertain dispatch.
- Persisted launch identity plus exact daemon binding identifies the child and launch generation. Readiness additionally requires a fresh child-authored startup acknowledgment for that generation; mailbox claims alone are insufficient.
- The registration token is captured early and removed from the environment; it is not persisted as public process identity.
- Both first fresh assignments and retained-worker assignments carry an exact process address and use mailbox protocol **v6**. The worker checks address before execution; acceptance must echo it. Older v5 readers reject v6 before executing. Legacy non-Radar unaddressed requests remain v5.
- Unknown dispatched launches durably reserve their label/mailbox, including across session restart, preventing a second same-label spawn. Authoritative launch refusal releases admission; this does not claim that no pane was created.
- Radar children use their bound spawn edge for topology/exit observation and `child.close` for guarded pane closure. New destructive admission relies on the daemon's replacement/process-birth checks.
- Stored dispatched/unknown close requests reconcile the exact UUID and parameters even when the pane has disappeared. A durably completed close permits only generation-guarded local cleanup, without another physical close.
- Mailbox/run identity, assignment locks and durable-result guards prevent old completion from cleaning a replacement generation. Cascade and result cleanup share these close-evidence paths.
- Retained reuse stays within the same proven addressed generation; saved-session continuation remains distinct from retaining a live process. Retention-off cleanup leaves caller result provenance/saved sessions available for discovery.

Primary files: `radar-launch.ts`, `radar-client.ts`, `index.ts`, `mailbox.ts`. Detailed implementation chronology: `.pi-herdsman/radar-managed-launch-progress.md`.

## Boundaries that must remain explicit

1. Startup acknowledgment is historical readiness, not perpetual liveness.
2. Fresh topology says the pane is present; unknown exit does not prove a process is alive.
3. Process-addressed request acceptance proves which incarnation accepted that request.
4. Pane closure, observed process exit and assignment completion are separate facts.
5. An uncertain dispatch remains recorded; do not mint a replacement UUID or switch backends to force progress.
6. Publication failure containment is not permission to launch without required Radar identity.

## Remaining direct Herdr dependencies

The worker migration is **not complete Herdr removal**. Current source still imports and calls `herdr.ts`, and common snapshot paths consult Herdr even while adding Radar evidence.

| Dependency | Current evidence / seam |
|---|---|
| Shared fleet snapshots, status and provenance | `index.ts:2653–2750`, `3683–3684`; `herdrSessionSnapshot` calls remain in result cleanup, close/cascade and overview. `herdr.ts` reads `api snapshot`, agent lists and worktree grouping. |
| Legacy integration/identity/inspection | `index.ts:2920–2928`, `6298–6304`; legacy `validateIntegration`/`closeHerdrPane` paths remain. `herdr.ts` still supplies agent/session/process inspection and direct CLI execution. |
| Restart preserving the existing pane | `index.ts:7255–7332` uses `pane get`, `stopHerdrAgentPreservingPane`, `startHerdrAgentInPane`. |
| Manager/Chief/Lead topology and worktree lifecycle | `index.ts:11034–11073`, `11321–11325`, `12426–12434`, `12861–12922`, `13052–13361`: agent discovery, worktree list/open/create, pane/process inspection and existing-pane Lead start. |
| Lead/worker/owner pane metadata | `index.ts:3244–3249`, `7504–7514`, `9784–9789`, `9877–9885`, `10498–10503`; `pane-metadata.ts:45–65` builds direct `pane report-metadata` commands. Awaited facts/titles/model/context/display metadata still use this transport. |
| Herdr native reporter readiness | `index.ts:9941` still checks `herdrReporterExtensionPath`; Manager Lead startup polls Herdr's reported Pi identity (`13356–13449`). Radar publication does not make this old consumer dependency disappear. |
| Herdr lifecycle subscription and environment | `index.ts:17375` still starts `watchHerdrLifecycle(HERDR_SOCKET_PATH, ...)`; workspace/tab/pane context still reads `HERDR_*`. |
| Packaging/docs/tests/smokes | `pi-herdsman/package.json` still declares Herdr-specific metadata; adapter/tests, smoke scripts and deployment wiring need a separate removal audit. |

This is a verified subsystem inventory, not a counted exhaustive list of every repository invocation. Line numbers refer to the current shared working copy and will move.

## Gaps and next steps

1. **Manager→worktree Lead placement:** current adopted spawn contract splits beside the registered parent, but Manager must start a Lead in a selected existing worktree root pane/workspace. Await an explicit authorized Radar contract; do not fake parent registration or silently change placement. Existing-pane launch, stop/restart and associated readiness need their own cutover.
2. **Resolve the 42 full-gate failures.** Remaining families include controller API retention/relaunch, Manager identity/worktree, settlement and control integration. Failure names must be compared against a reproducible baseline; passing focused tests does not certify whole migration readiness.
3. **Replace remaining common Herdr readers/reporters/subscriptions**, then remove legacy direct mutation paths. Do not remove the native reporter while Manager/session-readiness consumers still require it.
4. **Live verification/deployment remains outstanding.** Update pins and restart only after the gate and approved scope are ready; exercise one controlled launch, first-task acceptance, result delivery/close, retained or saved-session continuation and context publication against a compatible real daemon. Prior isolated publication smokes do not establish live adoption; the withdrawn old-daemon context smoke is not evidence.
5. **Finish documentation/decision landing and path-scoped commit.** Unrelated files also exist in the shared working copy. Earlier `.pi-herdsman/herdr-removal-scope.md` describes pre-spawn Radar capabilities and is historical, not the current contract inventory.
6. Nonblocking coverage gap: completed-close result cleanup is source-reviewed but lacks a dedicated new regression. Registry pruning and wider mux/exit support remain separate Radar concerns; this slice does not implement them.

## Start here

Read `.pi-herdsman/radar-managed-launch-progress.md`, then current `radar-launch.ts` and `index.ts` launch admission/submit/close cleanup seams. Consult the canonical Radar contract at `/home/saurabhj/Projects/dev/agent-radar/docs/control-plane.md` before extending Manager placement or restart semantics. Preserve the reviewed address and durable-operation guards while shrinking the remaining Herdr seam.
