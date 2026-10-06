# Herdsman control — owner-side audit and completion

Owner: worker (audit + completion of the uncommitted owner-side
`herdsman-control/v1` work). Started 2026-02-14.

Status legend: **present** (implemented and covered by a passing test),
**missing** (absent), **wrong** (present but does the wrong thing),
**partial** (implemented, not covered).

## Audit: what the uncommitted work already contains

| Artifact | State | Evidence |
| --- | --- | --- |
| `extension/control.ts` (749 lines) | present | directory trust, atomic writes, tolerant parse, expiry, `O_EXCL` claim, orphan finalization, pruning, `fs.watch` + startup scan, requester-side state derivation |
| `extension/control.test.ts` (569 lines) | present | real temp dirs, real `fs.watch`, no fs mocks |
| `extension/index.ts` shared close path | present | `closeAgentByIdentity` is called by both `agent_close` (via `actionUnsafe`) and the control executor; the old inline `agent_close` body was replaced by the shared call, so the agent_close tests are unchanged |
| `extension/index.ts` control wiring | present | `startSessionControlOwner` on `session_start`, `stop` on `session_shutdown`, `resolveControlTarget`, `executeControlRequest`, `restartIdleManagedWorker`, `publishControlToken`, `CONTROL_ENTRY` |
| index-side integration tests | present | `extension/control-integration.test.ts` (7 tests) drives the real owner path: request file → `fs.watch` → `executeControlRequest` → shared close/relaunch paths |
| `pi_herdsman_control` in `pane-metadata.md` + fixture | present | table row, slot paragraph, fixture source slot `pi-herdsman:control` on the owner pane and the key in both expected flattened records |
| ADR for files/`fs.watch`, claim-never-retry, model-told-only-of-abandoned-assignment | present | `docs/adr/0024-carry-control-requests-as-files-with-a-claim.md` |
| canonical-ownership row in `docs/development/documentation.md` | present | control pages added to the documentation map |

## Coverage: spec scenarios

| # | Scenario (spec) | State | Test |
| --- | --- | --- | --- |
| S1 | The directory is not trusted | present | `control.test.ts` "an untrusted control directory refuses the write"; "an owner reports an unavailable directory instead of watching it" |
| S2 | The owner is watching before any request | present | `control.test.ts` "a live owner executes a request written into its inbox" (request written after start is handled by the watch) |
| S3 | A cross-check disagrees | present | `control-integration.test.ts` refusals: `paneId: other-pane` → `target_ambiguous`, no pane close |
| S4 | The target changes between receipt and effect | present | two tests: a disagreeing `piSessionId` is refused at execution time and the guard is re-checked on `restart`; and `control-integration.test.ts` "a generation replaced after the request is resolved is refused untouched" swaps the mailbox to a new run between resolution and the shared close |
| S5 | An unretrieved result blocks the close | present | `control-integration.test.ts` "a control close is refused while the target's result is unretrieved" |
| S6 | Presence cannot be proven | present | `control-integration.test.ts` "a presence another pane can claim refuses without acting" |
| S7 | Two owners race one request | present | `control.test.ts` "two owners race one request and exactly one executes it" |
| S8 | The owner dies mid-execution | present | `control.test.ts` "a claim without a result becomes unknown at the next start and is never repeated" |
| S9 | The request outlives its owner | present | `control.test.ts` "a request that outlives its owner derives not_executed" |
| S10 | An idle worker restarts | present | `control-integration.test.ts` "a control restart relaunches an idle retained worker…" |
| S11 | A working worker is refused | present | same test, second fixture: `agent_busy`, no stop, no pane close, no wake |
| S12 | A lead has no restart | present | `control-integration.test.ts` refusals: a live parentless identity → `unsupported_target` |
| S13 | The confirmation names a different agent | present | `control-integration.test.ts` refusals: a confirmation naming another label → `invalid_request`, no claim |
| S14 | An idle retained worker is managed | **not covered by a test** | requester-side containment rule; documented in `herdsman-control.md`, no code in this repo (see "Not a row in this repo" below) |
| S15 | No herdsman keys | **not covered by a test** | same as S14 |
| S16 | An unknown field is present | present | `control.test.ts` "a request is read tolerantly and only an unspoken version is refused" |
| S17 | A working worker is closed by an operator | present | `control-integration.test.ts` "a control close abandons a working worker's assignment as closed by an operator" |
| S18 | An idle worker is closed by an operator | present | A2 test below: no wake and no `sendUserMessage`, worker absent from the next `agent_list` |
| S19 | The token is missed | present | A2 test: the owner publishes `pi_herdsman_control=<id>:closed`, while `answered()` reads the result file — the file stays authoritative |

## Coverage: acceptance criteria

| # | Item | State | Evidence |
| --- | --- | --- | --- |
| A1 | Coverage table exists first | present | this file |
| A2 | Close of an idle retained worker through the inbox: claim, shared close path, `closed` result with `process_ended` + `pane_closed`, token, no model turn | present | `control-integration.test.ts` "a control request closes an idle retained worker and answers from its file" |
| A3 | Close with an unresolved assignment resolves it as closed by an operator; restart of an idle worker is `restarted` with the same run id/label/session; a working target is refused `agent_busy` and untouched | present | the S17 test and the S10/S11 restart test |
| A4 | Every refusal category on the reference page produced by a test, target left as it was | present | `control-integration.test.ts` refusals: `target_ambiguous`, `target_not_found`, `unsupported_target`, `invalid_request` (unspoken version and mismatched confirmation); `agent_busy` in the restart test; S6 covers the unprovable presence |
| A5 | Two executions of one request id produce one effect | present | `control.test.ts` "two owners race one request…" |
| A6 | A request written while the owner was down is handled at start by expiry | present | `control-integration.test.ts` "a request written while the owner was down is handled at start by expiry" (owner stopped, request written, owner restarted → `invalid_request`, no claim) |
| A7 | `npm test`, `npm run validate`, `openspec validate --all --strict` counts and exit codes | present | `npm test` exit 0 — 984 tests, 983 pass, 0 fail, 1 skipped; `npm run validate` exit 0 — same suite plus `package audit passed: 123 files`; `openspec validate --all --strict` 15 passed, 0 failed |

## Not a row in this repo

S14 and S15 (the containment rule) are requester-side. The requester is the
Radar operator surface, which is not in this repository, so no test here can
execute the rule. The owner publishes the evidence the rule reads
(`pi_herdsman_*` keys), which `docs/reference/pane-metadata.md` and the
`pane-metadata.fixture.json` records cover; the rule itself is documented in
`docs/reference/herdsman-control.md` inside the (excluded) OpenSpec change and
in the reference page.

## Log

- Seam 1 — `control.test.ts` baseline: 8 of 16 tests failed. Two defects in the
  previous worker's test file: the `start()` helper read `directory` off
  `ControlOwnerStart` instead of `owner` (7 failures), and the untrusted-inbox
  test built the path from one session id and started the owner with another (1
  failure). Fixed both; the file is green.
- Seam 2 — confirmation semantics: `parseControlRequest` accepted a confirmation
  that named a different agent than the request. It now compares the
  confirmation's operation, label and run id with the request's own target and
  refuses `invalid_request` before the claim, which is what the reference fixture
  expects ("Confirmation names implementer-2, not implementer-1.").
- Seam 3 — cross-checks for both operations: `paneId`/`piSessionId`/`piSessionPath`
  were checked only on the close path, so a disagreeing cross-check on a
  `restart` acted anyway. The check moved into `resolveControlTarget`, so both
  operations refuse `target_ambiguous` before any effect, and
  `closeAgentByIdentity` lost its control-only `expected` option and is now the
  plain shared `agent_close` path.
- Seam 4 — pane metadata: `pi_herdsman_control` documented in
  `pane-metadata.md` and added to `pane-metadata.fixture.json` (source slot
  `pi-herdsman:control`, 30 s TTL, plus the expected flattened record).
  `pane-metadata.test.ts` passes (7/7).
- Seam 5 — index-side integration tests, one new file. The first cut of these
  had been appended to `controller-lifecycle.test.ts`; `git checkout --` reverted
  that file to HEAD (it now diffs clean) and the whole block moved to
  `extension/control-integration.test.ts` with a local `controlWorkerFixture`
  helper (lead env, retained worker, pinned session identity, real `fs.watch`).
  Seven tests: A2 close, S17 close-with-assignment, S10/S11 restart, S3/S4/S12/
  A4 refusals, S6 unprovable presence, A6 expiry-at-start, S5 unretrieved result.
- Debug-leftover probe (`zz-control-debug.test.ts`) removed: it drove a close and
  a restart through the same harness and printed the result file, stop/start
  calls, entries and metadata calls. It showed **no defect** — close answered
  `closed` with `process_ended` + `pane_closed` and the control token, restart
  answered `restarted` with `session_retained` and a relaunch continuing the same
  `--session`. Its console-log scaffolding is not committed.
- Three fixture defects were found red→green while writing the tests (each one
  is a harness bug, not a production bug, and each was confirmed by the change
  flipping the result):
  1. `fakePi({ exec })` without `entries` meant `pi.appendEntry` wrote into
     `fakePi`'s own array while the test read a different one, so the
     `pi-herdsman-control` transcript entry looked missing. Fixed by passing the
     shared `entries` array.
  2. The busy fixture dropped `agentDefinition` from the working state, so
     `stateAgentDefinition` fell back to opening the session file and threw
     `missing pi-herdsman-agent-definition entry`; the close left a claim with no
     result (A2-style close was unaffected). Fixed by keeping the definition on
     the working state.
  3. The S6 presence test first asserted no claim for a refusal: a refusal
     resolved inside `executeControlRequest` *does* leave a claim (the claim is
     created in `control.ts` before `execute` runs); only parse/expiry refusals
     are pre-claim. Assertion corrected.
- One-liner in `message_end` confirmed present at `extension/index.ts:17420`:
  `freshResponse = message?.stopReason !== "toolUse";` (list separately on
  commit; not authored this turn).
- `control-integration.test.ts`: **7/7 pass** (exit 0, run alone).
- Seam 6 — the shared gate was red for 154 tests, and the cause was this
  slice's session wiring, not another writer's WIP. A HEAD baseline
  (`git archive HEAD` into `/tmp/pihead` + the uncommitted `index.ts`,
  `control.ts`, `mailbox.ts`) reproduced the same 18/42 `extension-contract`
  failures, and deleting just the two new `pi.on("session_start")` /
  `pi.on("session_shutdown")` registrations made that file 42/42 again. The
  contract tests drive only `events.get("session_start")[0]` (254 such calls
  across the suite), and the control registrations were inserted *before* the
  real lifecycle handler, so the real handler never ran. Fix: `controlOwner` is
  now started inside the existing `session_start` handler (right after
  `preparePaneMetadata`) and stopped inside the existing `session_shutdown`
  handler, so the registration order is unchanged. No test file needed to
  change for this.
- Gate (after the Seam 6 fix), `PI_*` unset, full `npm test` as a background task
  with no timeout: **exit 0**, 984 tests, 983 pass, 0 fail, 1 skipped
  (88.2 s). `npm run validate`: **exit 0** (same suite, `package audit passed:
  123 files`). `openspec validate --all --strict`: 15 passed, 0 failed. The
  three steered `agent-runtime.test.ts` tests pass; they had been red for the
  Seam 6 reason, not for an unrelated one.
- Seam 7 — the control-close identity race. `executeControlRequest` resolved
  `agent`+`runId`, then called the shared `closeAgentByIdentity(…, request.agent)`,
  which took its own snapshot and read the mailbox by label: a generation that
  replaced the resolved one in between was the generation closed (red run
  answered `closed`/`process_ended`+`pane_closed` for the replacement, quoting
  the old run id). `closeAgentByIdentity` now takes an optional `expected`
  identity and threads it into `closeManagedSnapshot` (trailing parameter) and
  into `closeManagedAgentCascade`'s existing `expected` argument, so the
  existing `sameManagedAgentIdentity` check at the locked boundary binds the
  resolved generation — no preflight was copied. `agent_close` still calls it
  without `expected`, so its behaviour is unchanged. `restart` already compared
  the freshly read state with the resolved snapshot under the assignment lock
  (Seam 3), so it needed no change.
- Message fix: a close with no pane close said "its pane was already gone"; a
  lost generation can leave a shell pane behind, so it now says "its pane was
  not closed".
- Seam 7 red/green: with `expected` neutralized at the control call site the new
  race test fails (`outcome: "closed"`, `process_ended`+`pane_closed` for the
  replacement, quoting the resolved run id); with the binding restored,
  `control-integration.test.ts` is **8/8** and the race test ran green three
  times in a row. Gate after the fix (`PI_*` unset, background, no timeout):
  `npm run validate` **exit 0** — 985 tests, 984 pass, 0 fail, 1 skipped
  (control-integration 8/8), `package audit passed: 123 files`.

## Parent verification

Final parent gate bg-839: validate exit 0 (985 tests, 984 pass, 0 fail,
1 skipped; package audit 123 files), strict OpenSpec exit 0 (15/15).
Focused control, integration and mailbox tests 54/54. Expected generation
checked in the shared close path under the assignment lock. No live
Radar-to-owner smoke claimed. Incident fixes were committed separately as
d196c011 (toolUse is not a final answer) and b7ac64ec (bounded context usage).
