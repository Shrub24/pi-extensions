# Proposal

## Why

Physical model transitions already flush Magic Context before dispatch, but a healthy sticky route can also lose prompt-cache locality after idle TTL expiry. Materialize pending context changes at that estimated cache-bust boundary rather than preserving an obsolete prefix or reviving an independent idle timer.

## What Changes

- Add optional user-owned TTL configuration per physical candidate; omitted TTL disables expiry handling.
- Track branch-local successful physical-request activity and consumed expiry boundaries across resume and fork.
- On the next session request after TTL expiry, await the existing Magic Context flush bridge before context transformation and provider dispatch, even when the physical model is unchanged.
- Retain healthy-route stickiness. Flush once per expired activity epoch; retries and simultaneous switch/expiry must not duplicate it.
- Report estimated expiry separately from physical-model transition events. No confirmed-cache-miss claim or artificial warming request.

## Capabilities

### New Capabilities

- `physical-cache-lifecycle`: Request-driven cache age and once-only pre-dispatch context flush at configured physical-route TTL expiry.

### Modified Capabilities

None. This composes with the completed, not-yet-archived `pi-native-router` change; healthy-route stickiness and failure-driven fallback remain unchanged.

## Impact

`pi-native-router` configuration, branch state, native Pi adapter, flush seam, README and focused tests. Uses the existing Magic Context flush protocol; no Magic Context source/config changes, provider transport, timers, dependencies, deployment changes or shared cross-process health database.
