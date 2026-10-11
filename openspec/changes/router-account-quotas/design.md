# Design

## Context

See proposal.md for motivation. Current routing has no polling/snapshot subsystem; quota errors only produce local cooldowns. `router-api-key-accounts` supplies trusted account/auth and correlated attempt identity, while `router-shared-health` supplies transactional cause records and leases.

External source inspected during scoping: [CodexBar Go documentation](https://github.com/steipete/CodexBar/blob/main/docs/opencode.md) describes direct Go usage fetching with an API key. Use that as a protocol lead, not proof of a live response for our accounts. Initial source is `GET https://opencode.ai/zen/go/v1/usage`; the implementation must pin the provider contract, capture a sanitized authenticated response and verify required rolling/weekly/monthly fields before enabling the adapter. Device-local OpenCode database estimates are not authoritative account quota.

## Goals / Non-Goals

**Goals:** Add one direct, opt-in Go fetcher with conservative account eligibility, shared refresh and source-labelled diagnostics. Reuse the configured key binding without duplicating credentials.

**Non-goals:** CodexBar installation, browser scraping, OAuth discovery, subscription billing/cost estimates, quota-based scoring, eager migration to accounts with more headroom, synthetic warming or network polling during dispatch.

## Decisions

### Provider-specific code, one normalized snapshot contract

Add a small Go parser/fetcher, not a generic scraper/plugin framework. A snapshot contains account and canonical provider, source ID, fetch start/completion time, source observation time when supplied, bounded freshness, completeness/coverage, and applicable windows. Each window retains a stable identity, units, utilization or remaining capacity and a credible reset deadline when available. A source revision identifies the parser/contract used.

Normalize the provider's native fields rather than guessing every API uses tokens, percentages or one reset timestamp. Keep rolling, weekly and monthly constraints separate. Any exhausted applicable window can restrict the account; one available window cannot cancel another exhausted window. Missing subscription/window data means unknown or unsupported, not infinite capacity.

Initial parser mapping is pinned to the verified Go response shape. Invalid required fields make that refresh unavailable/incomplete and preserve last valid evidence as visibly stale; do not silently publish zeros. Estimated/imported observations may share the representation later but cannot clear authoritative error blocks.

### Reuse private native auth and a trusted origin

The account change's native private credential binding resolves the key for a bounded usage request. Do not independently read another account store, export keys through JSON, or introduce browser cookies. Auth values are never included in snapshots, diagnostics or request URLs.

Pin HTTPS origin/path and reject credential forwarding through cross-origin redirects. Treat quota-endpoint errors as monitoring availability failures. A 403/429 at the usage endpoint is not proof the generation API or subscription is unavailable; explicit generation health remains separately sourced.

This is a control-plane HTTPS call, not a replacement provider generation transport.

### Refresh outside dispatch with shared leases

An enabled Pi instance requests refresh on session initialization and when it notices a stale configured account snapshot. Those are fire-and-forget bounded tasks, coalesced through one transactional per-account refresh lease. Add an operator refresh action for deliberate inspection; do not create an independent daemon or idle timer.

A route callback reads the shared snapshot and optionally schedules an eligible refresh, but never awaits its HTTP result. Do not poll all candidates on every request. Defaults are a five-minute minimum refresh interval, a five-minute freshness horizon and a five-second HTTP ceiling, with bounded user overrides. Failed polling backs off without marking generation health; stale observations stay visible.

Lease expiry recovers from crashed instances, and tokens/revisions fence late results. Auth/account mapping is immutable per launch; account replacement uses a new ID. Shutdown aborts owned polling without clearing another process's lease. A newer successful snapshot supersedes only the same account/source's older snapshot.

### Quota is eligibility evidence, not a score

A fresh authoritative exhausted applicable window records a source-labelled account quota cause in the shared health store. Complete fresh capacity can resolve a relevant quota cause under its fence. No headroom ranking, price score, healthy-route movement or cache-age refresh follows polling.

If the snapshot becomes stale, it no longer proves fresh capacity or generates a new restriction. Previously established quota causes remain until their credible deadline or the shared recovery policy permits a probe. A known reset opens recovery admission; it does not release a stampede or assert healthy status.

When snapshots have no credible reset, the shared health unknown-reset backoff and probe policy applies. No quota polling failure may clear an existing failure-derived block.

### Reconcile by fetch-start revision and cause coverage

Capture the account's health revision at fetch admission. Commit the snapshot under the refresh lease. Clearing quota-only causes also requires that no newer failure/reset superseded the captured revision and that the observation covers every relevant applicable window with authoritative capacity.

A response arriving after a failure does not become newer evidence merely from completion time if its fetch began before the failure. Provider timestamps, when available, must pass freshness/skew validation. Stale/incomplete/estimated responses cannot clear causes. Auth, rate-limit and service-outage records are never edited by quota reconciliation.

Keep quota observations and generation errors distinguishable in diagnostics even when both contribute to one account's eligibility. This avoids making an unavailable monitoring source the authority for all routing health.

## Risks / Trade-offs

- [API is provider-specific or changes shape] -> Pin original contract, sanitized fixtures, conservative unknown handling and one adapter.
- [Monitoring becomes a dispatch dependency] -> Cached reads only on routing path; bounded asynchronous refresh with shared lease.
- [Healthy stale snapshot erases real quota exhaustion] -> Fetch-start revision fence and complete window coverage.
- [Five-minute freshness misses a new limit] -> Generation errors remain authoritative and shared immediately; this is not exact concurrency/quota accounting.
- [Different clock/window units produce early recovery] -> Explicit units, timestamp bounds, source provenance and reset-to-probe semantics.
- [No credentials are available for live proof] -> Keep adapter disabled and record the exact authenticated-contract gate; do not claim fixture-only tests prove provider compatibility.

## Migration Plan

1. Land account identity/auth binding and shared health before integrating snapshots; preserve existing routing when quota config is absent.
2. Verify Go protocol at a recorded provider/source revision with sanitized authenticated evidence and no persisted headers.
3. Add bounded shared refresh and diagnostics, then opt in configured Go accounts.
4. Roll back by disabling polling and ignoring future snapshot admissions; independent error-derived health must remain active. Existing quota-only records retain their deadline or can be explicitly reset.
5. Other providers and a CodexBar importer may later produce the same normalized observations without changing the router's target identity or stickiness policy.

## Validation

Use the verified Go response as parser fixtures, then a local HTTP peer to assert account-specific auth, trusted-origin redirect handling and bounded request behavior without real secrets. Two processes must share one refresh lease/snapshot. Exercise rolling-available/weekly-exhausted data, all-required-window capacity, malformed/missing/reset units, stale/unsupported fetches, a crash/late response, and a healthy fetch started before newer quota failure. Native router host tests must prove cached quota exclusion crosses routes, no headroom migration occurs and dispatch never waits for a slow monitor.
