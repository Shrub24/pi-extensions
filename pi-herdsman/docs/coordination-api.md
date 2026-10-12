# Coordination API

[Documentation index](README.md) · [Getting started](getting-started.md)

Pi Herdsman exposes small, role-specific model-facing interfaces. This page is
the router to their exact contracts, not a second copy of them.

## Owned Agent work

A Lead or delegation-enabled Agent controls only its owned Agent boundary.

Use [Agent tools](reference/agent.md) for:

```text
agent_list
agent_delegate
agent_continue
agent_steer
agent_interrupt
agent_extend
agent_reply
agent_close
agent_inspect
agent_transcript
```

`agent_extend` appears only for a directly owned worker with an armed soft
window; it lengthens that worker's next advisory checkpoint without changing
its assignment, and can replace that assignment's `watcherGuidance` for a
consumer that filters checkpoints.

Managed Agents contact their exact direct owner through
[`ask_owner`](reference/ask-owner.md).

The lifecycle and execution-ownership rules are documented in
[Lifecycle](concepts/lifecycle.md) and [Delegation](concepts/delegation.md).

## Direct reports

Chief uses [Staff tools](reference/staff.md) for direct-report observation and
communication.

```text
staff_list
staff_inspect
staff_transcript
staff_message
```

## Direct supervisor

Ordinary Leads communicate upward through [Supervisor tools](reference/supervisor.md).

```text
supervisor_message
```

The message routes to Chief.

## Same-role peers

Ordinary Leads can discover and message live peer Leads through
[Peer tools](reference/peer.md):

```text
peer_list
peer_message
```

Peer communication does not change ownership or supervision authority.

## Human UI

Slash commands and TUI surfaces are separate from the model-facing contracts:

- [Commands](reference/commands.md)
- [Status widget](reference/status-widget.md)
- [Getting started](getting-started.md)

For the relationship between Chief, Lead, and Agent, read
[Coordination](concepts/coordination.md).
