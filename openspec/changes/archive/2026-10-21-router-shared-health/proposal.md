# Proposal

## Why

The router's health map lives in one Pi process and conflates account failures with a provider identifier. Parent and worker sessions can therefore repeatedly hit the same exhausted account, and current recovery safety filtering can hide useful quota observations after partial output.

## What Changes

- Share secret-free health records across same-user Pi processes on one machine, using the account identity introduced by `router-api-key-accounts`.
- Normalize specific error evidence separately from whether a request is safe to retry.
- Apply account-wide quota/auth blocks, narrow account/model limits and explicit provider-outage blocks without indiscriminately disabling healthy alternatives.
- Honor credible reset deadlines; use bounded fallback backoff when reset time is unknown.
- Lease recovery probes atomically so cooldown expiry does not wake a herd of requests; fence stale observations and crashed probes.
- Keep Pi responsible for retry scheduling and execution, with existing bounded recovery, direct-request isolation and sticky fallback.
- Expose inspect/reset diagnostics and a bounded process-local degradation path when shared storage is unavailable.
- Establish a small typed observation/lease boundary for later authoritative quota observations; fetching is not part of this change.

## Capabilities

### New Capabilities
- `shared-provider-health`: Cross-process scoped provider/account health, cooldown decisions, fenced recovery probes and operator diagnostics.

### Modified Capabilities
None. This builds on the completed, unarchived native-routing baseline and extends local cooldown behavior through a distinct shared-health capability.

## Impact

- `pi-native-router/src/policy.ts` failure classification and health policy; `src/index.ts` attempt observation and eligibility integration.
- A local transactional health store under the user router state root, with no credentials, raw provider bodies or session transcripts.
- Depends on `router-api-key-accounts`; quota snapshots in `router-account-quotas` consume this store contract.
- No distributed/multi-host store, daemon, concurrency scheduler, proactive healthy-route migration, subscription scoring or provider transport interception.
