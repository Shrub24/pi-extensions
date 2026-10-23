# Tasks

The user resolved the former Pi 1.2.0 host gate on 2026-10-23: preexisting queued nextTurn content intentionally joins a resumed conversation; programmatic idle abort is an accepted documented limitation. Terminal keys, explicit off, active abort and lifecycle cancellation are supported. No further host approval is required for this implementation.

## 1. Prove the continuation boundary

- [x] 1.1 Preserve the real native host proof: empty quota failure can continue the existing conversation without replaying completed tools.
- [x] 1.2 Verify the revised accepted idle/pending-input, abort, branch/model/session-change and shutdown contract. Exercise non-consuming terminal keys, active abort, stale queued dispatch fencing, partial-output and unresolved-tool rejection. Record accepted idle SDK abort and queued nextTurn semantics in design.md.

## 2. Intent, scope and lifecycle

- [x] 2.1 Implement validated route/provider/account/exact-target and pinned-target snapshot scopes, default route regardless of pin, with README examples and simple arguments/completions.
- [x] 2.2 Implement armed/waiting/waking/running/stopped/suspended phases, default 24-hour start deadline and three unsuccessful actual wakes per pause. Preserve first-prompt arming and once/standing progress semantics; reject unsafe/non-capacity stops.
- [x] 2.3 Persist atomic lifecycle intent and session pointer with generation/owner claim leases, one active intent per session, suspended restore and terminal retention. Test two connections, revoked generations, expired claims and store failure.

## 3. Capacity readiness and dispatch

- [x] 3.1 Record structured terminal candidate rejection facts after ordinary recovery; distinguish physical quota/reset-bound rate, auth/fit/credentials and budget-only exhaustion without parsing displayed router errors.
- [x] 3.2 Evaluate all quota windows, authority/freshness, remembered tracker evidence and live health revisions. Test weekly exhaustion after short reset, early restoration, unavailable after manual clear and older observations against newer failures.
- [x] 3.3 Wire periodic shared refresh rechecks and reset-aware bounded checks to the injected schedule. Use existing fetch gating without force/clear or paid passive model calls; test cancellation during pending refresh, one timeout and deadline expiry.
- [x] 3.4 Constrain actual resumed dispatch and fallback to saved scope with normal strategy, credentials, fit, probe leases and awaited flushes. Disable automatic pin health bypass and recheck the chosen target before dispatch.
- [x] 3.5 Join claims to public native custom continuation; test duplicate observations, bounded repeated failures, once consumption/standing progress and exactly-once completed tools.

## 4. Operator controls and lifecycle cancellation

- [x] 4.1 Implement `/route-resume once|on|off|status`, simple scope/deadline arguments and completions. Report defaults, reject invalid args, and keep status read-only.
- [x] 4.2 Fence off, active-run abort, real submitted user intent, terminal Escape/Ctrl+C, selected-model change, session switch/fork/tree/compaction and shutdown. Restores require explicit re-arming.
- [x] 4.3 Publish quiet transitions and separate `native-router-resume` footer status; report scope, blockers/windows, tracker provenance, next check, deadline and outcome. Document footer extension point, accepted host limitations and rollback.

## 5. Integration acceptance

- [x] 5.1 Run full router suite, focused production/test typecheck and strict OpenSpec validation; record pre-existing example alias errors separately. Exercise native host multi-window exhaustion -> fresh restoration -> one safe continuation using shared SQLite and fake tracker/time, without live paid calls.
- [ ] 5.2 With owner approval, smoke an explicitly armed live session across controlled capacity pause/recovery; confirm scope enforcement, no duplicate execution, visible cancellation and correct live usage accounting. Automated tests do not establish this live evidence.
