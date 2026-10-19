# Proposal

## Why

A route picks its physical model by order, stickiness and eligibility. When the user wants a specific candidate for a while, for example a cheaper model for a cheap task or a particular account, there is no way to choose it without editing config or waiting for a failure. A manual pin and a cycle hotkey give that choice while keeping the route's fallbacks.

## What Changes

- Add a per-role physical pin, stored on the session branch. It is a preference beneath a healthy current physical target; when no incumbent is eligible, the pin is tried ahead of configured route order.
- Add `/route-pin`, which opens a picker of the route's candidates plus `auto`. It also accepts a candidate label or `auto` as an argument, for completion and scripting.
- Add a configurable hotkey that moves the pin to the next eligible candidate in route order and wraps around.
- When the pinned candidate cannot serve a request (cooldown, exhausted quota, or too small for the request), the router preserves a healthy current target or uses configured automatic selection for that request and keeps the pin. The pin becomes preferred when there is no eligible incumbent.
- Show a pin mark on the physical footer item. Log each manual change with reason `manual`.

## Capabilities

### New Capabilities

- `physical-pin`: a user-chosen, branch-scoped physical preference for a route, with a picker, a cycle hotkey, dormant fallback and visible state.

### Modified Capabilities

Failure-driven fallback, shared health and capacity rules are unchanged. A pin changes preference order but does not force a switch away from a healthy incumbent.

## Impact

`pi-native-router` policy selection, branch state, command and shortcut registration, footer status, decision log, README and focused tests. A pin change alone does not force a physical-model switch. If selection changes the physical model, the existing Magic Context flush runs before dispatch. No Magic Context, provider, or dependency changes.

## Non-goals

- Quota-based or cost-based automatic selection.
- A pin shared across sessions or roles.
- Disabling fallback. A pin never makes a route fail when another candidate can serve.
