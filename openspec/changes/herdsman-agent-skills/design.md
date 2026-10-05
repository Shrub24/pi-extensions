# Design: agent skill resolution and preloading

## Context

Herdsman composes a worker's launch arguments from its definition
(`pi-herdsman/extension/agent-definitions.ts`). Three fields already append *files* to the
child's system prompt: the definition body (`--system-prompt` or
`--append-system-prompt`, lines 943-946), inherited context files (line 962) and the shared
prompt (line 966). `extension/support.ts:2941-2963` resolves those arguments back to paths
so their contents stay tracked.

`skills` is different. Lines 986-988 push `--no-skills` when native discovery is off and
then `--skill <value>` per entry, passing the value through untouched. The behaviour is
correct for a path and wrong for a name.

pi-subagents is the reference implementation for name resolution
(`pi-subagents/src/agents/skills.ts`): its search roots are
`<project>/.pi/skills`, `<project>/.agents/skills`, `~/.pi/agent/skills` and
`~/.agents/skills` (lines 345-348), extended by package-declared and settings-declared
skill paths, deduplicated by name with source priority
`project > user > project-package > user-package > project-settings > user-settings`.
It strips frontmatter before using a skill's body.

## Goals

- A bare skill name in a definition resolves, or the launch fails loudly.
- A definition can require a skill's method to be present in the child's system prompt from
  the first request.
- Resolution matches what a user already gets from pi-subagents.

## Non-Goals

- Changing Pi's own skill discovery or `/skill:` handling.
- Proactive or automatic skill invocation, and fetching skills from git or npm at launch.
- Any change to pi-subagents.

## Decisions

### D1 — Bare names resolve against the same roots, in the same priority order

A value that contains a path separator, or that already resolves to an existing file, passes
through unchanged. Anything else is looked up by name against, in order:
`<project>/.pi/skills`, `<project>/.agents/skills`, `~/.pi/agent/skills`,
`~/.agents/skills`, then the package-declared roots (`pi.skills` in an installed package
manifest under the project's or the user's `npm/node_modules`) and the settings-declared
roots (package declarations and skill paths in `settings.json`). First match wins, and a
project match outranks a user match of the same name. The root set and its priority are the
ones pi-subagents searches, so the two resolve a name the same way.

### D2 — An unresolvable value fails the launch

Today a bare name becomes a nonexistent path and nothing else happens; that silence is the
bug. An unresolved entry produces a typed error naming the value and the roots searched.
Explicit paths that do not exist keep failing as they do now.

### D3 — Preloading reuses the prompt-file mechanism

A `preloadedSkills` entry resolves like a `skills` entry, then the skill's `SKILL.md`
body with frontmatter stripped is written into the launch's prompt files and appended with
`--append-system-prompt`. No new flag and no new Pi-side plumbing: the mechanism that
carries the definition body, the context files and the shared prompt carries this too, so
content tracking in `support.ts` keeps working unchanged.

### D4 — The two fields stay independent

`skills:` advertises through Pi's registry; `preloadedSkills:` inlines. A name listed in
both is preloaded and dropped from the advertised list, because advertising a skill whose
text is already in the prompt only spends tokens. A preloaded skill is not registered, so
`--no-skills` together with `preloadedSkills` is coherent: the agent has the method and no
registry entry.

### D5 — Preloaded bodies append after the definition body, before context files

The existing order is: base or definition body, inherited context files, shared prompt,
`<active_agent>` marker. Preloaded skills sit immediately after the definition body: a
preloaded skill is part of how the agent works, so it belongs with the role's method rather
than with the repository facts that follow it.

### D6 — Bounds are explicit, and never silent

Total preloaded content is capped at 64 KiB, the ceiling the brief parser already uses, and
exceeding it is a typed error rather than a truncation. Each entry must be a readable
regular file; a directory, an unreadable file or a path escaping its skill root is a typed
error.

### D7 — The launch records what was preloaded

Each preloaded skill's name and resolved path are recorded with the launch's prompt files
and in the managed request metadata, so a worker's prompt is auditable after the fact.

### D8 — The schema reference is corrected

`docs/reference/agent-definition-schema.md` gains `preloadedSkills`, and also
`briefProfile` and `responseContract`, which are validated fields the page omits today.

## Risks

- **Prompt growth.** A preloaded skill costs its tokens on every request. Opt-in per
  definition, bounded by D6, and `skills:` remains the cheap default.
- **Resolution drift from pi-subagents.** Two implementations of one lookup can diverge.
  The roots and priority are stated in the spec and covered by tests, so divergence shows up
  as a test failure rather than as a worker with the wrong skill.
- **A stale preloaded skill.** An inlined body is a snapshot; editing the skill file does
  not change a running worker. Accepted, and the recorded path makes it visible.
