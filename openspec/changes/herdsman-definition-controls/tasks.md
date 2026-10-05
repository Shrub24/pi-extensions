# Tasks: definition controls

## 1. Configuration

- [x] 1.1 Add `disabledDefinitions` to `HerdsmanConfig`, `DEFAULT_CONFIG` and the config
  validation, with a typed error for a malformed list. Test each rejection and the accepted
  shape. The "names no definition" check belongs to discovery and is task 2.1.
- [x] 1.2 Document the key in `docs/reference/configuration.md`: accepted values, default, and
  how it differs from `enabled: false`.

## 2. Offered surfaces

- [x] 2.1 Reject a `disabledDefinitions` name that matches no definition during discovery,
  naming the value. Test the rejection.
- [x] 2.2 Omit config-disabled definitions from the lead roster, the `/agents` definitions menu
  and owner-visible definition lists, while keeping them resolvable for reference validation.
  Tested: the offered roster omits the disabled name and keeps the others, a definition that
  references the disabled name still loads, and discovery marks it `disabledByConfig` with
  `enabled: false`. Delegation to it is rejected by the existing disabled-definition path,
  which the managed-agent list test already covers.
- [x] 2.3 Test that definitions not named in the list are offered unchanged.

## 3. Field provenance

- [x] 3.1 Record the source of every frontmatter field during the merge (bundled, project or
  global) and expose it on the effective definition. Covered by the overlay test (fields
  inherited from the bundled base) and the standalone test (every field owned by its own
  file). The layer label must come from the layer being applied, not from the definition's
  own source fields, which are unset until it is merged in.
- [x] 3.2 Resolve the `noSkills`/`inheritSkills` pair from that record per decision D5. Test
  all four combinations: neither field, an inherited `noSkills` with a local
  `inheritSkills`, a local `noSkills`, and both in one file.
- [x] 3.3 Report the fields inherited from a lower-precedence definition, with their source, in
  the effective-definition view. `inheritedFields` rides on `agentDefinitionMetadata`, which
  every listing surface renders, and is omitted when empty. Tested at the metadata level for
  an inherited field and for a standalone definition; the rendering surfaces themselves are
  covered by the offered-surface test in section 2.
- [x] 3.4 Update the `noSkills` and `inheritSkills` rows in
  `docs/reference/agent-definition-schema.md` and the overlay section of
  `docs/guides/agent-definitions.md` to state the resolution order and the inherited-field
  report.

## 4. Gates

- [x] 4.1 Run the `pi-herdsman` suite and `npm run package:audit`, and record the counts and
  the source checkpoint. 2026-10-05: `npm run validate` green at working copy `kpzumwru` on
  `main` 4fd08969 — 933 tests, 932 pass, 0 fail, 1 skipped; `package audit passed: 108
  files`.
- [x] 4.2 Strict OpenSpec validation for this change.
- [x] 4.3 Report both behaviours to the dotfiles agent, since it carries the
  `inheritSkills`-only definitions and the bundled-roster question. Reported 2026-10-05 over
  intercom, including the exact config shape for dropping the two bundled roles.
