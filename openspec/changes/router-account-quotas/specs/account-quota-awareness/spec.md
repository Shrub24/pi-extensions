# Spec Delta

## Purpose

Use quota snapshots from an external tracker to avoid exhausted accounts until their reset, without coupling provider execution to tracker availability.

## ADDED Requirements

### Requirement: Snapshots are source-neutral and keep provenance

A quota snapshot SHALL record the account, provider, source label, observation time and each window's slot, label, used percent, reset time and cadence when supplied. Missing values SHALL remain unknown rather than becoming zero usage or available capacity.

#### Scenario: Several windows
- **WHEN** a source reports an available five-hour window and an exhausted monthly window
- **THEN** both windows and their resets are retained and the account is treated as exhausted by the monthly window

#### Scenario: Unrecognized shape
- **WHEN** a required field cannot be interpreted
- **THEN** the snapshot is marked invalid and no capacity or reset is fabricated

### Requirement: CodexBar is read off the dispatch path

The router SHALL obtain CodexBar snapshots by running its CLI with a bounded timeout and output size, under a per-account shared refresh lease with crash expiry. Provider dispatch SHALL NOT await a refresh.

#### Scenario: Slow or missing tracker
- **WHEN** the binary is missing, times out or exits non-zero
- **THEN** the account's quota is unknown, a bounded diagnostic is recorded and dispatch is unaffected

#### Scenario: Concurrent stale refresh
- **WHEN** two processes need a stale account snapshot
- **THEN** one refreshes and the other uses cached or unknown data

### Requirement: Accounts map explicitly to tracker accounts

Each router account SHALL declare its tracker provider and account label. A command SHALL generate the tracker's configuration from router accounts and the same environment-variable key references, without printing secrets or overwriting existing configuration unconfirmed.

#### Scenario: Generated configuration
- **WHEN** the operator requests configuration generation
- **THEN** each router account with a quota mapping appears in the output with its key sourced from its environment reference and no secret value printed

### Requirement: Exhaustion blocks the account until reset

A fresh snapshot with an exhausted applicable window and a future reset SHALL write a source-labelled quota cause for that account with that reset as its deadline. Stale, invalid or unknown snapshots SHALL NOT establish exhaustion or capacity.

#### Scenario: Monthly window exhausted
- **WHEN** a fresh snapshot shows 100% used with reset in eleven days
- **THEN** every model on that account is skipped until that reset and another account remains usable

#### Scenario: Exhausted without reset
- **WHEN** a window is exhausted and no usable reset exists
- **THEN** the shared unknown-reset backoff applies

### Requirement: Reconciliation is cause-specific and fenced

A newer fresh snapshot with all applicable windows below exhaustion SHALL clear only tracker-sourced quota causes not newer than its fetch start. It SHALL NOT clear auth, rate-limit, outage or error-derived quota causes. Expiry of a reset SHALL hand the account to the shared probe policy.

#### Scenario: Older healthy fetch after a newer failure
- **WHEN** a fetch begun before a newer error-derived quota block completes healthy
- **THEN** the block remains

### Requirement: Quotas are inspectable without secrets

A `/quotas` command SHALL list each account's windows, percent used, reset, observation age, source, staleness, refresh outcome and whether it blocks routing. It SHALL NOT show or store keys, identity fields or raw tracker output.

#### Scenario: Stale snapshot beside an active error cause
- **WHEN** an account has a stale snapshot and an active error-derived block
- **THEN** the output distinguishes the stale monitoring data from the active cause
