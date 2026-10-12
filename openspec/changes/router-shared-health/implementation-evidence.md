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

## Completion round
- `pi-native-router/src/health-report.ts`: pure, secret-free report with an explicit coordination mode (`shared`, `degraded-local`, `local-only`); causes show their reason and expiry; lease holders are never printed.
- `pi-native-router/src/index.ts`: `/native-router-health` uses that report, labels a store that fails at runtime as degraded, and reports reset scope and probe fencing. `native-router-health` errors are caught and degrade rather than throw.
- Dispatch integration (task 3.1): retry and failover selection (`resolve`), terminal recovery (`agent_before_settle`) and direct selection (`choose` over `activeOnly` candidates) all consult shared eligibility through `Health.eligible`, using the candidate's account. Direct requests take no probe admission and record no observations, by design.
- Deployed runtime (task 2.1): the installed `pi-bolt` 0.8.4 binary reports runtime `bun v26.3.0`; a probe extension loaded through `-e` executed `node:sqlite` `DatabaseSync`, set WAL, created a table, inserted and read back a row (`ok rows=1`). The probe process exited 1 afterwards only because the global `tool-renderer` extension conflicts with the probe's environment; that is unrelated to the store.

## Verification (completion round)
- `bun test tests` in `pi-native-router`: 110 pass, 0 fail, Bun 1.4.2 under Node v24.21.0 host modules (5 new tests: report labels and reasons, lease-holder privacy, store reset leaves another account and a provider outage intact, and a router-level cross-session test).
- `bun run typecheck`: clean.
- `openspec validate router-shared-health --strict`: valid.

## Coverage boundaries (be explicit when citing)
- Router-level cross-session test (`host.test.ts`) runs separate Pi sessions and separate SQLite connections in one Bun process; it proves the shared store steers dispatch, survives reopening, and admits one probe after expiry.
- True OS-process concurrency is covered at store level by `shared-health.test.ts` (child processes mark, block, and race admission: one grant out of three).
- The `/native-router-health` handler itself is not driven through Pi's command runner; its output is covered through `healthReport` and its reset through `HealthStore.resetAccount`.
- No live OpenCode Go traffic and no parent/worker smoke on the deployed install have been run.

## Not yet verified
- Parent and worker processes running the deployed package against one shared store (live smoke).
- Live provider wording for quota and auth errors.
