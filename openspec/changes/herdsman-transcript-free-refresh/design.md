# Design

## Context

See `proposal.md` — Why. Constraints that shape the approach:

- The measured burn on an idle lead is two `SessionManager.open` (body-load) calls per
  2 s tick from one predicate (`isLeadSessionBoundary`, `extension/index.ts:2280`),
  reached only from `managedAgentSnapshots` with `proveLead=true` (`:3161`), plus
  `persistedSessionName` (`:2269`) reached from the supervision snapshot (`:10897`) —
  both byte-identical to the upstream code PR #229
  (merge `f4f249a2b2c74d2a5c4c960b9705ca9ea6974c80`) deleted.
- Existing identity checks are already bounded and stay allowed: `matchesExpectedSession`
  (`extension/herdr.ts:1902`-`1992`) resolves a path expectation with
  `readPiSessionHeaderId` — a 4 KiB-chunk header scan that stops at the first newline
  within a 1 MiB budget. That is not a body load and must not be replaced by one.
- `leadSessionIds` has one consumer: `statusBreadcrumb` (`:3766`). `loadStatusSnapshot`
  hardcodes the lead breadcrumb (`["herd"]` when `controllerScope.kind === "lead"`),
  so a lead's own periodic proof is unused; only the worker-leaf path consumes it.
- Local preconditions for the upstream predicate already exist:
  `readLeadCoordinationState` (`:257`, defined in `supervision.ts`) and
  `supervisionRuntime()` (defined `extension/supervision.ts:904`, imported
  `extension/index.ts:223`), with live leads already carrying
  `role: "lead"` coordinator records (verified, `.pi-herdsman/read-loop-trace.md`).
- The local supervision path already has a generation guard
  (`currentSupervisionGeneration`, `:11943`) but no in-flight coalescing; the status
  path and the health scanner already coalesce with one trailing rerun
  (`statusInFlight`/`statusRefresh` at `:12709`/`:12745`; `healthInFlight`
  rescan loop at `:15575`).
- The published pane-name fact already exists locally: `pi_herdsman_name`, written
  by the pane-metadata publisher and already read at `extension/supervision.ts:2355`.
- Package gates that actually exist: `npm test` and `npm run validate`
  (`check` + `package:audit`). There is no build, lint or typecheck script.

## Goals / Non-Goals

**Goals:**

- Remove every recurring transcript body load from lead status, worker-leaf status,
  health and supervision refresh, without weakening bounded identity checks or
  explicit identity/retirement validation.
- Keep the adaptation textually close to upstream #229 so a later pre-extraction
  baseline adoption does not re-litigate this change.
- Make the honesty of unresolved evidence explicit: `unknown` is displayable, never
  authoritative, never a reason to infer loss.

**Non-Goals:**

- The explicit managed-Lead/worktree lookup that still calls `SessionManager.listAll`
  (upstream #258): an explicit operator/agent action, not the recurring timer burn.
  Upstream's fix also touched manager stats aggregation, which is not part of this
  local surface and is not imported here.
- Adopting the pre-extraction upstream baseline, module extraction, Pi package
  baseline change, durable result reservations or supervision UI redesign.
- Changing the pane-metadata token contract, storage format, config key, or the
  independent proven-lost / `unknown` / expired-`stale` projection.

## Decisions

**1. Remove the recurring transcript proof instead of bounding or caching it.**
Adopt the upstream #229 contract: delete the recurring owner-transcript body load
(`isLeadSessionBoundary`) and the supervision transcript name read
(`persistedSessionName`), and source recurring authority from lead coordination state.
Alternatives considered:
- *Cache keyed by (path, mtimeMs, size)* (`read-loop-trace.md` Option 1): it does cover
  **both** the lead's own recurring proof and the worker-leaf uses of the same
  predicate, so caching is not inherently unable to satisfy this requirement — the
  worker-leaf path is the same `proveLead` predicate, not a separate reader. It does
  not cover the *other* readers, which would need their own handling: the supervision
  name read and the legacy definition fallback. So caching is a viable partial design
  that needs more than one mechanism, and it adds an invalidation surface (mtime
  granularity, atomic replacement, session replaced within the same pane).
- *Reuse the live `ctx.sessionManager` when the path is the current session*
  (Option 2): cheapest for the dominant self-read, but requires proving in-memory
  entries are equivalent to a file parse for conflict/retirement semantics.
- *Bounded header read instead of body parsing wherever an identity is needed*
  (Option 3): already the shipped behaviour for `matchesExpectedSession`; it removes
  nothing further here because the recurring paths need entries, not an id.
- *Prove lead less often* (Option 4): reduces frequency without removing the load and
  makes the breadcrumb lag.
The chosen contract is the one upstream owns and later releases keep, so aligning now
avoids a local-only mechanism that would need re-litigating at baseline adoption.

**2. Authority source: coordination state, degraded to `unknown` under a guard.**
Lead proof becomes the published coordination state role for the owner session. The
local read can throw on malformed/oversized state, so it is wrapped: any failure
degrades to `unknown` rather than failing the refresh. Accepted consequence: a lead
that has published no coordinator record is observed `unknown`. This does not change
a lead's own breadcrumb (hardcoded `herd`) and does not change ownership authority
(which still requires exact session match), but a worker leaf could see `?` where it
previously saw `herd`. Missing coordination evidence never implies loss: `lost` and
expired `stale` keep their existing independent evidence, and the projection for
proven-lost rows is untouched.

**3. Legacy definition fallback disabled on recurring paths only.**
Recurring callers pass `allowTranscriptDefinitionFallback=false` so
`agentDefinitionForRuntime`/`stateAgentDefinition` (`:4776`, `:1473`) return
`unknown` instead of body-loading the legacy transcript. Explicit and continuity
callers keep the fallback.

**4. Unresolved evidence is displayable but not authoritative.**
`unknown` is a legitimate observation: it may be shown as unresolved and may be
republished as the current tick's value. What is forbidden is treating it as durable
truth — persisting it, caching it, or letting it outrank a later explicit resolution.
This is what keeps a periodic `unknown` from poisoning a subsequent explicit legacy
definition resolution.

**5. Names come from published pane facts.**
The supervision snapshot drops the transcript-derived session name and uses the
already-published name fact (`pi_herdsman_name`, `supervision.ts:2355`), then other
already-available observation fields. No new token, no second publisher.

**6. Bound refresh overlap; do not forbid overdue work.**
Require at most one in-flight refresh per kind and at most one pending rerun, with the
existing generation guard deciding publication and shutdown clearing pending work. A
sustained stream of fresh triggers may still cause later runs once the in-flight
refresh finishes — the guarantee is "no concurrency and no unbounded queue", not
"never run back to back". This is the direct answer to the overlap risk in
`read-loop-trace.md` Q3 and matches the status/health behaviour already in place.

**7. Keep the change one coherent "recurring observation is body-load-free" unit.**
The deletions, the authority swap, the fallback gate and the overlap bound are
mutually dependent: any one alone leaves a recurring body load or a misleading state.
#258 stays out because it is an explicit-action path with a different trigger.

## Risks / Trade-offs

- *Recurring path no longer detects a pane/transcript identity mismatch every 2 s* →
  Bounded header identity checks stay in place, and identity/retirement checks stay
  fail-closed on every explicit, continuity and settlement path; the recurring path
  only publishes presentation state.
- *Legacy leads without coordinator records* → `unknown`, never `herd`, never `lost`;
  covered by a regression and called out as a real behaviour difference.
- *Malformed/oversized coordination state* → guarded degradation to `unknown`; a
  refresh must not fail because one coordinator record is bad.
- *A periodic `unknown` could shadow a real value later* → `unknown` is never
  persisted as authoritative, and a regression exercises a periodic `unknown`
  followed by an explicit legacy resolution.
- *Overlap bound mistaken for a hard serialization guarantee* → the requirement states
  no-concurrency plus one-pending, not a prohibition on overdue runs under sustained
  triggers.
- *Fork divergence from upstream* → keep the port textually close to #229 and record
  the deviations here; the local one-expression condition (`loadStatusSnapshot`
  proving lead only for non-lead scopes, `read-loop-trace.md`) becomes redundant once
  the predicate is removed and must not be carried forward.
- *Verification gap: passing tests do not prove a deployed read reduction* → the plan
  requires live before/after idle read-rate sampling on the deployed extension.

## Migration Plan

- No on-disk, config or protocol migration; single coherent commit; no data rewrite.
- Load the extension into the local deployed session and reload sessions, then sample
  idle read rate before/after (per-lead `rchar` over a quiet window) and confirm zero
  transcript body loads on the recurring paths while status/supervision output still
  renders.
- Rollback: revert the commit; nothing persisted depends on the new source of truth.

## Open Questions

- Whether the worker-leaf breadcrumb should keep needing the owner's lead authority at
  all, or could use the worker's own published parent fact instead. Deferrable: either
  answer satisfies the requirements, and this change removes the body load in both
  cases.
- Whether a later local-only fallback for legacy leads without coordinator records is
  warranted operationally. Deferrable: the spec's `unknown` behaviour is correct
  either way, and no requirement or task changes if the answer is "no".
