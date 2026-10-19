# Design

## Pin state

A pin is a custom branch entry, `native-router:physical-pin`, with data `{ role, identity }`, where `identity` is `provider/id` plus the account when one is bound, or `null` for `auto`. The last entry for a role on the current branch wins, so resume and fork behave as they do for thinking choices. Nothing is stored outside the session branch.

## Selection

`choose()` takes a preferred identity and falls back to the first usable candidate. A newly written pin entry carries a one-shot override bit: the next resolution tries that eligible target before current-target stickiness or automatic recovery preference. The router consumes the bit only after it has prepared a dispatch, then keeps the chosen physical target sticky. The pin identity remains stored; if the incumbent later becomes unavailable, the pin is preferred again. If the pin is ineligible on the override request, the existing health/context/route fallback applies and the override is consumed once a fallback dispatch is prepared.

## Cycling

The cycle target is computed from the candidate list in route order. Starting after the currently serving candidate (or the pin, when set), it selects the first candidate that is eligible and fits the current context estimate, wrapping once. The cycle writes the same pin entry as the picker. If no candidate is eligible, it notifies and changes nothing.

## Command and hotkey

- `/route-pin` with no argument opens `ctx.ui.select` with `auto` and each candidate label. Without a UI it lists the candidates and the current pin.
- `/route-pin <label>` and `/route-pin auto` set the pin directly; argument completion lists the labels.
- The hotkey is registered with `pi.registerShortcut` and is configurable under the router config (`shortcuts.cyclePin`). The default is `ctrl+shift+m`, which Pi leaves unbound; `ctrl+shift+p` is taken by `app.model.cycleBackward`. It is registered at load, so a change takes effect on restart.

## Footer and telemetry

The physical item gets a pin mark (`⚑`) while a pin is set. A pin that is dormant still shows the mark, so the user can see that the choice is not in effect. The decision log records each manual change with reason `manual`.

## Cache

Setting a pin does not dispatch immediately. The next route resolution honors an eligible new pin even when the incumbent is healthy, using the existing transition path and awaited Magic Context flush before replacement dispatch. After selection the target stays sticky. The command explains this one-shot override; the ordinary transition notice reports the actual cache rebuild.
