# Tasks

## 1. Prove the continuation boundary

- [x] 1.1 Demonstrate supported post-settlement continuation on the real Pi host harness: an empty quota failure can continue the existing conversation after capacity returns without replaying completed tools. Record the API and transcript semantics in design.md; stop and report a host gap if this cannot be proven.
- [ ] 1.2 Demonstrate idle/pending-input, abort, branch/model/session-change and shutdown behavior at that boundary with controlled host events. Verify unsafe partial output and unresolved tools remain stopped; do not implement scheduling against an unproven seam.

Blocked at 1.2 on installed Pi 1.2.0: idle abort has no observable session event and does not invalidate later continuation; public pending checks omit queued `nextTurn` messages. See design.md's host gate evidence. No scheduler or resumption controls are implemented; tasks 2–5 remain outstanding. Full suite/static/schema validation results are recorded there, but do not establish integration acceptance 5.1.

## 2. Intent, scope and lifecycle

- [ ] 2.1 Implement normalized route/provider/account/exact-target scope and pinned-target snapshot validation. Verify default route scope ignores implicit pin narrowing, exact targets preserve account identity, and targets outside the route are rejected; document scope examples in the README.
- [ ] 2.2 Implement arm-once/standing/waiting/waking/running/stopped/suspended lifecycle with deadline and unsuccessful-wake limits. Verify normal completion disarms, timer/observation churn cannot reset limits, and partial or non-capacity failures do not arm a wait.
- [ ] 2.3 Persist bounded lifecycle intent in the router-owned store with generation/owner fencing and suspended restore. Verify two connections cannot claim the same generation, cancelled owners cannot wake it, shared-store failure suspends it, and terminal retention meets the count/age limits; document storage and restart behavior.

## 3. Capacity readiness and dispatch

- [ ] 3.1 Emit structured terminal capacity-rejection facts after native recovery settles. Verify quota and reset-bound rate pauses are distinguished from missing auth/fit and exhausted recovery budgets, without parsing displayed errors or changing immediate retry safety.
- [ ] 3.2 Add a scoped readiness evaluation using all quota windows, freshness/authority and health revisions. Verify short-window reset with weekly exhaustion does not wake, fresh early restoration does, unavailable tracker data after operator reset does not, and older snapshots cannot clear newer failures.
- [ ] 3.3 Integrate periodic shared refresh and reset-aware bounded checks without invoking operator-clear refresh semantics. Use a fake clock and counting runner to verify one outstanding check, shared-fetch gating, no billed model request during passive waiting, cancellation of stale callbacks, and deadline expiry; document cadence and unknown-read behavior.
- [ ] 3.4 Constrain the resumed execution and its fallback candidates to the saved scope while retaining native strategy, credential activation, normal probe leases and awaited flushes. Verify provider-specific wake cannot dispatch outside scope, pins cannot grant a health bypass, and capacity lost before dispatch returns to waiting within limits.
- [ ] 3.5 Join claimed intent to the proven continuation boundary. Verify exactly one continuation for duplicate observations, successful progress consumes once permission, repeated quota failures retain standing authorization only within bounds, and prior completed tools run exactly once.

## 4. Operator controls and lifecycle cancellation

- [ ] 4.1 Implement `/route-resume once|on|off|status`, scope selection/completion and optional deadline, with explicit displayed proposed defaults. Verify invalid scopes/deadlines are rejected without arming and status never implicitly authorizes execution. Add working README examples for route, provider/account and pinned-target waits.
- [ ] 4.2 Wire off, abort, new user intent, selected model change, branch/session switch and shutdown to generation fencing and timer cleanup. Verify a ready callback racing each cancellation cannot start the cancelled task; restored sessions require explicit re-arming.
- [ ] 4.3 Publish quiet transition notifications and an optional compact waiting status without replacing the physical-model footer. Verify status names scope, blockers, next check, deadline and last outcome; unchanged polls create no notices and diagnostics expose no prompts or credentials. Document the status extension point and rollback procedure in the README.

## 5. Integration acceptance

- [ ] 5.1 Run the router suite, typecheck and strict OpenSpec validation; record any pre-existing example/typecheck failures separately. Add an integrated multi-window exhaustion -> fresh restoration -> one safe continuation example covering real host dispatch and shared store coordination, without live paid provider calls.
- [ ] 5.2 With owner approval, smoke an explicitly armed live session across a controlled capacity pause and recovery; confirm scope enforcement, no duplicate execution, visible cancellation and correct usage accounting. Leave this unchecked until live evidence exists.
