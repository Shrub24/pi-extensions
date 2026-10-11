# Implementation evidence: router-account-quotas

## Implemented
- `pi-native-router/src/quota.ts`: source-neutral windows and snapshots; CodexBar JSON parser (unknown shape, malformed values, future observation time and out-of-range percentages are errors); exhaustion rule (100% with a future reset blocks until reset, with bounded backoff when the reset is unusable); bounded CLI runner (15 s, 64 KiB); leased refresh that writes tracker-sourced causes only when `enforce` is true and clears only tracker causes.
- `pi-native-router/src/health-store.ts`: causes keyed by scope and kind (so tracker quota never overwrites auth or rate causes); refresh leases; quota snapshot persistence; tracker-only fenced clear.
- `pi-native-router/src/config.ts`: strict per-account `quota` mapping, `enforce` defaulting to false.
- `pi-native-router/src/codexbar-config.ts`: pure generator (token accounts per CodexBar provider, `source: "api"`, stable UUIDs from router ids, skipped accounts reported) and a private 0600 atomic writer that refuses replacement without `--replace`.
- `pi-native-router/src/index.ts`: `/quotas` and `/quotas-config` commands.

## Verification
- `bun run typecheck`: passes.
- `bun test tests`: 59 pass, 0 fail, 224 expect calls.
- End to end: the generator output for one account was written and accepted by `codexbar config validate`; `codexbar usage --provider opencodego --account go-a` resolved the labelled account (the synthetic token then failed at the provider, as expected).
- The parser test uses the real `codexbar usage --provider opencodego --format json` output (CodexBar 0.73.0) with identity fields removed. It shows Go's monthly window at 100% with a reset on 2026-10-22.

## Not yet verified or built
- Enforcement is off by default; the Go source check (does `local+api` reflect account-wide usage?) is open (task 3.1).
- Session-start and stale-triggered background refresh are not wired; refresh happens only through `/quotas`.
- A two-process test of the quota lease is not written; the lease is covered by a store-level test.
- A `/quotas` command test is not written; its output is only checked by typecheck.

## Source finding
- CodexBar's OpenCode Go `auto` source can return a device-local estimate (`dataConfidence: estimated`). The captured `local+api` sample is not authoritative and is not enforced. Generated config uses `source: "api"`; the Go source check (task 3.1) still needs a live authenticated response to confirm account-wide meters.
