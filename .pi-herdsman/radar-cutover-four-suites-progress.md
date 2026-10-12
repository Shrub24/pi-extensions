# Radar-cutover four-suite regression fix: progress

Owner: four-suite worker. Owned files: `controller-lifecycle.test.ts`,
`extension-contract.test.ts`, `control-integration.test.ts`,
`agent-runtime.test.ts`, this note. Narrow owner exception: three restorations
in `index.ts` (below).

Run shape for every measurement:
`cd pi-herdsman && node --experimental-test-module-mocks --import=./scripts/test-env.mjs
--test --test-concurrency=1 --test-timeout=60000 extension/<suite>.test.ts`

## Result

| Suite | Before | After |
| --- | --- | --- |
| `controller-lifecycle.test.ts` | 85 tests, 69 pass, 14 fail, 2 cancelled | 76 tests, **76 pass**, 0 fail |
| `extension-contract.test.ts` | 48 tests, 28 pass, 16 fail, 4 cancelled | 47 tests, **47 pass**, 0 fail |
| `control-integration.test.ts` | 10 tests, 3 pass, 7 fail | 7 tests, **7 pass**, 0 fail |
| `agent-runtime.test.ts` | 91 tests, 83 pass, 8 fail | 90 tests, 86 pass, 4 fail (all evidenced pre-existing) |

Net: 14 tests removed, 1778 lines removed, three suites green. Per file:
`controller-lifecycle` 7012 → 5691 (−1321), `extension-contract` 3779 → 3653
(−126), `control-integration` 793 → 509 (−284), `agent-runtime` 6124 → 6077
(−47). Two now-unused local helpers deleted (`liveAgentList`,
`registeredSubject`), 15 unused support imports deleted, and the
`controlWorkerFixture` `snapshot` option plus its whole Herdr executor model
removed.

## The production defect, and the three restorations (owner-approved)

The publisher removal had collapsed three statements in `index.ts`, and one of
them — not the fixtures — caused the extension-contract chief/staff/supervision
family (~10 failures) and the four 60 s peer-presence timeouts:

1. `16982`: `leadContext = ctx;` had been merged into the dead branch before it
   (`if (previousChiefMode === "active" && previousLeadContext)      leadContext = ctx;`).
   `leadContext` was therefore never set at startup, so `persistRole()` →
   `currentSessionId()` threw "Lead session context is unavailable" and every
   chief/role path recorded `pi_herdsman_role_error` and fell back to the lead
   toolset. Restored to an unconditional `leadContext = ctx;`.
2. `16964`: the newline after `=> {` before `if (controllerScope)`.
3. `17122`: `) {      }` — the emptied `queueLeadMetadata` branch and its
   side-effect-free condition, deleted whole.

`publishLeadRole` and `preparePaneMetadata` stay removed; only the collapsed
statements were restored. Reproduce with
`--test-name-pattern="Chief activation exposes only semantic"` (was failing,
now green).

## Classification and disposition

(S) delete · (R) rewrite compactly · (F) fix invented fixture evidence ·
(M) migrate · (P) pre-existing, out of this cutover.

### controller-lifecycle (14 failures resolved)

| Test | Class | Action or replacement |
| --- | --- | --- |
| a replaced process cannot accept an addressed retained continuation; concurrent session activation permits one generation; session continuation keeps an exact live ID busy… (missing path); … (contradictory observations); session continuation ignores removed secondary session fields | F | five assertions had lost their callback in a bulk edit (`array.some()` with no argument, `&&` yielding `0`): repaired to `assert.equal(radarDaemon.spawns.length, 0)` |
| …session continuation keeps an exact live ID busy… (all three) | S | the claim's canonical form is "exact requested session IDs remain busy when persisted paths are stale" (passing); the three variants proved liveness from the removed Herdr snapshot, and a canonical row carries no `agent_session` for `herdrSessionsMatch` |
| parent delegates two same-definition children with exact ownership (×2) | F | no longer names a tab the fixture's fleet does not report |
| lead herd runs start once…; restored herd run keeps its start…; fresh path sessions remain controllable…; worker launches store one launch fingerprint | F | the launch fixture's fleet is empty before it launches, so placement refused; the daemon now observes the canonical fleet (`radarObservedFleet`) |
| staged fresh assignment bridges pending start through working | F | same fleet, plus the dead `workingObservations` count (a Herdr-read counter) deleted |
| staged fresh assignment removes a fast completion without observing working | S | its evidence was a Herdr snapshot read ("did not read a later snapshot"); pending→working is covered by the sibling test kept above |
| recovery cleanup finishes an idle restored herd without settlement | S | the child was a hand-written mailbox the daemon never registered, so its close refuses by design; herd finish is covered by "restored herd waits for direct durable cleanup before finishing" |
| parent delegation lock makes concurrent close and delegate fail fast | S | its interlock was a Herdr `pane close`; the lock contract is covered by "zero-child lead close is blocked by the parent delegation lock" and "lead close maps assignment-lock contention to agent_busy" |
| cascade close keeps the parent when descendant mailbox cleanup is unresolved | S | cascade and cleanup-warning semantics live in `recovery.test.ts` ("close returns a structured nonfatal mailbox cleanup warning" and the cascade family) |
| concurrent continues of an idle retained worker serialize on the reservation | S | its interlock was a Herdr `api snapshot`; the reservation is covered by "concurrent session activation permits one generation" and "a failed continue releases the session activation reservation" |
| registered extensions preserve adjacent ask escalation and assignment results | S | 440 lines of hand-written nested mailboxes that never registered; ask/reply escalation is covered by `recovery.test.ts`'s ask family and extension-contract's "delivered owner asks retain the question in visible message details". Partial replacement — the nested parent/child ask hop has no exact canonical home |

Also deleted here: the now-unused local helper `liveAgentList` and 11 unused
support imports.

### extension-contract (17 failures resolved, 1 test removed)

| Test | Class | Action |
| --- | --- | --- |
| Chief activation…; managed agents receive no peer tool…; active chief describes…; staff transcript…; Chief supervision context…; persisted Chief startup…; leaf agents and active Chiefs…; first failed chief supervision refresh…; a replacement chief…; an obsolete background supervision refresh…; lead rejects a remote chief…; a restored non-Lead role keeps operator classification; Lead startup publishes minimal peer presence…; peer provenance enrichment…; session shutdown prevents pending peer presence publication…; stale peer publication… | index.ts defect | fixed by the restorations above |
| Herdr preflight gates minimum client version…; registered delegate embeds text… | F | the launch fixture's empty pre-launch fleet replaced by the canonical fleet (installed after the fixture, which owns the model otherwise) |
| a launched child publishes the pane it reads and never its parent's | R | asserts the fields the claim is about (the child's own pane, the lead's own pane, the daemon's negotiated backend) instead of fixture trivia (tab, backend word) |
| a session replacement clears the queued supervision rerun instead of running it | S | its instrument was a stack frame of the removed `herdrSessionSnapshot`; refresh generation/dedup is covered by "Chief supervision context is persistent, deduplicated, and compaction-aware" |

Also: one unused local helper (`registeredSubject`) and four unused support
imports removed.

### control-integration (7 failures resolved, 3 tests removed)

The whole fixture was Herdr-shaped: `startupExecutor` plus a response wrapper
that pinned sessions, answered `worktree list`/`workspace get` and exposed a
`snapshot` hook. It now launches the worker through the daemon
(`adoptRetainedChild`, with `childSession` pinned to this worker's session) and
records the returned launch record as the `pi-herdsman-radar-spawn` entry; the
daemon's own close record is the assertion (`closes()`), not a CLI call count.

| Test | Class | Action |
| --- | --- | --- |
| a control request closes an idle retained worker… | M | Radar child; asserts the daemon's close |
| a control close abandons a working worker's assignment… | M | Radar child, whose launch acknowledgment survives taking an assignment |
| a control restart relaunches an idle retained worker and refuses a busy one | S | the relaunch half measured the removed `agent start` launch; the busy refusal is kept, renamed "a control restart refuses a working target and leaves it untouched", and the relaunch itself lives in `recovery.test.ts` ("a restart reuses a retained worker in its existing process") |
| a control restart reuses its pane and applies the current child command | S | its subject is the Herdr `pane run` relaunch; replacement as above |
| a pane that does not claim the alias refuses control with the pane named | S | its subject is the Herdr-reported alias; the unregistered-child refusal lives in `recovery.test.ts`'s unclaimed-alias family |
| a presence another pane can claim refuses without acting | S | presence for a Radar-launched child is its own launch edge, not the fleet, so a second claimant of the fleet cannot make it unprovable; the fleet only decides for a never-registered child, which the close refuses before presence matters |
| control refusals name their category… | R | the `snapshot` hook and the `unsupported_target` case dropped (see gap below) |
| a generation replaced after the request is resolved… | R | the Herdr-snapshot gate replaced by a mailbox-read gate |
| a request written while the owner was down…; a control close is refused while the target's result is unretrieved | F | `paneCloses()` → the daemon's `closes()` |

Deleted fixture machinery: the `snapshot` option, `pinSession`, the worktree and
workspace responses, the Herdr exec wrapper, `starts`, `preservedStops`, the
launch-fingerprint entry and the `agent-definitions.ts` import.

### agent-runtime (4 failures resolved, 1 test removed, 4 attributed pre-existing)

| Test | Class | Action |
| --- | --- | --- |
| full snapshots clear unavailable presentation values during task updates | S | its only evidence was the removed pane-metadata publisher (`pi_herdsman_run=`, `--clear-token` calls) |
| registered agent writes state, handles input, and settles one result | F | dropped its assertion on a `pi-herdsman:` metadata call |
| a stray agent variable does not suppress the active Lead tool surface | F | the lead's registered commands are `manager, chief, agents, herdsman` |
| unfinished background work holds settlement through a flush and late work; a recovered worker settles with an unretrieved prior-request result…; only unfinished work holds while unreviewed terminal results settle; settlement publishes an unread terminal result… | P | see below |

Pre-existing evidence: these four assert the
`registerBackgroundWorkProvider` snapshot semantics (`awaiting-result-review`,
`captureCertified`), which live in `pi-bash-processes/extensions/background-work.ts`
— another extension's file, imported at `index.ts:85`. Neither the producers nor
the production `backgroundWaiting` logic are touched by this tree's diff, the
test bodies are byte-identical to HEAD, and the failures show the same two
shapes (an `advisory-task` held alongside `incomplete-task`/`live-task`, and a
settlement that publishes no result). They match the five previously reported
agent-runtime failures.

## Remaining production gaps found, not fixed (outside my four files)

- `unsupported_target` is unreachable: `controlPaneIdentity` (`index.ts:6810`)
  reads `agent.tokens.pi_herdsman_label`, a shape nothing produces any more
  (`index.ts:6820` is its only reference), while the daemon's canonical rows
  expose `managed_label`/`managed_run`. Either read canonical facts, or drop the
  category. The `unsupported` case was removed from the refusal test.
- `managedAgentPresence`'s `aliasUnclaimed` branch is unreachable for canonical
  rows: `canonicalAgentRelated` treats any occupant of the recorded pane as
  related, so `occupants.length > 0 && relatedAgents.length === 0` cannot hold.
- `herdrSessionsMatch` reads `agent.agent_session`, which the canonical
  observation never carries, so a live session can no longer be proved busy from
  the fleet alone (this is why the three session-continuation variants were
  deleted rather than migrated).

## Follow-ups for the retained worker's files

- The full package gate (`npm run check`) was not run: my validation is the four
  files individually. The lead owns the final gate.
- `support.ts`: `createStagedAssignmentFixture`'s `workingObservations` counter,
  its getter and its `agent list`/`api snapshot` counting are now referenced by
  nothing.
- `support.ts`: `setAgentEnvironment` names tab `registered-tab` while several
  launch fixtures report `<label>-tab`/`delegated-tab`; a test that pairs them
  must either name no tab or the fixture's own.
- `support.ts`: `startupExecutor` overwrites `radarDaemon.observeInventory` with
  a fleet that is empty before a launch, which is what made lead-side placement
  refuse; a lead that uses it must restore `radarObservedFleet` afterwards.

## Decisions to record

1. The daemon's observed fleet is the fixture's canonical model: this process's
   own pane plus one row per launched child. A fixture that owns the model must
   include the process's own pane, or placement refuses.
2. A Radar-launched child's presence is proved by its own launch edge; the fleet
   observation only decides for a child that never registered.
3. `index.ts` had three collapsed statements from the publisher removal; the
   `leadContext = ctx;` collapse, not any fixture, caused the extension-contract
   chief/staff/supervision failures and the four peer-presence timeouts.
4. Restoring the `late`-bound `leadContext` only; `publishLeadRole` and
   `preparePaneMetadata` stay removed.
