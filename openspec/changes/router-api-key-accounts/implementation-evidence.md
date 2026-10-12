# Implementation evidence: router-api-key-accounts

## Completion round (reconciliation and gap closure)
- Runtime-key activation is now serialized per Pi runtime (`accounts.ts`): each mutation waits for the previous one, verifies the effective key, and rejects on any failure.
- Activation moved after the pre-dispatch Magic Context flush. A failed flush therefore leaves the runtime key on the previous account (tested).
- A failed or unverifiable activation fails the route closed before dispatch and emits `native-router:account-unavailable` with a secret-free reason.
- A host without `setRuntimeApiKey` drops named candidates from selection, so default-auth candidates still dispatch; a named-only route reports the host gap instead of a generic exhaustion.
- Tests (router suite 115 pass, typecheck clean): same-provider rotation from pool-one to pool-two is one flush and one counted transition, with cache activity recorded for pool-two; a failed flush blocks the second account; a host without the operation dispatches nothing named; an inert activation fails closed; concurrent activations run one at a time; absent operation and unverified activation reject.
- Direct routing with named accounts only uses already-active accounts; cache activity is written from the dispatched physical identity, which includes the account, so A's success cannot warm B.

## Not verified
- Task 1.2 residual: native Go provider headers and the absence of a canonical default key are not asserted by a test; the rotation test checks key effect, API, and base URL only.
- Task 3.1 residual: account removal and legacy-branch decoding for account-qualified state have no dedicated test.
- Task 4.2: pi-otel and Herdsman suites were not rerun in this round; this change did not touch them. The matching-host binding is exercised in-process on Pi 1.1.0 module code, not on the deployed binary with real provider keys.
- No live OpenCode Go key switching, quota, or auth wording has been observed.
