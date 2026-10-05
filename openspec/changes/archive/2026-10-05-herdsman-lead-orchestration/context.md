# Code Context — pi-herdsman fork seams for two planned features

Read-only recon. Root: `/home/saurabhj/Projects/dev/custom/pi-extensions-herdsman/pi-herdsman`.
Fork of `boadij/pi-herdsman` v0.18.0 (`156b1c66`), imported into the
`pi-extensions` monorepo; per the monorepo README "no fork delta yet".

> **Output-path note for the parent:** the task text named
> `openspec/changes/herdsman-lead-orchestration/context.md`; the run-level
> override made this file authoritative instead. The
> `openspec/changes/herdsman-lead-orchestration/` directory does **not** exist yet
> (`openspec/changes/` currently holds only `declared-background-task-lifecycle/`).
> Copy this file there if that is where it belongs.

All line numbers are for the fork as read in this session. Every claim below is
either **read** (I saw the code) or **inference** (labelled inline).

## File map (the only files that matter for both features)

| File | Lines | Role |
| --- | --- | --- |
| `extension/index.ts` | 15 554 | Everything: tools, controller runtime, child runtime, health scanner, result path, `/agents` menu |
| `extension/core.ts` | 419 | Pure helpers: `agentControlState`, `taskAcceptanceAllowed`, `steerAcceptanceAllowed`, `chooseLabel`, `spawnPlacement*` |
| `extension/mailbox.ts` | 847 | Durable V4 mailbox: `ManagedAgentState`, `RequestRecord`, `AskRecord`, `ResultRecord`, read/write/claim/remove |
| `extension/config.ts` | 164 | Flat user-wide config: parse/validate/atomic update |
| `extension/presentation.ts` | 3 324 | Renderers, status tree, widget, `AgentLifecycleState` |
| `extension/herdr.ts` | 2 490 | Herdr CLI/API: `closeHerdrPane`, snapshots, aliases |
| `extension/supervision.ts` | 2 462 | Manager/Chief/peer coordination — **not** on either feature's path (inference from grep of call sites) |
| `extension/storage.ts` | 38 | `herdsmanDataRoot`, `herdsmanConfigPath`, `result:` refs |
| `extension/lock.ts` | 287 | `claimProcessLock`, assignment/delegation/session-activation locks |

---

# Feature A — Lead soft deadline

Goal restated: an elapsed-time **advisory** timer per delegated assignment, armed
on accepted `agent_delegate` / `agent_continue`, that wakes the idle direct owner
once per armed window with `continue / agent_steer / agent_interrupt /
agent_close / extend`; `extend` re-arms; never aborts.

## A1. Where the health scan runs — read

| Location | Symbol | What it does |
| --- | --- | --- |
| `index.ts:13520-13567` | `runAgentHealthScanner(ctx, signal)` | Owns `healthGeneration`, the in-flight/rescan coalescing (`requestHealthScan`), the 30 s `setTimeout` reschedule loop, `healthTimer.unref()`, and the Herdr lifecycle watcher that triggers an extra scan. Exposed to the outer scope via `startAgentHealthScanner` (`index.ts:13565`). |
| `index.ts:12982-13518` | `scanAgentHealth(ctx, signal, generation)` | The whole condition ladder. Guards: `signal.aborted \|\| generation !== healthGeneration \|\| !ctx.isIdle()` at entry (`12987`) and re-checked inside the loop (`13019`). |
| `index.ts:13806` | `startAgentHealthScanner(ctx, sessionSignal)` | **Lead / Manager** start site (session-ready handler; skipped for `managed-agent`). |
| `index.ts:14924` | `startAgentHealthScanner?.(ctx, metadataAbortController.signal)` | **Delegating managed agent** start site, inside child init; only when `delegationEnabled`. |
| `index.ts:333-338` | `STALE_AFTER_MS = 10*60_000`, `STALE_SCAN_MS = 30_000`, `STALE_DIAGNOSTIC_TIMEOUT_MS = 2_000`, `STALE_DIAGNOSTIC_LINES = 20`, `ATTENTION_REPEAT_MIN_MS = 60_000`, `ATTENTION_FIRST_REPEAT_MS = STALE_AFTER_MS/2` | All timing constants. `formatAttentionDuration` is at `index.ts:346`. |

**What changes for A:** a soft-deadline check must be added inside
`scanAgentHealth`'s ladder (or as a sibling pass driven by the same
`requestHealthScan` loop so it inherits the 30 s cadence, the generation guard,
and the idle gate). No new timer is needed; a new timer would be a second
delivery path, which docs explicitly forbid (see A9).

## A2. Attention conditions / episodes / reminders / delivery — read

| Location | Symbol | Notes |
| --- | --- | --- |
| `index.ts:9045-9050` | `type AttentionReminder = { episode: string; intervalMs: number; nextAt: number }` and `const attentionReminders = new Map<string, AttentionReminder>()` | **Keyed by `runId`**, one reminder per run. State is process-local, not durable (docs confirm: recovery guide "Reminder state is process-local and advisory, not durable mailbox state"). |
| `index.ts:12839-12845` | `attentionDue(runId, episode, now)` | `reminder?.episode !== episode \|\| now >= reminder.nextAt`. New episode ⇒ immediately due. |
| `index.ts:12846-12854` | `nextAttentionInterval(runId, episode)` | Backoff: same episode ⇒ `max(60_000, intervalMs/2)`; new episode ⇒ `STALE_AFTER_MS/2` = 5 min. |
| `index.ts:12855-12864` | `recordAttention(runId, episode, intervalMs)` | Writes `{episode, intervalMs, nextAt: sentAt+intervalMs}`. |
| `index.ts:12865-12873` | `currentOwnedState(state, ownerSessionId)` | Re-reads `listAgentStates()` and returns the record only if the **same durable identity** and `ownerSessionId` still match. This is the "exact direct owner" revalidation. |
| `index.ts:12874-12888` | `currentAvailableActions(view, agent, ownerSessionId, unresolvedMailboxState)` | Wraps `listedAgentRecord(...).available_tools` and strips the `agent_` prefix ⇒ internal action names `inspect\|transcript\|steer\|interrupt\|reply\|close`. |
| `index.ts:13009-13010` | reminder GC | `for (const runId of attentionReminders.keys()) if (!ownedRuns.has(runId)) attentionReminders.delete(runId)` — reminders are dropped when the run stops being owned. |
| `index.ts:12889-12981` | `publishAgentLoss(ctx, state, availableActions, nextReminderMs, signal)` | The only extracted publisher. Every other condition inlines `pi.sendMessage({customType: ...}, {triggerTurn: true})`. |
| `index.ts:12662-12692` (`SUPERVISION_CONTEXT_TYPE`, etc. region) / `index.ts:6768-6788` | `pi.registerMessageRenderer` for `pi-herdsman-agent-stale`, `pi-herdsman-agent-lost`, `pi-herdsman-agent-attention`, `pi-herdsman-agent-result`, `pi-herdsman-agent-ask`, `pi-herdsman-stop-summary` | Custom message types are registered here. |

**The condition ladder inside `scanAgentHealth`** (each branch is
`episode = "<name>:<key>"`; all use `if (published || !attentionDue(...)) continue;`
then a `currentOwnedState` revalidation then `recordAttention`):

| Lines | Episode | Custom type | Interval |
| --- | --- | --- | --- |
| `13028-13071` | `result-error:${failedAt}:${requestId}` | `pi-herdsman-agent-attention`, `details.reason: "result_error"` | backoff |
| `13073-13083` | `"lost"` | via `publishAgentLoss` ⇒ `pi-herdsman-agent-lost` | backoff |
| `13085-13130` | `"unknown"` | `pi-herdsman-agent-attention`, `reason: "unknown"` | `Infinity` (one-shot) |
| `13132-13200` | `ask:${askId}` | `pi-herdsman-agent-ask` | backoff; first arm at `now + ATTENTION_FIRST_REPEAT_MS` |
| `13203-13247` | `blocked:${activeRequestId}` | `pi-herdsman-agent-attention`, `reason: "blocked"` | backoff |
| `13249-13305` | `handoff:${requestId}` (unacknowledged request older than `STALE_AFTER_MS`) | `pi-herdsman-agent-attention`, `reason: "handoff"` | backoff |
| `13307-13500` | `stale:${activeRequestId}:${lastActivityAt}` | **`pi-herdsman-agent-stale`** (dedicated renderer) | fixed `ATTENTION_FIRST_REPEAT_MS` |

Two constraints that directly shape a soft-deadline branch (**read**):

1. `let published = false;` at `index.ts:13011` and every branch's
   `if (published || !attentionDue(...)) continue;` mean **at most one attention
   event is published per 30 s scan across all owned agents** (asserted by
   `recovery.test.ts:5088 "health reconciliation publishes at most one attention
   per scan"`).
2. All branches share **one `attentionReminders` slot per `runId`**. A
   soft-deadline episode written via `recordAttention(runId, "soft:…", …)` would
   *overwrite* a live stale reminder for the same run, and vice versa. A separate
   map (e.g. `softDeadlines: Map<runId, …>`) or an episode-prefixed composite key
   is the safe shape (**inference**).

## A3. Durable anchor for "assignment accepted at" — read

The soft window must survive controller restart, so it needs a durable timestamp,
not `runtime.startedAt` (in-memory only).

| Location | Field | Written by | Semantics |
| --- | --- | --- | --- |
| `mailbox.ts:47-67` | `ManagedAgentState.activeRequestId`, `completedRequestId`, `lastActivityAt`, `pendingAskId`, `resultError`, `lastAck{requestId,accepted,code,message,acknowledgedAt}`, `updatedAt` | controller + child | The durable state record. |
| `mailbox.ts:68-80` | `RequestRecord { createdAt, requestId, runId, ownerSessionId, workspaceId, agentLabel, paneId, kind, text }` | controller (`writeRequest`) | `createdAt` is the **submission** time. |
| `index.ts:2621-2800` | `submit(pi, runtime, kind, text, ctx, signal, askId, createdAt, requestId, operation)` | controller | Writes the request (`writeRequest`, `2775`), waits up to 5 s for `state.lastAck?.requestId === requestId` (`2699-2706`), and on a `"task"` ack sets `runtime.activeRequestId`, `runtime.task`, `runtime.startedAt = Date.now()` (`2741-2750`). Deletes the request file in the `finally` (`2753-2776`). |
| `index.ts:15197-15220` | child `"input"` handler, `request.kind === "task"` branch | child | `mutateAgentState` writes `activeRequestId: id, completedRequestId: undefined, lastActivityAt: Date.now(), lastAck{accepted:true, acknowledgedAt}`. **This is the first durable "accepted" record.** |
| `index.ts:15310-15374` | `finalizeStateTransition` | child | Sets `completedRequestId: requestId`, clears `activeRequestId` + `lastActivityAt`. |
| `index.ts:5772-5781` (assignment object) | `assignment = { createdAt: Date.now(), requestId, runId, ownerSessionId, workspaceId }` | controller, before launch | `createdAt` is durable only as long as the request file exists — it is deleted after ack (`2753-2776`) and the mailbox is removed on cleanup. |
| `index.ts:15209-15215` + `presentation.ts` `parsePresentationTokens` / `index.ts:10864` | `reportMetadata(..., activity: { requestId, task, startedAt })` on task acceptance | child → herdr pane tokens | `startedAt` is durably re-derivable from herdr agent tokens (`index.ts:12754-12770`, `10849`, `10864`). |

**Recommendation (inference, not read):** the only durable, restart-surviving,
per-assignment anchor that already exists is `state.lastAck.acknowledgedAt`
(child-side acceptance) plus `state.updatedAt`. If the window must be exact to
the millisecond and survive a *child* restart, add a field to
`ManagedAgentState` (e.g. `softDeadlineArmedAt` / `softDeadlineNotifiedAt`).
Note that adding a field to `ManagedAgentState` requires touching `mailbox.ts`
`validate()` (`mailbox.ts:226-537`) and the `LIMITS.state` size budget.

Also relevant: `index.ts:12694-12824` `recoverControllerRuntimes(ctx, signal)` —
on a lead/manager restart it rebuilds a `Runtime` from each direct mailbox state
and **already registers a live agent with no `activeRequestId` and no
`completedRequestId` into `runtimes`** (`12796-12816`: it `runtimes.set(...)`
then `continue`s). That is the natural place to re-arm a restarted soft window.

## A4. Adding a new attention reason — read

1. **Message type.** Register a new `pi.registerMessageRenderer` next to
   `index.ts:6768-6788`. Reusing `pi-herdsman-agent-attention` avoids that but
   requires a new `details.reason` string and a renderer branch in
   `presentation.ts:3036-3095` (`renderAgentAttentionMessage`; it lowercases and
   de-underscores `reason` and renders `details.summary`, `details.nextAction`,
   `details.availableActions`, `details.nextReminderMs`, `details.requestId`,
   `details.piSessionId`, `details.paneId` — all optional and generic).
2. **Episode + branch.** Append a branch to `scanAgentHealth`
   (`index.ts:12982-13518`) in the ladder, before the stale branch, obeying the
   `published` gate and using `currentOwnedState` + `recordAttention`.
3. **Advisory docs.** `docs/concepts/lifecycle.md:134-142` enumerates the health
   conditions explicitly ("The health conditions are deliberately narrow: …"),
   and `docs/guides/recovery.md:33-39` enumerates the generic attention reasons
   ("The generic attention reasons are `result_error`, live runtime `blocked`,
   old unacknowledged `handoff`, and physical `unknown`."). `docs/reference/agent-states.md:80-90`
   ("Inactivity fields") documents thresholds/cadence. All three need edits.
4. **Guidance strings.** `AGENT_UNRESOLVED_GUIDANCE` / `AGENT_HANDOFF_GUIDANCE`
   text at `index.ts:382-385` already tells the model how to treat repeated
   reminders; a soft deadline that is *not* evidence of a hang needs its own
   sentence there.
5. **Tests that enumerate reasons** — see A8.

## A5. Registering a new tool or a new field — read

- Nine `agent_*` tools are one object (`agentTool`, `index.ts:13949-14112`) plus
  eight spread-and-override `pi.registerTool({...agentTool, name: "agent_x", …})`
  blocks: `agent_delegate:14117`, `agent_continue:14145`, `agent_steer:14173`,
  `agent_interrupt:14201`, `agent_reply:14229`, `agent_close:14257`,
  `agent_inspect:14279`, `agent_transcript:14301`. `agent_list` itself is
  registered at `14109`.
- Note the shape: `agentTool` is `agent_list`-flavoured; each alias overrides
  `name`, `label`, `description`, `parameters`, `promptSnippet: undefined`,
  `promptGuidelines: undefined`, `execute` (which calls
  `agentTool.execute(id, { action: "<x>", ...params }, …)`), and both renderers.
- Parameters: `emptyParameters` (`6864`), `agentListParameters` (`6865`),
  `agentDelegateParameters` (`6866-6883`), `agentContinueParameters` (`6893-6905`),
  `agentMessageParameters` (`6907-6913`), `agentTargetParameters` (`6915-6917`).
  **Every one ends `{ additionalProperties: false }`** and the fork has a test
  asserting strictness: `agent-cutover.test.ts:221 "each Agent operation has its
  own strict schema without projection"`.
- Dispatch: `actionUnsafe` (`index.ts:5567`) fans out on `p.action`
  (`"list" | "delegate" | "continue" | "steer" | "interrupt" | "reply" | "close" |
  "inspect" | "transcript"` — the `Params` union is around `index.ts:540-560`).
  A new tool means a new `action` value, a new branch in `actionUnsafe` and in
  `formatToolModelResult` (`presentation.ts:1637`).
- **`available_tools` computation:** `listedAgentRecord` (`index.ts:3149-3212`)
  builds `const actions: string[] = []` and returns
  `available_tools: actions.map(a => \`agent_${a}\`)`. Only
  `transcript|close|inspect|steer|interrupt|reply` can ever appear
  (`3163-3211`). `agent_delegate`/`agent_continue` are structurally absent —
  they are not in `actions` at all. `currentAvailableActions` (`12874`) consumes
  this for attention messages, so a soft-deadline message can reuse it verbatim
  and will only ever advertise currently-eligible controls.
- `available_tools` is asserted to be the authority in
  `docs/reference/agent-states.md:22-31`.

## A6. Config key pattern — read

`extension/config.ts`:

- `HerdsmanConfig` type `16-21`; `DEFAULT_CONFIG` `23-28`; `CONFIG_KEYS` set
  `39-44` (unknown keys are a hard error, `59-60`).
- `parseRawConfig` `46-88`: per-key validation; byte limits share the loop at
  `71-79` with `validByteLimit` (`30-37`, min 1024, max 1 MiB).
- `updateConfig(key, value|undefined)` `112-164`: takes the shared process lock
  (`<config>.lock`), re-reads raw, validates per key (`125-136`), deletes on
  `undefined`, writes atomically (`writeConfigAtomically` `94-110`), and unlinks
  the file when the last key is removed.
- Read call sites for a new key would follow `readConfig().contextRetirement` at
  `index.ts:1742, 3620, 11673, 11688, 14768, 14783` and
  `readConfig().spawnPlacement` at `index.ts:912`/`1050`.
- Menu surface: `openAgentsMenu` (`index.ts:11645-11700`) has a
  `context-retirement` toggle that flips a boolean and calls `updateConfig`
  (`11687-11691`) — the closest template for a `softTimeoutMs` / retained-workers
  toggle. `openMessageLimitsMenu` (`11582-11642`) is the template for a numeric
  value with presets + custom input + reset, and shows the `validByteLimit`
  validation loop.
- Docs: `docs/reference/configuration.md` — schema block (lines 20-27), defaults
  table (29-36), and prose per key; plus the `/agents` menu enumeration at
  `docs/reference/commands.md:33-34`.
- Tests: `extension/config.test.ts` (7 tests, listed in A8).

**Suggested `softTimeoutMs` validation (inference):** integer, `>= 0`,
`<= 2_147_483_647`, default `600_000`, `0` disables — this mirrors
`pi-subagents` exactly (see A7). A `0`-disables integer does **not** fit
`validByteLimit`; a new `validSoftTimeout` helper is needed, and `updateConfig`'s
`else`-branch validation (`129-135`) must learn the new exception the same way it
special-cases `spawnPlacement` and `contextRetirement`.

## A7. Existing reference implementation — read (different package)

`pi-subagents` in the same monorepo already ships the exact semantics wanted. Its
README lists it as a fork delta ("the advisory soft deadline"). Useful anchors:

| Location | What |
| --- | --- |
| `pi-subagents/src/runs/foreground/subagent-executor.ts:2994-3003` | `resolveSoftTimeoutMs(raw, configDefaultMs)`: param > config > `600_000`; invalid param ⇒ `0` (disabled). |
| `pi-subagents/src/extension/config.ts:177-183` | Validation: integer `0..2_147_483_647`, message "0 disables the advisory soft-deadline wake." |
| `pi-subagents/src/extension/schemas.ts:240` | Tool param: "Advisory per-run soft deadline in ms; default 600000, 0 disables. Expiry wakes with choices instead of aborting." |
| `pi-subagents/src/runs/background/subagent-runner.ts:1910, 2052, 2747-2752` | `softTimeoutMs` resolution, `softDeadlineAt = overallStartTime + softTimeoutMs`, and `emitSoftDeadlineNotice()` — fires once per armed window, does not stop the run. |
| `pi-subagents/src/runs/background/control-channel.ts:229-233, 411-412` | `extend` request carrying `softTimeoutMs`, validated and consumed exactly once. |
| `pi-subagents/src/runs/shared/subagent-control.ts:251-260` | The model-facing wake text: "Soft deadline (advisory only; the child was not aborted)… extend with … softTimeoutMs: 600000 … The hard timeout/deadline is unchanged." |
| `pi-subagents/test/unit/soft-deadline.test.ts:41, 73, 88, 118, 136, 156, 170` | Directly portable test list (one notice per window; finished run emits nothing; `0` disables; extend consumed once; notice names the four choices; precedence). |

`pi-bash-processes` in the same repo also carries "soft deadlines" as a fork
delta (monorepo README), i.e. the house pattern for advisory deadlines is
established twice already.

## A8. Feature A tests

Directly relevant (`extension/`, run with `bun test` from the package dir):

- `recovery.test.ts:4058` "stale scanner starts immediately, reschedules, deduplicates, and retries failed publication" — the scanner-loop contract any new branch must satisfy.
- `recovery.test.ts:4141` / `:4186` "stale scanner skips completion or identity changes before publication" / "…every replaced identity field before publication" — the revalidation contract.
- `recovery.test.ts:5088` "health reconciliation publishes at most one attention per scan" — the `published` gate; a soft branch must respect it.
- `recovery.test.ts:4762` "settling alone does not trigger generic health attention".
- `recovery.test.ts:4796` "health attention stays idle-only and does not queue resolved stale work".
- `recovery.test.ts:4890` "physical unknown attention is one-shot and fail-closed" — the one-shot episode pattern a soft window would mirror per window.
- `recovery.test.ts:5016` "old unacknowledged requests get attention without being resubmitted".
- `recovery.test.ts:4728` "health scanner alerts true runtime blocking".
- `recovery.test.ts:5304`, `5369`, `5412`, `5473` — `available_tools` in attention messages.
- `recovery.test.ts:4267` "delegation parent notifies only its direct stale child" — direct-owner-only delivery.
- `recovery.test.ts:6187`, `6283` — scanner in-flight/generation/shutdown.
- `config.test.ts:86, 113, 142` — config overlay/validation/update round-trip.
- `agent-cutover.test.ts:221` — strict per-operation schema assertion.
- `presentation.test.ts` (13 attention-related matches) — `renderAgentStaleMessage` / `renderAgentAttentionMessage` snapshots.
- `support.ts` — the test harness: `fakeContext`, `fakeAgentContext`, `configReadHook`, `agentStateReadHook`, `watchedResultPaths`, `failNextMailboxWrite`, fixture session IDs (`:528-560`). New features will be tested through this.

## A9. Invariants at risk (Feature A) — exact quotes

1. `docs/concepts/lifecycle.md:134-142` —
   > "The health conditions are deliberately narrow: stale working and proven lost retain their dedicated messages; a delivered owner question may be reminded; `result_error`, a live runtime `blocked` condition, and an old retained unacknowledged handoff use generic attention. A retained request is not proof of non-delivery and must not be duplicated. Physical `unknown` remains fail-closed and receives at most one attention event for an episode. `settling` alone is not a timeout or generic attention condition."

   A soft deadline is an **elapsed-time** condition, i.e. exactly the class this
   paragraph excludes. The docs must be rewritten, not just extended.

2. `docs/guides/recovery.md:36-39` —
   > "Reminder state is process-local and advisory, not durable mailbox state. Health attention is direct-owner-only; do not poll, add a second delivery path, or keep a turn alive solely to wait."

   → the soft timer must ride the existing scanner, not a new `setTimeout`.

3. `docs/concepts/lifecycle.md:110-114` —
   > "Routine progress checking remains prohibited. A stale health-attention event is different: it is an unsolicited diagnostic boundary."

   A periodic "your agent has been running 10 minutes" wake is close to a
   progress-polling boundary; the wording needs to distinguish *advisory choice
   point* from *diagnostic boundary*.

4. `docs/concepts/lifecycle.md:126-131` — reminder cadence
   `5m → 2m30s → 1m15s → 1m` and "Stale first becomes eligible after ten
   minutes…". The one-shot-per-armed-window semantics of the soft deadline do
   **not** match the decaying backoff, so the docs must state both.

5. `docs/reference/agent-states.md:80-90` — "Inactivity fields" section ties
   `stale`/`inactive_ms`/`last_activity_at` to a single ten-minute threshold.

## A10. Open risks / open questions (Feature A)

- **Interval collision.** All A-timings assume the 30 s scan; a 10-minute soft
  window will land up to 30 s late. Acceptable? (**inference:** yes, matches
  stale.)
- **One-slot reminder map.** `attentionReminders` is per-`runId`, not
  per-`(runId, episode)`. Sharing it between stale and soft will cause one to
  cancel the other's backoff. Decide: separate map, or composite key.
- **One-publish-per-scan.** `published` at `index.ts:13011` means a soft wake can
  be starved by an unrelated stale/ask/handoff event indefinitely (each scan
  publishes one). Should the soft branch bypass the gate (it is advisory, not a
  failure) or respect it?
- **`extend` needs a durable re-arm** if the controller restarts mid-window;
  otherwise the window silently restarts. Requires a new
  `ManagedAgentState` field + `mailbox.ts` validation + `LIMITS.state` check.
- **Which clock.** `state.lastActivityAt` is *progress* time, not assignment
  time; `lastAck.acknowledgedAt` is acceptance time. The stated goal ("elapsed
  time per delegated assignment") = acceptance time, so `lastAck.acknowledgedAt`
  / request `createdAt` / pane `startedAt` — pick one and document it.
- **`continue` as a choice** already has a meaning in this codebase
  (`agent_continue` = new generation from a session). If the soft wake offers a
  choice literally named "continue", it will read as "make a new assignment".
  Naming decision needed.
- **`agent_close` as a choice** conflicts with the close preflight: a live agent
  with an unread durable result is *not* closeable
  (`recovery.test.ts:5369`, `5473`). The offered choices must be derived from
  `currentAvailableActions`, not hardcoded.

---

# Feature B — Retained workers

Goal restated: a config setting so that a managed agent's pane/Pi process stays
live and idle after delivering its result, bound to its agent label; the next
`agent_continue` for that session/label injects into the SAME live process rather
than spawning a new generation; released by `agent_close` or a new clear command.

## B1. The full post-result path — read

| Location | Symbol | What it does |
| --- | --- | --- |
| `index.ts:3919-3941` | `deliverResult` | In-flight dedupe by `${mailboxPath}:${requestId}`, then `deliverResultUnsafe`; schedules a retry on throw. |
| `index.ts:3540-3720` | `deliverResultUnsafe` | Identity revalidation (`3549-3562`), builds the `pi-herdsman-agent-result` custom message (`3559-3690`, `deliverAs: "steer"`, `triggerTurn: true`), sets `resultDeliveryEvidence`, stops the result/ask watchers, then **clears** `runtime.completedRequestId = result.requestId; runtime.activeRequestId = undefined; runtime.task = undefined; runtime.startedAt = undefined; runtime.contextPercent = undefined` (`3698-3706`), then `finalizeDeliveredResult` or `scheduleResultCleanupRetry`. |
| `index.ts:3720-3742` | `resultCleanupReady(runtime, requestId, entries)` | Gate: delivery must be in the branch **and** the durable state must satisfy `!activeRequestId && completedRequestId === requestId` + full identity match. |
| `index.ts:3744-3751` | `newerMailboxWorkExists(mailbox, state, requestId)` | `durableResultRequestIds(mailbox, state).some(id => id !== requestId)`; `durableResultRequestIds` (`2781-2797`) reads `{completedRequestId, activeRequestId, handoff?.requestId}`. |
| `index.ts:3888-3917` | `finalizeDeliveredResult` | `resultCleanupReady` → `cleanupAfterDeliveredResult` → delete `resultDeliveryEvidence` → `requestStatusRefresh`. |
| `index.ts:3823-3859` | `cleanupAfterDeliveredResult(pi, runtime, result, ctx, signal)` | `managedAgent = process.env.PI_HERDSMAN_MAILBOX !== undefined`; takes the delegation lock when the controller is itself managed; `waitForState` up to 5 s for a settled state; then `if (!managedAgent) closeManagedAgentCascade(..., {deliveredRootResultId})` `else finalizeDeliveredRoot(...)` (`3851-3854`); `requestHerdRunFinishCheck?.(ctx)` (`3855`); records `runtime.cleanupError` on failure. |
| `index.ts:3753-3821` | `finalizeDeliveredRoot(pi, ctx, state, requestId, signal, assignmentLockHeld)` | **The teardown primitive.** Under the assignment lock: revalidate identity, reject if `activeRequestId`, `completedRequestId !== requestId`, or `newerMailboxWorkExists`; `managedAgentPresence`; **if live → `closeLiveManagedExecution(..., allowPostCompletionTransition = true)`** (`3786-3799`); re-read + revalidate; `removeResult(mailbox, requestId)` (`3805`); re-read; **`removeAgentMailbox(mailbox)`** (`3813`); `invalidateCachedRuntime(state.agentLabel)` (`3815`). |
| `index.ts:5094-5206` | `closeManagedAgentCascade(pi, ctx, expected, signal, options, stopReport)` | Controller-owned variant: takes the delegation lock + parent assignment lock, `managedAgentCascadePlan`, `assertManagedAgentCascadeSafe`, closes every descendant child-first (`closeManagedSnapshot`), then either `finalizeDeliveredRoot(..., true)` when `options.deliveredRootResultId` is set, or closes the parent snapshot. |
| `index.ts:4604-4652` | `closeLiveManagedExecution(pi, ctx, agent, state, signal, allowPostCompletionTransition)` | Resolves/caches the `Runtime`, `validateIdentity(..., {requireLiveSession:true})`, `validateIntegration`, then **`closeHerdrPane(...)`** (`herdr.ts:2165`) with `allowPostCompletionTransition` threading through to `proveExactRunningAgent`. |
| `index.ts:4654-4722` | `closeManagedAgent` | The manual `agent_close` path (see B3). |
| `index.ts:4724-...` | `closeManagedSnapshot` | Per-snapshot close used by the cascade. |
| `index.ts:3943-4010` | `settlePersistedResults(pi, ctx, signal)` | Called from the controller's `agent_settled` (`12827-12838`) and on recovery; re-drives `deliverResult` for any runtime with `runtime.completedRequestId`. |
| `index.ts:12982`-adjacent recovery | `recoverControllerRuntimes` (`12694-12824`) | On restart: rebuild `Runtime` from mailbox; if `activeRequestId` → `watchResult`/`watchAsk`; else if `completedRequestId` → `deliverResult` if a result file exists, else `cleanupAfterDeliveredResult` (after asserting the durable delivery entry exists). |

## B2. What state is removed on delivery — read

`finalizeDeliveredRoot` removes exactly:

1. the durable result file — `removeResult(mailbox, requestId)` (`3805`);
2. the entire mailbox directory — `removeAgentMailbox(mailbox)` (`3813`) ⇒ deletes every `request-*.json`, `result-*.json`, `ask.json`, then `state.json`, then `rmdir` (best effort) — `mailbox.ts:613-640`;
3. the cached in-memory runtime — `invalidateCachedRuntime(state.agentLabel)` (`3815`).

And before that, `closeLiveManagedExecution` closes the Herdr pane
(`closeHerdrPane`), i.e. kills the Pi process and removes the label from the live
herdr roster.

`removeAgentMailbox` **deliberately skips `.starting`** (`mailbox.ts:623`) and
treats `rmdir` failure as non-fatal ("State removal is the logical cleanup commit
point; pruning is best effort", `mailbox.ts:637-639`).

**What Feature B must suppress:** the `closeLiveManagedExecution` call, the
`removeResult`, and the `removeAgentMailbox` — i.e. `finalizeDeliveredRoot`'s
three side effects. Everything else (identity revalidation, `newerMailboxWorkExists`,
`requestHerdRunFinishCheck`) still applies. Under a retained policy the function
would instead need to: clear `completedRequestId` (+ `lastActivityAt`) durably,
remove the result file (or keep it and handle `hasDurableResult` on close — see
B3), keep `state.json`, keep the pane, and keep the `runtime` cache entry.

## B3. "One generation = one assignment" invariants and where they are enforced — read

| # | Enforcement | Location | Behaviour |
| --- | --- | --- | --- |
| 1 | `agent_continue` rejects a session with an **unresolved managed representation** | `index.ts:5862-5910` | `states = listAgentStates().filter(state.piSessionId === resumed.id \|\| samePersistedSessionPath(state.piSessionFile, resumed.path))` (`5865-5870`) ⇒ `representations` set. `> 1` ⇒ `target_ambiguous` "The assignment session matched multiple managed agents" (`5895-5899`). `=== 1` ⇒ **`agent_busy`** "The exact Pi session is already represented by active managed work" (`5900-5908`), `nextAction` "Let that assignment finish, or close its exact agent if abandoning it, then retry." |
| 2 | Label collision against **live** labels | `index.ts:5857-5861` (`labels` = `listedAgents(...)` labels) then `index.ts:5916-5921` | `if (requestedLabel && labels.has(requestedLabel)) fail("agent_label_exists", …)`. On `continue`, `requestedLabel = resumed.label` (`5817-5818`), so a retained live worker means **`agent_continue` fails with `agent_label_exists` before it even reaches the pane**. |
| 3 | Mailbox occupancy | `index.ts:5966-6066` loop (`claimAgentMailbox` / `MailboxClaimOccupiedError`, `guardMailboxOccupancy`) | `guardMailboxOccupancy` (`4343-4379`): any existing `state.json`, or an unacknowledged request, occupies the label; explicit labels fail with `agent_label_exists`, auto labels are bumped via `chooseLabel`. |
| 4 | Session activation lock | `index.ts:765` `claimSessionActivationLock`, used at `5863` | One concurrent continuation per session path. |
| 5 | Child-side task acceptance | `index.ts:15124-15145` | Rejects a `task` request when `state.completedRequestId !== undefined` (`"Agent assignment is already complete"`) or when `taskAcceptanceAllowed(ctx.isIdle(), state.activeRequestId, pendingResult \|\| pendingStateTransition)` is false (`"Agent already has an active assignment"`). Both ack `"busy"`. |
| 6 | `core.ts:394-399` `taskAcceptanceAllowed` | pure helper | `isIdle && !activeRequestId && !completionPending`. |
| 7 | `completedRequestId` set | `index.ts:15310-15374` `finalizeStateTransition`; cleared only on new task acceptance (`15201`) or on `result_error` recovery (`15452-15462`). |
| 8 | `newerMailboxWorkExists` | `index.ts:3744-3751` | Blocks cleanup when any non-matching durable request id exists. |
| 9 | `available_tools` never lists `delegate`/`continue` | `index.ts:3149-3212` + `docs/reference/agent-states.md:27` | Structural — `actions` only ever gets `transcript\|close\|inspect\|steer\|interrupt\|reply`. |
| 10 | `hasDurableResult` blocks close | `index.ts:2795-2824`; used at `4674`/`4692` (`closeManagedAgent`) | "Managed agent has a durable result; close result delivery first". |
| 11 | Herd-run completion gate | `index.ts:9011-9035` `maybeFinishHerdRun` | Returns early while `listAgentStates().some(({state}) => state.ownerSessionId === sessionId)`. **A retained mailbox state keeps the herd run open forever.** |

**Read conclusion for the core design question:** yes, the child pump *mechanically*
can accept a second request in the same process — `readUnacknowledgedRequest` is
polled every 250 ms (`index.ts:14927`) and the `"input"` handler (`14987`) is the
only gate. The gate is row 5: `state.completedRequestId !== undefined`. Note also
`index.ts:15012` `if (state.lastAck?.requestId === id) return { action: "handled" };`
and `pumpRequest` (`14601-14620`) calling
`pi.sendUserMessage(controlMarker(request.requestId), {deliverAs: "steer"})`. So
retention = (a) don't close the pane, (b) don't remove the mailbox, (c) clear
`completedRequestId` durably after delivery, (d) relax rows 1, 2 and 11.

## B4. How a managed agent receives an assignment (child pump) — read

1. Controller writes `RequestRecord` to `request-<uuid>.json` — `submit`
   (`index.ts:2621-2800`) via `writeRequest` (`mailbox.ts:653`).
2. Child reads `PI_HERDSMAN_MAILBOX` (`index.ts:14424`), started on
   `agent_start`/session-ready at `14926-14928`:
   `pumpRequest(ctx); requestPumpTimer = setInterval(() => pumpRequest(ctx), 250); requestPumpTimer.unref?.();`
   The pump only starts when `delegationEnabled` (`14921`).
3. `pumpRequest` (`14601-14620`) → `readUnacknowledgedRequest(mailbox, state)`
   (`mailbox.ts:671-708`) → `pi.sendUserMessage(controlMarker(requestId), {deliverAs: "steer"})`.
4. Pi delivers the marker as user input; `pi.on("input", …)` (`14987`) parses it
   with `parseControlMarker` (`mailbox.ts:804`), reads the request, runs the
   identity/kind/precondition ladder, and either transforms the text or
   `acknowledgeAndDiscard`s a rejection.
5. Task acceptance (`15197-15220`) writes `activeRequestId`, `lastAck{accepted}`,
   `lastActivityAt`, clears `completedRequestId`, and calls `reportMetadata`
   with `activity: {requestId, task, startedAt}`.
6. `submit` waits ≤5 s for `lastAck.requestId === requestId` and maps
   `code` → `ErrorCategory` (`2725-2736`: `busy`/`idle`→`agent_busy`,
   `invalid`→`invalid_request`, `identity`→`target_not_found`, else
   `internal_failure`).
7. `pumpRequest` stops when `readUnacknowledgedRequest` returns `undefined`
   (`14605-14610`), which is exactly what `removeRequest` after ack achieves.
8. `resetRequestPump` (`14623-14627`) is only called from `resetLeafStatus`
   (`14806`) and `session_shutdown` (`15545`) — **not** after settlement, so the
   pump is already live-and-idle after a result. (**read**)

**Risk flagged by the schema (read):** `readUnacknowledgedRequest` **throws**
`"Multiple unacknowledged requests found"` if two request files exist
(`mailbox.ts:701-703`), and `unacknowledgedRequestExists` maps any throw to
`true`. `submit` removes the previous request file first (`2669-2672`, only when
`current.lastAck` is set) — so a retained worker's second `agent_continue` must go
through `submit` (which it would) and must not leave the old request file behind.
`durableResultRequestIds` (`2781-2797`) calls `readUnacknowledgedRequest` without a
try/catch, so this throw becomes a cleanup error path.

## B5. `agent_settled` on the agent side and result publication — read

- `index.ts:15522-15538` `pi.on("agent_settled", …)` (inside
  `registerManagedAgentRuntime`, the child branch):
  1. if `pendingInterruptReplacement`, publish the replacement prompt and return
     (interrupt semantics: same assignment continues);
  2. `settleCurrentAgent(ctx)`;
  3. if `delegationEnabled`, `await settlePersistedResults(...)` (the child also
     delivers *its* children's results).
- `index.ts:15376-15521` `settleCurrentAgent`:
  - early-returns if no `activeRequestId`, or `pendingAskId`, or `pendingResult`,
    or `pendingStateTransition`, or (if delegation-enabled)
    `hasUndeliveredDirectChildWork(...)`;
  - builds `ResultRecord` with `status: latest ? "completed" : "failed"` and
    `contextUsage: ctx.getContextUsage()` (`15385-15408`);
  - `flush()` writes the result and calls `finalizeStateTransition(ctx, true)`
    (`15438-15440`); retries every 250 ms up to `RESULT_WRITE_MAX_ATTEMPTS = 8`
    (`index.ts:339`), then records `ResultPersistenceError` with
    `nextAction: "…use agent_close before starting another assignment."` (`15485-15499`);
  - oversized results are downgraded to `status: "failed"` with
    `error.code: "result_too_large"`.
- `latest` is populated in `pi.on("message_end", …)` (`15224-15234`) from the last
  assistant message, and blanked by `touchActivity`/steer/interrupt handling.

**Retention seam:** `settleCurrentAgent` → `finalizeStateTransition` is where a
retained policy would write `completedRequestId` (or a new
`retained: true` / `lastCompletedRequestId` field) and **not** blank
`lastActivityAt`. The child never learns whether the controller kept or closed
the pane, so the retain decision must be resolved on the controller side
(config read at `cleanupAfterDeliveredResult`) and expressed in the mailbox
state the child reads (**inference**).

## B6. State projection — read

`index.ts:2900-2995` (inside `managedAgentSnapshots`) computes the public state:

- `lifecycleState = normalizeHerdrLifecycleState(agent)` (or `"unknown"` if no
  live agent) — `2900-2902`;
- `completionPending = pendingResultExists(path, state.completedRequestId)` —
  `2903-2906`;
- `handoffPending = unacknowledgedRequestExists(path, state)` — `2907`;
- `liveState = agentControlState(lifecycleState, activeRequestId, completionPending, handoffPending, !!pendingAskId, !!resultError)` — `2909-2917`;
- `waitingForChildren` → `"blocked"` (`2919-2931`);
- `projectedState = completionPending || resultError ? "settling" : presence.kind === "lost" ? "lost" : presence.kind === "unknown" ? "unknown" : existingLiveProjection` — `2932-2939`;
- `steerable = presence.kind === "live" && !pendingAskId && (projectedState === "working" || waitingForChildren)` — `2940-2945`;
- `listed` object with `state`, `stale`, `inactive_ms`, `last_activity_at`, `active_request_id`, `result_error` — `2946-2981`.

`core.ts:370-392` `agentControlState`:

```
if (completionPending || handoffPending || recoveryPending) return "settling";
if (activeRequestId) { working→"working"; waitingForOwner→"blocked"/"unknown";
                        blocked→"blocked"; idle|done→"settling"; else "unknown" }
if (lifecycle === "idle" || lifecycle === "done") return "settling";   // ← no active request
return "unknown";
```

**What a live-idle retained agent would project as (read + inference):** with
`completedRequestId` cleared and no `activeRequestId`, `completionPending=false`,
`handoffPending=false`, `lifecycle="idle"` ⇒ the final `return "settling"`
(`core.ts:390`). So a retained idle worker projects **`settling`** — which the
docs then call out as not-closeable, not-timeout-worthy, and "Do not assign
another task to a settling agent"
(`docs/reference/agent-states.md:54-59`). This is the single biggest semantic
collision for Feature B: either a new public lifecycle state is introduced, or
`agentControlState` gains a `retained` input that yields a distinct projection
(**inference** — `core.ts` has pure unit tests in `core.test.ts` to update).

Also note `stale`/`inactive_ms` are only attached when
`listedStateIsWorking(presence, existingLiveProjection) && activeRequestId && …`
(`index.ts:2962-2972`), so a retained idle worker can never be `stale`.

## B7. `agent_list` / presentation / widget implications — read

- `listedAgentRecord` (`index.ts:3149-3212`) — with `presence.kind === "live" &&
  direct && !listed.recovery_only` the record advertises
  `inspect`, `transcript`, `steer` (only if `listed.steerable`), `interrupt`
  (only if `listed.state === "working"`), `reply` (pending ask), `close`. A
  retained idle worker would advertise `inspect`, `transcript`, `close` (+
  `agent_close` preflight is allowed only when
  `assertManagedAgentCascadeSafe` succeeds — `3163-3180`). No new action is
  strictly required, but a `clear` action would need a new entry here.
- `buildStatusRows`/`buildStatusTree` (`presentation.ts:197-350`) and
  `layoutStatusRows` (`:468`) render `StatusAgent.state`; the glyph table is
  documented at `docs/reference/status-widget.md:20-28` ("`○` means idle or done
  … `◌` means settling or starting"). A new state needs a new glyph or an
  explicit mapping decision.
- `createStatusWidget` (`presentation.ts:3318`) consumes `StatusSnapshot`
  (`presentation.ts:56-65`) — `stale`, `unavailable`, `herdRunStartedAt`,
  `breadcrumb`, `ownTools`, `identityOnly`, `refreshedAt`.
- `loadStatusSnapshot` (`index.ts:10823-10900+`) maps listed records into
  `StatusAgent`, including
  `startedAt: presentation.startedAt ?? runtime?.startedAt` (`10864`) — for a
  retained worker the pane tokens still hold the *previous* assignment's
  `startedAt`/`task`, so the widget would display stale assignment text unless
  cleared. `finalizeStateTransition` already clears them via
  `reportMetadata(..., {activity: null, context: null, ...})` (`15359-15369`) —
  good news.
- The widget refreshes every 2 s (`docs/reference/status-widget.md:60`), independent
  of the health scanner.

## B8. Recovery / restart reconstruction — read

- `recoverControllerRuntimes` (`index.ts:12694-12824`) already handles the
  retained shape: it builds the `Runtime`, `runtimes.set(runtime.label, runtime)`
  (`12773`), and then `if (runtime.activeRequestId) { watch…; continue; }` and
  `if (!runtime.completedRequestId) continue;` (`12775-12784`). With
  `completedRequestId` cleared, the runtime is registered and left idle — no
  cleanup, no close. **This is a favourable seam.**
- It also validates presence: `if (match.presence.kind === "live") { validateIdentity(...); validateIntegration(...) }` (`12772-12779`).
- `recovery.test.ts` themes relevant here (test names, read from grep):
  `completed and failed one-shot agents converge after durable delivery` (`:1486`);
  `one-shot close failure retains the result for exact cleanup retry` (`:1587`);
  `delivered-result cascade retries descendant mailbox cleanup failure` (`:1656`);
  `recovery redelivers an unpersisted child result and then cleans it safely` (`:1761`);
  `result cleanup retains durable delivery across agent identity changes` (`:2931`);
  `delivered result remains while agent state is active` (`:2994`);
  `live result cleanup keeps a later request owned by the mailbox` (`:3349`);
  `lost result cleanup keeps a later request owned by the mailbox` (`:3446`);
  `parent cascade keeps a later parent request during result cleanup` (`:3550`);
  `managed child automatic cleanup respects the parent delegation lock` (`:3943`);
  `automatic close invokes the exact lifecycle only after live identity proof` (`:3715`);
  `controller cleanup barrier blocks newer work until stale acknowledgement cleanup succeeds` (`:2262`).
  These all assert teardown; retention inverts them.
- `controller-lifecycle.test.ts:1737` "recovery cleanup finishes an idle restored herd without settlement" and `:1876` "restored herd waits for direct durable cleanup before finishing" — the herd-run/gate interplay.
- `controller-lifecycle.test.ts:3948` "lost mailbox labels remain reserved until explicit close" — the label-reservation precedent a retained worker extends.
- `agent-runtime.test.ts:2398` "agent reload preserves a completed request awaiting delivery" — child-side restart with a pending completed request.

## B9. `/agents` command menu structure for a `clear` action — read

- Menu root: `openAgentsMenu` (`index.ts:11645-11700`). Items: `running`, `stats`,
  `definitions`, `layout`, `context-retirement` (inline toggle), `message-limits`,
  `stop-all`. Dispatch is a flat `if/else if` chain (`11682-11696`). Commands are
  registered at `12688` (`agents`) and `12689` (`herdsman`), with an
  unmanaged-mode fallback at `6797-6805`.
- `openRunningAgentsMenu` (`11000-11064`) is **focus-only**: it builds
  `buildStatusRows`, maps option label → row index, re-loads a fresh snapshot,
  matches `label+paneId+sessionId`, then `runHerdr(pi, ctx, ["agent","focus", paneId])`.
  A per-agent `clear` action would either extend this menu or add a new section.
- `selectMenu` helper (`11066-11158`) is the generic list selector (search,
  arrow keys, cancel); `MenuItem = {value, label}` at `11064`.
- `confirmAndStopAll` (`11620-11642`) is the confirmation-dialog template.
- `presentStopSummary` (`11601-11613`) sends `pi-herdsman-stop-summary`.
- Docs to update: `docs/reference/commands.md:30-38` enumerates the root menu
  items verbatim; `:125-131` documents Running as focus-only.
- **Naming note (inference):** the task says `/agents` already has a `clear`
  action to add. In the current tree there is no `clear` anywhere in `/agents`;
  the nearest destructive op is `stop-all`. `agent_clear` would also be a new
  tool name that must not collide with the `available_tools` vocabulary.

## B10. Feature B tests

- `agent-runtime.test.ts:577` "registered agent writes state, handles input, and settles one result" — the per-generation contract.
- `agent-runtime.test.ts:814` "managed task acceptance retains its request during assignment contention".
- `agent-runtime.test.ts:434` "managed input handles duplicate markers before and after cleanup idempotently".
- `agent-runtime.test.ts:181` "managed interrupt continues the same assignment after abort settlement".
- `agent-runtime.test.ts:1490` "parent settlement waits for agent delivery and ignores result cleanup lag".
- `agent-runtime.test.ts:1024` "agent ask_owner blocks settlement and reply resumes the same assignment".
- `controller-lifecycle.test.ts:2611` "concurrent session activation permits one generation".
- `controller-lifecycle.test.ts:3285` "session continuation starts a new agent generation with current prompt contents".
- `controller-lifecycle.test.ts:3377` "session continuation ignores an unrelated missing live session path".
- `controller-lifecycle.test.ts:3469` / `:3558` "session continuation keeps an exact live ID busy despite a missing path observation" / "…despite contradictory live observations" — **the two tests that encode the `agent_busy` representation rule**.
- `controller-lifecycle.test.ts:3654` "session continuation ignores removed secondary session fields".
- `controller-lifecycle.test.ts:3749` "session continuation fails closed on an unrelated malformed persisted mailbox path".
- `controller-lifecycle.test.ts:3948` "lost mailbox labels remain reserved until explicit close".
- `controller-api.test.ts:4485` "session continuation inherits the saved label without an override".
- `controller-api.test.ts:4619` "session continuation rejects label overrides and occupied inherited labels" — **the label-collision test**.
- `controller-api.test.ts:4939` "managed historical sources require durable owner-side ancestry for continue".
- `controller-api.test.ts:5230` "session assignment fails closed on duplicate live representations".
- `controller-api.test.ts:5578` "assignment retains its request when acknowledgement never arrives".
- `controller-api.test.ts:6342` "acknowledgement state-write failures retain requests for durable retry".
- `recovery.test.ts` list in B8.
- `commands.test.ts:4232` "Running excludes lost and unknown durable generations"; `:5276` "lead agents stop closes a direct subtree agents-first"; `:5405`; `:5461`.
- `agent-cutover.test.ts:92` "managed Agent surfaces distinguish delegation capability from leaf access"; `:221` "each Agent operation has its own strict schema without projection".
- `extension-contract.test.ts` (3 277 lines) — the registered-tool-surface contract; any new tool/field lands here.
- `mailbox.test.ts` / `mailbox-cleanup.test.ts` — mailbox state/validation round-trips if `ManagedAgentState` gains a field.

## B11. Invariants at risk (Feature B) — exact quotes

1. **`docs/concepts/lifecycle.md:190-191`** —
   > "Each accepted task request maps to one final assignment result. Each managed agent generation receives exactly one assignment; a completed agent is not available for another task."

   This is the sentence the retained-worker feature directly contradicts: a
   retained agent *would* be available for another task.

2. **`docs/concepts/agents.md:107-111`** —
   > "Every managed agent generation executes exactly one delegated assignment. Its terminal result is delivered once, then the agent's pane, process, mailbox, and runtime state are cleaned up."

   All four named artefacts (pane, process, mailbox, runtime state) are what
   retention keeps.

3. **`docs/reference/agent-states.md:27`** —
   > "`available_tools` never includes `agent_delegate`; an agent generation handles one assignment only."

4. **`docs/reference/agent.md:42-43`** —
   > "Each accepted definition delegation creates one agent generation for one assignment. The terminal result is delivered once and the agent is cleaned up."

5. **`docs/reference/agent.md:55-58`** —
   > "Continuation always creates a new agent generation for one assignment with a live label; **it never assigns work to an existing agent.**"

   This is the sharpest contradiction — the whole feature *is* "assign work to
   an existing agent".

6. **`docs/reference/agent.md:59-61`** —
   > "Concurrent or otherwise conflicting managed representations of the exact session fail closed."

7. **`SKILL.md:62-64`** —
   > "Each managed agent exists for one assignment only. After its terminal result is delivered, Pi Herdsman cleans up that agent automatically. To continue completed work with its existing context, use the exact session returned with the result. Agent labels control the currently live generation; they are not continuation selectors."

8. **`docs/guides/handoffs.md:221-222`** —
   > "Each agent generation builds its system prompt once for its single assignment. Session continuation builds a new generation with the current effective definition configuration while preserving the saved Pi session context."

   A retained worker cannot rebuild its system prompt, so continued work in the
   same process runs under the *first* assignment's prompt — a behavioural
   difference from today's `agent_continue`.

9. **`docs/reference/agent-states.md:54-59`** — "`settling` … Do not assign another task to a settling agent." Plus `:24-26` "`available_tools` is authoritative … Do not infer control eligibility from `state` alone."

10. **`docs/concepts/agents.md:125`** —
    > "agent label → stable logical name across sequential generations; live control target only for the current generation"

11. **ADR `0004-separate-delegation-from-continuation.md`** header —
    > "Pi Herdsman will expose fresh Agent delegation and historical Agent continuation as distinct operations." … "Delegation creates a new definition-backed assignment. Continuation resumes an exact previously owned Pi session and restores its saved identity, definition, label, and working directory from durable history."

    and Consequences —
    > "Fresh handoffs use delegation. Reuse of an existing managed Pi session uses continuation." / "New features must not reintroduce caller-controlled identity overrides as continuation parameters."

    A retained worker makes "continuation" mean *the same* process, not a
    resumed session — a re-reading of this ADR is required.

12. **ADR `0002-persist-intent-and-derive-runtime-state.md`** —
    > "Ambiguous or conflicting runtime evidence must fail closed. Herdsman must not invent ownership, placement, or liveness from stale observations."

    A retained idle process *is* a live artefact with stale assignment metadata
    still on its pane tokens; the projection must not invent a current
    assignment from it.

13. **ADR `0010-retire-managed-agent-sessions-before-threshold-compaction.md`** —
    > "While context retirement is enabled, a retired managed session is not eligible for historical `agent_continue`; follow-up work must use a fresh Agent with the relevant handoff, result, and files."

    Fork config keeps `contextRetirement: false` and
    `docs/reference/configuration.md` says "managed agents are persistent
    sessions that compact through the context stack their Pi configuration
    loads, and `agent_continue` stays available after compaction" — i.e. the fork
    has *already* moved toward persistent sessions. That is the strongest
    existing precedent for Feature B (**read**, doc text at
    `docs/reference/configuration.md` "When `contextRetirement` is enabled…").

14. **ADR `0003-use-durable-ownership-for-agent-scope.md`** and
    **`0007-store-durable-state-under-pi-agent-data.md`** — durable mailbox
    ownership is the authority; a retained worker must not weaken
    `ownerSessionId`/`runId`/`paneId` identity checks (they are revalidated in
    ~20 places listed in B3).

## B12. Open risks / open questions (Feature B)

- **`settling` projection collision** (B6). Highest-impact unknown: decide
  whether a retained idle worker is a new public state or a `settling` variant,
  then update `core.ts` + `core.test.ts` + `docs/reference/agent-states.md` +
  `docs/reference/status-widget.md`.
- **Label semantics.** Today the label is "live control target only for the
  current generation" and dies with cleanup. Retention makes the label persist
  across assignments for one process — so `agent_label_exists` (B3 rows 2/3) and
  the `docs/concepts/agents.md:125` identity table both change meaning.
- **`agent_continue` sends into the same process — but the child's system prompt
  is already built** (`docs/guides/handoffs.md:221`). A retained worker cannot
  pick up definition changes; the "current effective definition configuration"
  promise in `docs/reference/agent.md` breaks.
- **Herd-run gate** (`index.ts:9011-9035`): a retained `state.json` keeps the
  lead's herd run open indefinitely ⇒ status widget and `/agents stats` will show
  a permanently running herd. Needs an explicit carve-out.
- **`hasDurableResult` blocks `agent_close`** (`index.ts:4674`). If the
  result file is retained, `agent_close` must be taught the retained state, or
  the result file must still be removed.
- **Delegating agents.** The completion gate
  (`hasUndeliveredDirectChildWork`, `docs/concepts/lifecycle.md:225-236`) plus
  `settlePersistedResults` mean a *delegating* retained worker can keep children
  alive too — decide whether retention is recursive or lead/manager-only.
- **Bounded agent count.** Nothing today caps how many retained panes can
  accumulate; `docs/reference/agent-states.md` and the `/agents` Running list
  will grow unboundedly.
- **`agent_clear` vs `agent_close`.** Two release paths with different
  durability implications; the task says both. Needs a stated rule for which one
  a controller should pick when the session has a live unread result.
- **Crash mid-retention.** If the controller dies after the result is delivered
  but before the child clears `completedRequestId`, recovery sees
  `completedRequestId` set and runs `deliverResult`/`cleanupAfterDeliveredResult`
  again → it would close the pane. Retention needs a durable marker written
  *before* the child settles, or an idempotent "already retained" check in
  `cleanupAfterDeliveredResult` (**inference**).
- **`PI_HERDSMAN_RUN_ID`/`runId` per generation.** `runId` is generated per
  assignment (`index.ts:5779`) and is baked into the herdr agent alias
  (`herdrAgentAlias(workspaceId, label, runId)`, `index.ts:12736-12740`, `5459`). A
  retained worker cannot change its `runId` without re-registering the herdr
  alias, so a second assignment in the same process either keeps the old `runId`
  (weakening the "run-scoped identity" checks that `recoverControllerRuntimes`
  and `validateIdentity` depend on) or must rebind the alias. This is the most
  likely place for the design to break (**inference** from the identity-recheck
  density; not verified by running anything).

---

# Files most likely to need changes

Both features:

- `extension/index.ts` — `scanAgentHealth` (`12982-13518`), `runAgentHealthScanner` (`13520-13567`), `attentionReminders` (`9045-9050`), `recoverControllerRuntimes` (`12694-12824`), message renderers (`6768-6788`), tool registrations (`13949-14360`), parameter schemas (`6864-6990`), `actionUnsafe` (`5567`), `/agents` menus (`11000-11158`, `11620-11700`), `maybeFinishHerdRun` (`9011-9035`).
- `extension/config.ts` — new key: type (`16-21`), defaults (`23-28`), `CONFIG_KEYS` (`39-44`), `parseRawConfig` (`46-88`), `updateConfig` (`112-164`).
- `extension/core.ts` — `agentControlState` (`370-392`), `taskAcceptanceAllowed` (`394-399`), possibly a new small predicate.
- `extension/mailbox.ts` — `ManagedAgentState` (`26-51`) if a new durable field is added, plus `validate` (`226-537`) and `LIMITS.state` (`120-125`).
- `extension/presentation.ts` — `renderAgentAttentionMessage` (`3036-3095`) / `renderAgentStaleMessage` (`3098-3170`), `AgentLifecycleState` (`42`), `StatusAgent` (`44-55`), status tree/rows (`197-517`), `formatToolModelResult` (`1637`).

Docs: `docs/concepts/lifecycle.md`, `docs/concepts/agents.md`, `docs/concepts/delegation.md`, `docs/reference/agent-states.md`, `docs/reference/agent.md`, `docs/reference/configuration.md`, `docs/reference/commands.md`, `docs/reference/status-widget.md`, `docs/guides/recovery.md`, `docs/guides/handoffs.md`, `SKILL.md`, plus a new ADR (the ADR index is `docs/adr/0001`…`0012`; `docs/adr/0011-use-progressive-disclosure-and-single-owner-documentation.md` governs where new prose goes).

---

# Start Here

1. **`extension/index.ts:12982-13518` (`scanAgentHealth`)** — read the whole ladder once. Feature A is a new branch here; Feature B's "does the health scan object to a live idle agent?" question is answered by the `lost`/`unknown` branches and the `presence` computation in `managedAgentSnapshots` (`2858-2995`).
2. **`extension/index.ts:3753-3821` (`finalizeDeliveredRoot`)** — the three lines Feature B must suppress (`closeLiveManagedExecution`, `removeResult`, `removeAgentMailbox`) are all in this function; nothing else in the codebase closes a delivered generation on the controller side except `closeManagedAgentCascade` (`5094`).
3. **`extension/index.ts:15124-15145` and `15197-15220`** — the child-side admission gate and the durable acceptance write. This is where "can the same process take a second assignment?" is actually decided.
4. **`extension/core.ts:370-392` (`agentControlState`)** — cheapest place to prototype the retained-idle projection, and it is pure and unit-tested.
5. **`pi-subagents/src/runs/background/subagent-runner.ts:2747-2760` + `pi-subagents/test/unit/soft-deadline.test.ts`** — the working reference for Feature A's exact semantics.
