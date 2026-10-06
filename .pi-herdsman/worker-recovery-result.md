# agent_continue recovery of a proven-stopped worker

Updated 2026-10-06. Scope: `pi-herdsman` continuation recovery, session-unavailable diagnostics and
lifecycle guidance. No commit, push or bookmark movement. Shared `extension/index.ts` was released by the
fork lead, so this change is limited to the continuation seam and never touches the control implementation
(`92e52f0e4`), the assignment-lock identity checks, or the session-activation claim boundary.

## Behaviour

`agent_continue` on an exact saved session whose single directly owned managed record is a **proven `lost`
generation** now recovers it instead of refusing `agent_busy`:

1. the stale record is retired through the shared lost path (`closeManagedSnapshot`), which revalidates
   identity under the assignment lock, refuses while an unretrieved durable result exists, and removes only
   the mailbox — no pane is ever closed for a lost target;
2. the same Pi session then continues in a new generation (new process, new pane) under the same label,
   reporting `relaunched: "process_lost"`.

Nothing is rewritten to make this work: presence is never weakened to `lost` (an `unknown` presence or a
foreign/possible-live agent still refuses `agent_busy`), an unread durable result still refuses rather than
being overwritten, and a surviving shell pane is left untouched because it may hold unrelated operator work.

A continuation whose recorded session can no longer be opened as the recorded identity now fails with a
descriptive session-unavailable `invalid_request` naming the exact path, instead of the generic
"outside the caller's proven session ownership tree" error.

## Changed files

- `pi-herdsman/extension/index.ts`
  - continuation identity block: `isLostWorkerOf` selects a proven lost record, retires it through
    `closeManagedSnapshot`, preserves the label removal, and reports `relaunched: "process_lost"`; an
    unretrieved durable result refuses with a continuation-oriented `agent_busy` message;
  - `resolveAssignmentSession`: a matched owned child that cannot be opened as the recorded identity fails
    with `Saved assignment session is unavailable: <path> ...`;
  - `ownedAssignmentChildren`: a child whose recorded path cannot be canonicalized is kept (it was dropped)
    so the selector can report it as unavailable instead of unknown;
  - guidance: `LOST_WORKER_RECOVERY_GUIDANCE` added to the handoff guidance, and the lost sentence of
    `AGENT_UNRESOLVED_GUIDANCE` now teaches continue-to-recover / close-to-abandon;
  - `agent_continue` tool description mentions recovery.
- `pi-herdsman/extension/controller-api.test.ts` — four recovery regressions plus the fixture's `lost`
  inventory option (`vanished` | `shell` | `foreign`); two session-availability assertions updated.
- `pi-herdsman/extension/agent-runtime.test.ts` — two seam regressions for carried prior-request
  background results (below).
- `pi-herdsman/extension/controller-lifecycle.test.ts` — both propagated lost-guidance phrase lists aligned
  with the new `AGENT_UNRESOLVED_GUIDANCE` sentence.
- `pi-herdsman/SKILL.md` — the lost-agent paragraph: continue the exact saved session to recover; close only
  to abandon; no manual pane/mailbox handling.
- `pi-herdsman/docs/reference/agent.md` — continuation outcome table gains the `recovered` row and the
  session-unavailable refusal.
- `pi-herdsman/docs/guides/handoffs.md` — continuation outcomes gain `recovered` (`relaunched: "process_lost"`).
- `openspec/specs/herdsman-retained-workers/spec.md` — new requirement "Continuation recovers a proven-lost
  worker" with four scenarios.

## Regression evidence (red before the fix, green after)

Red runs swap only `extension/index.ts` for `HEAD` (`git checkout -- extension/index.ts`), keeping the new
tests:

- `continuation recovers a worker whose pane is gone` — red (refused `agent_busy`), green.
- `continuation recovers a worker behind a surviving shell and leaves the shell alone` — red (refused), green.
- `continuation preserves an unretrieved result instead of overwriting it` — red (no refusal; would have
  retired the mailbox), green.
- `continuation refuses an unprovable identity instead of weakening presence` — green before and after: it
  pins the pre-existing safeguard, so it is not a red/green discriminator.
- Session-unavailable assertions — red at `HEAD` (generic ownership-tree error), green.

## Carried prior-request background results (the missing acceptance item)

The Herdsman side had no regression for a worker that binds a new assignment while an earlier request's
**finished, certified, unretrieved** background result is still carried into it (ADR 0023). Two tests in
`agent-runtime.test.ts` drive the real Herdsman worker path over the real background-work bus seam
(`registerBackgroundWorkProvider` plus the real `bindBackgroundWorkProvider`/snapshot helpers), with the
provider side modelling the production contract:

- `a recovered worker binds a finished prior-request result and settles only after retrieval` — the new
  assignment binds (provider `bind` ok, `backgroundWorkProvider` persisted), the answer does **not** publish
  while the carried `awaiting-result-review` task of the earlier request is outstanding
  (`backgroundWaiting.taskIds === ["bg-prior"]`, no result, no `completedRequestId`), the provider then
  reports retrieval, and a fresh post-retrieval answer settles normally.
- `a recovered worker never adopts an earlier request's running or uncertified work` — a bind refused with the
  production reason (`unresolved work not attributable to request "<id>" …`) discards the task marker as
  `busy`: no `activeRequestId`, no `backgroundWorkProvider`, no `backgroundWaiting`, request removed, no
  result. Exited is not certified and is not retrieved; the distinction is preserved.

The tests pin Herdsman's handling. The carry **decision itself** lives in
`pi-bash-processes/extensions/background-tasks.ts` (`classifySettlementTasks`) and is covered there by
`pi-bash-processes/tests/background-work-carry-forward.test.ts` (real extension host), which is outside this
assignment's scope — the production carry cannot be driven from the pi-herdsman node:test suite without
importing that package's bun fixtures. Neither new test is a red/green discriminator: at `HEAD` the hold and
refusal paths already existed, so they pin behaviour rather than fix it.

Parent shortened routine guidance further: "Recover a proven-stopped worker with agent_continue and its
exact saved session. No cleanup step is required first." Transport details remain in reference docs;
the implementation still leaves surviving shells untouched.

## Gates

Run after the guidance-assertion fix (a stale phrase in `controller-lifecycle.test.ts` still pinned the
removed lost sentence; that phrase list is now aligned with `AGENT_UNRESOLVED_GUIDANCE`):

- `extension/controller-lifecycle.test.ts` — 62 tests, 62 pass, 0 fail.
- `npm test` — exit 0, 989 tests, 988 pass, 0 fail, 1 skip (pre-existing,
  `resolves native Windows body file reference forms`).
- `npm run validate` — exit 0, 989 tests, 988 pass, 0 fail, 1 skip.

Focused rerun after this completion (production guidance change + new tests, so no full gates were rerun;
the parent gates afterward): `agent-runtime.test.ts` 74/74, `controller-lifecycle.test.ts` 62/62,
`extension-contract.test.ts` 42/42, `controller-api.test.ts` 106/106.

Earlier focused runs in the same change: `controller-api.test.ts` 106/106, `core.test.ts` 29/29,
`recovery.test.ts` 96/96, `extension-contract.test.ts` 42/42, `agent-runtime.test.ts` 72/72.

## Parent acceptance

Final parent gate `bg-917` passed on the implementation, shortened guidance and expanded mid-turn test:
`npm run validate` exit 0, 992 tests / 991 pass / 0 fail / 1 skipped, package audit 123 files;
`openspec validate --all --strict` 15/15. The mid-turn regression now also includes nonempty commentary
attached to a tool call, as reproduced by Radar; both variants pass against the existing `d196c011` fix.
This added variant was not run red. No live recovery or destructive control smoke was run.

The classifier remains separately tested by pi-bash-processes; the provider in the Herdsman tests models
its contract. Unknown presence and unretrieved durable agent results still refuse continuation.
A new generation uses a new pane rather than reusing or killing a surviving shell.
