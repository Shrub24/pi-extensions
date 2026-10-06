# Store fresh managed sessions under the target working directory

## Decision

A fresh managed launch adds `--session-dir <target-cwd>/.pi/sessions/children`.
Every other launch that continues an existing session — `agent_continue`, a
retained worker's reuse, lost-session recovery, an owner-side restart — passes the
exact saved `--session <path>` and adds no session directory.

## Rationale

The operator's sessions are already project-local, resolved by the `sessionDir`
setting relative to the working directory. Pi does not recurse when it discovers
sessions: the current-project picker reads the session directory's own files and
the all-project picker reads project directories, so a directory nested inside a
project's session directory is absent from both. Nested storage therefore removes
workers from the operator's picker without hiding them from anything that already
holds their path.

The directory follows the target working directory rather than delegation depth,
so a managed agent that delegates again lands in the same `children/` directory
as its own children instead of accumulating a level per generation.

`--session-dir` outranks both `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir`
setting, so one operator-level setting and one launch flag express both halves of
the layout; no second configuration source has to agree with them.

A resumed session keeps its exact path because the ownership record, not the
directory, is what authorizes continuation. Rehoming a continued session would
move the file that record names, and every consumer holding that path — a
retained pane, a result reference, a prompt snapshot — would be pointing at a file
that no longer describes the live session.

## Alternatives rejected

- A subdirectory per role: role is metadata, and the durable distinction is
  operator versus managed. Roles change; storage should not have to.
- A directory outside the sessions root: unnecessary, because Pi does not recurse,
  and it costs the project-local `.pi` layout and the ignore rule that already
  covers it.
- Relocating existing sessions into the new layout: ownership records, prompt
  snapshots and pane metadata hold exact paths, and history would be rewritten to
  describe a session that was resumed from somewhere it no longer lives.
- Moving a resumed session into `children/`: it would reorganize the operator's
  history by which code happened to be running at the next restart.
- Replacing the operator's own storage instead of nesting: a consumer that no
  longer finds sessions where it looks needs an adapter, which is a cost paid by
  every discovery integration rather than by the origin.
- Depth-based nesting: a second `children/` level per generation would split one
  logical group of workers across directories.

## Consequences

- Existing sessions, including every currently running pane, keep their paths and
  their behaviour until they are restarted.
- A managed session started by an owner running an older build lands in the
  operator's directory but still classifies itself as managed, so a consumer filters
  it by metadata rather than by location.
- Consumers that scan the sessions root — a cross-project search, a historical
  index — no longer see workers. They keep seeing operators.
- A registry of project session roots, and any consumer adapter, is separate work;
  nothing here depends on it.

## See also

- [Session organization](../reference/session-organization.md)
- [Record session classification in its own versioned entry](0025-record-session-classification-in-its-own-entry.md)
- [Retain workers across assignments](0013-retain-workers-across-assignments.md)
- [Store durable state under Pi agent data](0007-store-durable-state-under-pi-agent-data.md)
