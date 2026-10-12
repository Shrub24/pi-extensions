# Tasks

Prerequisites: router-shared-health (committed) and router-api-key-accounts.

## 1. Snapshot and `/quotas`

- [x] 1.1 Define the source-neutral snapshot and window types and a shared snapshot table beside the health store; test round-trip, unknown-not-zero and invalid shapes.
- [x] 1.2 Add the CodexBar adapter: bounded CLI run, output cap, defensive JSON parse; test the recorded Go output, exhausted with and without reset, all-available, stale, malformed, missing binary, timeout and per-provider error.
- [x] 1.3 Add `/quotas` listing windows, usage, reset, age, source, staleness, refresh outcome and blocking state; test secrets and raw output are absent.

## 2. Refresh and mapping

- [x] 2.1 Add per-account shared refresh lease and freshness horizon; two-process test of one refresher, crash expiry and a slow tracker not delaying dispatch.
- [x] 2.2 Add account `quota` mapping to strict config and the generate-CodexBar-config command; test no secret printed and no unconfirmed overwrite.

## 3. Eligibility

- [x] 3.1 Record the Go source check: confirm whether `local+api` percentages are account-wide; keep blocking disabled per account until recorded.
- [x] 3.2 Write tracker-sourced quota causes from fresh exhausted windows and clear them under fetch-start fencing; host test that an exhausted account is skipped across models, another account is used, and a healthy snapshot cannot clear an auth or error-derived block.
- [ ] 3.3 Document configuration, mapping, freshness defaults, rollback and the no-ranking rule in the router README; run typecheck, tests and strict OpenSpec validation.
