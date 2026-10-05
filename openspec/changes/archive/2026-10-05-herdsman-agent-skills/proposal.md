# Resolve and preload agent skills

## Why

Herdsman agent definitions carry a `skills` field, but each value is passed through
unchanged as a Pi skill argument (`extension/agent-definitions.ts:988`). A bare name like
`codebase-explore` therefore becomes a literal path that resolves to nothing: the worker
launches with a skill argument pointing nowhere and never learns the skill exists. Only an
absolute path works today, and nothing says so.

Pi also only ever *advertises* skills: a `--skill` argument puts the skill's name,
description and location in the system prompt, and the model decides whether to read the
file. There is no way to say "this skill is part of how this agent works, load it". For
definitions whose whole method is a skill — `lean-implementation`, `review-policy`,
`evidence-discipline` — the model can skip the read and work without it, silently.

## What Changes

- `skills:` values that are bare names resolve against the project, user, package and
  settings skill roots, in the same priority order Pi and pi-subagents use. Values that are
  paths keep passing through unchanged.
- An unresolvable value fails the launch with a typed error instead of being handed to Pi
  as a path that does not exist.
- New `preloadedSkills:` field. Each entry resolves like a `skills:` entry, then the
  skill's `SKILL.md` body (frontmatter stripped) is appended to the child's system prompt
  through the prompt-file mechanism the definition body already uses, so the agent starts
  with the method in context rather than with an advertisement it may ignore.
- `skills:` and `preloadedSkills:` stay independent: the first advertises, the second
  inlines. A name in both is inlined and not advertised.
- The launch records which skills were preloaded and where each resolved from.
- `docs/reference/agent-definition-schema.md` gains `preloadedSkills`, plus
  `briefProfile` and `responseContract`, which it currently omits.

## Impact

- Affected: `pi-herdsman` — definition parsing and validation, launch argument composition,
  prompt-file content tracking, tests, the schema reference and the agent-definitions guide.
- Not affected: Pi's own skill discovery, pi-subagents, the dotfiles, and any existing
  definition that names skills by path.
- Compatibility: `skills:` with explicit paths behaves exactly as it does now. A bare name
  that previously did nothing now either resolves or fails loudly.
