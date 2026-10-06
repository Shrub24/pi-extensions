# Herdsman control reference, fixture and pin test — result

Change: `openspec/changes/herdsman-control` (tasks 1.1, 1.2, 1.3; task 3.1 gates).
Owner: worker. Scope: `pi-herdsman/docs/reference/herdsman-control.md`,
`pi-herdsman/docs/reference/herdsman-control.fixture.json`,
`pi-herdsman/extension/herdsman-control-fixture.test.ts`,
`pi-herdsman/docs/README.md`, this file. No extension source was touched.

## Files written

| File | Size | Content |
| --- | --- | --- |
| `pi-herdsman/docs/reference/herdsman-control.md` | 221 lines | Request and result shape, outcome and category vocabulary, terminal-state derivation, close/restart eligibility table, containment rule, handling and retention. |
| `pi-herdsman/docs/reference/herdsman-control.fixture.json` | 535 lines | Trust cases, 15 request cases (valid, invalid, tolerant), 10 result documents covering every outcome and five refusal categories, the 4-row derivation table. |
| `pi-herdsman/extension/herdsman-control-fixture.test.ts` | 135 lines | 4 tests pinning fixture parse, scenario naming, vocabulary, shape and derivation. |
| `pi-herdsman/docs/README.md` | +1 line | `- [Herdsman control](reference/herdsman-control.md)` in the focused-reference list, after pane metadata. |

`package.json` was not changed: its `files` list names `docs` as a directory, so
no reference page is listed individually, and `scripts/package-audit.mjs` has no
per-page list to extend.

## Derivation table shape

`derivation` is a list of cases, each carrying the file evidence a requester
sees plus the state that evidence implies:

```json
{
  "case": "the owner died mid-execution and left only its claim",
  "scenario": "Scenario: The owner dies mid-execution",
  "requestId": "a0000000-0000-4000-8000-000000000015",
  "resultFile": false,
  "claimFile": true,
  "expiresAt": "2026-01-01T00:00:30.000Z",
  "observedAt": "2026-01-01T00:01:00.000Z",
  "state": "started",
  "terminal": true
}
```

Four rows, ordered by the precedence the page documents (`result` outranks
`claim`, `claim` outranks expiry): `result` (result file present), `started`
(claim with no result, expiry already passed, which pins claim-over-expiry),
`not_executed` (no claim, past `expiresAt`) and `pending` (no claim, expiry not
reached, not terminal). The test re-implements the derivation from the file
flags and asserts each row's declared `state` and `terminal` flag, so a drifted
row fails rather than being read back.

## Test: red then green

Command (both gates run with this process's own `PI_HERDSMAN_*` and
`PI_SUBAGENT_*` variables unset):

```sh
node --experimental-test-module-mocks --import=./scripts/test-env.mjs \
  --test --test-timeout=10000 extension/herdsman-control-fixture.test.ts
```

| Step | Result |
| --- | --- |
| Test written first, no fixture | 4 fail, 0 pass, exit 1 (ENOENT on the fixture path) |
| Fixture written, page still absent | 1 fail, 3 pass, exit 1 (ENOENT on the page, the vocabulary test) |
| Page written | 4 pass, 0 fail, exit 0 |
| Sensitivity check: fixture given an undocumented `target_busy` category and an undocumented `closed_ok` outcome | 2 fail, 2 pass, exit 1 (`closed_ok is not documented`) |
| Fixture restored from the pre-mutation copy | byte-identical (`cmp` empty), test 4 pass, exit 0 |

## Gates

| Gate | Result |
| --- | --- |
| `npm test` (pi-herdsman) | exit 0 — 962 tests, 961 pass, 1 skipped, 0 fail |
| `npm run validate` (pi-herdsman, `check` + `package:audit`) | exit 0 — `check`: 962 tests, 961 pass, 1 skipped, 0 fail; `package:audit`: package audit passed, 118 files |

## Spec gaps and inferences to confirm

The spec fixes the named categories and outcomes but leaves four mappings and
one ordering unstated. The page applies `docs/reference/errors.md`'s own
meanings rather than inventing names, and each is a one-line change if the owner
reads it differently:

1. **Refusal disposition name.** The spec names three outcomes (`closed`,
   `restarted`, `unknown`) and the request brief requires a separate optional
   error `category`, so a refusal needs an outcome of its own. The page uses
   `refused`; the rejected alternative was repeating the category in `outcome`
   and leaving `category` redundant. This is a new vocabulary item.
2. **`restart` of `settling` or `lost`.** The spec names `agent_busy` only for
   working, waiting and blocked. The page states the rule "any owned target that
   is not an idle retained managed worker refuses `restart` as `agent_busy`",
   which covers those two states.
3. **`unknown` presence.** The page maps it to `target_not_found` (errors.md:
   "could not prove this exact target") for both operations.
4. **Expiry.** The page states expiry is checked before the claim, which is what
   makes the `not_executed` state reachable while an owner is alive, and lists
   `invalid_request` as the category for an expired refusal.
5. **Lost `close` effects.** Not exercised by the fixture: a closed `lost`
   generation has no pane to close, so whether it reports `pane_closed` is the
   owner implementation's to settle.

No design decision or spec requirement was changed; `openspec/**` is untouched.

## Deferred follow-ups

- `docs/development/documentation.md`'s canonical-ownership table has no row for
  this contract (out of the assigned scope).
- `docs/concepts/lifecycle.md` and `docs/guides/recovery.md` do not yet mention
  operator-initiated close and restart; both are outside the assigned scope.
