# Proposal

## Why

A route picks its physical model by order, stickiness and eligibility. When the user wants a specific candidate for a while, for example a cheaper model for a cheap task or a particular account, there is no way to choose it without editing config or waiting for a failure. A manual pin and a cycle hotkey give that choice while keeping the route's fallbacks.

## What Changes

- Add a per-role physical pin, stored on the session branch. It is a preference: the pinned candidate is tried first whenever it is eligible and fits the request.
- Add `/route-pin`, which opens a picker of the route's candidates plus `auto`. It also accepts a candidate label or `auto` as an argument, for completion and scripting.
- Add a configurable hotkey that moves the pin to the next eligible candidate in route order and wraps around.
- When the pinned candidate cannot serve a request (cooldown, exhausted quota, or too small for the request), the router uses route order for that request and keeps the pin. The pin resumes when the candidate is eligible again.
- Show a pin mark on the physical footer item. Log each manual change with reason `manual`.

## Capabilities

### New Capabilities

- `physical-pin`: a user-chosen, branch-scoped physical preference for a route, with a picker, a cycle hotkey, dormant fallback and visible state.

### Modified Capabilities

None. Stickiness, failure-driven fallback, shared health and capacity rules are unchanged; the pin only changes which eligible candidate is tried first.

## Impact

`pi-native-router` policy selection, branch state, command and shortcut registration, footer status, decision log, README and focused tests. A pin change is a physical-model change, so the existing Magic Context flush runs on the next request. No Magic Context, provider, or dependency changes.

## Non-goals

- Quota-based or cost-based automatic selection.
- A pin shared across sessions or roles.
- Disabling fallback. A pin never makes a route fail when another candidate can serve.
