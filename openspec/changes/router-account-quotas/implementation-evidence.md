# Implementation evidence: router-account-quotas

## Implemented
- `pi-native-router/src/quota.ts`: source-neutral windows and snapshots; CodexBar JSON parser (unknown shape, malformed values, future observation time and out-of-range percentages are errors); exhaustion rule (100% with a future reset blocks until reset, with bounded backoff when the reset is unusable); bounded CLI runner (15 s, 64 KiB); leased refresh that writes tracker-sourced causes only when `enforce` is true and clears only tracker causes.
- `pi-native-router/src/health-store.ts`: causes keyed by scope and kind (so tracker quota never overwrites auth or rate causes); refresh leases; quota snapshot persistence; tracker-only fenced clear.
- `pi-native-router/src/config.ts`: strict per-account `quota` mapping, `enforce` defaulting to false.
- `pi-native-router/src/codexbar-config.ts`: pure generator (token accounts per CodexBar provider, `source: "api"`, stable UUIDs from router ids, skipped accounts reported) and a private 0600 atomic writer that refuses replacement without `--replace`.
- `pi-native-router/src/index.ts`: `/quotas` and `/quotas-config` commands.

## Verification
- `bun run typecheck`: passes.
- `bun test tests`: 69 pass (with pricing), 0 fail, 254 expect calls.
- End to end: the generator output for one account was written and accepted by `codexbar config validate`; `codexbar usage --provider opencodego --account go-a` resolved the labelled account (the synthetic token then failed at the provider, as expected).
- The parser test uses the real `codexbar usage --provider opencodego --format json` output (CodexBar 0.73.0) with identity fields removed. It shows Go's monthly window at 100% with a reset on 2026-10-22.

## Not yet verified or built
- Enforcement is off by default; the Go source check (does `local+api` reflect account-wide usage?) is open (task 3.1).
- Periodic (5 min) and session-start refresh are wired in `index.ts` with a timer cleared on shutdown; no test exercises the timer itself.
- A two-process test of the quota lease is not written; the lease is covered by a store-level test.
- A `/quotas` command test is not written; its output is only checked by typecheck.

## Source finding
- CodexBar's OpenCode Go `auto` source can return a device-local estimate (`dataConfidence: estimated`). The captured `local+api` sample is not authoritative and is not enforced. Generated config uses `source: "api"`; the Go source check (task 3.1) still needs a live authenticated response to confirm account-wide meters.

## Enforcement
- Enforcement is enabled per account by `"enforce": true` in router settings. The live setting lives in the owner's Nix-managed settings, which this change does not edit.

## Go source check (task 3.1)
- Question: are CodexBar `local+api` percentages account-wide?
- Answer: blocking never uses a `local+api` reading. `/quotas-config` writes provider sources as `api`, and only authoritative readings (`api`, `web`, `oauth` with exact confidence) can block. Operator confirmed the meters are account-wide.
- Live state at recording: `opencode-go#go-a` exhausted until 2026-10-22, `opencode-go#go-b` until 2026-11-01. The operator confirmed these are genuine exhausted quotas awaiting the provider's refresh, so enforcement stays on for them.
- Source of the answer: operator confirmation plus the router's authority rule; no new CodexBar probe was run for this record.

## Documentation (task 3.3, documentation part only)
- README now states the no-ranking rule and the per-account rollback (`enforce: false` or remove the mapping).
- Typecheck, tests and strict validation for 3.3 are not yet run; the task stays open until they pass.
