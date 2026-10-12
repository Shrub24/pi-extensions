# Remove Manager orchestration

## Decision

Manager is removed from pi-herdsman. The Manager role, its `/manager` command,
its per-workspace lease, its project-assignment and project-message stores, and
its worktree orchestration (`staff_delegate`, `staff_stop`, `staff_complete` and
`staff_discard`) go with it. [ADR 0012](0012-manager-owns-project-assignment-resolution.md)
is superseded by this record.

- Chief keeps direct supervision of its ordinary Leads. Only its Manager-report
  branch goes.
- The `project_assignment` message kind goes with its producers. Every producer
  was inside the Manager's project-delegation path, so no producer survives
  the removal.
- `manager` is no longer an operator role. A persisted `manager` role reads back
  as `lead` in the session entry, the lead coordination state and the peer
  record. The `managers/` runtime directory is no longer created or read; an
  existing directory is left in place, inert.
- The `manager-recovery` smoke scenario and its runner tests are removed with
  the code.

Test decisions recorded with the removal:

- The cascade-close test was deleted rather than migrated. It counted reads of
  the parent's state file, an oracle the canonical observation now trips, so a
  read count can no longer identify the caller. Its coverage is now
  `control-integration.test.ts` "a generation replaced after the request is
  resolved is refused untouched", which shows the parent generation is
  revalidated under its assignment lock and that the control-request close is
  the only path passing `expected`.
- A cached `unknown` definition is never a resolution. Recurring ticks stay
  transcript-free, and an explicit listing re-reads. The root cause was
  `runtimeIdentityMatches` calling `sameCwd` with an undefined canonical cwd and
  reporting `unknown` from the catch.
- The identity cwd gate applies only when both sides report one. This scopes the
  remaining comparison inside `runtimeIdentityMatches`; it does not reinstate the
  Herdr-only cwd requirement that ADR 0031 ("Legacy child identity (Option A)")
  drops.

## Rationale

Manager's worktree orchestration is outside the useful scope of the Herdr-free
Radar cutover. Chief and Lead supervision cover the coordination that remains in
scope, and they do not depend on Manager state.

Leaving a persisted `manager` role unmapped would make a legacy session fail
when its state is read. Mapping it to `lead` keeps those sessions readable
without keeping a Manager vocabulary alive. Leaving the lease directory inert
avoids a deletion step with no consumer.

## Alternatives considered

- **Launch a worker into a selected existing worktree pane.** Rejected. Radar's
  spawn places a child beside its parent and offers no contract for launching
  into a selected existing worktree pane, and since Manager was never used,
  extending Radar for it was not justified.
- **Delete the lease directory and its entries.** Rejected for now. It needs a
  deletion step with no consumer after the code is gone. The directory is inert
  and can be removed later if it becomes a nuisance.
- **Keep Manager as a role and remove only the worktree launch.** Rejected. The
  remaining Manager surface (lease, project messages, dashboard) has no owner
  once project assignment is gone.

## Consequences

No live Manager acceptance remains. The `manager-recovery` smoke was the only
end-to-end check of the Manager path, and it goes with the code.

Retained-worker relaunch and continuation still use `worktreeGroupScope`,
`startHerdrAgentInPane` and `stopHerdrAgentPreservingPane`. Those helpers stay
until the relaunch slice replaces them, so their removal is not part of this
decision.
