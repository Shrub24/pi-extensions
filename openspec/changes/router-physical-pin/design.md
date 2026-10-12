# Design

## Pin state

A pin is a custom branch entry, `native-router:physical-pin`, with data `{ role, identity }`, where `identity` is `provider/id` plus the account when one is bound, or `null` for `auto`. The last entry for a role on the current branch wins, so resume and fork behave as they do for thinking choices. Nothing is stored outside the session branch.

## Selection

`choose()` already takes a preferred identity and falls back to the first usable candidate. The pin is passed as the preferred identity on every resolution, ahead of the current physical model:

- preferred = `state.next` (recovery) when set, else the pin when set, else the current physical model.

Recovery keeps priority so a failed pinned candidate still fails over normally. The pin becomes preferred again on the next request after the candidate is eligible. A pin that is unusable for a request is simply not chosen; route order decides, and the pin is not cleared.

## Cycling

The cycle target is computed from the candidate list in route order. Starting after the currently serving candidate (or the pin, when set), it selects the first candidate that is eligible and fits the current context estimate, wrapping once. The cycle writes the same pin entry as the picker. If no candidate is eligible, it notifies and changes nothing.

## Command and hotkey

- `/route-pin` with no argument opens `ctx.ui.select` with `auto` and each candidate label. Without a UI it lists the candidates and the current pin.
- `/route-pin <label>` and `/route-pin auto` set the pin directly; argument completion lists the labels.
- The hotkey is registered with `pi.registerShortcut` and is configurable under the router config (`shortcuts.cyclePin`). It is registered at load, so a change takes effect on restart.

## Footer and telemetry

The physical item gets a pin mark (`⚑`) while a pin is set. A pin that is dormant still shows the mark, so the user can see that the choice is not in effect. The decision log records each manual change with reason `manual`.

## Cache

Changing the physical model goes through the existing transition path, which flushes Magic Context before the next dispatch. The command and hotkey say that the route's cache rebuilds on the next request.
