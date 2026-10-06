# Record session classification in its own versioned entry

## Decision

A session's classification is a dedicated session entry,
`pi-herdsman-session-metadata`, version 1. An operator record carries the role; a
managed record carries the effective definition as the role, the direct owner's
session id, the definition and the label. Records are appended chronologically and
the latest record for the exact current session id is authoritative. An earlier
record is history — a previous role or a previous direct owner — never a fallback.

The launch entry `pi-herdsman-agent-definition` keeps its meaning and gains no
classification field.

## Rationale

`pi-herdsman-agent-definition` records one launch: which definition and label
started this generation. Classification is a different kind of fact. It changes
while the session lives — a lead role is restored or suspended, a worker
continues under a new owner — and each change would have to be written as a new
record for the launch entry to stay honest, which turns launch provenance into a
timeline of unrelated facts and leaves a reader unable to tell which fields
describe the launch and which describe the present.

A separate entry can be strict. Version, kind and the exact field set per kind
are validated, so an unreadable record is reportable instead of being read as
whatever fields happen to parse. That matters because the entry is written to a
file that outlives the code that wrote it.

Append-only chronological records also survive a fork and a rewind honestly: the
added record is the newest statement about the session, and every earlier one
stays readable as what was true before.

## Alternatives rejected

- Adding a `kind` and `parentSessionId` to `pi-herdsman-agent-definition`: the
  launch record would have to be appended again on every classification change,
  and a reader could no longer treat it as launch provenance.
- Rewriting the classification record in place: Pi session files are append-only
  JSONL; there is no rewrite.
- A sidecar file keyed by session id under Pi agent data: a second location that
  must be kept consistent with the session file, and one that outlives the file
  it describes when a session is deleted or moved.
- Deriving classification from the live pane: an offline consumer — a picker, an
  indexer, a viewer that never attached to Herdr — needs it from the session file
  alone.

## Consequences

- A reader selects the latest record whose `sessionId` matches the session it is
  reading, and skips any other before inspecting its payload
  ([ADR 0027](0027-ignore-a-foreign-session-record-before-validating-it.md)).
- An unreadable current record produces an `unavailable` result and a durable
  diagnostic entry. It never fails the session, because classification is
  discovery information and no control decision reads it.
- A managed session is never downgraded to operator by a later record: opening a
  worker's file does not make it an operator session.
- The entry is written from the existing role-persistence path and from managed
  startup, so no new lifecycle handler observes session events.

## See also

- [Session organization](../reference/session-organization.md)
- [Ignore a foreign session record before validating it](0027-ignore-a-foreign-session-record-before-validating-it.md)
- [Store fresh managed sessions under the target working directory](0026-store-fresh-managed-sessions-under-the-target-cwd.md)
- [Use durable ownership for agent scope](0003-use-durable-ownership-for-agent-scope.md)
