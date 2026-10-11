# Design

## Context

See proposal.md for motivation. The current native adapter serializes session route callbacks, persists JSON virtual-model state, and flushes only when the physical identity changes. Native Pi 1.1.0 routes before the extension context pass and provider dispatch, including retries and boundary continuations. Magic Context's existing bridge sets pending drop/history flags; the next real context pass consumes them. Successful flush does not reread disk-backed system adjuncts mid-turn.

## Goals / Non-Goals

**Goals:** add the smallest request-driven expiry policy to the existing physical-dispatch seam; keep behavior independently testable with an injected clock and real Pi fake-provider tests.

**Non-Goals:** selecting warmer alternatives, confirmed cache eviction detection, timers, warming traffic, cache economics, provider guarantees, Magic Context internals, cross-process coordination, deployment activation or changing the 200k pressure threshold.

## Decisions

1. **Opt-in candidate `cacheTtlMs`.** Positive finite integer milliseconds; omitted disables this feature. TTL belongs to the actual provider/model, not the virtual role. No provider defaults are asserted: request caching options and account behavior vary. The existing user-only config boundary remains authoritative.
2. **Successful responses, not attempts, anchor idle age.** Record activity only for successful session physical responses (including tool use), never direct traffic or errors/aborts. Use Pi's real success-event seam and persist cache metadata in branch-resident state; prove updates are visible to the next native routing callback. A dispatch-time timestamp would falsely extend warmth on provider errors. Metadata is advisory and branch-local, not proof that providers share a cache across forked processes.
3. **One consumption marker per successful-activity epoch.** Awaiting an acknowledged flush consumes the expired epoch; further retries without success do not repeatedly flush. A new successful response starts a fresh epoch. Initial selection and legacy state without age evidence do not force a TTL flush. Clock rollback must not create negative ages or uncontrolled repeated invalidation.
4. **Flush once at the physical-dispatch boundary.** Determine actual transition and expiry before any flush. If both apply, existing transition flushing satisfies both; otherwise same-model expiry uses the bounded existing bridge without pretending that a physical transition occurred. Reuse the abort/timeout contract, preserving physical-only transition counters/events. An additional awaitable cache-boundary contract is justified only if its concrete integration requires it; do not introduce a lifecycle framework.
5. **Retain healthy-route stickiness.** Owner selected this over preferring a warm alternative. Expiry materializes pending context but does not reorder candidates, create artificial warming requests or infer invalidation from cacheRead=0.

## Risks / Trade-offs

- [TTL is an estimate] → explicitly report estimated expiry; use configured values only.
- [Branch callbacks can overwrite success metadata] → native-host tests must prove response activity is persisted and read before the next request, including continuation, resume and direct isolation.
- [Failed flush accidentally consumes expiry] → consume only after acknowledgment and abort checks; verify provider receives no affected request on failure.
- [Simultaneous retry/switch/expiry duplicates flush] → decide one dispatch boundary and assert provider-visible context plus flush count with a controlled clock.
- [Context assembly and system-adjunct limitations] → preserve the initial router's capacity floor and scoped pending-transform contract; no new host patch.

## Migration Plan

Old configuration and branch state continue working without TTL. Users may configure `cacheTtlMs` on their physical candidates after installation; examples are illustrative, not asserted provider TTLs. Removing the setting disables expiry flushing without changing provider selection. No live settings, external repositories or deployment pins are changed by this implementation.
