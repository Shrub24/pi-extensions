# Design: model policy

## Context

A child's model is decided in `resolveChildModel` (`extension/agent-definitions.ts`): a
pinned `model:` is passed through as written with `extensionDiscovery: false`; otherwise the
spawning controller's model is used, and the extension-discovery exception applies when that
model's provider is registered by an extension; otherwise Pi's default applies. The decision
becomes `--model` and, for a denied definition, `--no-extensions`.

Delegation parameters are closed — `agent_delegate` accepts `definition`, `task`, `label`
and `files` with `additionalProperties: false` — so no agent can name a child's model. The
sources are therefore exactly two: the operator's definition file, and the controller's own
model.

The herdsman configuration is a flat, strictly validated JSON schema where unknown fields and
invalid values are errors.

## Goals

- An operator can state which models an agent may run on, and have a violation stop the launch.
- The diagnosis names the definition and the model, not just Pi's later "model not found".
- A definition that pins an extension-provided model while denying extension discovery fails
  immediately and says why.

## Non-Goals

- Letting an agent choose a child's model. The delegation parameters stay closed.
- A cost or token budget, and a thinking-level cap (pi-subagents had `maxThinking`); both are
  adjacent, deliberately deferred, and separate changes.
- Rewriting a definition's pinned model. The policy rejects; it never substitutes.
- Changing what a `continue` resumes: a continued session keeps its saved model, which the
  policy then checks like any other.

## Decisions

### D1 — The policy lives in the herdsman configuration

`modelScopes` is one new key beside `retainWorkers` and `spawnPlacement`, so an operator can
constrain a *bundled* definition without authoring an overlay for it, and one file holds every
operator policy. A per-definition frontmatter field was rejected: it cannot constrain a bundled
definition, it would grow the definition schema for an operator concern, and the disable list
already establishes the configuration as the place for roster policy.

### D2 — A candidate must satisfy every scope that exists

The global `allow` list and the agent's own `allow` list are both applied when both are
present; a model must appear in each. An absent list is unrestricted. Per-agent lists are
therefore restrictions, never exemptions, which is the direction that fails safe.

### D3 — Patterns are exact, trailing-wildcard, or the reserved `$inherited`

`provider/model` matches exactly; `provider/*` matches any model of that provider;
`$inherited` matches a model the launch inherited rather than pinned. `$inherited` exists so
an operator can write "unpinned agents may follow me, pinned agents must be on this list"
without enumerating every model the controller might be switched to. It never matches a pinned
model, because a pin is the case the policy exists to constrain.

### D4 — A violation fails the launch, and names the reason

The launch fails with a typed error naming the definition, the resolved model, whether it was
pinned or inherited, and the scope that rejected it. Substituting a permitted model was
rejected: it would silently run work on a model the definition did not ask for, and the
definition's `model:` is often a deliberate capability choice rather than a preference.

### D5 — A pinned extension-provided model fails fast when discovery is denied

When a definition pins a model whose provider an extension registers and also sets
`noExtensions: true`, the launch fails immediately with a diagnostic naming both facts and the
two ways out (drop the denial, or pin a model a built-in provider serves).

Silently enabling extension discovery for that model was rejected: `noExtensions: true` is a
deliberate "keep the child lean" decision, and contradicting it quietly trades a loud failure
for a subtle one — a child that loads extensions the definition said not to load. The current
behaviour is worse than either: the contradiction surfaces as Pi's `Model "<id>" not found`
two seconds later, which reads as a missing model rather than as a conflicting definition.

## Risks

- **A restrictive policy blocks work.** The failure is loud and names the scope, so the operator
  can widen it deliberately.
- **Nested agents.** A nested agent inherits its managed parent, so a policy on the parent's
  definition governs the model a grandchild inherits. Stated in the docs.
- **Two places to look.** A model can be pinned in the definition and constrained in the
  configuration. The error names both, which is the mitigation.
