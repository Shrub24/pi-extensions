# herdsman-agent-skills Specification

## Purpose
Resolve a definition's skill names to real paths, and let a definition force-load chosen skill bodies into its agent prompt.

## Requirements

### Requirement: Skill values resolve by name or pass through as paths

A definition's `skills` entries SHALL be treated as paths when the value contains a path
separator or already resolves to an existing file, and otherwise SHALL be resolved by name
against the project skill roots (`<project>/.pi/skills`, `<project>/.agents/skills`),
the user skill roots (`~/.pi/agent/skills`, `~/.agents/skills`), the package-declared roots
(`pi.skills` in an installed package manifest) and the settings-declared roots, in that
order.

#### Scenario: A bare name resolves to the project skill

- **WHEN** a definition lists `skills: [codebase-explore]` and
  `<project>/.pi/skills/codebase-explore/SKILL.md` exists
- **THEN** the launch receives `--skill` with the resolved path to that skill file

#### Scenario: A project skill outranks a user skill of the same name

- **WHEN** a skill name exists under both `<project>/.pi/skills` and `~/.pi/agent/skills`
- **THEN** the project path is used

#### Scenario: A package-declared skill resolves

- **WHEN** an installed package under the project's `npm/node_modules` declares a skill in
  its `pi.skills` manifest and a definition names that skill
- **THEN** the launch resolves it to that package's skill path

#### Scenario: An explicit path is passed through unchanged

- **WHEN** a definition lists `skills: ["./skills/local.md"]`
- **THEN** the launch receives that value unchanged, exactly as before this change

### Requirement: An unresolvable skill value fails the launch

A `skills` or `preloadedSkills` entry that is neither a path nor a resolvable name SHALL
fail the launch with a typed error naming the value and the roots searched. It SHALL NOT be
passed to Pi as a path.

#### Scenario: An unknown bare name fails loudly

- **WHEN** a definition lists `skills: [no-such-skill]`
- **THEN** the launch fails with a typed error naming `no-such-skill` and the roots searched

#### Scenario: A missing explicit path keeps failing

- **WHEN** a definition lists `skills: ["./missing.md"]`
- **THEN** the launch fails as it does today, with the path named

### Requirement: Preloaded skills are inlined into the child's system prompt

A definition's `preloadedSkills` entries SHALL each resolve like a `skills` entry, and the
skill's body with its frontmatter removed SHALL be appended to the child's system prompt
through the launch's prompt-file mechanism, after the definition body and before inherited
context files.

#### Scenario: A preloaded skill reaches the first request

- **WHEN** a definition lists `preloadedSkills: [lean-implementation]` and the skill
  resolves
- **THEN** the child's launch appends a prompt file containing that skill's body without its
  frontmatter, and the first request's system prompt contains the body text

#### Scenario: The skill is not registered as well

- **WHEN** a definition preloads a skill
- **THEN** the launch passes no `--skill` argument for that skill

#### Scenario: Preloading works with native discovery disabled

- **WHEN** a definition sets `noSkills: true` and lists `preloadedSkills: [review-policy]`
- **THEN** the launch passes `--no-skills` and still appends the preloaded body

### Requirement: Advertised and preloaded skills stay independent

`skills` SHALL continue to advertise through Pi's skill registry, `preloadedSkills` SHALL
inline, and a name present in both SHALL be inlined and omitted from the advertised list.

#### Scenario: A name in both fields is only inlined

- **WHEN** a definition lists the same skill in `skills` and `preloadedSkills`
- **THEN** the launch appends the body and passes no `--skill` argument for it

#### Scenario: Other advertised skills are unaffected

- **WHEN** a definition advertises one skill and preloads a different one
- **THEN** the launch passes `--skill` for the advertised skill only

### Requirement: Preloaded content is bounded and validated

The total preloaded content SHALL be capped at 64 KiB, and exceeding the cap, reading a
directory, reading an unreadable file or resolving outside the skill root SHALL each fail
with a typed error rather than truncating or ignoring content.

#### Scenario: Oversized preloaded content is refused

- **WHEN** the combined preloaded skill bodies exceed 64 KiB
- **THEN** the launch fails with a typed error and no partial prompt is used

#### Scenario: A non-regular skill target is refused

- **WHEN** a preloaded skill name resolves to a directory or an unreadable file
- **THEN** the launch fails with a typed error naming the path

### Requirement: Preloaded skills are recorded for provenance

Each preloaded skill's body SHALL be delivered through the launch's private prompt
snapshots like the definition body, and the definition's `preloadedSkills` SHALL be part of
the launch inputs covered by the stored launch fingerprint, so a change to them is visible
to retained-worker reuse.

#### Scenario: The launch records its preloaded skills

- **WHEN** a worker launches with a preloaded skill
- **THEN** the skill's body is one of the launch's prompt snapshots, and the stored launch
  fingerprint differs from the same definition without that preloaded skill

### Requirement: The definition schema reference documents every validated field

`docs/reference/agent-definition-schema.md` SHALL document `preloadedSkills`,
`briefProfile` and `responseContract`, including the difference between advertising a
skill and preloading it.

#### Scenario: The reference covers the skill fields

- **WHEN** a reader opens the schema reference
- **THEN** `skills`, `preloadedSkills`, `noSkills` and `inheritSkills` are each
  documented, and the page states that preloading costs tokens on every request
