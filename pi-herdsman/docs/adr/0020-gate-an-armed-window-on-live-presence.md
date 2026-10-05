# Gate an armed window on live presence

## Decision

`agent_extend` revalidates that the target is currently live before it replaces
an armed soft window, and fails with `agent_busy` when it is not. The
precondition is the same one the advertised-controls gate uses — the target's
observed presence is `live` — rather than the `working`/`waiting`/`blocked`
triad the soft-deadline digest pass requires before it acts.

## Rationale

Enforcement and advertisement have to agree. Recovery arms and keeps a soft
window for any directly-owned unresolved request, so the existence of an armed
window proves only that a window was recorded, never that the worker it belongs
to is still running. The advertised-controls gate already excluded a non-live
target, which left the two disagreeing: the control was withheld from the model
while a direct call still succeeded, rewrote the deadline and appended a durable
`extended` entry for an assignment that was not running.

Using the digest's triad instead would introduce the same class of divergence in
the other direction: the advertised gate admits every live target, including a
live `settling` worker, so requiring `working`/`waiting`/`blocked` would refuse
a call the model was offered.

## Alternatives rejected

- Infer liveness from the armed window: the defect this replaces.
- Copy the digest's triad: creates a new advertisement/enforcement divergence.
- Check only the assignment state (resolved, idle): a recovered record whose
  worker is no longer observed can still hold an unresolved assignment.

## Consequences

- A proven `lost` target never reaches this branch: `resolveRuntime` fails first
  in `validateIntegration` with `invalid_request`, because the pane it would
  validate against is gone.
- The reachable case is an `unknown` presence — the pane still answers, but the
  inventory no longer proves the worker's exact identity. The listing marks that
  presence `recovery_only`, and `recovery_only` is set for `unknown` only, so the
  live check is equivalent to the advertisement's `live && !recovery_only`.
- Extending a dead worker recorded a deadline for work that was not running; it
  could not revive the worker or publish anything.

## See also

- [Advisory soft-deadline checkpoints](0014-advisory-soft-deadline-checkpoints.md)
