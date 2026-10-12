# Supervisor tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`supervisor_message` is the coordination operation for ordinary Leads. It routes
to Chief. Managed Agents use `ask_owner` instead.

Direct-supervisor delivery validates the current authority. Ambiguous or
incomplete authority fails closed instead of silently routing around the
supervisor.

## `supervisor_message`

Available to ordinary Leads.

```json
{
  "message": "The branch is ready for review.",
  "files": ["result:reviewer#1"]
}
```

Use it for material progress, decisions, warnings, and review handoffs. Messages
are bounded. `files` accepts ordinary paths, reusable direct Agent refs, and
canonical result refs already supplied as evidence; attachments are prepared at
submission and the durable message is text-only.

## Delivery

Direct-supervisor messages are queued for the exact current recipient and
validated against current authority before delivery.

## See also

- [Staff tools](staff.md)
- [Peer tools](peer.md)
