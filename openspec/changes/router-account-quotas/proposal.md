# Proposal

## Why

Error-derived cooldowns cannot predict when an account's quota resets, and repeatedly probing a weekly or monthly limit wastes recovery attempts. An OpenCode Go account observed during scoping had its monthly window at 100% with a reset eleven days away; only a quota snapshot can say that before a request fails. CodexBar already fetches, normalizes and timestamps quota for the providers the owner uses, and is installed (0.73.0) on the owner's machine, so the router consumes it rather than reimplementing provider fetchers.

## What Changes

- Add a source-neutral account quota snapshot (account, provider, ordered windows with used percent, reset time and cadence, observation time, source) and a shared snapshot cache.
- Add CodexBar as the first source: run its CLI off the dispatch path with a bounded timeout, parse its usage JSON per configured account, and treat missing, stale or failed output as unknown.
- Let each router account declare its quota source mapping (CodexBar provider and account label), and add a command that generates the matching CodexBar configuration from the router's accounts so one source of truth drives both.
- Add a `/quotas` command listing each account's windows, usage, reset, age, source and whether it currently blocks routing.
- Make an exhausted authoritative window block that account until its reset time through the shared-health store, as a source-labelled quota cause that error-derived auth, rate and outage causes are never cleared by.
- Keep a provider-specific direct fetcher out of scope; the snapshot type is the seam if one is added later.

## Capabilities

### New Capabilities
- `account-quota-awareness`: Quota snapshots from an external tracker, shared refresh, conservative exhausted-account eligibility and operator inspection.

### Modified Capabilities
None. Shared health keeps its own capability; this adds a quota-sourced cause to it.

## Impact

- Router configuration (account quota mapping), a snapshot table beside the shared-health store, a CodexBar CLI adapter, `/quotas` and the config-generation command in `pi-native-router`.
- Depends on `router-shared-health` (cause store, refresh lease) and `router-api-key-accounts` (account ids).
- External dependency: a `codexbar` binary on the Pi process PATH. Absent or failing binary leaves quota unknown and routing unchanged.
- Not included: a direct OpenCode Go fetcher, headroom-based ranking or migration, polling on the dispatch path, browser-cookie providers, OAuth account discovery, CodexBar installation or upstream CodexBar changes.
