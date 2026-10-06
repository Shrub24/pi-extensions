# Handoffs and files

[Documentation index](../README.md)

Pi Herdsman has distinct assignment and definition file mechanisms:

- every `agent_delegate`/`agent_continue` task and eligible `agent_interrupt`
  replacement is a complete versioned Markdown delegation brief;
- `brief.context.inputs` are validated, privately snapshotted, and bound to the
  accepted request so recovery sees the exact accepted bytes;
- `files` supplies additional evidence to assignment and owner-message tools;
- whole-line body `@file` references put definition-owned text into the agent
  system prompt when a new agent generation is built.

For the `files` channel, strict UTF-8 text is embedded when it fits; non-text and
non-fitting files remain canonical local references and are not copied or
snapshotted. This is separate from the brief's required context snapshots.

## Brief format

The delegation tools' guidance shows the model the brief shape: YAML frontmatter,
explicit lists, the profile block, and a worked example built from the same
canonical examples the parser is tested against. A rejected brief returns the
field-specific diagnostic followed by the example for the profile the role
requires, so a caller can correct it in one attempt.

## Message `files`

Agent-session context crosses boundaries explicitly.

- `task` or interrupt `message` contains a complete `delegation-brief/v1`;
- brief context inputs are immutable private snapshots, while `files` carries
  additional explicit evidence;
- `agent_continue` resumes an exact managed-agent Pi session with a fresh brief;
- the caller's conversation and caller-side attachments are not implicitly
  copied into another agent session.

When a new or updated assignment depends on a caller-visible file, pass that
file through `files`.

Do not attach or mention agent instruction files such as `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`, or equivalents merely because they exist; rely on normal project
or runtime discovery.

Attach an agent instruction file only when the task requires inspecting,
modifying, comparing, or transmitting it, the user explicitly requests it, or
its instructions are required and the target would not otherwise receive them.
Skills are separate: attach a required `SKILL.md` only when the task needs it
and the selected definition does not already provide that skill. Ordinary
relevant source, documentation, configuration, and evidence files remain
attachable.

`files` is the single evidence channel. It accepts ordinary paths, reusable
direct-agent result refs such as `result:researcher#1`, and already-known
canonical result references. Copy the exact result ref shown by a completion
into `files` when later work depends on that result.

Example:

```json
{
  "definition": "reviewer",
  "task": "Review the implementation against the approved plan.",
  "files": [".pi-herdsman/plan.md"]
}
```

The model-facing representation follows Pi's native `@file` convention:

```xml
<file name="/absolute/canonical/path" bytes="123">
contents
</file>
```

A reference-only file uses a self-closing tag:

```xml
<file name="/absolute/canonical/path" bytes="123" />
```

For an ordinary file, `name` is the canonical absolute path and `bytes` is the
observed file size. For a result reference, an embedded file uses the exact
`result:<request-id>` as `name`:

```xml
<file name="result:550e8400-e29b-41d4-a716-446655440000" bytes="123">
contents
</file>
```

A result that is supplied by reference keeps both identities in its
self-closing envelope:

```xml
<file name="result:550e8400-e29b-41d4-a716-446655440000" path="/absolute/canonical/path" bytes="123" />
```

A body means the complete submission-time UTF-8 snapshot was embedded. For an
ordinary file, a self-closing tag carries its canonical path and observed byte
size; for a result reference, it carries the logical result name, the physical
path attribute, and observed byte size. File content remains raw text. This
markup frames evidence for the model and is not a security boundary.

`files` is supported by `agent_delegate`, `agent_continue`, `agent_steer`,
`agent_interrupt`, `agent_reply`, and `ask_owner`. For
controller actions, relative paths resolve from the calling controller's cwd;
for `ask_owner`, they resolve from the managed agent's cwd. Accepted ordinary
filesystem paths retain canonical absolute-path names; `result:<request-id>`
inputs retain the logical result reference as the model-facing name.

Supplied paths must resolve to readable regular files. Missing, broken,
unreadable, and non-regular paths reject the whole operation. Canonical
duplicates are represented once, with the first occurrence winning.

For `delegate` with `definition`, deterministic validation and known-input sizing happen
before mutation. The final durable envelope can be sized only after herdr
returns the authoritative pane ID; if the configured `mailboxPayloadLimitBytes`
is then exceeded, `delegate` with `definition` returns `invalid_request` without delivering a task and
rolls back the exact startup attempt (`rollbackOccurred: true` when
applicable).

For each regular file:

- complete strict UTF-8 text without NUL bytes is embedded when the complete
  message fits the effective configured `mailboxPayloadLimitBytes` boundary;
- invalid UTF-8, NUL-containing, binary, and non-fitting ordinary files are
  represented only by their canonical local path and observed byte size;
  result references retain their logical name and carry the physical path and
  observed byte size.

The fixed 1 MiB mailbox protocol safety ceiling is a separate read limit for
mailbox records; it does not replace the configured admission limit for new
messages.

No file is partially embedded. Embedded text is a submission-time snapshot.
Reference-only files are not copied or snapshotted; their contents may change
or disappear after submission, and the recipient must already have local
filesystem/tool access to inspect them. `files` supplies evidence and does not
grant runtime capabilities.

Files are read through their canonical `realpath` target. Ordinary file inputs
are rendered with that canonical path; result references retain the
`result:<request-id>` name so recipients can pass the same reference through
`files` again.

## Canonical deduplication

Within any message's `files`, the first canonical occurrence wins.

These can therefore represent one attachment:

```text
./notes.md
/project/notes.md
./symlink-to-notes.md
```

when they resolve to the same physical canonical path. The same canonical path
in caller-supplied `delegate.files` also takes precedence over a definition body
`@file` reference, including when the caller file is reference-only.

Later duplicates are omitted.

## Body `@file` references

Inside an agent body, a line is a file reference only when the trimmed complete
line has one of these shapes:

```text
@./relative.md
@../relative.md
@/absolute/path.md
@~/home-relative.md
```

On Windows, native backslash forms are also supported, including `@.\relative.md`,
`@..\relative.md`, `@~\home-relative.md`, rooted paths, drive-rooted paths,
and UNC paths. References use the host platform's native path resolution rules.

These remain literal text:

```text
@alice
Use @./policy.md when needed
@~user/file.md
@$HOME/file.md
@${HOME}/file.md
```

Relative body references are resolved from the Markdown definition that
declared them **before** bundled/global body composition.

Expansion then happens once, in body order, when a new agent generation is
constructed.

Included file contents are not recursively parsed for more `@file` references.

## Cross-mechanism precedence

Caller assignment files win overlap with definition body references.

If the same canonical file appears in both:

```text
delegate.files
body @file
```

the assignment keeps its user-message copy and the body reference is omitted.

The combined rule is:

```text
duplicates inside delegate.files
    → first caller occurrence wins

duplicates inside body @file references
    → first body occurrence wins

same canonical file in both
    → caller attachment wins
```

## Immutable prompt transport

A definition body is expanded into text before agent lifecycle mutation.

The final expanded body and shared herdr agent guidance are written to private
temporary snapshots (`0600` files under private `0700` directories), passed to
Pi, and removed after the delegation attempt.

Original body source paths are never handed to Pi as system-prompt paths.

Each agent generation builds its system prompt once for its single assignment.
Session continuation builds a new generation with the current effective
definition configuration while preserving the saved Pi session context. Its
omitted model and thinking fields restore the saved session settings; explicit
definition overrides still apply.

## Result handoff

A direct-agent completion that has a reusable persisted result exposes an exact
ref such as `result:global-peer-fix#1`. Pass relevant direct-agent results
through `files` using the exact refs shown by the completions:

```json
{
  "definition": "reviewer",
  "task": "Compare both implementation passes.",
  "files": ["result:global-peer-fix#1", "result:global-peer-fix#2"]
}
```

`result:<agent>#<index>` is a branch-local reusable direct-result ref. It
resolves only against matching completion entries on the caller's current Pi
branch. The index is scoped to the logical agent label: the first reusable
completion from `global-peer-fix` is index 1, a continued generation is index
2, and both remain independently attachable. Indexes are not reused after
historical branch rewinds. Each semantic ref is converted internally to its
canonical `result:<request-id>` reference before entering the ordinary file
pipeline.

Pass an exact canonical reference through `files` when it was supplied as file
evidence, especially for a transitive handoff:

```json
{
  "definition": "reviewer",
  "task": "Review the implementation described in the supplied result.",
  "files": ["result:550e8400-e29b-41d4-a716-446655440000"]
}
```

`files` accepts ordinary readable regular local file paths, reusable direct
refs in the form `result:<agent>#<index>`, and canonical
`result:<request-id>` references. Semantic refs resolve against the caller's
current Pi branch before becoming canonical references. A canonical result
reference resolves internally to the normal private result file under Pi
Herdsman's durable data directory; it is still validated, canonicalized, and
deduplicated like any other file. Preserve the exact reference already supplied
as evidence. Do not guess or reconstruct the underlying path.
Completion results live under Pi's agent data directory
(`~/.pi/agent/pi-herdsman/results` by default, respecting Pi's configured agent
directory) rather than the OS temporary directory, so result handoffs are not
subject to temporary-directory cleanup.

Persisted reusable completions are self-describing. Herdsman prefixes the
agent-authored result with source context containing the logical agent label,
agent definition, assignment cwd, and producing Pi session ID when available:

```text
Agent result source: {"agent":"researcher","definition":"scout","cwd":"/project","piSessionId":"<producing-session-id>","responseValidation":{"contractHash":"<sha256>","briefHash":"<sha256>","workerSessionId":"<producing-session-id>","target":"artifact","textSource":"worker","artifacts":[{"path":"reports/result.md","canonicalPath":"/project/reports/result.md","sha256":"<sha256>","bytes":123,"disposition":"created"}]}}

<agent-authored result>
```

This context is part of the durable result artifact, so it survives semantic-ref
resolution and transitive canonical-ref forwarding through `files`. The
framework-owned `responseValidation` record preserves the accepted contract and
brief hashes, worker session identity, text source, and observed artifact hashes,
sizes, and created/reused dispositions. These observations establish output
identity and shape, not the truth of model-authored claims or proof that claimed
checks ran. For a reference-only result, provenance is available with the body
when the referenced artifact is read; it is not separately embedded. The context
is informational model evidence, not authorization: an exact session ID or path
does not authorize `agent_continue` without durable ownership ancestry.

Oversized non-completion registered-tool output may additionally expose
`full_output_path` when overflow persistence succeeds. Model-visible content
remains bounded in both cases.

## Retained workers and continuation

By default (`retainWorkers: true`), delivering a terminal result keeps the worker's
verified live process, pane, label, and mailbox instead of cleaning them up. The
worker projects as `idle`, so its pane stays available for the next assignment
and the logical label is not released.

Continue such a worker with `agent_continue` and the exact session ID or session
path from the result. Prefer continuation whenever a retained worker already
holds the relevant context — a follow-on, a revision, or the same kind of work
against the same scope. The worker keeps its Pi session, its in-memory context,
its artifacts and its pane, and a fresh `agent_delegate` would reconstruct all of
that from the brief and start a new pane. Delegate a fresh agent when no live
worker holds the relevant context, or when the assignment is genuinely
independent of every live worker.

A retained idle worker still holds a live pane and its full context, so close it
with `agent_close` once its scope is finished and no follow-up of the same kind is
expected. Closing keeps its Pi session, so `agent_continue` can resume it later.
Each delivered result reminds the lead of this for the worker it came from.

The outcome of a continuation depends on how the session's managed
representation stands:

- **reused** (`reused: true`): the launch configuration still matches the current
definition, so the task is submitted into the existing process. No new process or
pane starts, and the worker's Pi session keeps its in-memory context.
- **relaunched** (`relaunched: "definition_changed"`): the definition changed since
that process started (prompt body including `@file` contents, model, thinking, or
the effective tools, skills, extensions, and context inheritance), or the launch
record is gone. The idle worker is closed and the same session continues in a
fresh process, which restores the saved session's model and thinking unless the
current definition overrides either field.
- **recovered** (`relaunched: "process_lost"`): the session's worker is a proven
lost generation — its process is gone, and its pane is either gone or survives
as a shell. The stale record is retired and a new generation continues the same
Pi session in a new process and pane, so recovery needs no `agent_close` and no
manual mailbox or pane handling first. A surviving pane is left untouched, since
it may hold unrelated operator work.
- **fresh** (neither field): no retained process represents the session, so a new
agent generation starts as usual.

A reused process keeps its launch-time system prompt and in-memory extension
state, which is why drift forces the relaunch. Hand the next assignment an
explicit checkpoint in the task text rather than assuming a reused worker still
holds details from the previous one. Working, settling, or ambiguously
represented sessions still fail closed, an unprovable identity still refuses
`agent_busy` without weakening it to lost, and an occupied logical label still
fails with `agent_label_exists`.

## Project-local coordination workspace

Use the project-local `.pi-herdsman/` directory for temporary coordination artifacts
used by agents working on the repository.

Typical contents include implementation plans, scope and non-goals,
specifications, accepted decisions, investigation notes, review scope or
acceptance criteria, validation notes, and handoff state.

Prefer one current artifact per coordinated objective. Reuse and update an
adequate artifact rather than creating multiple competing descriptions of the
same work.

Keep the default structure flat:

```
.pi-herdsman/
  task.md
  runtime-contract.md
  plugin-remapping-ui.md
```

Create subdirectories only when real artifact volume makes the flat layout
unwieldy.

These files are coordination state, not product state. Do not use `.pi-herdsman/`
for product source, permanent user documentation, application data, build
output, caches, or generated artifacts.

Read-only agents may consume existing coordination artifacts but do not gain
permission to modify them.

When dependent work uses an artifact, pass the same path through `files` on the
message that creates or updates the dependency: `delegate.files` for a new
agent, `steer.files` and `interrupt.files` for an active agent, `ask_owner.files` for supporting
evidence in a question, or `reply.files` for the owner's answer. Update the
artifact before submission. Small text is embedded at submission time; a
reference-only artifact remains a live canonical local path.

Required textual instructions or evidence may be passed through `files`.
`files` does not add runtime capability; use a capable definition when an
actual runtime capability is required.

## See also

- [Agent tools](../reference/agent.md)
- [Agent-definition schema](../reference/agent-definition-schema.md)
- [Delegation](../concepts/delegation.md)
