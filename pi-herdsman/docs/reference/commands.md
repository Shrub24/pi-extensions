# Commands

[Documentation index](../README.md)

`/agents` is the human-facing agent-management command namespace.

`/herdsman` is a discovery alias for `/agents`. It accepts the same arguments
and runs the same command behavior; help and usage text continue to use
`/agents` as the canonical name.

It is separate from the structured model-facing Agent tools.

Agent-management commands require a lead Pi session with UI. Outside Herdr,
plain `/agents` and its `/herdsman` alias remain available as a setup
diagnostic that includes the running Pi Herdsman package version.

## Usage

```text
/agents
/agents stats
/agents definitions
/agents stop
/chief
/chief leave
```

The plain command opens a native Pi selection menu titled with the running
Pi Herdsman package version for both `/agents` and `/herdsman`, with `Running`,
`Session stats`, `Definitions`, `Clear idle…`, and `Stop all…` destinations.
Runtime settings such as retention, soft timeouts, placement and message limits
are declared in the rendered configuration file, not in this menu. See
[Configuration](configuration.md).

## `/agents stats`

Shows accumulated Pi-native token usage and cost for the current Pi session plus
transitively owned managed-Agent Pi sessions whose exact persisted identity can
be verified.

Usage follows Pi's session accounting across the whole session history,
including assistant responses, model-attributed usage entries, tool-result model
usage, compaction, and branch summaries. Input includes cached and uncached
tokens, with cache writes shown within uncached input.

The Models section attributes assistant responses to their response model,
usage entries to their recorded model, and tool/summary usage to
`Tools/summaries`, sorted by cost.

Repeated continuations of the same Pi session are counted once. Peer Leads,
Chief staff, supervised Leads, and unrelated Pi sessions are excluded.
Chief still sees usage for its own current Pi session. Missing,
malformed, or identity-mismatched owned-session evidence is skipped and marks
coverage incomplete instead of guessing or scanning global sessions.

## `/agents definitions`

Opens the native Definitions menu for the effective bundled, project, and
global roster. Project definitions are included when Pi considers the project
trusted. Project participation is marked `[project]`; a global override adds
`*` (so `[project] *` means both layers contribute). Edits write global
overrides only.

The details view can show:

- name and description;
- configured or inherited model and thinking;
- declared tool policy represented by definition metadata (not a complete
  runtime capability probe);
- named skills;
- declared direct delegation;
- overridden/custom state;
- override/custom source path when relevant.

Bundled implementation paths are intentionally hidden from the human overview.

Structured `agent_list` keeps exact deterministic metadata, including exact
source and skill paths when available.

`/agents definitions` does not probe runtime tool availability.

Selecting a definition opens:

```text
Model
Thinking
Enabled
Details…
```

Model selection refreshes Pi's registry and stores the canonical provider/model
token. `Inherit current session` removes the selected field. Unset model and
thinking rows display `inherit · <current session value>` when the current
value is available. Thinking uses Pi's supported levels when the selected
model is known.

When Pi provides an explicit scoped-model list, that scope is used. Otherwise
available models are offered.

Thinking options use the effective model's supported levels when resolvable,
or Pi Herdsman's validated vocabulary when not.

The command edits only the selected top-level `model`, `thinking`, or `enabled`
line in the global Markdown override. It preserves unrelated frontmatter and
the complete body.

Details re-resolves the selected definition when opened, so it reflects current
overlays and body references even if the menu remained open while configuration
changed.

Changes apply to future assignments, not already-running agents or the lead Pi
session. Fresh `delegate` assignments inherit the spawning controller's
current settings when fields are unset; `continue` restores the saved
session's settings.

Standalone global definitions are editable too. Removing a model or thinking
field selects `Inherit current session`; removing any other field inherits its
lower-precedence value.

## `/agents` Running

Select a live managed agent from the shared status projection to focus its pane.
Pi Herdsman refreshes and verifies the exact label, pane, and session identity,
then asks the Agent Radar daemon to focus that pane; see
[Focus actions](#focus-actions). If the agent changed, or the daemon cannot
confirm that exact session at the pane, nothing is focused.

## `/agents` retention and soft timeout

`retainWorkers` (set in the rendered configuration) decides retention. Enabled, a delivered worker
keeps its verified live process, pane, label, and mailbox and stays in the
public `idle` state until a later `agent_continue` reuses it. Disabled, each
worker's process and pane are cleaned up after its result is delivered, and its
Pi session stays continuable through `agent_continue`. See
[Configuration](configuration.md) and [Handoffs and files](../guides/handoffs.md).

`softTimeoutMs` sets the window in milliseconds; `0` turns it off. The value is the advisory
soft-deadline window armed for each accepted assignment; expiry sends the idle
controller one digest and never aborts, steers, or closes an agent.

`Clear idle…` asks for confirmation, closes exactly the directly owned `idle`
workers, and reports how many were cleared. Working, settling, foreign-owned,
and durably owned descendant workers are left untouched, and no active
assignment is interrupted. Close one exact worker with `agent_close`.

## `/agents stop`

Destructive lead-only emergency control.

It aborts the current lead turn and attempts to close the exactly proven owned
agent tree.

It reports discarded active work or durable pending results when present.

Cleanup uses existing exact ownership proofs and proceeds conservatively across
independent failures.

Use ordinary `agent_close` for normal targeted model-driven control.

## Chief

Every session starts as a Lead. An eligible ordinary Lead can activate runtime
Chief mode with `/chief`. While Chief, `/chief` opens the overview and
`/chief leave` exits the mode. Chief's staff roster contains the ordinary Leads
it supervises directly. See [Coordination](../concepts/coordination.md) for the
role boundaries.

### Focus actions

Selecting a live row in the Chief overview, `/chief` on a Herdr
runtime where a Chief already holds the lease, and `/agents` Running all focus a
pane. Each refreshes its own identity proof — a supervision row, the verified
Chief descriptor, or a live managed row — and then asks the Agent Radar daemon
to observe and focus that exact pane. `herdr agent focus` is no longer called.

Focus therefore requires a running daemon that advertises both `observe` and
`focus`. Without one nothing is focused, no other adapter is tried, and the
action reports it:

- No usable daemon: `Radar control plane unavailable (code: message); the lead
  was not focused.`
- The fresh observation no longer places exactly one agent with that Pi session
  at the proved pane: `Radar could not confirm the lead from a fresh observation;
  reopen staff.`
- The daemon refused the operation: `Radar did not focus the lead (code:
  message).`
- The daemon accepted the operation but its reply was lost: `Radar did not
  confirm the focus (message); the lead may already be focused.` The action then
  reads that operation's record back under the same operation id, so a focus is
  never submitted twice.

Each notice names its own surface: `the lead` with `reopen staff.` for an
overview row, `the chief` with `reopen the command.` for `/chief`, and `the
selected agent` with `reopen Running.` for `/agents` Running.

## See also

- [Coordination](../concepts/coordination.md)
- [Staff tools](staff.md)
- [Supervisor tools](supervisor.md)
- [Agent tools](agent.md)
- [Configuration](configuration.md)
- [Status widget](status-widget.md)
