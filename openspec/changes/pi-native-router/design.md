# Design

## Context

See proposal.md for motivation. The workspace has independently installable Pi extension packages but no native router package. Prior investigation established that pi-bifrost's input/setModel routing predates Pi virtual models; adopting that baseline would retain the architecture this change explicitly replaces. Build a small native adapter instead, borrowing its separation of policy and reliability, not its transport or switching mechanism.

Pi provides registerVirtualModel, per-request route reasons and branch-persisted router state. Native retries only revisit routing for errors Pi classifies retryable; quota failures therefore need agent_before_settle continuation. Installed bundle documentation paths do not include virtual-models.md, so implementation must inspect matching host package/upstream documentation and verify real types, not assume the older Herdsman devDependency is current.

Magic Context at ../magic-context exposes magic-context:flush and magic-context:flush-result through packages/pi-plugin/src/ctx-lifecycle-events.ts. Results currently identify sessionId, status, reason and pendingOps; there is no request correlation identifier. Its context/extension-seams.md explicitly rejects direct imports because duplicate module identities and load order make them brittle.

## Goals / Non-Goals

**Goals:** One independently installable package, pure routing/reliability decisions, a thin host adapter, faithful lifecycle tests and documented configuration. Parent and worker instances use identical policy.

**Non-Goals:** New execution transport, setModel routing, shared health storage, background scheduling, warming, cost scoring or Jev decisions. Do not activate dotfiles or unrelated bundle changes.

## Decisions

### Native adapter over a bifrost fork

Keep candidate validation, selection, failure classification and local cooldown calculation independent from Pi event wiring. The native route callback returns registry models and thinking levels. Configuration follows existing extension-manager settings patterns with explicit validation and no default paid routes.

### Session state versus health

Persist only versioned JSON session routing state through Pi's returned router state. Store physical identity and bounded recovery bookkeeping; reconcile removed or changed candidates against current configuration. Health is local process state with model and provider scopes and injected time for tests. Direct routing neither reads nor writes transition bookkeeping or consumes session recovery budgets.

### Pi owns retries and continuations

Transient errors may remain on the physical model for a small configured count before advancing. Native retry scheduling stays untouched. For terminal safe provider errors, the pre-settlement handler requests continuation only if another eligible candidate and remaining budget exist. Verify actual host abort, partial-output, failed-message cleanup and tool semantics before coding this path. Never inject an artificial user instruction or repeat completed tools. Exhaustion must settle, not keep an assignment alive.

### Transition handshake, not asynchronous notification

The route adapter compares the previous session dispatch identity with its proposed physical model. On a real change it awaits registered pre-dispatch work, including a bounded Magic Context request/result handshake filtered by session identity; only after success does it commit transition state and emit observation. Serialize requests within a session to avoid uncorrelated flush results being mistaken for another transition. Expose a replaceable local event-based awaitable seam without importing Magic Context internals. Initial selection and direct requests bypass this session transition path.

### Flush is not compression

Use the existing flush surface, not wrapup. Preserve the 200k pressure threshold; disable the independent idle trigger in the owning config or narrowly scoped Magic Context source if no config surface exists. Because repo-local OpenSpec execution is scoped to pi-extensions, any required external edit must be separately coordinated rather than smuggled into this package. Pi 1.1.0 routes before extension context preparation: final effective context is unavailable to the router. For v0.1, select using conservative canonical/latest-successful-usage estimates plus the greater of configured output reserve and candidate maximum output. Require initial candidates to meet the logical configured capacity. Persist a non-decreasing branch capacity requirement no smaller than the route's configured contextWindow; each request must also fit the estimate plus reserve. Capacity is not persisted, so a route can fall back to a smaller window than the model it replaces. Reject smaller-window fallback rather than asserting a hard final-token guarantee. A future late-preparation/re-route host seam is deferred (owner-approved v0.1 compatibility rule).

## Risks / Trade-offs

- Pi 1.1.0 awaits routing before extension context handlers for initial calls, native retries and settlement continuations. Verify provider-visible pending-op materialization separately from the flush result: Magic Context signals history/materialization for the next context pass, but system adjunct refresh waits for the next before_agent_start (not native retry/continuation). Final extension-added tokens cannot be bounded here; v0.1 preserves capacity rather than shrinking it.
- Flush bridge lacks correlation → serialize local handshakes, filter by session, bound timeout, and report any unavoidable concurrent-emitter ambiguity.
- Error strings do not reliably expose headers or account scope → conservative classification, use structured information only when available, document provider-level granularity.
- Old dev types can hide lifecycle mistakes → compile against the matching current Pi API and run the adapter through a native host fixture.
- Shared deployment owner may be unavailable → finish local implementation and evidence, provide exact required deployment settings; do not claim deployed validation without running it.

## Migration Plan

Ship opt-in with no logical routes until configured. Add the package to workspace validation. Document route definitions and parent/worker discovery, and hand bundle/config activation to its owner. Rollback is removing router loading and selecting physical models directly; existing provider credentials are unchanged.
