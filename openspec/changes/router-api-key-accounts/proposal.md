# Proposal

## Why

A logical route currently identifies only a physical provider/model, so it cannot select between API keys for the same provider without risking credential interference or losing native provider behavior. Named key accounts are the prerequisite for account-specific recovery, shared health and quota observations.

## What Changes

- Add user-owned named API-key accounts and optional account references on ordered route candidates; one configured key is one account.
- Activate the chosen account through Pi's serialized runtime-key API before native request preparation; one active key per provider exists in each Pi runtime.
- Preserve sticky model/account selection, restore/fork state and isolated direct requests.
- Treat account changes as cache namespace changes and await one Magic Context flush, coalescing simultaneous physical-model changes and TTL expiry.
- Publish secret-free account identity alongside logical and physical model identity.
- Keep existing candidates using native default auth compatible, including existing single-account OAuth providers.
- Follow the existing pi-accounts runtime-key activation pattern with structural feature detection, serialized mutation and effective-key verification. Document that this is provider-global within one runtime and does not isolate overlapping/direct calls; no router transport or provider alias is added.

## Capabilities

### New Capabilities
- `provider-accounts`: Named API-key account selection, native credential isolation, account-aware route persistence and lifecycle.

### Modified Capabilities
None. The completed but unarchived `pi-native-router` and `router-cache-ttl` changes remain the routing/lifecycle baseline; this adds an account dimension without duplicating their capabilities.

## Impact

- Router configuration, candidate identity, adapter, branch state and cache-activity records in `pi-native-router/src/{config,index,policy,transition}.ts`.
- The Pi 1.1.0 runtime-auth compatibility adapter patterned on pi-accounts, with fail-closed feature detection and explicit internal-surface compatibility limits.
- Router diagnostics and `pi-otel` account attribution where dispatch identity is available.
- No change to Herdsman model admission: it still selects the configured logical model and loads the same router in parent/child instances.
- Prerequisite for `router-shared-health` and `router-account-quotas`; independent of `physical-model-pricing`.
- Not included: multi-account OAuth, shared quota pools, key-management UI, concurrent request credential isolation, provider transport changes, deployment activation or routing scores.
