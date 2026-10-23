# Proposal

## Why

A task stops permanently when its route runs out of quota, even if an account resets a few minutes later. Opt-in resumption would let an unattended task continue when capacity returns, including using remaining weekly allowance between short-window resets, without turning every failed session into an automatic spender.

## What Changes

- Add session-owned permission to wait and resume the current task: once after the next capacity pause, or through repeated pauses until the task completes, is cancelled, or reaches its deadline.
- Make the waiting scope explicit: any current-route candidate (default), a provider optionally narrowed to an account, or an exact physical model/account. A “pinned target” convenience snapshots the pin when armed; pins never silently narrow or retarget waiting.
- Detect terminal quota exhaustion after ordinary native retry/fallback has settled. Recheck capacity after predicted resets and periodic shared quota refreshes; all applicable quota windows and health constraints must permit a wake.
- Resume through a supported Pi continuation boundary with duplicate-wake fencing, existing recovery leases, bounded attempts, deadline, cancellation and secret-free diagnostics. Partial-output or unresolved-tool cases stay stopped unless safe native continuation is specifically proven.
- Offer `/route-resume` controls and a compact waiting status. Changing selected model, branch, session or user intent cancels the pending wait rather than retargeting it.
- Keep execution process-local: Pi must remain open. Persist bounded intent in the router-owned store, but require explicit re-arming after process/session restoration.

## Capabilities

### New Capabilities

- `route-task-resumption`: Explicit session authorization, capacity-scoped waiting, safe bounded continuation, lifecycle cancellation and operator visibility.

### Modified Capabilities

None. Native routing still settles exhausted requests predictably; the new opt-in capability schedules a later continuation without weakening immediate retry safety or making the health store execute tasks.

## Impact

- `pi-native-router`: terminal error classification, quota observation integration, a resumption coordinator, router-owned intent persistence, commands and footer status.
- Pi host integration: verify post-settlement continuation and cancellation semantics with the real host harness before enabling execution.
- Existing route selection, credentials, usage accounting and awaited Magic Context transitions remain authoritative.
- No new service, global task scheduler, provider transport, automatic paid probing loop, or closed-session launcher. Direct calls and provider-wide wake broadcasts are out of scope. Generic transport/auth recovery, priority queues, spend optimisation and autonomous task scheduling are deferred.

Accepted defaults (2026-10-23): route-wide scope; 24-hour authorization lifetime; three unsuccessful wake attempts per capacity pause; quota and reset-bound rate failures only. No behavior changes unless the session is explicitly armed.

Accepted host contract: terminal Escape/Ctrl+C, explicit off and lifecycle events cancel waiting. Programmatic idle abort is unobservable on Pi 1.2.0 and is documented. Preexisting queued `nextTurn` content intentionally joins a resumed conversation; active steering/follow-up still postpones delivery. These limitations are not implementation gates.
