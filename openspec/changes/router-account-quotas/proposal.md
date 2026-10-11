# Proposal

## Why

Error-derived cooldowns cannot reliably predict when an account's quota resets, and repeatedly probing a weekly or monthly limit wastes recovery attempts. The router already owns account identities and native auth references, so it can fetch authoritative quota windows directly rather than requiring a separate account configuration in CodexBar.

## What Changes

- Add an opt-in direct OpenCode Go quota fetcher using each configured account's native credential binding.
- Normalize rolling, weekly and monthly usage/reset observations into account-scoped snapshots with source, observation time and freshness.
- Cache snapshots in the shared local store and lease bounded refreshes across processes; dispatch never waits on a quota network request.
- Exclude an account when a fresh authoritative applicable window is exhausted, without quota scoring or selecting the account with most remaining headroom.
- Reconcile newer authoritative snapshots with quota-only health blocks using fenced observation ordering; never clear auth, rate-limit or outage blocks by inference.
- Treat missing, stale, failed and estimated data as unknown, not free capacity.
- Retain a small provider-specific fetcher boundary for additional providers or a future CodexBar importer.

## Capabilities

### New Capabilities
- `account-quota-awareness`: Direct account-authenticated quota snapshots, shared refresh lifecycle and conservative quota eligibility.

### Modified Capabilities
None. Shared health and native routing retain their own capabilities; this supplies an additional authoritative observation source.

## Impact

- Account/auth access introduced by `router-api-key-accounts`.
- Snapshot, refresh lease and reconciliation integration with `router-shared-health`.
- A provider-specific OpenCode Go fetcher and router configuration/diagnostics, not a generic credential scraper.
- Source contract: OpenCode Go's documented `GET https://opencode.ai/zen/go/v1/usage`, subject to an authenticated response-shape check during implementation.
- No CodexBar dependency, browser cookies, local OpenCode usage database, OAuth account discovery, proactive quota optimization, independent reset scheduler or deployment activation.
