# Design

## Pin state

A pin is a custom branch entry, `native-router:physical-pin`, with data `{ role, identity }`, where `identity` is `provider/id` plus the account when one is bound, or `null` for `auto`. The last entry for a role on the current branch wins, so resume and fork behave as they do for thinking choices. Nothing is stored outside the session branch.

## Selection

`choose()` takes a preferred identity and falls back to the first usable candidate. Ordered selection keeps an eligible current physical model sticky. When there is no eligible incumbent, preference order is:

- `state.next` (explicit recovery) when set;
- an eligible pin when set;
- the configured automatic selection (route order by default).

A pin cannot pull the route away from a healthy current target after failover cooldown expires. If the incumbent becomes unavailable, the still-stored pin is promoted again. A pin that cannot serve is skipped for that request and is not cleared.

## Cycling

The cycle target is computed from the candidate list in route order. Starting after the currently serving candidate (or the pin, when set), it selects the first candidate that is eligible and fits the current context estimate, wrapping once. The cycle writes the same pin entry as the picker. If no candidate is eligible, it notifies and changes nothing.

## Command and hotkey

- `/route-pin` with no argument opens `ctx.ui.select` with `auto` and each candidate label. Without a UI it lists the candidates and the current pin.
- `/route-pin <label>` and `/route-pin auto` set the pin directly; argument completion lists the labels.
- The hotkey is registered with `pi.registerShortcut` and is configurable under the router config (`shortcuts.cyclePin`). The default is `ctrl+shift+m`, which Pi leaves unbound; `ctrl+shift+p` is taken by `app.model.cycleBackward`. It is registered at load, so a change takes effect on restart.

## Footer and telemetry

The physical item gets a pin mark (`⚑`) while a pin is set. A pin that is dormant still shows the mark, so the user can see that the choice is not in effect. The decision log records each manual change with reason `manual`.

## Cache

Setting a pin does not itself switch the physical model. When selection changes candidates because the incumbent is unavailable, the existing transition path flushes Magic Context before replacement dispatch. The command explains that a healthy incumbent stays sticky; the ordinary failover notice reports an actual cache rebuild.
