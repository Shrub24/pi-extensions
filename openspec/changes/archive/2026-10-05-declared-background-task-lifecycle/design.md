# Design

## Context

See `proposal.md` for motivation and `specs/background-task-retrieval/spec.md` for the behavior contract. `context.md` is the source map; `handoff.md` assigns ownership and gates. This is planning only.

The current implementation already owns shell processes, combined stdout/stderr logs, foreground waiters, deferred completion wakes, snapshots, retention, and soft/hard timers. Reuse those mechanisms instead of introducing another scheduler. Finalization closes process lifecycle before its log flush settles; therefore process status alone is not a final-result readiness signal (`extensions/background-tasks.ts`, `finalizeTask`, inspected at lines 887–914). The current package name is `@vanillagreen/pi-background-tasks`, but its repository directory is `pi-bash-processes`.

Planning baseline: jj working change `srsuqtxkqllk`, observed commit `e932b20d310d`, parent `slpkuxzq` / `0c4f4aac`. It is dirty with pre-existing OpenSpec scaffolding and bash/codemode work. These changes are inputs to preserve, not scratch work to restore. References describe the inspected working tree, not an immutable release.

## Goals / Non-Goals

**Goals:** one task-result path used by tools, CLI, stop, and completion; explicit review/acknowledgment boundaries; complete output before truncation; reliable suppression of extension-held stale wakes; a small normal model-facing surface.

**Non-goals:** subagent lifetime/provider integration, parent waiting-state UI, a Pi core queue patch, filesystem access enforcement, a promise/fabric runtime, a global change to timeout defaults, stream-separated logs, unrelated kendex configuration cleanup, or new telemetry features.

## Decisions

### 1. Keep existing names; reduce the normal action surface

Use `bg_task` with normal actions `spawn`, `get`, `stop`, `list`. Keep normal `bash` as the primary execution tool; explicit spawn remains optional. Use the existing CLI name `pi-bg`, not a new `bg` executable that conflicts with the shell job-control builtin. Conversation examples using `bg` mean this interface.

`get` requires an ID and defaults to a bounded progress/result preview. Its only output-format choice is `output: "preview" | "full"` (default preview). CLI spelling is `pi-bg get ID [--output]`; no destination path, blocking toggle, acknowledgment flag, or independent timer-reset parameter. `stop` requires an ID and returns the same result envelope; the existing human/dashboard stop-all path can remain administrative, outside the small model-facing contract.

In normal TUI, register only `bg_task` with spawn/get/stop/list/extend; do not register the separate `bg_status` tool. Exclude wait/log/clear from the TUI schema and guidance, but keep `extend`: it re-arms or disables a running task's soft-reminder interval, which the narrowed surface still needs and which never moves a hard deadline. In print/json/rpc/unknown modes, retain `bg_status` as a compatibility adapter: its list/stop/log actions use the shared observational inventory, confirmed-stop, and get operations respectively, with no live-log-path details or independent acknowledgment channel. Until the separately deferred child bridge exists, noninteractive/child compatibility must retain existing required `bg_task wait` and `bg_status` contracts. Select with the public Pi 0.99.2 `ctx.mode`: only `"tui"` gets the reduced schema; `print/json/rpc` and unknown mode take the compatibility path. Do not use `ctx.hasUI` alone (RPC also has UI). The current native child explicitly binds extensions with `mode: "print"` in `pi-subagents/src/runs/shared/child-session.ts:468–471`; no child-runtime modification is needed for this discriminator. Register/re-register at the existing session/load boundary, and test which schema reaches the model. Do not remove an agent-required tool or its wait action before the future lifecycle bridge passes its tests. Deprecated log retrieval forwards to the new get operation; legacy wait terminal delivery uses the same acknowledgment path. Legacy soft extension cannot move hard deadlines.

`instructions.md` is appended through a shared installer and cannot assume every receiving session is TUI. Keep that installed block mode-neutral: describe shared ID-based get/stop/list behavior and refer pending-work waiting to the session's mode-specific guidance. Do not name `bg_status` or `bg_task action:"wait"` in the shared block, because neither is callable in TUI. Use the existing `before_agent_start` prompt contribution for both branches: TUI recommends independent work then ending the response for native wakes; print/json/rpc/unknown names the retained bounded wait and compatibility tool, and requires waiting when the caller needs a pending shell result before returning. No push-only child guidance. Do not rewrite a shared user AGENTS file dynamically per session. Check the assembled effective prompt alongside the model-visible tool schema for all modes; removing a name/action in TUI must not leave a stale recommendation in its prompt.

Default interactive completion remains on; there is no new silence/detach/interest policy. Preserve legacy snapshot settings on restore rather than retroactively changing old tasks' notification contract. Existing optional output-monitor wakes and resource controls are not redesigned, but output chatter must never masquerade as a deliberate review.

**Alternative rejected:** replace all callers and tools at once. That would silently break children whose sessions currently close while shell tasks are pending.

### 2. Separate process lifecycle, result readiness, and notification acknowledgment

Keep the existing process outcome fields. Add only the minimum explicit readiness/review/acknowledgment state necessary, preferably by extending the existing task/snapshot types rather than layering a second task object.

Conceptual states:

| Condition | Result readiness | Notification effect |
|---|---|---|
| Process active | Running preview/snapshot | Successful get records a review, never final acknowledgment |
| Process ended, output not flushed | Finalizing preview | No terminal acknowledgment |
| Process ended, output flushed | Terminal result | Successful get/stop/foreground delivery acknowledges |
| Terminal result acknowledged | Still retrievable | No extension-held completion wake is owed |

Define a single result-building service returning ID, command, process/readiness state, elapsed time, configured absolute deadlines, outcome/termination details, output preview, changed-output indicator, and optional immutable snapshot reference. Normal operation state is reported in `structuredContent` as well as model text. A nonzero child command exit is an outcome, not a management lookup failure; unknown ID, I/O failure, or stop failure must be explicit management errors. Preserve `outputSchema`/`structuredContent` through renderer/output-policy handlers.

Mutations must use a per-task serialized critical section or equivalent synchronous reservation plus post-I/O revalidation. Never hold a global lifecycle lock while copying a large log. Use identity/generation checks so an old task with a reused short ID cannot mutate a replacement.

A get takes a well-defined observation point. It can truthfully return a running/finalizing snapshot if completion races with it, with no acknowledgment. A final read observes the flush barrier before handing off output. Commit review/acknowledgment only after preparing a valid response/output reference; output failures leave the completion obligation outstanding.

**Alternative rejected:** `status !== "running"` means ready. It reproduces the already-observed late-output/late-wake fixture race.

### 3. Hand off immutable snapshots, never mutable live log handles

Keep the live log internal. Remove model/CLI/UI/structured-detail advertisements of its path and consumption-specific environment variables. Retain private manager storage and any minimal session binding the CLI requires; task IDs are scoped handles, not security credentials. No filesystem-sandbox promise is made.

For a running full read: flush captured output to a defined boundary, snapshot only that captured prefix, and return a partial immutable artifact. Subsequent task output cannot mutate the snapshot. For a terminal read: use the final flushed log and reuse a finalized immutable artifact where possible. Large snapshot creation must stream/copy rather than materialize the entire log in memory. Distinguish captured command output from manager diagnostic lines; do not inject retrieval metadata into raw stdout.

The CLI emits raw snapshot output on stdout and its status/partial/error metadata on stderr. `>` and pipes act inside the shell before model-output truncation. The CLI does not offer `--out PATH`. Success means the requested stdout write/stream finishes without a detected error and the manager accepts the internal success receipt. EPIPE (including early closure by `head`), snapshot/open/write failure, or disconnect before that receipt leaves completion unacknowledged; partial bytes already delivered do not change that rule. The CLI reports a failed handoff through stderr/nonzero management exit when possible. If a short stream finishes successfully before the consumer closes, that is a successful handoff. Success does not certify that a downstream caller read or used every byte. Preview and full output use the same rule. A successful running handoff commits only a review reset, never completion acknowledgment.

Tool responses and foreground managed-bash completion must preserve full captured output before any head/tail/minimization limit and include the complete artifact reference when bounded. Do not label a downstream output-policy spill containing only the preview as the task's complete output. Preview retrieval does not require copying a huge running log merely to show a tail; full snapshots are made on request or when preserving a truncated final result. Artifact references are safe for ordinary read tools because reading them no longer alters lifecycle state.

The existing manager merges stdout/stderr chunk arrivals. Keep that behavior; do not rewrite the command with `2>&1`, claim exact cross-pipe ordering, or change user redirections.

**Alternative rejected:** let output-policy save whatever it receives. Managed bash can already have discarded the full prefix from its in-memory preview by then.

### 4. CLI retrieval is an explicit manager request, not a read detector

The live manager owns the get observation, snapshot, review reset, and acknowledgment. Tool and CLI adapters must call the same operation. Session binding must prevent another Pi session's similarly numbered task from being resolved accidentally.

The existing generated CLI is file/receipt-only (`read-shim.ts:53–84`), with no package-owned bidirectional control bridge established by the source map. Replace that channel with one session-private Unix socket on supported POSIX hosts and a minimal allowlisted get/list/stop protocol, using built-in Node facilities rather than a global daemon, new dependency, or shell-argv detector. The current generated POSIX helper already has no Windows implementation; portable Pi-tool operations must keep their existing platform support, and new Windows CLI support is not part of this change. Full output is handed off as an immutable snapshot descriptor for the CLI to stream, not as a giant JSON value. Register the endpoint only when a session starts and clean it up on shutdown. Reject stale session/task generation and malformed requests. Keep the endpoint/session binding private and separate from live-output storage; omission of a live path is behavioral scoping, not a security boundary.

Use a bounded request/response timeout and explicit bridge-unavailable error, not direct-file fallback that silently bypasses the review/ack contract. Test CLI invocation from a managed bash call to ensure the extension event loop can service the request without deadlock. Direct spawn/waiter lifecycle is still event driven; this does not add model polling.

Result handoff can fail after the manager has returned a prepared result (e.g. transport breaks or the CLI cannot open the snapshot). Use a small prepared-result token bound to session/task generation and an idempotent explicit success receipt where needed; the CLI sends it only after completing the requested output handoff. An accepted receipt commits terminal acknowledgment or running review, according to the prepared observation. Revalidate generation/readiness at receipt: a prepared running result must not acknowledge a task that completed while streaming. If the connection fails after receipt acceptance but before its confirmation arrives, the caller can retry that receipt idempotently; do not claim distributed exactly-once delivery. Expire only unaccepted abandoned preparations without acknowledgment or review reset, and keep the retained file retrievable. Accepted tokens must return the committed outcome on retry through the owning task's retained lifetime (or an explicit task-expired outcome once it is pruned), never an unaccepted-preparation error that implies acknowledgment was rolled back. This token is internal protocol state, not another agent-facing option. Do not attempt end-to-end transactional guarantees for arbitrary shell consumers.

**Alternative rejected:** rename the old consume log and assume shell reads become explicit. It cannot atomically synchronize live-manager state, finalization, and CLI delivery failures.

### 5. One completion obligation and honest host-delivery semantics

Centralize terminal acknowledgment for terminal get, confirmed stop, foreground command delivery, retained bounded wait, and host completion notification. Separate acknowledgment from output deletion. Preserve/migrate existing `exitNotified` truth; add versioned fields only where readiness/review cause cannot be inferred safely. Do not reinterpret `exitNotified=true` as proof that all output bytes were read.

Extension-held exit/reminder batches use stable task identity and a review/notification revision. Immediately before dispatch, recheck current state: drop acknowledged completions, stale review revisions, and reminders for tasks that are now terminal. Simultaneous get/stop/wake paths must settle the obligation once within this process. Preserve batching, replay, wake-budget, orphan-watcher, and process cleanup invariants that do not conflict with the new contract.

Pi 0.99.2's `pi.sendMessage()` returns void and lacks safe selective custom-message cancellation. Never clear whole steering/follow-up queues or mutate Pi internals. Once a wake is submitted, record that its obligation has been fulfilled. Persist acknowledgment so normal reload/restore does not replay it. Include task ID and stable event identity in messages so any already-queued stale message is recognizable. A crash between host submission and persistence can produce an at-least-once replay; document this ambiguity rather than assert exactly-once host delivery. Treat later retrieval as repeatable data access, not another delivery obligation.

Use direct actionable boundaries already available in Pi for the new scheduling logic rather than adding more `agent_settled` continuation behavior. Regression-test the current deferred flush path before moving it. This change does not promise to retract submitted host messages or undo a request already sent to a model.

**Alternative rejected:** clear/rebuild Pi's queues to remove one wake. It risks deleting or reordering user steering and unrelated extension messages.

### 6. Soft reminders measure review; hard deadlines never move

Preserve existing configured values: `foregroundYieldMs` = 20,000 ms; `defaultSoftTimeoutMs` = 600,000 ms for reviews; `defaultTimeoutSeconds` = 0 (disabled) for the absolute process ceiling, overridden per task by the existing `timeoutSeconds` option. “Hard deadline” is descriptive terminology for that ceiling, not a new setting. The user described the hard timeout as a generous safety guard, not a new short default; no two-hour hard default is introduced.

Track last successful review time and a cheap output revision/length marker. Running get resets the review interval and invalidates any extension-held reminder. A valid progress reminder submitted to the host counts as a delivered review and rearms the next interval. At most one held reminder per task; no accumulation during long turns. Disabled soft interval stays disabled. Restore uses persisted review time/deadline and schedules at most one overdue review rather than replaying every missed interval.

Listing, log appends, output-pattern wakes, widget refreshes, and internal retention scans do not count as review. Repeated deliberate get calls do reset the reminder: discourage pointless polling in returned guidance, not by arbitrary rate limiting. All these paths leave the original hard deadline unchanged.

**Alternative rejected:** rearm on output activity. A noisy process would never be brought back for review.

### 7. Stop is bounded cancellation plus result delivery

Reuse existing process-group/resource-control signaling and `forceKillGraceMs` (default 5,000 ms). Observe natural exit or confirmed stop, drain output, and build the same terminal result used by get. Stop should finish early when termination is confirmed; never wait out the task's original timeout. If termination or output flush is still unresolved after the bounded procedure, return an explicit nonterminal/error observation with partial output and keep completion outstanding.

A natural completion winning the race remains natural completion. Confirmed explicit cancellation delivers the retained final output and acknowledges redundant wakes; repeated stop returns the existing final result. Failed signaling is not a successful stop. CLI success status describes the management operation; the task's own exit/signal is carried in metadata so retrieving a failed command's result is not confused with failure to retrieve it.

**Alternative rejected:** report success immediately after SIGTERM. It lies about task outcome and can suppress the only eventual notification.

### 8. Retention and compatibility are bounded, not silent data loss

Keep active tasks exempt from finished-task pruning. Preserve the existing bounded finished-task policy, but define it as retained-lifetime access rather than indefinite storage. A copied snapshot handed to the caller has its own artifact lifecycle and must not be deleted merely because the live task map is pruned. Use explicit missing/expired errors; never synthesize an empty successful result from a missing log.

Remove read-inference PATH shims, consumption-log environment exports, per-PID consumption-log pruning, and old live-path read replacement where they serve only that inference. Preserve unrelated shell/process safety features. Sleep interception must not provide a backdoor model-side wait/poll loop in the new interactive surface; any internal compatibility requirement must be named and tested before deletion.

## Risks / Trade-offs

- **CLI transport changes are a real seam** → build scoped request/response fixtures before removing the receipt-based implementation; no untested file-read fallback.
- **Snapshot copying competes with output appends or retention** → explicit flush/prefix boundary, task generation checks, streamed copy, independent artifact lifetime.
- **Early acknowledgment loses the only notification** → successful handoff is the commit point; inject response/file/socket failure in tests.
- **Already-queued Pi messages remain possible** → document the public-API limitation and keep core cancellation work separate.
- **Terminal pruning before final get/stop finishes** → protect in-flight result preparation; recover from snapshots through the same resolver where supported.
- **Noninteractive children currently need bounded waits** → retain compatibility and do not change their completion/disposal path.
- **Re-registering a tool changes model schemas** → select the surface at the existing session/load boundary; test TUI/noninteractive modes and required tools, not just help text.
- **Pre-existing codemode work gets overwritten** → preserve current foreground routing, outputSchema/structuredContent, no-script-spawn guard, and intent tests as mandatory regressions.

## Migration Plan

1. Capture a jj baseline that includes the owner's current working-copy changes; separate changes only with owner approval. Install no packages or alter Nix during this change.
2. Add readiness/result/ack/review primitives and tests while old adapters still work.
3. Add the CLI bridge and get/stop adapters; retain explicit compatibility paths for children/headless sessions. Validate large output, full redirection, and failure handoff.
4. Switch normal TUI registration, prompts, notices, widgets/dashboard text, and result formatting to the new interface. Remove live-path advertisements and read inference only after declared CLI acknowledgment is covered.
5. Migrate old snapshots conservatively: existing notification acknowledgment stays acknowledged; unknown readiness is established by reconciliation/flush; old consume receipts are not a new authoritative channel. Do not replay historical delivery based on an absent new field.
6. Run targeted, package, integration, and live-host gates; inspect the scoped diff and update fork provenance/docs. Restart/reload for a genuine live check against the new module, not a cached old instance.
7. For rollback, restore the scoped implementation change with jj while preserving unrelated changes and retaining output files. Retain legacy snapshot fields/schema readability during this migration so rollback does not fabricate missed results. Do not roll back by clearing live queues or deleting logs.

## Deferred work

`deferred.md` records the separate subagent pending-work bridge and proposed selective Pi queue cancellation API. Neither is a gate claimed to be complete here. The local implementation must remain truthful and compatible without them.
