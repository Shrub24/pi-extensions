# Proposal

## Why

Long-lived Pi sessions need explicit physical-model stickiness and bounded provider failover without losing native credentials, transports or usage records. Gateway routing hides cache boundaries and cannot coordinate pending Magic Context transformations before a replacement request.

## What Changes

- Add a small `pi-native-router` package registering configurable `route/<role>` virtual models with ordered native registry candidates.
- Persist sticky route state on the session branch; keep auxiliary/direct routing independent.
- Classify failures, track local model/provider cooldowns, and use Pi retries plus bounded terminal recovery rather than a custom execution loop.
- Expose an awaitable physical-transition seam and observational decisions; await Magic Context flush before physical switches, never on initial selection or repeated same-model requests.
- Verify parent/worker parity, restore/fork behavior, abort safety and exhaustion. Disable Magic Context's independent idle-TTL trigger while retaining the 200k pressure threshold through its owning configuration surface.

## Capabilities

### New Capabilities

- `native-model-routing`: Native logical-model selection, sticky physical routes, reliability policy and physical-transition integration.

### Modified Capabilities

None. Herdsman remains the launcher, not the routing authority.

## Impact

New router package, root workspace/test registration, and narrowly necessary worker launch or bundle discovery wiring. Magic Context is a separate repository at `../magic-context`; use its existing `magic-context:flush` request/result API, not its internals. Deployment configuration belongs to the coordinated dotfiles owner; do not activate unrelated changes. No proxy, provider transport, database, shared cooldown service, cache warming or scoring framework.
