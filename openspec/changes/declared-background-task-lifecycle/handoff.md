# Implementation handoff — declared background-task lifecycle

## Status and authority

**Ready for implementation delegation when authorized.** Strict structural validation passes. The owner-approved alternate-model independent reviewer returned **OK — No issues found** after rechecking the corrected contract. Initial findings and final disposition are preserved in `plan-review.md` and `plan-review-final.md`; provenance is in `review.md`. The owner authorized implementation delegation on 2026-10-01. At dispatch, all 27 task boxes are unchecked. Captured input baseline: jj change `srsuqtxkqllk`, commit `d5a595a3a4c39e6cf408b5404585fd1795777272`; recovery evidence: `/tmp/pi-bg-implementation-baseline.R1xfDQ/`. Preserve all dirty owner inputs. Run the sequential assignments below with parent gate checks and a fresh read-only implementation review; authorization does not extend to deferred work, publishing, or unrelated edits.

Repository: `/home/saurabhj/Projects/dev/custom/pi-extensions`.
Change: `openspec/changes/declared-background-task-lifecycle/`.
Host target: Pi 0.99.2; no 0.87 compatibility project.

Read in order:
1. `proposal.md` — scope and breaking changes.
2. `specs/background-task-retrieval/spec.md` — behavioral acceptance contract.
3. `design.md` — state, output, transport, recovery, and compatibility choices.
4. `context.md` — source map plus parent corrections/provenance.
5. `tasks.md` — dependency-ordered checklist; all boxes are initially unfinished.
6. `deferred.md` — excluded integrations whose constraints must remain intact.

Conversation decisions outrank stale existing prose; specs are the local acceptance authority. If design, tasks, source, or existing tests conflict with the contract, report the exact contradiction to the supervisor rather than guess or silently relax it.

## Locked behavior

- Keep ordinary bash and its 20-second default foreground yield; no new timeout defaults. Explicit spawn remains available.
- Normal TUI surface: register only `bg_task` spawn/get/stop/list, not bg_status; `pi-bg get ID [--output]`, list, stop on supported POSIX hosts. Keep existing cross-platform Pi-tool support, but do not add a Windows CLI or a `bg` shell executable.
- Successful running get is a review: metadata/preview, soft timer reset, no final acknowledgment. Final get requires flushed output and acknowledges the notification, not the data.
- Full CLI output uses stdout; retrieval metadata uses stderr; ordinary pipes and `>` choose destinations. Complete the requested write/stream before sending the internal success receipt. EPIPE, open/write/snapshot failure, or disconnect before receipt acceptance leaves completion unacknowledged and does not count as a running review. A successful write does not certify downstream byte consumption; receipts are idempotent. No destination flag, consume/unconsume flag, polling loop, or new wait option.
- Complete captured output must be preserved before inline truncation. Handed-off output is an immutable snapshot, not the live log. Capture both streams as currently done; do not rewrite commands with `2>&1` or claim exact cross-pipe ordering.
- Stop returns confirmed terminal result/output under the same ID when possible. A later get still works. A sent signal is not confirmed termination; an unconfirmed stop must leave the eventual outcome outstanding.
- List never acknowledges or resets clocks. Soft review is time since review; output chatter is not review. Hard deadline is absolute. Keep configured soft/hard-disabled values.
- Cancel extension-held stale wakes. Already-submitted Pi messages can still arrive; never clear unrelated queues or claim transactional exactly-once host delivery.
- Keep bounded wait and legacy required bg_status callable for print/json/rpc/unknown modes. Pi exposes `ctx.mode`; hasUI alone is not sufficient because RPC has UI. Shared append-system guidance must be mode-neutral and not name bg_status or bg_task action:"wait", which are absent in TUI. Supply TUI push waiting and other modes' named bounded-wait compatibility guidance through the supported session prompt contribution; route legacy bg_status log through get with no live-path or independent acknowledgment bypass. Test the assembled prompt and schema together. No shared user-file rewrite per session and no pi-subagents lifetime changes.
- Preserve the current codemode foreground bash route, BASH_OUTPUT_SCHEMA/structuredContent, nested-call provenance, intent requirements, and no-script-bg-spawn gate.

## Ownership and permitted edits

One writer at a time in this cwd. Do not parallelize implementation by handing overlapping pieces of `background-tasks.ts` to multiple workers. Use three sequential assignments, preferably the same retained worker after each gate, or fresh workers with the preceding verified report. Read-only reviews may run alongside independent work; final fixes return to the writer.

Primary allowed edit scope:
- `pi-bash-processes/extensions/` task/result/snapshot/log/CLI/wake/registration/format/render/settings modules and small new helpers needed for the declared bridge/result service.
- `pi-bash-processes/tests/` and `extensions/__tests__/` relevant regression fixtures/tests.
- `pi-bash-processes/{instructions.md,README.md,DEVELOPMENT.md,CHANGELOG.md,package.json}` and the existing append-system installer only when required for source-owned guidance/schema consistency.
- `tasks.md` checkboxes as verified work lands, plus evidence corrections to this handoff through the parent.

Secondary integration scope:
- Add focused tests in `pi-output-policy` / `pi-tool-renderer` if necessary. Their existing structuredContent/outputSchema forwards should normally be reused, not rewritten.
- A production change in either secondary package requires supervisor approval backed by the failing integration test. Do not expose a new cross-package private API just to reuse the current output-policy artifact writer: reuse its storage/presentation pattern or an existing supported contract.

Forbidden without new owner approval: pi-subagents changes, Pi core patch/private queue mutation, dotfiles/Nix changes, dependency reinstall/upgrades, global config/AGENTS edits, vendored-upstream takes, cleanup of unrelated owner work, pushes, or live task inventory destruction.

Baseline is dirty. Before editing, record `jj status` and the scoped diff, and capture the relevant pre-existing files. Do not run `jj restore --from @-`, blanket reset/checkout, or another stale-tree restore to obtain a clean tree: that would discard the owner's current codemode/OpenSpec work. Isolated worktrees need an approved captured base that includes those inputs; a clean HEAD-only worktree is not the right base. Use jj for local history. Ask before splitting/committing mixed owner changes; do not bundle them into your implementation commit.

## Sequential delegation assignments

### Assignment A — lifecycle foundation (tasks 1.x, relevant parts of 3.x)

**Goal:** implement readiness, shared result preparation, durable idempotent acknowledgment, review-clock primitives, and safe restoration while old adapters remain usable.

**Writer:** worker, fresh context initially. Owns types, lifecycle integration, snapshots/persistence, wake reconciliation, and their tests. May add a focused task-result helper instead of growing the monolithic entrypoint unnecessarily; do not introduce another task registry/scheduler.

**Gate:** deterministic finalization/acknowledgment/review/restore tests pass; no current codemode regression. Report the observation and successful-handoff commit points before the CLI adapter begins.

**Return:** changed paths, source baseline, per-scenario results, command/exit evidence, snapshot migration behavior, remaining limitations, and the exact next phase interface. Bind report output via `runs.run(..., { output: "background-task-phase-a.md" })`, not an instruction to write repository scratch.

### Assignment B — output and CLI handoff (tasks 2.x plus get/stop adapter work)

**Dependency:** consume Assignment A's actual output and verified diff first.

**Goal:** stable full/partial snapshots, complete-artifact preservation before truncation, session-private POSIX request/response bridge, shared tool/CLI get, and confirmed stop-result delivery.

**Writer:** exclusive owner of log/output/CLI/result adapters and required lifecycle wiring during this phase. Use built-in Node facilities. Stream large output; don't put it in a giant RPC JSON response or hold a global task lock while copying it.

**Early feasibility gate:** first prove two-session socket request/response and managed-bash-invoked pi-bg without deadlock; do not remove the old receipt channel until the declared bridge and acknowledgments pass.

**Gate:** full redirection/file-content and partial-snapshot immutability tests, two-session handle isolation, prepared-result/transport/file failure tests, accepted-token retries through task retention, normal-stop/natural-exit/SIGKILL escalation, and existing structured-output contracts pass. Stop/CLI requests from managed bash must not deadlock.

**Return:** result/schema and transport handoff contract, exact successful-delivery receipt policy, files/commands/results, resource/retention cleanup behavior, and residual risks. Bind `background-task-phase-b.md` through the runner.

### Assignment C — surface switch and integration (remaining tasks 3.x–5.x)

**Dependency:** consume both previous phase reports and passing gates; do not remove the inferred-read channel before declared acknowledgment works.

**Goal:** wire review scheduling and dispatch revalidation, switch TUI schemas/guidance, retain explicit noninteractive compatibility, remove live-path advertisements/inferred-read machinery, update docs/prompts/provenance, and complete integration/live checks.

**Writer:** exclusive owner of final integration and all fixes. Keep wait compatibility outside normal TUI guidance. Use `ctx.mode === "tui"`; unknown mode is conservative. Re-register only at a supported session boundary and verify the model-visible schema, not just TypeBox source text.

**Gate:** complete acceptance matrix, all three package suites, prompt/schema audit, fresh-host checks, and independent implementation review. Deliver no unfinished tests as completed boxes.

**Return:** final scoped diff, completed checklist, test/host evidence, review response, no-debug/no-unrelated-work audit, and honest remaining queued-host-message/crash/retention limitations. Bind `background-task-phase-c.md` through the runner.

### Independent implementation review

Fresh read-only reviewer/oracle checks both contract and actual diff against the captured baseline. Focus on result readiness, lost/duplicate wakes, CLI acknowledgment commit point, large output before truncation, deadline mutability, process cleanup, and compatibility/codemode invariants. Findings require an observable failure mechanism and source evidence. P0/P1 block handoff; fix and rerun their regression tests. No review worker writes in the implementation cwd.

## Acceptance matrix

Prefer fixtures, fake clocks, and explicit flush barriers. Use a few decisive real-process/host checks for stream capture, termination, IPC, and continuation; do not substitute repeated sleeps/polling for assertions.

| Area | Required experiment / assertion |
|---|---|
| Foreground / yield | Immediate completion is delivered once; threshold crossing yields ID and preview but does not stop the process. |
| Running get | Returns promptly, reports changed/unchanged output, resets review only, leaves completion owed. |
| Exit/flush race | Pause the log flush, close process, get returns finalizing; release flush and final get includes last marker. |
| Terminal get | Two gets both succeed; one ack obligation; no pending extension-held completion wake remains. |
| Failure handoff | Inject snapshot/open/write/transport failure at preparation/handoff; no fabricated complete result or silent premature ack. |
| Large output | Emit >1 MiB with prefix/middle/suffix markers; assert artifact/redirection contents match captured combined output, not just tail. |
| Running snapshot | Snapshot prefix, append later output, assert previous snapshot unchanged and labeled partial. |
| CLI stdout/stderr | Redirect raw output to a file; verify no retrieval metadata in that file. Pipe into a filter and retrieve again. Large output piped into head must detect EPIPE and not commit receipt/ack/review; short successful writes may count as delivery. Inject open/write/disconnect failure; retry accepted receipts idempotently. |
| Combined streams | Emit stdout and stderr markers; both captured. Explicit command redirection remains effective. Do not assert total ordering across pipes. |
| Stop result | SIGTERM-confirmed stop returns final retained output and ID; same-ID get succeeds; naturally exited task retains real exit. |
| Escalation/failure | SIGTERM-ignoring process reaches existing SIGKILL path; failed/unconfirmed termination is not declared stopped or acknowledged. |
| Review clocks | Fake-clock get reset, reminder submission rearm, one held reminder, stale revision invalidation, and no output/list reset. |
| Hard guard | Repeated reviews still reach the original deadline; hard-disabled task never gets an invented hard limit. |
| Wake races | Completion/get/stop/reminder permutations at active-turn/idle dispatch preserve one local obligation and don't retract unrelated host messages. |
| Recovery | Legacy/new acknowledged snapshots stay silent; unacknowledged outcomes replay per policy; one overdue review; orphan process and retained output remain truthful. |
| Session isolation | Two manager sessions with similar short IDs; foreign/stale generation cannot read/stop/review another task. |
| Retention | Active work never pruned; in-flight result protected; handed-off artifact independent; expired handle errors explicitly. |
| Model surface | Check the effective assembled prompt AND schema: TUI registers only bg_task spawn/get/stop/list, not bg_status, and has no absent-name/wait recommendations. Print/json/rpc/unknown retain bounded wait/bg_status and named session-specific compatibility guidance; legacy log routes to get without path/ack bypass. Shared installed instructions remain mode-neutral, without bg_status/wait names. No polling/live-log-reading advice. |
| Read inference removal | Raw artifact reads no longer acknowledge; consumption env/shims/live-path detail leaks absent; CLI declared operations still synchronize lifecycle. |
| Codemode | Preserve current foreground/no-managed-spawn/intent and structured-output tests, including nested wrapper provenance. |
| Fresh host | Load the new module in a fresh Pi 0.99.2 instance, not the parent's cached extension; prove yield/get/progress/completion/stop behavior and cleanup. No deferred child push-only claim. |

Commands (run separately, capture terminal results; do not call Running success):

```sh
cd /home/saurabhj/Projects/dev/custom/pi-extensions/pi-bash-processes && bun run test
cd /home/saurabhj/Projects/dev/custom/pi-extensions/pi-output-policy && bun run test
cd /home/saurabhj/Projects/dev/custom/pi-extensions/pi-tool-renderer && bun run test
```

The bash-processes manifest expands test to `bun test ./tests ./extensions/__tests__`; there is no package typecheck script to invent. Use the current fixtures listed in `context.md`; add narrow cases alongside their existing coverage. If a command exceeds the harness foreground window, continue independent work or return for its completion wake; collect its actual exit status once terminal.

Planning validation:

```sh
cd /home/saurabhj/Projects/dev/custom/pi-extensions
openspec validate declared-background-task-lifecycle --strict
openspec status --change declared-background-task-lifecycle --json
```

## Stop / escalation conditions

- Required child/headless wait cannot remain callable with the proposed schema selection.
- The result handoff would need private Pi queue access or a host API the installed version lacks.
- CLI requests cannot be serviced without deadlock or task/session identity cannot be established.
- Full output cannot be recovered from the canonical captured log before truncation, or log/snapshot I/O failure is being hidden as success.
- An existing baseline test breaks and the worker cannot show whether it is a intended contract replacement or regression.
- Worktree ownership is ambiguous, unrelated concurrent edits appear, or a scope expansion/dependency change is required.

Checkpoint the scoped diff and concrete blocker, preserve owned running tasks safely, and ask the supervisor. No silent protocol/runner fallback, no mass restore, no guessed passing evidence.
