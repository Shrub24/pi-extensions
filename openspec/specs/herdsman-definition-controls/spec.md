# herdsman-definition-controls Specification

## Purpose
TBD - created by archiving change herdsman-definition-controls. Update Purpose after archive.

## Requirements

### Requirement: A configured disable list removes definitions from every offered surface

The herdsman configuration SHALL accept a `disabledDefinitions` list of definition names,
and a definition named in it SHALL be omitted from the lead roster, from the `/agents`
definitions menu, and from owner-visible definition lists.

#### Scenario: A disabled bundled definition is not offered

- **WHEN** `disabledDefinitions` contains `generalist` and the bundled roster ships it
- **THEN** the lead roster, the definitions menu and owner-visible lists do not offer
  `generalist`

#### Scenario: A definition that is not listed is unaffected

- **WHEN** `disabledDefinitions` contains `generalist`
- **THEN** `scout` and `researcher` are offered exactly as before

### Requirement: A disabled name still resolves for reference validation

A config-disabled name SHALL remain part of the definition set that reference validation
sees, so an `agents` reference to it SHALL load, and delegating to it SHALL fail with the
disabled-definition error.

#### Scenario: A reference to a disabled definition still loads

- **WHEN** a definition lists `agents: ["scout"]` and `disabledDefinitions` contains `scout`
- **THEN** the referencing definition loads, and a fresh delegation to `scout` is rejected as
  a disabled definition

### Requirement: The disable list is validated strictly

A `disabledDefinitions` value that is not an array of unique non-empty strings or that
exceeds 64 entries SHALL fail configuration loading with the offending value. A name that
matches no definition SHALL fail definition discovery, naming that value, because only
discovery knows the roster.

#### Scenario: A typo fails loudly

- **WHEN** `disabledDefinitions` contains a name no definition matches
- **THEN** discovery fails naming that value

#### Scenario: A malformed list fails loudly

- **WHEN** `disabledDefinitions` is a string, or contains a duplicate or an empty entry
- **THEN** loading fails

### Requirement: The effective-definition view reports fields inherited from a lower-precedence definition

The roster view SHALL report, for each effective definition, the fields whose effective value
came from a lower-precedence definition rather than from the definition's own file, naming the
source that supplied each one. A field the definition's own file sets SHALL NOT be reported.

#### Scenario: An inherited bundled default is visible

- **WHEN** a global definition omits `noSkills` and the bundled definition it overlays sets
  `noSkills: true`
- **THEN** the roster view reports `noSkills` as inherited from the bundled definition

#### Scenario: A fully specified definition reports nothing

- **WHEN** every field a definition relies on is set in its own file
- **THEN** the view reports no inherited fields for it

#### Scenario: A standalone definition reports nothing

- **WHEN** a definition overlays nothing
- **THEN** the view reports no inherited fields for it

### Requirement: An explicit inheritSkills in the overriding definition wins over an inherited noSkills

When a definition overlays a lower-precedence definition that sets `noSkills: true`, an
explicit `inheritSkills: true` in the overriding definition SHALL enable native skill
discovery, while an explicit `noSkills` in that same definition SHALL still disable it.

#### Scenario: A local opt-in survives a bundled noSkills

- **WHEN** a local definition sets `inheritSkills: true` and the bundled definition it
  overlays sets `noSkills: true`
- **THEN** the launch passes no `--no-skills`

#### Scenario: An explicit noSkills in the same file still wins

- **WHEN** a definition sets both `noSkills: true` and `inheritSkills: true`
- **THEN** the launch passes `--no-skills`

#### Scenario: The default is unchanged

- **WHEN** a definition sets neither field
- **THEN** the launch passes `--no-skills`
