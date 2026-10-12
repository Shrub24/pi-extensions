# Staff tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`staff_*` is the direct-report interface for an active Chief session. Chief can
list, inspect, read transcripts, and message its direct Leads.

Lead-targeted actions use the exact full Pi `session` ID from a fresh
supervision snapshot or `staff_list`. Presentation state is not authority; every
action revalidates current identity and direct-report authority.

## Direct-report projection

Chief sees ordinary Leads that it supervises directly. Chief may observe their
descendant Agent counts but cannot target another Lead's Agents.

A direct-report record can expose the exact `session`, presentation-only
`display_name`, runtime state, Agent counts, `available_tools`, and optional
branch provenance. Use `session` as the target, never `display_name`. The
automatic supervision snapshot is bounded state, not terminal or transcript
evidence. Use `staff_list` when a fresh complete roster is materially needed.

## `staff_list`

```json
{}
```

Returns a fresh direct-report projection and fresh `available_tools`. Do not
call `staff_list` merely to poll progress.

## `staff_inspect`

```json
{ "session": "<exact full Pi session ID>" }
```

Read-only. Requires a current exact direct-report session. Returns bounded live
terminal/process evidence. It does not expose persisted Pi conversation
history. Use it only when live terminal/process evidence materially matters.

## `staff_transcript`

```json
{ "session": "<exact full Pi session ID>" }
```

Read-only. Requires a current exact direct-report session and revalidates the
persisted Pi session before returning bounded visible conversation and tool
evidence. Reasoning, system messages, extension entries, and control markers
are excluded; the internal session-file path is not returned.

## `staff_message`

```json
{
  "session": "<exact full Pi session ID>",
  "message": "Please revise the error handling.",
  "files": ["/tmp/review.md", "result:implementation#1"]
}
```

Queues one bounded follow-up to the exact direct report without waiting for
completion. `files` accepts ordinary paths, reusable direct Agent refs, and
canonical result refs already supplied as evidence. Attachments are prepared
at submission; the coordination record contains text.

## See also

- [Supervisor tools](supervisor.md)
- [Commands](commands.md)
- [Status widget](status-widget.md)
