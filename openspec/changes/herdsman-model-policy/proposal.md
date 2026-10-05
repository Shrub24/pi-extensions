# Model policy for delegated agents

## Why

Pi-subagents could constrain which model a given agent definition runs on
(`modelScope`: a global allow list, per-agent overrides, and `enforce`/`strict` flags). Herdsman
has no equivalent. Two consequences, both observed while porting the dotfiles setup:

**Any model can be pinned per definition, unvalidated.** A definition's `model:` is passed to
Pi as written. A typo or a model the operator's account cannot reach fails as
`Model "<id>" not found` about two seconds after the worker launches, with nothing pointing at
the definition.

**A child silently inherits whatever the controller runs on.** With no `model:` pinned, a
fresh delegation inherits the spawning controller's model (a nested agent inherits its managed
parent's). Nothing lets an operator say "this agent may never run on that model".

A third, narrower failure follows from the same resolution code: when a definition pins a model
whose provider is registered by an extension **and** sets `noExtensions: true`, herdsman emits
`--no-extensions`, and the child dies with the same two-second `Model not found` error. The
extension-discovery exception is applied only to inherited models, so a pinned one has no
escape.

## What Changes

- New `modelScopes` key in the herdsman configuration: an optional global `allow` list, and
  optional per-definition `allow` lists under `agents`.
- A candidate model must satisfy every scope that exists. Patterns are an exact
  `provider/model`, a trailing-wildcard `provider/*`, or the reserved token `$inherited`,
  which matches a model the launch inherited rather than pinned.
- A launch whose model violates the policy fails closed, naming the agent, the model, and the
  scope that rejected it.
- A pinned model whose provider is extension-registered fails fast with a diagnostic naming the
  contradiction, instead of reaching Pi and dying two seconds later.
- `docs/reference/configuration.md` documents the key and the pattern syntax.

## Impact

- Affected: `pi-herdsman` — configuration schema and validation, child-model resolution, launch
  admission, tests, and the configuration reference.
- Not affected: briefs, response contracts, waiting state, pane metadata, tool policy, and any
  configuration that does not set `modelScopes` (the default remains "anything the definition
  pins, else the controller's model").
- Compatibility: the configuration gains one optional key; unknown or malformed scopes are
  errors, so a typo fails loudly instead of silently permitting everything.
