# Design: definition controls

## Context

`HerdsmanConfig` (`extension/config.ts`) is a flat, strictly validated schema read from a
single JSON file; unknown fields and invalid values are errors. Definition discovery
(`extension/agent-definitions.ts`) reads the bundled directory, the project's
`<cwd>/.pi/agents` and the global `~/.pi/agent/agents`, overlays them by name in that
precedence, and validates the merged result, including every `agents` reference.

`enabled` already controls availability per definition: a disabled definition is rejected by
`delegate` and `continue`, is omitted from owner-visible lists, and stays in the lead roster
so it can be re-enabled from the `/agents` menu.

## Goals

- An operator can take a bundled definition out of the offered roster without authoring a
  stub file for it.
- Removing it from the roster does not break definitions that name it in `agents`.
- An overlay that explicitly opts into native skill discovery gets it.

## Non-Goals

- Changing what `enabled: false` means, or making config disablement re-enableable from the
  `/agents` menu.
- Removing bundled definition files from the package.
- Any change to delegation admission, brief validation or response contracts.

## Decisions

### D1 — The disable list lives in the herdsman config

`disabledDefinitions` is a new key of the existing flat configuration, beside
`spawnPlacement` and `retainWorkers`. It is an array of definition names, each a non-empty
string, unique, and at most 64 entries. It is the same file `/agents` already writes
atomically, so there is one configuration surface and one documented schema.

### D2 — An unknown name in the list is an error

The configuration validates strictly, and a name that matches no definition is a typo that
would otherwise disable nothing while appearing to work. The shape check (an array of unique
non-empty strings, at most 64) lives with the configuration; the "names no definition" check
lives in definition discovery, because that is the only place the roster is known. Both fail
with the offending name. The cost is that renaming a definition requires updating the list;
that is the same cost the `agents` reference list already carries.

### D3 — Disabled definitions are not offered, but still resolve

A config-disabled name is omitted from every offered surface: the lead roster, the
`/agents` definitions menu, and owner-visible definition lists. It is **not** removed from
the definition set that reference validation sees, so a definition whose `agents` names it
still loads, and delegating to it fails with the existing disabled-definition error.

Removing it outright was rejected: the bundled `generalist` and `reviewer` name `scout` and
`researcher` in `agents`, so removing a definition from the set would turn every such
reference into an unknown-definition load error and make the two features fight each other.

### D4 — Config disablement is not re-enableable from the menu

Because the name is not offered, the menu cannot show it to re-enable it. The operator edits
the configuration, which is a text file the reference already documents. `enabled: false`
keeps its current meaning for definitions the operator does want listed.

### D5 — An explicit `inheritSkills` in the overriding definition wins over an inherited `noSkills`

The merge records which source set each of the two fields, using the per-field provenance
introduced for D6. Resolution is then: an explicit
`noSkills` in the highest-precedence source that sets it wins; otherwise an explicit
`inheritSkills: true` in that source enables native discovery; otherwise the existing
default applies (disabled unless `inheritSkills: true`). Documenting the workaround instead
was rejected: the operator wrote the intent, the merged result contradicted it, and nothing
reported the contradiction — the failure mode is a worker silently missing its skills.

This is deliberately narrow: it changes only the `noSkills`/`inheritSkills` pair, which is
the one pair whose fields interact. Every other field keeps field-by-field overlay
inheritance, where an explicit value in the overriding source already wins.

### D6 — Provenance is tracked per field, and the view reports only what was inherited

The merge records, for every field, the source that supplied the effective value. Two things
use that record: the pair rule in D5, and the effective-definition view.

The view lists **only the fields inherited** from a lower-precedence definition, each with the
source that supplied it. Listing every field with its source was rejected: it buries the
signal in twenty rows when the operator's question is precisely "which of these values did I
not write?". A fully specified definition therefore reports nothing, which is itself the
useful answer.

Tracking every field rather than special-casing the skill pair was chosen because the leaks
are not confined to one pair. The dotfiles port hit `noSkills`, `noExtensions`,
`inheritGlobalContext` and `agents` — the last of which silently delegation-enabled a
review-only agent and handed it the coordination tools — and the next bundled definition can
leak any other field.

## Risks

- **A stale disable list.** Renaming a definition breaks loading until the list is updated.
  Accepted for the reason in D2.
- **Two ways to disable a definition.** `enabled: false` and the config list differ in what
  they do to the roster, so the docs must state the difference plainly.
- **Merge provenance is a new concept.** It is scoped to one field pair and covered by tests
  for all four combinations (neither set, `noSkills` only, `inheritSkills` only, both).
