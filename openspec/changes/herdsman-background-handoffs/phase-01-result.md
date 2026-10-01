# Phase 01 result — background settlement interface

## Outcome

**implemented-corrected-and-parent-verified.** The interface portion of task 1.2
(`pi-bash-processes/extensions/background-work.ts` plus its tests) is complete
and passes every parent-owned gate. Task 1.2 stays open: the real provider
adapter and interface/ownership documentation remain, and they depend on the
task 1.1 prerequisite. The worker ran no verification commands; every result
below was executed by the parent.

## Provenance

- Initial delivery: worker run `89155873` (coder-high) produced the module and
  18 authored tests, reported `implemented-unverified`, and correctly ran no
  commands. Source at that point:
  `f69995ccaec6d9b65c29cd05ef916a74132b5b653ee60ac629499ee607393127`.
- Parent gate on that delivery: 17 pass / 1 fail, plus three defects reproduced
  with `/tmp/herdsman-phase01-review-89155873.ts` (independent-module
  registration, bind-before-mutation identity, unbounded snapshots). The
  correction brief is `phase-01-correction.md`.
- Two recovery workers produced no edits: `4d8ea8e3` (exact-ID resume rejected,
  run metadata missing) and `7dcaa5d6` (30-minute timeout, steering
  unconsumed). Hashes confirmed unchanged before recovery.
- The parent applied the corrections directly, within the same three-file
  allowlist. Final identities:
  - `extensions/background-work.ts`
    `df0214534418457b1826dbc0697c8ef8b3cf8377d30daf62cd8357bbb16a9546`
  - `tests/background-work.test.ts`
    `abb8b5e8612d86567f31224510b8c861c996b5668768fe9eeb5ea850e00a3b78`

## Corrections applied (all in the original allowlist)

1. **Cross-module registration.** The registration slot moved from a
   module-private WeakMap to a `Symbol.for("pi-background-work:v1.registration")`
   property attached to the bus, so independently loaded helper module
   instances (provider side vs consumer side) share one registration, one
   duplicate guard and one change-validation view. Disposal clears the
   property, with a `disposed` flag as fallback when a frozen bus keeps it;
   anything left attached blocks `absent` (fail closed, never empty success).
2. **Expected identity before mutation.** `bind` checks
   `scope.expectedProviderId` against the registered slot and returns
   `identity-mismatch` *before* emitting, so `provider.bind` is never invoked
   on a mismatch (verified: 0 provider calls). Change subscriptions honor the
   same expectation.
3. **Finite bounds, rejection never truncation.** New exported limits:
   `BACKGROUND_WORK_MAX_OUTSTANDING` (128), `BACKGROUND_WORK_MAX_ID_CHARS`
   (256, identities rejected when oversized), `BACKGROUND_WORK_MAX_REPLIES` (8,
   raw reply collection bounded; overflow fails closed as ambiguous).
   Reason/message strings keep their 512-char truncation. `parseSnapshot`
   now returns the rejection reason so errors stay actionable.
4. **Assertion fix.** The provider-error test asserts the full three-task
   outstanding list; Bun's `toMatchObject` compares arrays element-by-element
   including length, so a one-task partial demanded a one-task received list.
5. **Rejected async answers consumed.** A thenable returned by a misbehaving
   provider is consumed with a detached catch (never awaited, never
   unhandled), reported as `provider-malformed`, in the snapshot listener, the
   bind listener and `notifyChange`.

## Parent gate evidence (all run by the parent, after edits)

| Gate | Command | Result |
| --- | --- | --- |
| Focused suite | `bun test tests/background-work.test.ts` | **27 pass / 0 fail** (73 assertions) |
| Deterministic probe | `bun /tmp/herdsman-phase01-review-89155873.ts` | independent consumer `ready` + change delivery 1; wrong-provider bind `identity-mismatch`, 0 provider calls; 10k-task snapshot rejected with bound message |
| Strict typecheck | `tsc --noEmit --strict` (pinned TS 5.9.3 / @types node 24.10.0 / bun 1.3.5 in `/tmp`, no manifest changes) | **clean** |
| Full package suite | `bun test` in `pi-bash-processes`, with files present vs quarantined | **223 pass / 9 fail** vs **196 pass / 9 fail**; failure name sets **identical** → phase-01 adds exactly 27 passing tests and zero failures |

The 9 pre-existing full-suite failures (intent/schema/outputSchema/codemode/
task-details family) exist without phase-01 and belong to the workspace
baseline that task 1.1 must establish. One further test
(`registered extension spawn hardening rows`) failed in one earlier run only —
treated as a pre-existing flake, not phase-01 related.

## Interface decisions (corrected state)

- Transport is Pi's public extension event bus, typed structurally; queries
  resolve inside one synchronous `emit` window; no timer, polling, global
  registry or persisted state in this module.
- One registration slot per bus, bus-attached (see correction 1); every reply
  carries the live `registrationId`; stale/foreign replies are `stale-reply`,
  never first-wins; >1 correlated reply is `ambiguous-reply`.
- Result states: `absent | missing | ready | reconciling | error`; `absent`
  requires nothing known or attached; errors are fail-closed discriminated
  results (`ambiguous-reply`, `malformed-reply`, `stale-reply`,
  `provider-exception`, `provider-malformed`, `identity-mismatch`,
  `provider-error`); caller misuse throws `TypeError` at the call site.
- Helpers delegate ownership and task state entirely to the provider
  (`bind`/`snapshot` are its methods); `expectedProviderId` is caller-side
  only and never forwarded; change notifications are identity/revision
  metadata — a hint to re-query, never a second wake path.
- Bounds as in correction 3; snapshots are rebuilt field-by-field, so provider
  extras never leak.

## Unverified / not covered

- No runtime or integration behavior: nothing imports this seam yet; waiting,
  settlement holds, persistence and wake delivery are later groups.
- Task 1.2's adapter and documentation are not started; task 1.1 (canonical
  declared-lifecycle integration) is not started — scoping found 37 differing
  files plus 17 exclusive between canonical and herdsman `pi-bash-processes`,
  needing a provenance split (accepted declared-lifecycle vs newer canonical
  WIP) before any copy.
- OpenSpec strict validation of the change was last run at authoring time;
  re-run with group 6.

## Next increment

Task 1.1: classify the canonical/herdsman file delta by provenance, integrate
the accepted declared-background lifecycle with recorded source identities,
and establish the package baseline (including the 9 failures above) — then the
1.2 provider adapter. Groups 4–5 (delegation briefs, response contracts) are
independent of 1.1 and can proceed in parallel if handoffs become the priority.
