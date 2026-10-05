# Design

## Context

See proposal.md for motivation and the two specs for required behaviour. The seam map is `context.md` in this change (file:line anchors into `pi-herdsman/extension/`). The constraints that shape the approach:

- Controller health runs as one loop, `runAgentHealthScanner`. It reschedules on a 30 s cadence, coalesces requests, and enters `scanAgentHealth` only when `ctx.isIdle()`. The ladder publishes at most one attention per scan (`published`, `index.ts:13011`, asserted by `recovery.test.ts:5088`). Reminder state is one slot per `runId` (`attentionReminders`).
- The durable mailbox (`state.json`, `request-*`, `result-*`) is shared by controller and child and is strictly validated (`mailbox.ts` `validate`). Lead-side custom entries (`pi.appendEntry`) already carry Herdsman state such as `HERD_RUN_ENTRY` and the lead state. They persist with the lead's session and never enter model context.
- After delivery, `finalizeDeliveredRoot` does three things: it closes the live pane (`closeLiveManagedExecution`), removes the result file, then removes the mailbox. `closeManagedAgentCascade` reaches the same function for controller-owned roots.
- The child admits a task only when `completedRequestId` is undefined and `taskAcceptanceAllowed` passes (`index.ts:15124-15145`). Its request pump stays live after settlement (`index.ts:14927`).
- `agentControlState` (`core.ts:370-392`) projects a live process with no active, no completed-pending, and no handoff as `settling`, the state documented as "do not assign another task".
- `runId` is minted per launch and baked into the Herdr agent alias (`index.ts:5779`, `12736-12740`).

## Goals / Non-Goals

**Goals:**

- Ride the existing scanner and lifecycle paths, so both features add no second delivery path, timer loop, or process supervisor.
- No mailbox schema change: everything new is either derivable from existing mailbox fields or recorded in the owner's own session.
- With `retainWorkers: false`, behaviour stays byte-for-byte upstream's, so upstream takes keep merging cleanly on that path.

**Non-Goals:**

- A pi-jev consumer of the digest event (the seam only).
- A cap on retained workers or idle eviction. `Clear idle` and `agent_close` are the release mechanisms for now.
- Changing a worker's model, prompt, or tools in place. Drift relaunches.
- Soft windows on Manager→Lead project work (`staff_*`); only `agent_*` assignments are covered.

## Decisions

### D1. Soft windows are a separate pass after the health ladder, not a ladder branch

`scanAgentHealth` gains a final pass that collects every due window the controller owns and publishes one digest. The pass ignores `published`, and its state lives in a dedicated `softWindows: Map<requestId, …>`, not `attentionReminders`.
- *Why:* inside the ladder, a digest would be starved by any other attention under the one-per-scan gate, and would overwrite the stale reminder slot that shares the same `runId`. A trailing pass keeps both contracts intact. The spec requires coexistence with stale attention. The "one attention per scan" test still holds for health attention because the digest is a different message type.
- *Alternative rejected:* a dedicated `setTimeout` per window. It gives exact timing, but it is the second delivery path `docs/guides/recovery.md` forbids, and it would need its own idle gating and restart handling. Up to 30 s of lateness is acceptable at 300 s windows.

### D2. The window anchor is controller-observed acceptance, recorded as a lead-session entry

`submit` already sets `runtime.startedAt = Date.now()` when it sees the accepted task acknowledgement (`index.ts:2741-2750`). At that point the controller appends `pi-herdsman-soft-window` `{requestId, label, runId, armedAt, windowMs}`. Each delivery appends `{requestId, deliveredAt, nextArmedAt, windowMs}`, and `agent_extend` appends `{requestId, armedAt, windowMs, extended: true}`. On recovery, `recoverControllerRuntimes` replays the last entry per unresolved `requestId`. If a working runtime has no entry, the anchor falls back to `state.lastAck.acknowledgedAt`.
- *Why:* acceptance time is what the spec measures; `lastActivityAt` measures progress, which is the wrong clock. Custom entries are durable across lead restarts without touching the mailbox validator or `LIMITS.state`. They also do not enter model context, so they cannot disturb prompt caching (ADR 0009).
- *Alternative rejected:* new `ManagedAgentState` fields. The child would carry owner-side scheduling state, and the change would hit the validator and the size budget.

### D3. Digest message and wording

The digest is a new custom message type, `pi-herdsman-agent-soft-deadline`, with its own renderer next to the stale renderer. It is delivered with `triggerTurn: true`, like other attention. Each entry lists the worker's `available_tools` from `currentAvailableActions`, never a hard-coded set; the close preflight and `agent_reply` eligibility come for free. The model-facing choices are worded *keep waiting / agent_steer / agent_interrupt / agent_extend / agent_close*. "Continue" is avoided because `agent_continue` already means a new assignment.

### D4. `agent_extend` is a tenth controller tool

The tool takes the strict schema `{agent: string, windowMs: integer 1..2147483647}` with `additionalProperties: false`. It is registered like the other `agent_*` aliases, with a new `"extend"` action in `actionUnsafe`. `listedAgentRecord` adds `extend` only for a directly owned record with an armed window. `agent-cutover.test.ts:221` (strict per-operation schemas) and `extension-contract.test.ts` gain the new tool.
- *Alternative rejected:* an optional `softTimeoutMs` on `agent_steer` or `agent_delegate`. That mixes advisory scheduling into assignment-changing operations, and the spec wants extend to have no side effects.

### D5. Event seam

Immediately before `sendMessage`, the pass calls `pi.events.emit("pi-herdsman:soft-deadline", payload)`. The payload is `{ownerSessionId, entries, annotations: string[]}`. The emit is wrapped so that a listener throw is caught and ignored. Non-empty `annotations` render as a trailing section of the digest. The channel name is documented in `docs/reference/agent.md`.

### D6. "Retained" is derived, not stored

A retained idle worker is the mailbox shape `completedRequestId` set, no result file, no `activeRequestId`, no unacknowledged request, plus a live verified process. Retention therefore means: in `finalizeDeliveredRoot`, when `readConfig().retainWorkers` and the root is live, skip `closeLiveManagedExecution` and `removeAgentMailbox`, still `removeResult`, and keep the runtime cache entry. The child's admission gate treats "`completedRequestId` set and its result file absent" as delivered and therefore admissible. Accepting the next task already clears `completedRequestId` (`index.ts:15201`).
- *Why:* the controller removes a result file only after delivery evidence exists, so its absence is a durable, child-readable "delivered" fact. The derivation is restart-idempotent: recovery that finds `completedRequestId` without a result file runs `cleanupAfterDeliveredResult`, which re-reads the setting and retains again, never closing.
- *Edge kept closed:* in the non-retained path the pane is closed *before* `removeResult`, so the derived idle shape never coexists with a live process there.
- *Alternative rejected:* a `retained: true` state field. It is redundant with the derivation and costs a mailbox schema change.

### D7. Projection: a new public `idle` state

`agentControlState` gains a `delivered` input, true when `completedRequestId` is set and no result file is pending. With a live idle or done lifecycle it now returns `idle`; this branch previously fell through to `settling`. `idle` gets the glyph `○`, which the widget docs already describe as "idle or done". `listedAgentRecord` gives `idle` records exactly `inspect`, `transcript` and `close`, with no steer, interrupt or extend. The stale and soft passes skip records without `activeRequestId`, which already excludes `idle`. `maybeFinishHerdRun` (`index.ts:9011-9035`) ignores `idle` states when it decides whether the herd run is still open.

### D8. Reuse goes through the normal `submit` path, and `runId` becomes process-scoped

`agent_continue` admission (`index.ts:5857-5921`) resolves the session's managed representations first. If exactly one exists, is directly owned, and projects `idle`, admission skips the busy and label-collision rejections and dispatches into the existing `Runtime` with `submit(kind: "task")`. Acknowledgement, `startedAt`, soft-window arming, watchers and result delivery are all unchanged. `runId`, the Herdr alias and `paneId` stay those of the process. In this fork a "generation" means a process lifetime, and one generation may now serve several assignments, each identified by its `requestId`.
- *Why:* every identity check (`validateIdentity`, `resultCleanupReady`, recovery) compares `runId`, `paneId` and the session, and all three stay constant for a reused process. Re-minting `runId` would mean re-registering the Herdr alias mid-life, which is where the code map predicts the design would break.

### D9. Definition drift uses a launch fingerprint stored by the owner

At launch, the controller hashes the resolved launch inputs it already computes: expanded body including `@file` contents, `systemPromptMode`, model, thinking, the effective tools, skills and extensions lists, and context inheritance. It appends `pi-herdsman-worker-launch {runId, label, fingerprint}` to its own session. Reuse recomputes the hash from the current effective definition, and on mismatch or a missing entry it closes the idle worker through the existing `closeManagedAgent` path. Admission then continues as today's fresh `agent_continue` on the same session, and the result carries `relaunched: "definition_changed"`.
- *Alternative rejected:* comparing raw definition files. That misses `@file` body changes and overlay composition, and the resolved inputs are what actually shape the process.

### D10. Configuration and menu

`config.ts` gains two keys, following the `contextRetirement` pattern:
- `retainWorkers`: boolean, default `false`.
- `softTimeoutMs`: integer 0..2147483647, default `300000`. A new `validSoftTimeout`; `validByteLimit` cannot express `0` meaning disabled.

`/agents` gains a `Retain workers  on|off` toggle and a `Clear idle…` action modelled on `confirmAndStopAll`. The soft timeout gets a numeric menu modelled on `openMessageLimitsMenu`, with presets 2 / 5 / 10 min, off, custom and reset.

### D11. Documentation and ADRs

Two fork ADRs are added: `0013-retain-workers-across-assignments` and `0014-advisory-soft-deadline-checkpoints`. They record D6–D9 and D1–D5, and state which upstream sentences they supersede (quoted in `context.md` A9/B11). The prose in `lifecycle.md`, `agents.md`, `agent.md`, `agent-states.md`, `handoffs.md`, `recovery.md`, `configuration.md`, `commands.md`, `status-widget.md` and `SKILL.md` is edited where each sentence lives (ADR 0011, single-owner documentation). The "deliberately narrow health conditions" paragraph stays true: the soft deadline is documented as a separate advisory checkpoint, not a health condition. The fork-delta section in `pi-herdsman/README.md` lists both features.

## Risks / Trade-offs

- [Idle panes accumulate, and the PiG research measured about 683 MiB per worker with the full config] → `Clear idle`, `agent_close`, and the documented guidance to release workers that will not be reused. A cap is a non-goal for now. The slim worker profile is the real lever.
- [A reused process keeps its launch-time system prompt and in-memory extension state] → D9 relaunches on definition drift. Extension state carrying over between assignments is the intended "warm" behaviour and is documented as such.
- [Up to 30 s digest lateness] → acceptable at a 300 s default; documented.
- [Upstream takes conflict in `finalizeDeliveredRoot`, `agent_continue` admission, `agentControlState`, and the scanner] → every fork branch is guarded by `retainWorkers` or `softTimeoutMs`, and each conflicting function is listed in the README fork delta, so merges know where to look.
- [A delegating idle worker's own children] → children follow the same global setting and are retained under that worker. Closing an idle delegating worker cascades child-first through the existing cascade preflight.
- [A digest on a lead mid-conversation with the user] → the scan already runs only when the lead is idle; digests never interrupt a turn.

## Migration Plan

Both features are opt-in or default-safe. `retainWorkers` defaults to `false`, so the upstream lifecycle is unchanged until it is enabled from `/agents` or the config file. `softTimeoutMs` defaults to 300000, and `0` disables it.

To roll back:
- Set `softTimeoutMs: 0`.
- Toggle `retainWorkers` off. Workers already `idle` stay idle until `Clear idle` or `agent_close`; toggling off does not kill them.

No mailbox migration is needed. The lead-session entries are ignored by builds that do not know them.
