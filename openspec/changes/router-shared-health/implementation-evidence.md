# Implementation evidence: router-shared-health

## Implemented
- `pi-native-router/src/health-store.ts`: private SQLite store (`node:sqlite`), schema version 1, WAL with 2 s busy timeout, `0600` file and `0700` directory. Cause records keep the strongest deadline; a monotonic revision fences observations; probe leases are admitted atomically for every expired scope on the chosen target, or none.
- `pi-native-router/src/policy.ts`: `Health` is backed by the store with a process-local mirror and degrades on store failure. Quota and auth deadlines keep up to eight days when supplied as epoch milliseconds; ambiguous units are unknown; a 403 naming a model is model-scoped; `observe()` separates health observation from replay safety.
- `pi-native-router/src/index.ts`: probe admission before each physical dispatch (moving to the next target on refusal), settlement on success or failure, partial-output observation without replay, `native-router:health-degraded` event, `/native-router-health` inspect and reset.
- `pi-native-router/src/config.ts`: `sharedHealth` boolean, default on.

## Verification
- `cd pi-native-router && bun run typecheck`: passes.
- `cd pi-native-router && bun test tests`: 49 pass, 0 fail, 193 expect calls (Bun 1.4.2).
- Real cross-process checks: two child processes share a block; three simultaneous probes after expiry yield exactly one grant.
- `node:sqlite` probed under Node v24.21.0 and Bun; both read and write WAL correctly.

## Not yet verified
- Router-level two-process smoke (parent plus worker sessions sharing a block through dispatch) and a deployed Pi runtime check of `node:sqlite` (task 2.1, 4.1, 4.2).
- Operator command output and reset are not covered by an automated test; store-level reset is.
- Typed quota-observation boundary (task 3.3) is not built; `router-account-quotas` will add it.
- Direct routing reads shared eligibility but takes no probe admission; that is deliberate.
- Process-local fallback is covered only by the degradation unit test.
