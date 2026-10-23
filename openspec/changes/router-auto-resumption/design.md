# Design

## Context

See proposal.md for motivation. The router already owns physical selection, shared health/probe leases, named-account binding, CodexBar snapshots, per-route pin overrides and awaited Magic Context transitions. `agent_before_settle` handles bounded immediate recovery, and `message_end` settles admissions. CodexBar refreshes on session launch and every five minutes, with a shared four-minute fetch gate. No existing router component resumes an already settled task.

The live `refreshQuotas(force)` path clears tracker blocks before fetching. Therefore “no cause exists” is not sufficient evidence of restored quota. Native route state also uses per-turn recovery budgets: delayed resumption must not manufacture a new turn merely to evade exhausted safety budgets.

Main-spec drift found during discovery: `native-model-routing` still describes the old max-output reserve calculation, and `shared-provider-health` predates explicit pin bypass. Those unrelated contracts are not rewritten in this change. Automatic resumption is not a manual pin and must never borrow the bypass.

## Goals / Non-Goals

**Goals:** Add one session-owned continuation coordinator above existing routing, with explicit scope, safe native continuation, bounded authorization, secret-free persisted intent and race-proof cancellation.

**Non-Goals:** Launch closed sessions; global worker scheduling or task priority arbitration; promise spend-maximising utilisation; initiate new tasks; warm caches; retry arbitrary errors; add provider transports; expand direct-call recovery; automatically continue unsafe partial output or unresolved tools.

## Decisions

### 1. Session owns permission; capacity scope is a separate selector

Use `scope = route | provider(providerId, account?) | target(providerId, modelId, account?)`. Every selector intersects the current route. `pin` is a UI shortcut that resolves immediately to a target selector; it is not a live pointer to future pin state. A missing pin is an input error.

Provider scope can span configured accounts; an account selector narrows it to one key. Default-auth and single-key providers have no invented account id. Exact target includes its account identity, so equal model ids using different keys are not interchangeable.

Rejected: provider-global permission and pin-derived implicit waits. Both would wake unrelated tasks or change the meaning of a pin. Changing a pin alone does not retarget a wait. Changing selected model cancels it, consistent with route pin clearing.

### 2. Commands authorize one task, not an indefinitely running session

Proposed surface:

- `/route-resume once [--scope route|pin|provider:<id>[#<account>]|target:<provider>/<model>[#<account>]] [--until <ISO-time>]`
- `/route-resume on` with the same options for standing authorization.
- `/route-resume off` and `/route-resume status`.

No scope argument means route, even when pinned. A picker can offer route, pinned target, configured providers/accounts and physical targets using the same parser/validation. Status with no armed permission is read-only, never an implicit arm.

Proposed defaults: 24 hours from explicit arming and three unsuccessful actual wake executions per capacity pause. Passive health checks do not consume attempts. A successfully resumed execution resets the unsuccessful-wake counter for a later distinct pause; timers, duplicate observations and another failure do not. Once mode ends after the first resumed execution makes a successful assistant step; standing mode continues across capacity pauses until normal successful agent settlement. Neither mode can manufacture follow-up tasks after successful completion.

These are proposed operational defaults, not previously established user preferences. They are visible when arming and adjustable through file-managed package settings, with no in-session settings-file writer.

### 3. Separate terminal capacity exhaustion from safe continuation

Record a structured exhaustion observation from candidate rejection data rather than parsing the displayed exhaustion error. Enter waiting only after native fallback/recovery has settled, when at least one otherwise usable scoped candidate exists and all such candidates are capacity-blocked. Missing-auth/fit candidates are inapplicable rather than an excuse to retry. A budget-only failure with an otherwise admissible candidate stops.

Capture session id, branch/head identity, task-generation token, selected route, normalized scope and failed-turn boundary. The coordinator rechecks them before every wake. Do not persist transcript copies.

Implementation starts with a specific host integration gate: demonstrate the supported post-settlement continuation API using the real host harness. It must preserve completed tool results and not replay tool effects. Existing `agent_before_settle` edits apply only before settlement and cannot be assumed safe after it. Do not edit old transcript entries or inject a generic “continue” message without proving the native semantics. If no supported seam satisfies this, stop implementation and report the host gap; do not ship a timer-driven workaround. Unsafe partial-output and unresolved-tool endings remain stopped in v1.

### 4. Readiness is evidence, not a missing block

On terminal pause retain the limiting quota scopes, observed snapshots and observation revisions. Readiness is one of:

- A newer fresh authoritative usable snapshot shows all applicable windows below exhaustion, with no remaining auth/outage/rate/model block.
- A failure-derived quota/rate deadline expires, with no fresh contradictory exhausted snapshot, and shared health permits a recovery probe.

For tracker-derived exhaustion whose reset has elapsed, prefer a new reading. If it is unavailable, remain waiting with bounded checks rather than treating the cleared/expired tracker cause as a healthy reading. A stale snapshot cannot block forever or declare restoration: refresh and show unknown. The authorization deadline bounds the wait.

A fresh healthy reading before the predicted deadline triggers an early reevaluation, including provider-announced resets. Reconcile only pre-existing quota causes for the observed provider/account using revision fencing; never clear auth/outage causes or newer request failures based on an older snapshot. The request still must pass shared admission. All windows matter: the earliest reset is a recheck time, while the remaining exhausted windows still prohibit dispatch.

Use the existing periodic quota refresh and shared fetch gate. Add a session-local timer for the next relevant reset plus small jitter; request one coordinated refresh when a known reset needs newer evidence, without invoking `/quotas refresh`'s operator-clear behavior. Back off unknown/reset-less cases, with a proposed five-minute recheck minimum. Polls are tracker calls only, not billed model requests. Do not bypass the shared fetch gate on every waiting process.

### 5. Constrain both readiness and resumed execution

Intersect the route's candidates with the saved scope for the resumed execution, not merely the initial readiness test. Existing strategy, healthy incumbent preference and recovery apply within the intersection. A stored pin outside scope cannot win; a pin inside scope is context, not a new one-shot health bypass. Do not permanently mutate route config or clear unrelated pins.

Normal fit, credential activation, native accounting, transition budgets and awaited flushes remain. If capacity disappears between the check and dispatch, return to waiting or stop at the failed-wake limit. A provider-scoped request must not silently escape to a different provider on failover. The next ordinary user task has no leftover scope constraint.

### 6. One coordinator per live session intent

State machine: `disarmed -> armed -> waiting -> waking -> running`, with `stopped` for deadline/attempt exhaustion and `suspended` for restored state. `once` ends after proven progress; standing permission re-enters waiting only on qualifying capacity settlement. Completion disarms it.

A monotonically changing intent generation fences asynchronous callbacks. Before execution, atomically claim the intent's generation/owner lease in the router store, verify the session is idle with no pending user message, and obtain normal candidate probe admission. Distinguish intent ownership (one session continuation) from capacity leases (one provider recovery probe). Shared quota refresh can notify multiple independently armed sessions; probe leases coordinate recovery, but v1 does not promise account-wide task fairness.

Explicit off, abort, new user intent, session/branch/model switch and shutdown cancel timers and invalidate generation before queued work can run. An already dispatched request follows normal abort semantics; cancellation never claims it prevented execution that already began. Restored intents are suspended and require explicit re-arming.

### 7. Persist only lifecycle transitions

Store the live intent in a router-owned resumption table in the existing router store, atomically on arm, wait, claim, cancel and stop. Session entries contain only a small intent pointer/transition, not full snapshots. Wake-attempt counters stay in process memory; after restart the suspended intent cannot spend until the operator re-arms a new bounded authorization. Lease expiry alone never launches a closed process.

No prompts, credentials, key paths or raw responses. Keep at most 100 terminal intents per user for seven days, whichever limit removes them first; at most one active intent per session branch. Diagnostic observations include scope, blockers, deadline, next check, outcome and provenance, not per-poll logs. Shared-store failure suspends resumption rather than risking duplicate automatic dispatch; ordinary routing's local-health fallback remains unchanged.

### 8. Status stays quiet and separate from physical identity

Notify on arm, entry into wait, resume, cancellation and terminal stop. No notification for unchanged polling results. Add an optional compact waiting status key rather than replacing the physical model label with a predicted future target. `/route-resume status` contains the full explanation, all limiting windows and last tracker result. Package README documents the controls and status extension point before implementation is considered complete.

## Risks / Trade-offs

- **Post-settlement continuation may lack a safe public seam** -> First implementation task proves it with actual native session behavior; no execution feature until that passes.
- **Quota restoration has no push notification** -> Existing refresh cadence plus reset-aware coordinated checks; status states freshness and next check, not a guarantee of immediate use.
- **Multiple quota windows and stale observations** -> Check each window, preserve provenance, and fence reconciliation against newer failures.
- **Multiple unattended tasks compete** -> Intent ownership and shared recovery leases prevent duplicate probes, not scheduling unfairness; global priority/fairness is deferred.
- **Provider quota estimates are wrong** -> Fresh snapshots only admit a bounded native attempt; unsuccessful wakes consume the attempt budget and reestablish health.
- **Host continues after intent changes** -> Generation fencing, idle/pending-message checks and native cancellation integration tested at the dispatch boundary.
- **A deadline expires during a long execution** -> No new wake after the deadline; an already running request completes unless the operator aborts. Deadline is authorization to start, not a forced mid-tool kill.

## Migration Plan

1. Prove continuation and lifecycle hooks against the deployed Pi host and harness.
2. Add the capability inert by default; no existing session is implicitly armed and no existing route selection changes.
3. Add the resumption store schema without changing health-key formats or existing causes. Suspended restored records never execute automatically.
4. Validate quota-reset, early-restoration, multi-window, cancellation and duplicate-owner behavior using controlled clocks and provider stubs.
5. Owner smoke with an explicitly armed test task, leave Pi open, observe wait and one resumed execution. Do not probe real accounts without approval.
6. Roll back by disarming active intents and disabling/removing the feature; expire owner leases and retain shared health. No daemon or background session launch needs cleanup.

## Host gate evidence (2026-10-23, installed Pi 1.2.0)

Implementation is blocked at task 1.2. No automatic resumption runtime, timers, store schema or commands have been enabled. This preserves the required cancellation contract rather than implicitly restricting execution to a subset of hosts.

The existing parent proof `post-settlement custom continuation preserves completed tools after quota exhaustion` is preserved unchanged. It executes a tool, settles an empty quota error, then calls `session.sendCustomMessage(..., { triggerTurn: true })`. The completed tool executes exactly once and its result remains in the successful request context. This establishes task 1.1 only; it does not establish capacity readiness, budget preservation or automatic cancellation.

The additional host test `resumption host gate: public continuation identifies its custom source but pending checks omit nextTurn` exercises public `pi.sendMessage(..., { triggerTurn: true })`. The real `before_agent_start` event has `messageType: custom`, the original custom type and generation details. However, after queueing a `nextTurn` message, the captured real extension context reports idle and `hasPendingMessages() === false`; the wake starts and consumes the queued intent. A coordinator checking only these public predicates cannot meet the pending-input guard.

The additional test `resumption host gate: idle abort emits no session event and does not fence a later continuation` calls real `session.abort()` after terminal quota settlement. No session event is emitted, and a subsequent custom continuation dispatches successfully. SDK inspection confirms `abort()` only marks a run aborted while a run is active and does not emit a generic extension abort event. A waiting coordinator cannot observe this idle SDK/RPC abort through the public extension lifecycle. The interactive `onTerminalInput` hook delegates to TUI input listeners and can observe terminal keys, but RPC's implementation is a no-op; that hook cannot establish the promised general abort contract. Interactive key cancellation was not proven by these noninteractive tests.

Relevant installed SDK paths (read only): `dist/core/agent-session.js`, `dist/core/extensions/types.d.ts`, `dist/modes/interactive/interactive-mode.js`, `dist/modes/rpc/rpc-mode.js` under `pi-native-router/node_modules/@earendil-works/pi-coding-agent`. `pendingMessageCount` includes steering/follow-up queues only; `_prepareRun` separately consumes `_pendingNextTurnMessages`. `sendCustomMessage` can defer a trigger during settlement without an extension generation predicate. Source identity permits a future router dispatch guard, but does not solve unobservable idle cancellation or pending input.

Transcript semantics: this is a custom control message appended to existing history, not removal of a failed turn or replay of the tool request. Custom content is converted into a user-role provider message; `display: false` only hides rendering. It is still model-visible input, and must carry no prompt copies or credentials. Successful manual continuation is not permission to reset the prior failed-turn safety budgets.

Required next decision belongs to the owner: obtain a host API that exposes idle cancellation and all pending intent (with an execution-time cancellation/generation guard), or explicitly approve a narrower host/input contract and revise the spec before implementation. A TUI-only restriction is not adopted here. Once that gate is resolved, tasks 1.2 and 2–5 still require implementation and evidence, including queued-wake races, partial/unresolved-tool rejection, scoped fallback, shared ownership and multi-window readiness. Live smoke remains unchecked and was not attempted.

Validation from the package directory:

- `bun test tests/host.test.ts --test-name-pattern 'post-settlement custom|resumption host gate'`: 3 pass, 0 fail, 53 filtered, 13 assertions.
- `bun test tests`: 159 pass, 0 fail, 594 assertions across 16 files; stub providers only.
- `bun run typecheck`: fails on the existing `examples/peak-quota-strategy.ts` package alias `@vanillagreen/pi-native-router/strategy` and consequent typing errors. No claim that examples typecheck cleanly.
- Focused check passes: `mapfile -t router_check_files < <(rg --files src tests -g '*.ts' -g '!example-strategy.test.ts'); ./node_modules/.bin/tsc --noEmit --target ES2023 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types bun --allowImportingTsExtensions "${router_check_files[@]}"`. Excludes only the test that imports the affected example; includes the changed host tests and production source.
- From the repository root, `openspec validate router-auto-resumption --strict`: valid.

Only task 1.1 is checked. Passing existing tests and schema validation do not substitute for the unimplemented acceptance scenario in 5.1.
