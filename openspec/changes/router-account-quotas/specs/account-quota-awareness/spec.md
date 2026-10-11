# Spec Delta

## Purpose

Use directly fetched, account-authenticated quota observations to avoid exhausted accounts and respect reset windows without coupling provider execution to monitoring availability.

## ADDED Requirements

### Requirement: Quota fetching reuses the selected account binding

An opt-in OpenCode Go quota fetcher SHALL use the configured account's native private credential binding. It SHALL associate observations with that exact account and trusted provider endpoint, without separate account discovery, browser cookies, local usage databases or a CodexBar dependency.

#### Scenario: Two Go accounts are fetched
- **WHEN** accounts A and B have separate configured keys
- **THEN** each quota fetch authenticates only as its corresponding account
- **AND** neither snapshot can overwrite the other's quota state

#### Scenario: Unsafe redirect or endpoint change
- **WHEN** a quota request redirects outside its trusted provider origin
- **THEN** the credential is not forwarded and the refresh is reported unavailable

### Requirement: Snapshots retain window semantics and provenance

A valid snapshot SHALL retain the account, provider source, observation/fetch times, freshness, completeness and each applicable quota window's stable identity, units, utilization and reset time when supplied. Missing values SHALL remain unknown rather than becoming zero usage or unlimited capacity.

#### Scenario: Rolling and weekly windows differ
- **WHEN** the provider reports an available rolling window and an exhausted weekly window
- **THEN** both window identities and reset times are retained
- **AND** the weekly exhaustion is not hidden by the rolling window's availability

#### Scenario: Provider response lacks a required field
- **WHEN** a required usage/reset field has changed shape or cannot be interpreted safely
- **THEN** the observation is marked invalid or incomplete
- **AND** no fabricated remaining capacity or reset deadline is published

### Requirement: Refresh is bounded and shared rather than on the dispatch path

Quota refresh SHALL use a bounded timeout and a per-account shared lease with crash expiry and result fencing. Concurrent Pi instances SHALL reuse fresh cached snapshots. Provider dispatch SHALL NOT await a quota network fetch or spawn an external tracker command.

#### Scenario: Concurrent stale-cache refresh
- **WHEN** two workers need quota data for the same stale account
- **THEN** one obtains the refresh lease and the other uses cached or unknown eligibility
- **AND** ordinary model dispatch does not wait for the fetch

#### Scenario: Refresher crashes
- **WHEN** a refresh lease holder exits without completion
- **THEN** another process can refresh after its bounded lease expires
- **AND** a late result from the old lease cannot overwrite the replacement snapshot

### Requirement: Only fresh authoritative exhaustion restricts routing

Fresh authoritative exhaustion in any applicable account-wide window SHALL make the account ineligible across its models and logical routes until reconciliation permits recovery. Available headroom SHALL NOT rank candidates, migrate a healthy sticky route or refresh cache activity.

#### Scenario: Fresh weekly exhaustion
- **WHEN** a complete fresh Go snapshot reports weekly quota exhausted until its reset
- **THEN** every model on that account is skipped while another account remains usable

#### Scenario: Healthy sticky account has less remaining quota
- **WHEN** the current account remains eligible but a fallback has greater headroom
- **THEN** the current route stays sticky
- **AND** polling changes neither the route nor its Magic Context cache epoch

### Requirement: Unknown monitoring state does not erase known health

Failed, stale, unsupported, incomplete or estimated observations SHALL NOT prove capacity or clear independent error-derived blocks. Expiry of a trustworthy exhausted window SHALL permit the shared recovery policy, not silently declare the account healthy. Refresh failures SHALL NOT be treated as generation failures.

#### Scenario: Quota endpoint is unavailable
- **WHEN** polling fails while an account has an active error-derived quota or auth block
- **THEN** that block remains effective
- **AND** polling failure does not create a model/provider outage or a fabricated zero balance

#### Scenario: Last known exhaustion expires without a new snapshot
- **WHEN** its credible reset deadline is reached and fresh quota data is unavailable
- **THEN** the shared health probe policy controls account re-admission

### Requirement: Quota reconciliation is cause-specific and fenced

Only a newer authoritative complete observation that proves the relevant windows have capacity SHALL clear an applicable quota-only block. It SHALL NOT clear auth, rate-limit or outage causes. A fetch begun before a newer failure or operator reset SHALL NOT overwrite that newer health generation.

#### Scenario: Older healthy fetch completes after quota failure
- **WHEN** a healthy snapshot fetch began before a generation request recorded newer quota exhaustion
- **THEN** the fetched snapshot cannot clear the newer block merely because it completed later

#### Scenario: Fresh quota capacity with invalid-key block
- **WHEN** a valid newer snapshot proves quota capacity but an independent auth cause remains active
- **THEN** only eligible quota causes can be cleared and the auth block remains

### Requirement: Quota diagnostics are source-labelled and secret-free

Operators SHALL be able to inspect per-account quota windows, freshness, refresh status and blocking reasons separately from failure-derived health. Stored snapshots, logs and telemetry SHALL NOT include keys, auth headers or raw usage response bodies.

#### Scenario: Inspecting stale and exhausted snapshots
- **WHEN** an operator inspects an account with stale quota data and an active quota failure
- **THEN** the output distinguishes stale monitoring evidence from the active error cause and reports any credible reset
- **AND** no secret material or unsupported billed-spend estimate is exposed
