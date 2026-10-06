# Tasks

## 1. Contract, reference and fixture

- [x] 1.1 Write `pi-herdsman/docs/reference/herdsman-control.md`: the wire shape of
  a request and a result, the three terminal states and how a requester derives
  them, the outcome and error vocabulary, the eligibility table for `close` and
  `restart`, and the containment rule.
- [x] 1.2 Write `pi-herdsman/docs/reference/herdsman-control.fixture.json`: valid and
  invalid requests, results for every outcome, and the state-derivation table.
- [x] 1.3 Add a test that the fixture parses, that every case names a documented
  outcome, and that the derivation table covers all three states.

## 2. Owner implementation (sequenced after the lifecycle workstream releases `index.ts`)

- [x] 2.1 Create and trust-check the control directory at session start; arm the
  `inbox` watcher.
- [x] 2.2 Admission: parse, version and confirmation checks, expiry, `O_EXCL`
  claim, orphaned-claim finalization at start.
- [x] 2.3 `close`: re-run the `agent_close` preflight at execution time through the
  existing code path, not a copy.
- [x] 2.4 `restart`: idle retained managed workers through the existing relaunch path;
  typed refusals for every other state.
- [x] 2.5 Result writing, the `pi_herdsman_control` token, result pruning, and the
  session entry that is excluded from model context.

## 3. Gates

- [x] 3.1 Run the `pi-herdsman` suite and `npm run package:audit`, and
  `openspec validate --all --strict`, recording counts and the checkpoint. Docs slice
  (group 1) gated: 962 tests, 961 pass, 0 fail, 1 skipped; package audit 118 files;
  openspec 15/15. Repeat after group 2.
- [x] 3.2 Send the Radar session the reference and fixture paths.

Owner implementation parent gate (`bg-839`): 985 tests, 984 pass, 0 fail,
1 skipped; package audit 123 files; strict OpenSpec 15/15. Parent focused
control/integration/mailbox tests: 54/54. Identity-race regression verified at
the locked close boundary. Radar received the paths and readiness caveat;
implementation readiness follows the commit. Live Radar-to-owner smoke remains
a downstream integration check, not claimed by this package gate.
