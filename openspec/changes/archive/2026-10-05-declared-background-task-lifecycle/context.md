# Code Context — declared ID retrieval in `pi-bash-processes`

## Parent reconciliation / provenance

Read this section before the preserved scout report below.

- Report source: workflow `28b8ea73-eed2-4228-bedc-cf7d9cf22c6f`, scout child `a75f0214-4f0c-451b-8ae7-92b6b1f745c5`, bound output `background-task-source-map.md` in the parent's subagent-artifacts outputs directory. This file is the durable repo copy; the implementation does not depend on ephemeral run paths.
- Parent checked `read-shim.ts:53–84` directly: the existing CLI is a file/receipt helper, not a bidirectional manager bridge. The plan therefore calls for a small session-private control endpoint. A new global daemon is not proposed.
- **Correction to Q2 below:** Pi 0.99.2 publicly exposes `ExtensionContext.mode` (`tui | rpc | json | print`), and `hasUI` is true in both TUI and RPC. The installed declaration was read directly at `pi-bash-processes/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:190–299`. Do not use hasUI alone to choose the reduced surface. Pi-subagents explicitly binds its child with `mode: "print"` at `pi-subagents/src/runs/shared/child-session.ts:468–471`; use this as compatibility evidence only, not a new child-lifecycle investigation. Normal TUI gets the reduced schema; print/json/rpc/unknown modes keep bounded-wait compatibility until the separate bridge is verified.
- Parent read `finalizeTask` directly at `background-tasks.ts:887–914` and confirmed the log-flush-before-wake/waiter-settlement barrier. Several scout line ranges span nearby functions and are navigation hints; locate the named symbol again before editing.
- Coverage check for the eight critical files reported `no_recorded_issue` / `metadata_match` at index generation `2026-10-01T10:31:25Z`. This is best-effort freshness, not proof of exhaustive negative findings. Scout grep negatives and uninvestigated host APIs below remain bounded evidence, not global absence claims.
- The scout reports the current bash-processes suite as **160 pass / 0 fail**. This is child-reported evidence; capture a new direct baseline at implementation launch. This planning handoff is not a parent verification of implementation.

## Preserved scout report

Repo: `/home/saurabhj/Projects/dev/custom/pi-extensions`
Package: `pi-bash-processes` (`@vanillagreen/pi-background-tasks` 2.1.1)
Working copy: pre-existing uncommitted edits in `extensions/background-tasks.ts`, `extensions/managed-bash.ts`,
`extensions/render.ts`, `tests/managed-bash.test.ts`, `README.md`, plus new `tests/bash-structured-output.test.ts`,
`tests/codemode-bash.test.ts`, `tests/codemode-bash-intent.test.ts`, `tests/fixtures/extension-host.ts`.
Do not revert them. `openspec/changes/declared-background-task-lifecycle/proposal.md` is untracked and already
states the agreed target. All line numbers below are current working-copy lines.

## 1. Entry points and registrations

| Surface | Anchor |
| --- | --- |
| Extension entry | `pi-bash-processes/extensions/background-tasks.ts:177` `export default function backgroundTasks(pi)` |
| Tool/command/shortcut registration | `extensions/registrations.ts:57` `registerTools`, `:256` `registerCommands`, `:360` `registerShortcuts`, `:399` `registerAll` |
| `bg_status` tool (list/log/stop) | `registrations.ts:58-95` (`action: ["list","log","stop"]`, `pid` only) |
| `bg_task` tool (spawn/list/log/stop/clear/wait/extend) | `registrations.ts:98-253` |
| Managed `bash` tool | `background-tasks.ts:2050-2100` (`outputSchema: BASH_OUTPUT_SCHEMA` at `:2064`) |
| `/bg` and subcommands | `registrations.ts:269-357` |
| Host event wiring | `background-tasks.ts:1903` `agent_settled`, `:1908` `session_start`, `:1922` `before_agent_start`, `:1928` `session_tree`, `:1932` `session_compact`, `:1936` `session_shutdown`, `:1987` `tool_call`, `:2011` `tool_result`, `:2015` `user_bash` |
| Renderer hookup | `background-tasks.ts:1888` `registerMessageRenderer(BG_MESSAGE_TYPE, …)`; tool renderers at `registrations.ts:90-93`, `:247-252`; `pi-tool-renderer/extensions/tool-renderer/managed-bash.ts` |
| Interop marker | `interop[MANAGED_BASH_SYMBOL] = true` at `background-tasks.ts:2101`; symbol in `extensions/constants.ts:7` |

## 2. Task model and lifecycle

- Types: `extensions/types.ts` — `ManagedTask` `:237`, `BackgroundTaskSnapshot` `:128`, `ForegroundWaiter` `:206`,
  `TaskWaitWaiter` `:229`, `ForegroundOutcome` `:200`, `TaskWaitOutcome` `:222`, `WakeDropReason` `:47`,
  `SpawnTaskOptions` `:299`, `BackgroundLogTruncation` `:278`.
- Spawn: `background-tasks.ts:1624` `spawnTask` (id `bg-<n>` at `:1631`, log path at `:1642`,
  `createForegroundWaiter()` at `:1701`, child pipes at `:1782-1812`, soft timer at `:1814`).
- Terminal transition: `background-tasks.ts:887` `finalizeTask` → `lifecycle.ts:55` `closeTaskLifecycle`
  (idempotent `task.closed` gate, status from `stopReason`/override/exitCode) and `lifecycle.ts:98`
  `sendExitWakeLifecycle`; orphan path via `finalizeTaskLifecycle` `lifecycle.ts:39`,
  replay via `replayMissedExitsLifecycle` `lifecycle.ts:135` gated by `snapshot.ts:344` `selectMissedExits`.
- Stop: `background-tasks.ts:1002` `requestStop` — sets `stopReason`/`terminationReason` eagerly, then SIGTERM,
  force-kill timer, and returns text **before** the child actually closes (`:1069` "Stopping …" while
  `finalizeTask` fires later on `close`). This is the gap for "distinguish requested stop from confirmed termination".
- Stop via tools: `registrations.ts:204-252`; failure path `:224-227`. `stop id:"all"` at `:196-208`.
  The stop result carries only `compactBackgroundTaskSnapshot` (`registrations.ts:90,123,246`), not the output.
- Output reads: `getTaskOutput` `background-tasks.ts:344`, tail read `readLogTail:321`, structured read
  `readStructuredOutput:357`, `managedBashStructuredContent:397`.

## 3. Output / log flush / truncation

- Writer: `extensions/log-writer.ts` — `createLogWriter:96`, `taskLogs:221`,
  `LOG_FLUSH_DELAY_MS=250 :26`, `LOG_WRITE_NOW_BYTES=1MiB :29`, `LOG_MAX_PENDING_BYTES=4MiB :32`,
  `LOG_WRITE_STALL_MS=2000 :35`, `settled(file)` used at `background-tasks.ts:400,897,913`.
- Ordering guarantee for "terminal after flush": `finalizeTask` (`:913-925`) waits on `taskLogs.flush(task.logFile)`
  before `settle()` sends the exit wake, drops in-memory output, and runs the finished-task bound. `exitWakeDue`
  WeakSet (`:437`) excludes those tasks from the bound. `removeTaskLog:409` also awaits `flush`.
- Full bytes before truncation: the task log is the canonical unfiltered record; `output` in memory is capped by
  `trimOutputBuffer` (`format.ts:41`, `outputBufferMaxChars` 1e6 default at `constants.ts:29`).
  In-memory `output` is cleared only after settled flush (`:915-918`).
- Truncation/advertisement sites (all must change or be re-pointed):
  - `format.ts:22` `taskLogTruncation`, `:33` `formatTaskLog` (emits `Full log: <path>`),
  - `managed-bash.ts:213` completion footer `[id: status; log: <path>]`, `:231` running text `Full log: <path>`,
  - `task-wait.ts:87` `formatTaskWaitRunningText` `Full log: <path>` (`:91`),
  - `wake-events.ts:507` soft-wake `Full log: ${task.logFile}`, `:585` exit guidance `bg_task log (or pi-bg read <id>)`,
    `:630-644` budget-exhausted notice `logFile`,
  - `auto-background.ts:161` `bashBackgroundAckText` `Log: <path>`,
  - `registrations.ts:174-176` spawn ack `Log: <safeLog>`, `:67-72`/`:231-238` `fullOutputPath` details,
  - `compactBackgroundTaskSnapshot` `wake-events.ts:439` always carries `logFile` into every tool result/wake `details`.
- Artifacts (immutable hand-off) already exist in pi-output-policy: `extensions/output-policy.ts:625` `writeArtifact`,
  `:756` call site, `:672-680` `notice` embedding `Full output: <path>`, write-once `wx` + delete-on-partial
  (`:597-623`), `preserveFullOutput` default true (`:558`). `directionForTool:376` treats `bash|bg_task|bg_status`
  as tail-truncated. This is the seam to reuse for "immutable handed-off artifact safe to read without shims".

## 4. Acknowledgment / deferred wakes / reminders / restore

- Deferred exit wakes: `turnActive` + `deferredExitWakes` map (`:200-213`), set in `sendTaskEvent` (`:604-618`
  foreground/wait owner, `:619-627` mid-turn hold, `:628-644` idle-debounce `idleExitBatch`),
  flushed at `agent_settled` (`:1903-1907` → `flushDeferredExitWakes:1478`).
- Acknowledgment today is **inferred**, three mechanisms:
  1. tool-side `consumeObservedExitWake` (`:1554`) called by `bg_task log/wait` (`registrations.ts:238`, `:1402`),
  2. PATH read shims: `read-shim.ts:28` `readWrapper`, `:55` `piBgScript` (`pi-bg path|peek|read`), `:92`
     `installReadShims`, `:114` `drainConsumedLogPaths`; installed by `settings.ts:130` `taskEnv` → `:143`
     `readShimEnv` with `PI_BG_CONSUME_LOG`/`PI_BG_LOG_DIR`/`PI_BG_LOG_GLOB`/`PI_BG_REAL_PATH`
     (`settings.ts:150-159`); drained in `flushDeferredExitWakes` (`:1478`) and `drainShimConsumedReads:1565`.
  3. sleep interception: `sleep-intercept.ts:74` `matchSleepIntercept` used at `background-tasks.ts:1244-1273`,
     consuming via `consumeObservedExitWake(target.id)` at `:1268`.
- Persistence of ack: `task.exitNotified` (types `:196`), consumed by `selectMissedExits` (`snapshot.ts:344-355`)
  and forced false on restore coercion (`snapshot.ts:283-290`); durable exit-once contract documented in
  `DEVELOPMENT.md` "Invariants".
- Soft reminder: `scheduleSoftTimeout` `:791` (one-shot `softTimeoutNotified`, deadline `softExpiresAt`),
  `extendSoftTimeout` `:826` (resets latch, fresh window from now, hard timeout untouched), wake text in
  `wake-events.ts:469-536`. Deadline is absolute (`softExpiresAt = startedAt + softTimeoutMs`, `:797`);
  no output-activity reset exists today. Restore re-arm at `:283-287`.
- Snapshot/state: `persistence.ts` (`createPersistence:183`, `sidecarStatePath:136`, barrier helpers `:72`),
  `snapshot.ts` (`taskSnapshot:11`, `rememberSnapshot:53`, `resolveTaskByToken:72`, `restoredTaskFromSnapshot`).
- Cross-process dedupe of reads: per-process consume log `settings.ts:82` `consumeLogPath` (`consumed-<pid>.log`),
  prune `:89`.

## 5. Auto-background / settings / docs / tests

- Auto-background decision: `extensions/auto-background.ts:76` `autoBackgroundDecision`, `:126`
  `forcedBackgroundDecision`, `:137` `duplicateTaskNote`, `:158` `ANTI_POLL_LINE`; wired in `user_bash`
  (`background-tasks.ts:2015-2048`) and `decisionForBashCommand:1872`.
- Managed bash route: `background-tasks.ts:1231` `runManagedBash`; codemode route `:1208` `runScriptBash`
  (via `managed-bash.ts:170` `isCodemodeCall`, blocked spawn `:1998-2003`, provenance set `:2007`, cleared `:2011`).
  `runScriptBash` uses `createBashToolDefinition` — preserves the "no bg spawn from codemode" invariant.
- Settings: `extensions/settings.ts` (`settingNumber/Boolean/String/Enum`, `logFilePath:55`, `taskLaneDir:102`,
  `taskEnv:114`, `readShimEnv:143`); declarations in `pi-bash-processes/package.json` `kendex.extensionManager.settings`
  (`foregroundYieldMs` 20000, `taskWaitDefaultSeconds` 30, `taskWaitMaxSeconds` 120, `defaultSoftTimeoutMs` 600000,
  `outputBufferMaxChars`, `logTailMaxChars`, `outputAlertMaxChars`, `taskDir`, …).
- Docs to update: `instructions.md` (appendSystem contract, mentions `pi-bg peek/read` and log reads),
  `README.md` "Fork delta"/"How it works"/"Soft timeouts"/"Settings", `DEVELOPMENT.md` invariants, `CHANGELOG.md`.
- Tests (suite passes today: `160 pass / 0 fail`, `bun test ./tests ./extensions/__tests__`): closest ones to touch —
  `tests/managed-bash-v1.test.ts`, `tests/managed-bash.test.ts`, `tests/task-wait.test.ts`,
  `tests/bounded-task-wait.test.ts`, `tests/deferred-exit-wake.test.ts` (shim consumption contract, see `:68`, `:96`),
  `tests/soft-timeout.test.ts`, `tests/restore-replay.test.ts`, `tests/snapshot-restore.test.ts`,
  `tests/log-tool-result-bounds.test.ts`, `tests/task-details.test.ts`, `tests/stop-content-e2e.test.ts`,
  `tests/sleep-intercept.test.ts`, `tests/pipe-strip.test.ts`, `tests/bash-structured-output.test.ts`,
  `tests/codemode-bash.test.ts`. Harness: `tests/fixtures/extension-host.ts` (`startExtensionHost:76`, `HostTool:22`,
  `tools`, `messages`, `entries`, `settle()`, `dispatch()`, `listTasks()`).

## 6. Direct answers to the two blocking questions

**Q1 — Does a bidirectional CLI control endpoint exist, or is the CLI file/receipt-only?**
Proven: today the only "CLI" is the `pi-bg` shell helper generated at `read-shim.ts:53-84`, installed into
`<taskDir>/shims` (`settings.ts:135` `shimDir`). It resolves a log path by globbing `$PI_BG_LOG_DIR/<id>-*.log`
and prints it (or tails it). Its only channel back into the extension is an **append-only receipt file**
(`$PI_BG_CONSUME_LOG` → `settings.ts:82` `consumeLogPath()`), drained and truncated by
`read-shim.ts:114` `drainConsumedLogPaths`, then matched to `task.logFile` in
`background-tasks.ts:1565` `drainShimConsumedReads`. There is **no socket, FIFO, port, or RPC** in
`pi-bash-processes/extensions/` (grep for `createServer|net\.|socket|mkfifo|listen(` returns only `active-context.ts`
`shouldAdoptActiveContext` false positives). So: **file/receipt-only, one-directional (read → receipt), no request
path**. A `pi-bg get` that must ask the extension for live state needs a new inbound channel; the consume-log
pattern (per-process file, drained by the host) is the only existing precedent, and it is write-only from the CLI side.
`bg_task`/`bg_status` are Pi tools in the same process, not CLI. **Missing evidence:** whether Pi exposes a
supported extension↔CLI request API was not investigated (out of remaining scope) — treat as unknown, not absent.

**Q2 — Current child/headless mode discriminator for preserving legacy wait.**
Proven: the extension's only environment discriminator is `ctx.hasUI` /
`shouldAdoptActiveContext` (`active-context.ts:19-24`). Uses: `background-tasks.ts:533` (`hasUi` for widget),
`:2043` (`if (ctx.hasUI)` for the user-bash notify), `dashboard.ts:54` (`if (!ctx.hasUI)` → text fallback),
`stacked-widget.ts:135`. `DEVELOPMENT.md` documents the headless case as `pi -p` ("no context has a UI").
Legacy wait machinery that children may currently rely on: `registrations.ts:141` `deps.waitForTask`,
`background-tasks.ts:1389` `waitForTask`, `task-wait.ts:25` `clampTaskWaitSeconds` / `:49` `settleTaskWaitWaiter`
/ `:87` `formatTaskWaitRunningText`, pending-message poll `ctx.hasPendingMessages()` at `:1428`.
There is **no** `isChild`/subagent flag read anywhere in this package, and no `PI_SUBAGENT*` env read
(grep negative in `extensions/`). **Missing evidence (do not guess):** whether Pi hands a child/subagent session
`hasUI=false`, and whether pi-subagents child runtimes inherit `PI_SESSION_ID`/session-file identity rather than a
child marker — no source was read in `pi-subagents` for this. The "hide wait only in ordinary interactive
guidance" decision therefore needs either (a) a proven child signal from Pi, or (b) a conservative choice to keep
`wait` callable everywhere and change only prompt/instructions text. Which of these is intended is an **owner
decision**, not derivable from the current source.

## 7. Seams to reuse, and open risks

Seams: `structuredOutputFor`/`BASH_OUTPUT_SCHEMA` (`managed-bash.ts:69,125`) for structured result shape;
`pi-output-policy` `writeArtifact` (`output-policy.ts:625`) for immutable full-output artifacts;
`consumeObservedExitWake` (`:1554`) as the single ack entry point; `exitNotified` + `selectMissedExits`
as the persisted exactly-once gate; `taskLogs.flush`/`settled` for terminal-after-flush; `softTimeoutNotified`/
`softExpiresAt` for the single pending reminder; `registrations.ts` `RegistrationDeps` as the only host↔tool seam.

Risks / unknowns (unverified, listed not answered):
- Cannot selectively cancel one already-queued custom message on Pi 0.99.2 — `sendMessage` options are only
  `{triggerTurn, deliverAs}` (`pi-coding-agent/dist/core/extensions/types.d.ts:1213-1216`); no queue-removal API was
  found. Whole-queue clearing is explicitly out of scope. Any "cancel stale notification" claim needs a Pi-side check.
- `requestStop` returns before termination is confirmed (`:1069`); the actual terminal result arrives via
  `finalizeTask`. Delivering output in the stop result requires waiting on that transition, which currently has no
  promise handle exposed.
- Removing `logFile` from `compactBackgroundTaskSnapshot` (`wake-events.ts:449`) touches every tool result, wake
  payload, restore fallback, and `tests/task-details.test.ts`; restore reads `details.task` for `id`+`command`
  (`background-tasks.ts:255-275`).
- Removing read shims touches `settings.ts:143-159`, `deferred-exit-wake.test.ts`, `sleep-intercept.ts`, and the
  `bashBackgroundAckText`/wake text that names log paths.
- Session scoping today is `activeSessionId` (`:216`, `sessionIdForContext` `persistence.ts:128` via
  `ctx.sessionManager.getSessionId()`); retrieval by ID must decide whether a cross-session/forked ID is resolvable
  (`session_tree` handler `:1928` currently only re-syncs UI).
- `pi-subagents` has **no** reference to `bg_task`/`pi-background-tasks` in `src/` or `tools/` (grep negative);
  its provider contract is generic (`docs/extension-api.md:392-416`). Child-only wait compatibility therefore lives
  entirely inside this package.
