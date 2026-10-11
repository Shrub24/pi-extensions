# Tasks

## 1. Cache age policy and configuration

- [x] 1.1 Add user-only optional candidate cacheTtlMs validation and document opt-in configuration/estimated TTL semantics; verify existing config stays unchanged and malformed TTLs are rejected.
- [x] 1.2 Add backward-compatible branch-local cache activity and consumed-expiry state with injected-clock policy; verify threshold equality, unexpired/disabled state, legacy restore, persisted resume/fork, failure/direct isolation and clock rollback behavior.

## 2. Native dispatch integration

- [x] 2.1 Wire successful physical session responses into persisted activity using the real Pi success lifecycle; verify successful normal/tool responses refresh age and failed/aborted/direct traffic does not.
- [x] 2.2 Await the existing bounded flush bridge at same-model expiry before provider dispatch; verify pending context changes reach the real fake provider, healthy route stays sticky, retry does not repeat consumed expiry and failure/timeout/abort prevent dispatch without consumption.
- [x] 2.3 Compose expiry with actual transitions and add distinct estimated-invalidation observations; verify one flush when switch and expiry coincide, physical events/counters remain physical-only, no initial/direct/miss-driven flushes, and document flush/system-adjunct limits.

## 3. Integrated verification

- [x] 3.1 Run Pi1.1.0 typecheck, full router tests, package dry-run, strict OpenSpec validation and diff check; record commands/counts and fix review findings before reporting completion. No live activation or provider cache guarantee claimed.
