# Prove a live managed generation by a claimed alias

## Decision

A managed generation counts as live only when the inventory carries exactly one
agent record that matches the expected pane, working directory and Pi session
**and reports the run-scoped alias**. An exact occupant whose reported name is
missing is `unknown`, with an `aliasUnclaimed` diagnostic naming the alias and
the pane.

Nothing acts destructively on that evidence. The listing projects `unknown` with
`recovery_only` and no available tools, and every control that would close,
retire or relaunch refuses with the diagnostic and the `{ label, paneId }` ids
rather than a terse generic message: the close preflight at its entry and at its
fresh re-read, the cascade preflight, the continued-session decision in
`agent_continue`, and the control request path. The mailbox, the saved Pi session
and any unread result are left intact.

`herdrAliasMatchesIfReported` keeps tolerating an unreported name. Post-launch
verification, which runs after the launch path has already matched the record,
and the inference that a generation is lost both keep their existing behaviour.

## Rationale

Every destructive control closes a generation through `herdr agent get <alias>`,
while liveness was decided from the inventory, where a record reporting no name
still matched on pane, working directory and session. The two could therefore
disagree: a listing advertised an idle, closable worker whose close and continue
then failed with `herdr ... not found`. ADR 0020 rejects exactly that —
advertisement and enforcement must agree — and the correction belongs where the
evidence is proved, not in the projection that reads it.

The tolerance is why the pane cannot be the proof. In the observed case a pane
resolved by pane id while an operator-mode process ran the same saved session in
it, with no alias resolving: a close authorised by pane-id resolution would have
killed the operator's own process. Only a record claiming the run-scoped alias
authorises a destructive action, and the absence of a claim is not the absence of
a process — an unresolved alias never proves that a generation is lost.

## Alternatives rejected

- A roster-only predicate that gates the advertised tools while presence stays
  tolerant: rejected because `agent_extend`, the digests, the cascade preflight
  and result cleanup read presence directly and would keep treating an unclaimed
  record as live — the same divergence, moved rather than fixed.
- Resolving the close by pane id when the alias does not resolve: rejected
  because it cannot distinguish the managed generation from an operator process
  occupying the pane.
- Reading a missing alias as a lost generation and recovering it: rejected
  because alias absence proves nothing about the process; recovery would relaunch
  a second process beside a live one.

## Consequences

An unclaimed occupant is diagnosable but not resolvable: nothing in the product
closes or recovers that pane. A recovery path needs an explicit operator
decision, and durable launch-time pane-process provenance would let that shape be
proved without the alias. Both are deferred.

The same evidence refuses as `target_ambiguous` from `agent_close` and
`agent_continue` and as `target_not_found` from a control request, because
control's mapping from unprovable presence predates this decision. Unifying the
category, or adding a dedicated code, is a separate decision.
