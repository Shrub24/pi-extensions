# Session-activation leak and advertised result-ref resolution

## Release approach (defect 1, corrected)

The reservation is claimed at its original position, at the start of the
`if (resumed)` block and before the managed-agent snapshot and identity checks,
so the identity checks, the relaunch `closeManagedAgent` and the idle-reuse
decision all run while the reservation is held. Two simultaneous continues of
one retained worker therefore serialize, and the loser fails `agent_busy`.

To keep the reservation from leaking, the whole activation is wrapped in a
release-and-rethrow `try/catch` that opens immediately after the claim and
closes at the end of the activation, after the launch `try/finally`:

```
if (resumed)
  releaseSessionActivation = claimSessionActivationLock(resumed.path);
try {
  if (resumed) { ...snapshot and identity checks... }
  ...label check, preflight, idle-reuse, prelaunch, mailbox loop, launch...
} catch (error) {
  if (releaseSessionActivation) {
    releaseSessionActivation();
    releaseSessionActivation = undefined;
  }
  throw error;
}
```

Every pre-existing explicit success-path release stays where it was (the
idle-reuse branch release is restored, the mailbox-loop catches, and the launch
`finally`). The outer catch is the safety net for the region those releases do
not cover: the identity checks, the label check, `resolveMessageFiles`, the
`acceptBrief`/`prepareAssignmentInput` file reads, and the read-only
`expandAgentBodyFiles`/`placementSettings`/`physicalPlacement` prelaunch.

Why the claim stays at the original position: it is the only point that is
before every session-observing step. Moving it later (as the previous delivery
did, to just before the mailbox loop) left the identity checks, the relaunch
close and the idle-reuse decision outside the reservation, so two simultaneous
continues of a retained worker no longer serialized.

## Shared resolver (defect 2)

Unchanged from the previous delivery. `resolveResultReference(input, branch,
operation)` lives in `pi-herdsman/extension/core.ts` together with
`agentResultDetails`, `validAgentLabel` and `AGENT_LABEL_PATTERN`. It is the one
implementation of the advertised `result:<label>#<index>` grammar and returns
the canonical `result:<requestId>` form. `index.ts`'s `resolveMessageFiles` is a
thin wrapper over it, and `core.ts`'s `resolveRegularFiles` calls it before the
read `try`, so `files` and `context.inputs` resolve identically. The active
branch is plumbed through `SnapshotTextFilesOptions.resultBranch` /
`MessagePreparationOptions.resultBranch`. `target_not_found`,
`target_ambiguous` and the actionable `Invalid result ref: ... Copy the exact
result ref shown by the agent completion.` message are preserved.

## Tests

- `controller-lifecycle.test.ts` — "a failed continue releases the session
  activation reservation": a continue rejected during preflight leaves no
  reservation, and the retry is not refused `agent_busy`.
- `controller-lifecycle.test.ts` — "concurrent continues of an idle retained
  worker serialize on the reservation": the first continue is held inside the
  identity decision; the second fails `agent_busy`; the first then completes as
  a reuse.
- `controller-api.test.ts` — "the relaunch close holds the session reservation
  against a concurrent continue": with a drifted retained worker, the close is
  held; the second continue fails `agent_busy`; the first then relaunches.
- `controller-api.test.ts` — "advertised result refs resolve as accepted context
  inputs" (from the previous delivery, unchanged).
- Fresh-launch serialization is covered by the pre-existing "concurrent session
  activation permits one generation".

Red/green evidence (red runs swap `extension/index.ts` for the previous
delivery, which claimed after the idle-reuse branch and before the mailbox
loop; the shared resolver in `core.ts` is unchanged in both):

- "a failed continue releases the session activation reservation" — red before
the fix at 60 pass / 1 fail (the retry was refused `agent_busy`); green after at
61 pass / 0 fail.
- "concurrent continues of an idle retained worker serialize on the
reservation" — red before the fix: full lifecycle file 61 pass / 1 fail, the
only failure being this test (the second continue was not refused); green
after: full lifecycle file 62 pass / 0 fail, exit 0.
- "the relaunch close holds the session reservation against a concurrent
continue" — red before the fix: the second continue failed with `Managed
assignment is already changing` (the assignment lock the close holds), so it
never reached the reservation; green after: refused with the reservation's
`The exact Pi session is already being activated` message, exit 0.
- "advertised result refs resolve as accepted context inputs" — green after:
controller-api file 101 pass / 0 fail, exit 0. Its red state is deterministic
from the pre-fix `resolveRegularFiles` → `resolveResultRef("result:implementation#1")`
path throwing `invalid result request id`.

## Exit codes

- focused `controller-lifecycle.test.ts`: exit 0 (62 pass / 0 fail)
- focused `controller-api.test.ts`: exit 0 (102 pass / 0 fail)
- focused `core.test.ts`: exit 0 (29 pass / 0 fail)
- `npm test` with `PI_HERDSMAN_MAILBOX` unset: exit 0 (957 tests: 956 pass,
  1 skipped, 0 fail)
- `npm run validate`: exit 0 (957 tests: 956 pass, 1 skipped, 0 fail)
