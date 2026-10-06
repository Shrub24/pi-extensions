# Proposal

## Why

An idle lead process body-loads its **own full Pi session transcript twice every 2 s**:
the status refresh reaches `agentSnapshotView(..., proveLead=true)` →
`managedAgentSnapshots` → `isLeadSessionBoundary`, which calls `SessionManager.open`
on the owner's JSONL twice per tick (a full read + parse each). Measured on the live
leads: ~38 MB transcript, ~230 ms per open, ~38 MB/s of `rchar` while idle
(`.pi-herdsman/read-loop-trace.md`). Our line is byte-identical to the upstream code
that had this exact defect; upstream fixed it in PR #229 (merge commit
`f4f249a2b2c74d2a5c4c960b9705ca9ea6974c80`, shipped as v0.19.1), and our fork still
pays the cost. This change ports the bounded #229 adaptation now, without adopting
the broader pre-extraction baseline.

## What Changes

- **Recurring observation paths stop loading transcript bodies.** The 2 s status path,
  the worker-leaf status path, the health scan and the supervision snapshot derive
  their facts without `SessionManager.open` and without reading or parsing a session
  transcript body.
- **Existing bounded header identity checks stay.** Exactly the current behaviour is
  permitted and unchanged: an exact-path identity proof may read the bounded session
  header (`matchesExpectedSession` → `readPiSessionHeaderId`, a ~4 KiB-chunk scan that
  stops at the first newline within a 1 MiB budget). That is not a body load and must
  not be replaced by one.
- **Periodic lead proof uses coordination state.** The status and worker-leaf paths
  derive lead authority from Herdsman's own Lead coordination state instead of the
  owner transcript's entries.
- **Missing or malformed coordination evidence stays `unknown`.** The derivation is
  guarded so a bad/unreadable coordinator record degrades to `unknown` (never throws
  the refresh, never claims `herd`). Missing coordination evidence alone MUST NOT
  infer `lost`; the independent proven-lost, `unknown` and expired-`stale`
  classifications are unchanged. A lead that has published no coordinator record may
  therefore breadcrumb `?` where the transcript check previously said `herd`.
- **Unresolved observations stay honest, not authoritative.** `unknown` may be
  displayed and republished as this tick's observation, but MUST NOT be persisted or
  trusted as a session's authoritative identity, definition or authority, and a later
  explicit resolution wins over an earlier periodic `unknown`.
- **`persistedSessionName` body-loading is removed from supervision.** The supervision
  snapshot reuses the already-published pane-name fact (`pi_herdsman_name`,
  `extension/supervision.ts:2355`) instead of opening each live `kind:"path"` session
  to call `getSessionName()`.
- **Legacy definition fallback is off on periodic paths only.** Periodic callers pass
  `allowTranscriptDefinitionFallback=false`, so `agentDefinitionForRuntime` /
  `stateAgentDefinition` report `unknown` rather than body-loading a legacy transcript;
  explicit and continuity callers keep the fallback.
- **Refresh overlap is bounded and shutdown-safe.** At most one refresh of a kind runs
  at a time and at most one pending rerun is queued; superseded generations and
  shutdown publish nothing. Sustained fresh triggers may still cause later runs once
  the in-flight refresh finishes.
- **Explicit and continuity paths keep full validation.** `sessionAgentIdentity`,
  `sessionContextRetired`, `retiredManagedSession`, `readAgentTranscript`, the
  `readPersistedTranscript` command and settlement/continuation identity checks still
  validate against real transcript contents and are unchanged.
- **BREAKING**: none. No storage format, token contract, config key, dependency,
  migration or CLI surface changes.

Out of scope: the explicit managed-Lead/worktree lookup that still calls
`SessionManager.listAll` (upstream #258 — an explicit-action path, not this idle timer
burn), and any adoption of the pre-extraction upstream baseline, module layout, Pi
baseline or durable schema changes.

## Capabilities

### New Capabilities

- `herdsman-observation-refresh`: the recurring observation contract — which refresh
  paths may load what, which bounded session reads remain permitted, what authority
  source proves lead/worker identity on those paths, how unresolved evidence is
  reported without becoming authoritative, and how a refresh overlapping its own
  interval behaves.

### Modified Capabilities

None. Existing capabilities (`herdsman-agent-hierarchy`, `herdsman-pane-metadata`,
`herdsman-definition-controls`, `herdsman-retained-workers`,
`herdsman-background-work`) describe token publication, definition resolution and
lifecycle authority; this change alters the *recurring observation* contract and the
authority source used on refresh paths, not those requirements. Where a local
requirement's text overlaps behaviour touched here is recorded in `design.md`.

## Impact

- Code: `pi-herdsman/extension/index.ts` (status refresh `:12574`, worker leaf
  status ~`:16596`, health scan ~`:14862`, supervision snapshot ~`:10801`/`:10897`,
  supervision refresh ~`:11943`, boundary/name readers `:2269`-`:2294`, definition
  fallback `:4776`), `pi-herdsman/extension/supervision.ts` (name resolution).
- Tests: recurring transcript-free regressions for lead, worker-leaf, health and
  supervision paths; a bounded-header identity check that remains permitted;
  malformed/missing coordination state and its non-inference of `lost`; periodic
  `unknown` followed by explicit legacy resolution (cache poisoning); refresh overlap,
  stale completion and shutdown cleanup.
- No new dependency, config, migration or API. Registers no ADR; recorded local
  deviations live in this change's `design.md`.
