# Status widget

[Documentation index](../README.md)

The TUI status widget is a local, display-only projection of exact managed
agents plus controller-local transient starting assignments.

It does not replace mailbox assignment/result authority.

An active Chief receives a separate supervision widget for its current direct
reports (Managers and ordinary Leads without an active project Manager). It
shows both categories together when both exist, not managed Agent rows. An
active Manager receives a work-centric branch projection rather than the
ordinary Lead Agent widget. Chief's complete overview, peek, and focus behavior
is documented in the [command reference](commands.md#project-manager-and-chief). Supervision and
Agent widgets are never combined.

The Chief supervision rows use `├─` for non-final visible reports and `└─` for the
final visible report. Selection and lifecycle remain separate: `>` means
selected, `●` means working, `◐` means blocked,
`◌` means settling or starting, `○` means idle or done, `?` means unknown, and
`×` means lost. An idle or done lead with active delegated descendants uses
`◉`. Workspace labels are presentation text inside each lead row, not
additional hierarchy nodes. The widget caps ordinary reports and shows omitted reports in a final
`└─ … N more · /chief` or `└─ … N more · /manager` row, according to the active role.

Chief's header shows only nonzero categories (`manager`, `direct lead`), or
`no reports`. Manager's header shows the project name and lists managed
branches as work, including work without live Leads:

```text
● manager · pi-herdsman
├─ ● feat/example · active
└─ ○ fix/other · paused
```

Manager work status is `active`, `paused`, or `conflict`.
An active row uses the live Lead's lifecycle marker when an executor is present;
otherwise it uses `●`. Paused uses `○` and conflict uses `!`. The row suffix is
project status, not the Lead's runtime state.
Unassigned live Leads are shown separately, not treated as managed work.
Branches are display handles; exact session identity is revalidated for control
actions.

## Installation

The widget is installed only when the current session has a valid supported
herdr/Pi identity and Pi is in TUI mode.

A lead Pi session gets its exact owned subtree view.

A valid managed leaf can receive an identity-only header.

A delegation-enabled agent can receive its direct-agent counts and rows.

Unmanaged or invalid agent environments do not receive the managed widget.

## Refresh

The widget refreshes managed herdr data plus mailbox state every two seconds.

Refresh performs a bounded herdr pane-list lookup to validate exact physical
identity. It does not add a socket transport or another agent-control protocol.

A refresh failure never mutates mailbox/control eligibility.

## Recurring observation

The widget refresh, the supervision refresh, and the health scan share one
observation contract: they read mailbox state, the bounded herdr pane and agent
list, and Herdsman's own published records. No recurring path opens a full Pi
transcript body.

Authority per role:

- a lead session's own breadcrumb is `herd`, and its rows come from mailbox
  state plus the herdr list;
- a worker or leaf session learns whether its owner is a lead from the owner's
  published coordination state, never from the owner's transcript;
- a row's agent definition comes from the definition recorded in mailbox state,
  else from the runtime resolved earlier in the session. A recurring tick never
  opens a transcript body, so a mailbox whose definition exists only in its
  transcript is resolved by the session-start continuity pass and reused
  afterwards; with neither source the row shows `unknown`.

Exact identity checks stay bounded. Matching an observed session against an
expected one reads only the Pi session header, stopping at its first line
within a 1 MiB budget, and never loads the transcript body.

Missing or malformed evidence is displayed as unresolved and never becomes
authority. A row with neither a recorded definition nor a resolved runtime
reports `unknown`; an absent, unreadable, oversized, or malformed
coordination-state record leaves the owner's lead classification unresolved.
Neither fails the refresh, and an unresolved definition never infers `lost`.

A lead whose session published no coordination state therefore shows its worker
panes an unresolved `?` ancestor instead of `herd`. The lead's own breadcrumb
and status rows are unaffected by that missing evidence.

Explicit reads are different: the agent tools, the transcript tool, `/agents`,
and continuation or settlement paths still resolve the persisted definition and
transcript contents.

## Breadcrumb

Example:

```text
● herd → implementer → scout
```

The breadcrumb uses validated definition/agent ancestry.

Delegating-agent and leaf panes can append a compact summary of their current
Pi active tools as muted bracketed metadata after the current identity.
Ordinary tool names retain Pi's order. Multiple `agent_*` semantic coordination
tools are collapsed into one `agent_*×N` display token. This is presentation
only: `ownTools` and Pi's active-tool state remain exact.

When width is limited, complete metadata items are omitted before breadcrumb
identity is shortened; tool names are not rendered as partial fragments.
Operational header state has priority over tool metadata. Lead Pi sessions do
not show this metadata.

If an ancestor cannot be proved, it is shown explicitly as `?` rather than
guessed:

```text
● ? → scout
```

## Header counts

Example:

```text
● herd  2 working · 1 blocked · 1 settling
```

The header reports exact non-zero lifecycle states in the order `working`,
`waiting`, `blocked`, `settling`, `starting`, `idle`, `unknown`, and `lost`.
`waiting` counts active assignments whose model turn has yielded while provider
work or its required post-review response remains unresolved. `starting` is a
presentation-only count for controller-local assignments that have begun
startup but have not yet become active or terminal. `idle` counts retained
workers whose terminal result was delivered and whose verified live process is
available for one new assignment. Neither is mailbox state, control authority,
or Running inventory.

Before the first successful refresh, the header says `unavailable`.

After a later refresh failure, the widget retains the last valid snapshot and
marks the header `stale`.

Header refresh staleness is not agent inactivity.

## Agent rows

Every visible agent is rendered in a stable tree. Siblings are sorted by
logical label and use Pi's `├─`, `└─`, and `│` connectors.
The row shows the agent definition and its exact logical agent label
separately. The tree contains only agents in the controller's proven ownership
projection; unrooted, ambiguous, or cyclic durable ancestry is not attributed to
the herd.

Rows share globally aligned columns for state, elapsed time, compact model,
thinking, context percentage, and optional inactivity. Context is shown as a
percentage without a `ctx` prefix. Responsive layouts drop the task first,
then elapsed time, then context percentage; the same column choice is used for
every row. The task is the rightmost elastic field and is kept only when it has
useful room before it is truncated.

Working rows use `● working`, waiting rows use `◷ waiting`, blocked rows use
`◐ blocked`, settling rows use `◌ settling`, starting rows use `◌ starting`,
idle rows use `○ idle`, unknown rows use `? unknown`, and lost rows use `× lost`
with the theme's attention/error styling. Working, settling, and starting
animate; waiting, idle, blocked, unknown, and lost rows are static.
While a controller-local start remains pending, an authoritative `settling`
row is presented as `starting` so launch and request handoff remain visually
continuous. `working`, `blocked`, and `unknown` authoritative states are never
overridden. A starting row is removed when its exact request becomes active or
terminal, its local runtime is removed, startup fails or rolls back, the
controller session restarts, or shutdown clears transient state.

The normal widget retains owned `lost` and fail-closed `unknown` rows because
they represent durable unresolved generations whose physical state is either
proven gone or not safely provable. `Running` inspection excludes `lost` and
fail-closed `unknown` rows because they are not safely focusable targets; it
otherwise shows authoritative live agent rows and excludes presentation-only
starting rows. A terminal result is followed by cleanup; the widget does not
retain an idle completed agent.

## Optional metadata

Rows can include best-effort:

- task;
- elapsed time;
- compact model;
- thinking;
- context percentage;
- agent type/display metadata.

These fields are not control authority.

The renderer preserves identity/state information before truncating task text
and bounds every output line by visible Unicode width.

The widget is a compact projection of active-tool state, not an authoritative
or exhaustive tool inventory.

## Agent inactivity

A `working` agent can expose an advisory inactivity marker based on durable
Pi-observed activity.

This is distinct from header `stale`, which means the widget failed to refresh
its latest snapshot.

Neither changes agent control state.

## See also

- [Agent states](agent-states.md)
- [`/agents definitions`](commands.md#agents-definitions)
- [Recovery](../guides/recovery.md)
