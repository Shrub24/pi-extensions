## Why

Users need to change a route's automatic priority and temporarily exclude candidates without editing global configuration, while retaining explicit manual access to every configured candidate.

## What Changes

- Add `/route-order` with a native Pi custom editor and `/route-order reset`.
- Keep order and automatic-enabled overrides in memory per session and route, clearing on route exit.
- Reconsider automatic priority once after apply/reset, then resume normal stickiness and safety rules.
- Apply overrides to strategies, previews, native retry/recovery and quota-resumption readiness.

## Capabilities

### New Capabilities

- `session-route-order`: session-local editing of candidate order and automatic eligibility.

## Impact

Only `pi-native-router` and this change's OpenSpec artifacts. Uses the host's existing Pi TUI package; no new reorder-list dependency. No global settings, session snapshots, provider calls, or deployment.
