# Tasks

Prerequisite: router-api-key-accounts must supply stable account and correlated attempt identity. This change adds no quota fetcher.

## 1. Error observation and scope policy

- [x] 1.1 Separate normalized provider health evidence from replay safety; test partial-text/thinking/tool-call quota observations update account health without continuing/replaying, while aborts, malformed requests, context overflow and extension errors do not penalize health.
- [x] 1.2 Implement evidence-specific account, account/model and provider-service scopes; verify explicit quota/invalid-key blocks the account, model-access 403 stays narrow, opaque 429 defaults narrow, and native-formatted status errors remain recognized.
- [x] 1.3 Preserve credible long reset deadlines separately from bounded unknown-reset backoff; test a seven-day account reset is not truncated by the current transient hint cap and invalid/ambiguous units become unknown.
- [x] 1.4 Document scope precedence, final OAuth-auth failure boundaries and observation-versus-retry safety; verify examples do not classify all 403/429 as quota or infer provider outage from local transport failure.

## 2. Transactional local health store

- [ ] 2.1 Prove one SQLite binding works in the deployed Pi runtime and declared Node test host, then add a private versioned store with bounded transactions; verify creation/permissions/schema and bounded busy/unavailable handling without a daemon or Bun-only assumption.
- [x] 2.2 Implement cause-specific records, attempt admission revisions and fenced update/reset operations; test older in-flight success cannot clear newer quota, independent auth/outage causes survive quota recovery and operator reset fences late results.
- [x] 2.3 Add atomic all-applicable-scope probe admission with bounded lease expiry; run two-process tests proving one winner, no leaked lease for rejected candidates and recovery after a crashed holder.
- [x] 2.4 Document state location, same-user/machine scope and degraded local-only behavior; verify bounded diagnostics and retained local health on storage failure without persisting synthetic keys, headers or raw error bodies.

## 3. Router admission and diagnostics

- [ ] 3.1 Integrate shared eligibility/observations into retry, terminal and direct routing using the dispatched account, preserving configured order, sticky fallback, context floor and native retry ownership; verify scoped exhaustion does not spin or replay completed tools.
- [ ] 3.2 Add operator inspect and explicit scoped reset with reason/deadline/probe/source status; test resetting X leaves Y and provider outage causes intact, and output identifies shared versus degraded-local coordination.
- [ ] 3.3 Expose the narrow typed observation/reconciliation boundary required by future quota snapshots without fetching them; verify source-labelled quota causes cannot directly clear auth/rate/outage causes.
- [ ] 3.4 Document configuration/rollback to process-local mode and parent/worker parity; verify no account-less legacy route silently gains a new identity and direct routing does not mutate session state.

## 4. Cross-process acceptance

- [ ] 4.1 Run two separate participating processes where A records X quota exhaustion and B skips every X model but uses Y; restart B and verify the block/deadline survives, then race recovery expiry and assert one fenced probe.
- [ ] 4.2 Run targeted router typecheck/native-host recovery tests and new shared-store races, plus strict OpenSpec validation; record exact runner/runtime versions and distinguish fixture integration from deployed smoke.

## Workflow follow-up

- Apply router-account-quotas against the observation/snapshot/lease boundary after this change lands.
- Review and archive after implementation acceptance; no distributed coordination or automatic activation is included.
