# Agents and identity

[Documentation index](../README.md)

A managed agent is a Pi session whose physical lifecycle is owned by herdr and
whose assignment lifecycle is coordinated through the extension mailbox.

## The identities are intentionally different

### Agent definition

The **agent definition** may override the agent's model and reasoning policy,
and selects its tools, skills, extensions, prompt body, context inheritance,
and allowed direct agents. Fresh agents otherwise inherit model and thinking
from their spawning controller session.

Example: `reviewer`.

Definitions are configuration, not live agent identity.

### Logical agent identity

The internal label is projected publicly as the `agent` identity for a live
agent.

Examples:

```text
reviewer
reviewer-2
my-review
```

Use the exact `agent` value from `agent_list` only for
the `agent` parameter to `agent_inspect`, `agent_transcript`, `agent_steer`,
`agent_interrupt`, `agent_reply`, or `agent_close` while those actions are listed
in `available_tools`. An agent label is the stable logical name across
sequential generations of one managed session, not a continuation selector.
It is a control target only for the currently live generation.

Labels must begin with a lowercase letter, contain only lowercase letters,
digits, `_`, or `-`, and be at most 32 characters.

### Pi session identity

Every managed agent has an exact Pi session. The list may expose the session
ID and path for correlation.

A session path or full UUID can be supplied to `agent_continue` to continue
historical managed-agent work. Continuation hands one new assignment to the
session's agent: it uses the saved session's cwd, definition, logical label, and
historical context, and either reuses a retained worker's process or starts a new
generation. The caller cannot rename the continued session. The Pi
session remains the continuation identity, not a live-control identity. An
exact active or unresolved managed representation blocks concurrent activation
of that session.

### herdr identities

Workspace, tab, pane, generated herdr-agent alias, run ID, and process evidence
exist to prove physical ownership and safe cleanup.

They are not public alternatives to the `agent` identity.

## Ownership

A lead and its recursively owned agent hierarchy form a **herd**, Herdsman's term for an agent fleet.

Each agent has one exact direct owner Pi session.

A lead Pi session owns its direct agents.

A delegating agent may own direct agents when its effective definition has
allowed `agents`.

Public list visibility follows this ownership boundary. A lead sees only
generations whose durable owner chain resolves to that lead. Durable descendants
remain attached to their recorded parent even when that parent is lost or
physically unresolved. Missing, ambiguous, or cyclic durable ancestry is not
attributed to a herd.

## Authority boundaries

Different systems answer different questions:

| Authority     | Owns                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| herdr         | Physical process/pane lifecycle, placement, live agent observations                      |
| Mailbox       | Assignment acknowledgement, active/completed request identity, pending ask, final result |
| Pi            | Session history, turns, messages, model interaction                                      |
| Logical label | Internal durable agent identity, projected publicly as `agent`                           |

The mailbox `ResultRecord` is the persisted completion record and carries the
identity needed to match its agent state. The owner-session delivery entry is
a separate, wider record: it also carries delivery metadata such as `cwd` and
the Pi session file. Those records are checked against their respective
identity requirements; `ResultRecord` is not intended to mirror the complete
delivery-entry shape.

If a result cannot be persisted after bounded retries, the agent state carries
a correlated `result_error` recovery condition instead of becoming assignable.

A safe control operation requires these sources to agree. Missing or conflicting
evidence fails closed rather than guessing.

## Agent generations and continuation

A managed agent generation is one process lifetime of a managed agent. It
executes one delegated assignment at a time. Its terminal result is delivered
once, then the agent's pane, process, mailbox, and runtime state are cleaned up.
Failed assignments follow the same path. By default (`retainWorkers: true`),
delivering the result, completed or failed, keeps the verified live process,
pane, label, and mailbox instead of cleaning them up: the same generation takes
the next assignment, and the worker projects as `idle` until a later assignment
reuses it. The cleanup described here happens when that retained worker is
closed, or at once after delivery when `retainWorkers` is `false`.

The Pi session outlives its generations. To continue the same
conversational context, use `agent_continue`, which addresses the worker by the
Radar subject this session recorded at its launch. Continuation of a retained worker
whose launch configuration still matches the current definition reuses that existing
process; otherwise Radar restarts the worker's own recorded session, which restores
the saved session's model and thinking unless the current definition
explicitly overrides either field. A restart keeps the subject, the session and any
held assignment: it is not a close followed by a continuation. Fresh delegation does
not inherit the caller's conversation; pass assignment-specific evidence through task
text and `files`.

The identities are therefore:

```text
agent definition → configuration for new work
Pi session       → durable conversational context and continuation identity
agent label     → stable logical name across sequential generations; live control target only for the current generation
generation      → one process lifetime; a retained worker keeps it across assignments until its launch configuration drifts
subject         → Radar's durable identity for an agent, retained across process lifetimes; Herdsman holds it and nothing else
```

## Radar seams

Herdsman is a Radar client, not a second registry. It calls Radar through the
`pi-radar` runtime and persists no registration or claim IDs.

| Decision | Who owns it |
|---|---|
| Process identity, attachment, launch placement, the 30 s launch deadline | Radar |
| Pi session, definitions, mailbox, settlement, the choice to launch, continue, restart or retire | Herdsman |
| Addressed messages, delivery receipts and attention scheduling | Radar (`pi-radar` mailbox and attention loop) |
| Durable completion capture, rejection and when to prompt or settle | Herdsman |

- A launch or continuation returns `ready`, `failed` or `unresolved`. Only `ready`
  carries a subject; `unresolved` carries the daemon's launch request id, which is
  read back rather than replaced by a second launch.
- Child process evidence is Radar's: `children.observe(subject)` answers live, gone
  or unknown. A missing subject or a failed read is unknown, never proof that a
  worker is gone.
- Recurring reads use one paged `children.list` for the launches backing current
  mailboxes, so retained history costs nothing at rest.
- A pending, duplicate, released or reserved presence grants no child capability,
  so Herdsman adds no local guard on top of Radar's refusal.

### Addressed completions

A sealed handoff is the body of a Radar message. One recipient loop per process
captures it into the existing completion store, deduplicated by message ID, before
Radar records a receipt. Capture does not prompt the model or settle an assignment.
A permanent rejection is recorded in the recipient's session before receipt;
unavailable storage or identity evidence leaves the message pending.

The loop drains at startup. Accepted facts-publication hints reach it through
`publication.facts.onAttention`; an absent hint is normal before a managed subject
exists. Herdsman opts into the attention subscription while working or waiting.
Its own status distinguishes tool, questionnaire, owner, background-work and child
waits from idle; Radar owns the idle hold and reconnect policy. Attention revisions
are never persisted. Background-task snapshots remain on the separate Radar task
bus, and pi-bash-processes still owns task output retrieval.

### Upgrading from the handoff-only mailbox

The addressed-message daemon refuses old records in `communications/`. First
capture pending results with the old build, then stop it and archive or explicitly
discard that directory before starting the new daemon. An empty inbox is not
sufficient: acknowledged records may still be retained. Plain `radar reset` keeps
them; `radar reset --hard` discards acknowledged records too. There is no migration
or dual-write period. Update the daemon, shared baseline and Herdsman SDK together.

## See also

- [Coordination](coordination.md) for the separate coordination model.
- [Lifecycle](lifecycle.md)
- [Delegation](delegation.md)
- [Agent states](../reference/agent-states.md)
- [Agent tools](../reference/agent.md)
