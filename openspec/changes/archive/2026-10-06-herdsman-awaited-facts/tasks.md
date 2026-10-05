# Tasks

## 1. The awaited set

- [x] 1.1 Compute the set: a Lead's outstanding workers, a worker's outstanding
  nested children, and `owner` while an owner reply is outstanding. Test each
  source independently and together.
- [x] 1.2 Build the token value with the entry cap, the 80-character bound and the
  terminal-safe transformation. Test the empty, single, several, over-cap and
  unsafe-character cases.
- [x] 1.3 Publish on every membership change, refresh on a timer while the set is
  non-empty, and clear the key and stop the timer when it empties. Test that a
  pane awaiting nothing publishes nothing.
- [x] 1.4 Publish while the pane is working, and cover it with a test that asserts
  the set is present in a working state.
- [x] 1.5 Publish `pi_herdsman_label` with the runtime label on managed worker
  panes under the existing worker metadata source, cleared with that source's
  other names, with reference/fixture coverage and one behavioral assertion.

## 2. Documentation and gates

- [x] 2.1 Document `pi_herdsman_awaited` and the derivation rule in
  `docs/reference/pane-metadata.md`, and add the key to
  `pane-metadata.fixture.json` with its expected flattened record.
- [x] 2.2 Run the `pi-herdsman` suite and `npm run package:audit`, recording the
  counts and the source checkpoint: 945 tests, 944 pass, 0 fail, 1 skipped
  (86.5 s); package audit 111 files. Checkpoint: git `5b778a04`, jj
  `wtkylqrrmmqknqzvyysrlrqypnuslyru`. Run with this process's own
  `PI_HERDSMAN_*`/`PI_SUBAGENT_*` env removed: with them inherited, role-sensitive
  tests fail on a managed-worker session (pre-existing at HEAD).
- [x] 2.3 Strict OpenSpec validation for this change.
- [x] 2.4 Tell the Radar session the key, the item shape and the derivation rule.
