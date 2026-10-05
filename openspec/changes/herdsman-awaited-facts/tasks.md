# Tasks

## 1. The awaited set

- [ ] 1.1 Compute the set: a Lead's live workers, a worker's live nested children,
  and `owner` while an owner reply is outstanding. Test each source independently
  and together.
- [ ] 1.2 Build the token value with the entry cap, the 80-character bound and the
  terminal-safe transformation. Test the empty, single, several, over-cap and
  unsafe-character cases.
- [ ] 1.3 Publish on every membership change, refresh on a timer while the set is
  non-empty, and clear the key and stop the timer when it empties. Test that a
  pane awaiting nothing publishes nothing.
- [ ] 1.4 Publish while the pane is working, and cover it with a test that asserts
  the set is present in a working state.

## 2. Documentation and gates

- [ ] 2.1 Document `pi_herdsman_awaited` and the derivation rule in
  `docs/reference/pane-metadata.md`, and add the key to
  `pane-metadata.fixture.json` with its expected flattened record.
- [ ] 2.2 Run the `pi-herdsman` suite and `npm run package:audit`, recording the
  counts and the source checkpoint.
- [ ] 2.3 Strict OpenSpec validation for this change.
- [ ] 2.4 Tell the Radar session the key, the item shape and the derivation rule.
