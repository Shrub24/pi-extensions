# Control which definitions are offered, and let an overlay's explicit fields win

## Why

Two operator-control gaps surfaced while porting the dotfiles setup onto pi-herdsman.

**A bundled role cannot be removed from the roster.** Herdsman ships `generalist`,
`implementer`, `researcher`, `reviewer` and `scout`. `enabled: false` disables a
definition, but the schema reference states that a disabled definition "remains in the lead
roster so it can be enabled again". An operator who does not want a bundled role still sees
it offered beside their own roster, with no way to take it out.

**An overlay's explicit intent can be defeated by an inherited bundled default.**
Definitions merge field-by-field with the lower-precedence definition
(`bundled < project < global`), and the bundled `scout`, `reviewer` and `researcher` set
`noSkills: true`. A local definition that sets `inheritSkills: true` still launches with
`--no-skills`, because an explicit `noSkills` beats `inheritSkills` and the merged
frontmatter carries the bundled `true`. On the dotfiles port this silently left native skill
discovery off for three of seven definitions, and nothing reported it.

## What Changes

- New `disabledDefinitions` key in the herdsman configuration: names that are not offered
  anywhere — omitted from the lead roster, the `/agents` definitions menu and owner-visible
  definition lists.
- A config-disabled name still exists for reference validation, so an `agents` reference to
  it keeps failing at assignment with the existing disabled-definition error rather than
  becoming an unknown-definition load error.
- An explicit `inheritSkills: true` in the overriding definition wins over a `noSkills`
  inherited from the lower-precedence definition. An explicit `noSkills` in the same file
  still wins over `inheritSkills`, which is what the schema reference already documents.
- The schema reference and the configuration reference document both behaviours.

## Impact

- Affected: `pi-herdsman` — configuration schema and validation, definition discovery and
  merge, the roster and menu surfaces, tests, `docs/reference/configuration.md`,
  `docs/reference/agent-definition-schema.md` and `docs/guides/agent-definitions.md`.
- Not affected: delegation admission, briefs, response contracts, waiting state, pane
  metadata, and any existing definition that does not use these fields.
- Compatibility: the configuration file gains one optional key; unknown names in it are
  rejected, so a typo fails loudly instead of silently doing nothing.
