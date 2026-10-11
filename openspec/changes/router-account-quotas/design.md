# Design

## Context

See proposal.md. Shared health (`pi-native-router/src/health-store.ts`) already stores cause records with deadlines and fenced probe leases, keyed `provider#account`. Accounts are named in router configuration and activated through Pi's runtime key operation.

CodexBar 0.73.0 is installed. `codexbar usage --provider opencodego --format json` returns, per provider, `usage.primary|secondary|tertiary` with `usedPercent`, `resetsAt` (UTC ISO), `windowMinutes`, a shared `usage.updatedAt`, `rateWindowLabels` (5-hour, Weekly, Monthly for Go) and `source` (`local+api` for Go). The observed Go monthly window was at 100% with a reset eleven days out. `--account <label>` and `--all-accounts` select configured token accounts; failed providers are reported without failing the document.

## Goals / Non-Goals

**Goals:** a source-neutral snapshot, CodexBar as first source, `/quotas`, and exhaustion-until-reset blocking. **Non-goals:** a direct provider fetcher, ranking by headroom, migrating healthy routes, polling on the dispatch path, cookie providers, installing or modifying CodexBar.

## Decisions

### Snapshot type is the seam

A snapshot holds account id, provider, source label (including CodexBar's own `source` value), observed-at, and ordered windows. A window keeps CodexBar's slot (primary, secondary, tertiary), its label, `usedPercent`, `resetsAt` and `windowMinutes`. Missing fields stay unknown, never zero. Percent is the only usage unit assumed; absolute remaining counts are not invented.

### CodexBar is read through its CLI, off the dispatch path

Run `codexbar usage --provider <id> [--account <label>] --format json` with a bounded timeout (default 15 s) and a 64 KiB output cap. Refresh when the cached snapshot is older than the freshness horizon (default 5 minutes) at session start, on `/quotas`, and when routing notices staleness, coalesced through one shared refresh lease per account. Dispatch only reads cached snapshots and never waits on the process. A missing binary, non-zero exit, non-JSON output or per-provider error yields unknown for that account and a bounded diagnostic; it never counts as generation failure.

CodexBar's `updatedAt` is the observation time. A snapshot older than the horizon is stale and cannot establish exhaustion or capacity.

### Account mapping and generated configuration

Each router account may declare `quota: { source: "codexbar", provider, account? }`. A command generates the matching CodexBar account configuration from the router's accounts, taking keys from the same environment-variable references, so keys are defined once. The command writes only on explicit request, never overwrites an existing CodexBar file without confirmation, and prints no secret values.

### Exhaustion blocks until reset, as its own cause

A fresh snapshot with any window at `usedPercent >= 100` and a future `resetsAt` writes a source-labelled quota cause to the shared store for that account with deadline `resetsAt`, through the existing strongest-deadline rule. Account-wide blocking follows the shared-health scope rules. A window at 100% with no usable reset is recorded with the shared unknown-reset backoff.

A fresh snapshot with every applicable window below 100% clears only quota causes whose source is the tracker and whose revision is not newer than the fetch start. It never clears auth, rate-limit, outage or error-derived quota causes. Expiry of `resetsAt` hands the account to the normal shared probe policy rather than declaring it healthy.

### Source field caveat

CodexBar labels Go as `local+api`. Whether the percentages come from the account API or a device-local estimate is not established from the label alone. Gate enabling the block on a recorded check that the Go source reflects account-wide usage; until then `/quotas` displays the windows but does not block routing, and the source value is shown to the operator.

### `/quotas`

Lists, per router account: provider, each window (label, percent used, reset in relative and absolute time), observation age, source, staleness, whether it blocks routing, and the refresh outcome. No secrets, identity fields or raw CodexBar output are shown or stored.

## Risks / Trade-offs

- [CodexBar JSON shape changes] -> Parse defensively, record the CodexBar version, treat unrecognized shapes as unknown.
- [Estimated usage blocks a healthy account] -> Source-field gate above; stale data never blocks.
- [Account label mismatch attributes exhaustion to the wrong account] -> Explicit per-account mapping, generated from one source, shown in `/quotas`.
- [Binary absent in a worker's PATH] -> Unknown, diagnostic, routing unchanged.

## Migration Plan

1. Snapshot type, cache and `/quotas` with no blocking.
2. CodexBar adapter and generated configuration.
3. Enable exhaustion blocking per account after the Go source check.
4. Roll back by removing account `quota` mappings; tracker-sourced causes expire at their deadline or are cleared by account reset.

## Validation

Parse recorded sanitized CodexBar fixtures, including the observed Go output. Cover exhausted-with-reset, exhausted-without-reset, all windows available, stale, malformed, missing binary, timeout and per-provider error. Two-process test of one refresh lease. Host test that a tracker block skips every model on the account while another account is used, that polling never delays dispatch, and that a healthy snapshot cannot clear an auth or error-derived block.
