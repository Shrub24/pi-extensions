# Ignore a foreign session record before validating it

## Decision

Reading session metadata scans every metadata entry and skips any whose
`sessionId` differs from the session being read, before inspecting the payload.
The latest record for the current session id is authoritative. A latest record
that cannot be parsed yields `unavailable` — it is never replaced by an earlier
record, and it never fails the session. Writing is idempotent: a classification
identical to the current one appends nothing, and a managed session is never
rewritten as an operator.

## Rationale

A session file is a branch, and a branch can be copied: a fork replays its
source's entries, and a rewind can return to an earlier point with later records
still on disk. A record naming another session is therefore not corruption; it is
the ordinary result of copying. Reporting it as a defect would be wrong, and
adopting it would be worse — the copy would inherit a classification, and a
worker could be told it is a lead.

Filtering before validation keeps a foreign session's defect out of this
session's diagnostics, which matters because the record may have been written by
a different build with different field rules.

`unavailable` is the honest answer when the current record cannot be read.
Falling back to an earlier record would present a superseded role or owner as
current, which is exactly the fact a consumer wants to trust. Guessing is not an
option either: the reader cannot know whether a role or a direct owner changed
next.

None of this is admission. Ownership provenance and the assignment lock decide
what a session may do, so an unreadable or missing classification can be reported
and left unresolved while the session continues to run.

## Alternatives rejected

- Validating a record before comparing session ids: a foreign record's unknown
  field or format would surface as a defect of this session.
- Using the first matching record: a later role change or a new direct owner would
  be invisible, and the reader would report the session as it was, not as it is.
- Rewriting a record in place: Pi session files are append-only.
- Falling back to the newest parseable record when the latest one is unreadable:
  it presents a superseded classification as current.
- Treating an unreadable record as fatal: a discovery field would be able to stop
  a live session that is otherwise healthy.
- Letting a copied record classify the copy: a forked or rewound session would
  inherit its source's role and owner, and the metadata would be worth less than
  the directory it replaces.

## Consequences

- A fork carries its source's metadata records and is read as unclassified until
  it writes its own, which it does at startup.
- The append is skipped when nothing changed, so repeated startup adds no
  duplicate record.
- A record written by a newer version yields a durable diagnostic entry naming the
  reason, so a field added in the future is visible rather than silently ignored.
- The reader needs no write access and no lock, so any consumer can read a session
  file that a live process is still appending to.

## See also

- [Session organization](../reference/session-organization.md)
- [Record session classification in its own versioned entry](0025-record-session-classification-in-its-own-entry.md)
- [Accept an older owner's request shape](0022-accept-an-older-owners-request-shape.md)
