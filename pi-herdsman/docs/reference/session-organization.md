# Session organization and metadata

Herdsman separates new managed-worker session files from operator conversations
and writes enough durable classification into each session's own JSONL for an
offline consumer to tell what a session is and who directly owned it. Metadata is
discovery information: it never authorizes continuation, control or reuse. Those
rights stay with the existing ownership and result provenance.

## Where sessions are stored

Pi's native `sessionDir` setting stores this operator's new sessions under
`<cwd>/.pi/sessions/`. Native CLI and environment overrides keep their normal
precedence, so an explicit `--session-dir` still wins for operator sessions. An
installation without that setting keeps writing wherever Pi is otherwise
configured; Herdsman never rewrites an already-open operator session.

Fresh managed sessions are launched with `--session-dir
<target-cwd>/.pi/sessions/children`, which overrides inherited
operator configuration on purpose. Storage follows the **target cwd**, not
delegation depth or the parent session file, so a worker delegating another
worker in the same cwd reuses one `children/` directory and never creates
`children/children`. A launch targeting another cwd writes under that cwd.

Native listing is flat, so the operator picker's current-folder scope reads
`<cwd>/.pi/sessions/*.jsonl` and never shows the `children/` subdirectory.
Resuming a child by its exact path re-homes Pi to that file's own directory for
later `/new` and picker scopes, so resume a child only when that is intended.
Nothing is moved: continuation, retained
reuse, recovery and owner-control restart keep passing the saved session's exact
`--session <path>`, so a session opened under the old global directory stays
there. Historical session files are not migrated, renamed or deleted, and no
global registry replaces the picker yet: a session stored under a local
`.pi/sessions/children/` directory is outside the default global discovery scan
until that registry work lands.

Local session data is generated, ignored by version control, and not part of a
clone. Back up or export any session you need to keep.

## The metadata entry

Herdsman appends Pi custom entries of type `pi-herdsman-session-metadata`. Data
version `1` is either an operator record:

```json
{"type":"custom","customType":"pi-herdsman-session-metadata","data":{"version":1,"sessionId":"5f2c4e0a-9c31-4a1e-9a1c-2f9a8e6b1d40","kind":"operator","role":"lead"}}
```

or a managed record, which adds the definition, the label and the direct owner:

```json
{"type":"custom","customType":"pi-herdsman-session-metadata","data":{"version":1,"sessionId":"a91b7d52-3f8e-4c62-9f1b-6d0e2c7a4b18","kind":"managed","role":"worker","parentSessionId":"5f2c4e0a-9c31-4a1e-9a1c-2f9a8e6b1d40","definition":"worker","label":"impl"}}
```

| Field | Operator | Managed | Meaning |
| ----------------- | -------- | ------- | ---------------------------------------- |
| `version` | required | required | Data version; `1` is the only known one |
| `sessionId` | required | required | The exact Pi session UUID this record describes |
| `kind` | required | required | `operator` or `managed` session origin |
| `role` | required | required | `lead`, `manager`, `chief`, or the effective definition name |
| `parentSessionId` | — | required | Current **direct owner's** Pi session UUID |
| `definition` | — | required | Managed agent definition name |
| `label` | — | required | Worker runtime label for the current generation |

A record carries no pane, process or live-activity state, no credentials, no
paths and no transcript content. Consumers derive the hierarchy themselves by
joining each `parentSessionId` to the session that carries that `sessionId`;
there is no child list. The entry is written beside the pre-existing
`pi-herdsman-agent-definition` identity entry, which is unchanged: identity
still answers admission questions, this entry only answers classification.

## Origin versus role

`kind` records where the session came from — an ordinary operator session or a
managed launch — not whether it is alive or what it is doing right now. `role`
is the effective role: an operator's Lead, Manager or Chief position, or a
worker's effective definition name, matching `pi_herdsman_role` on the pane.

A managed session keeps `kind: "managed"` even when its file is opened outside a
managed launch environment; it is not reclassified as an operator just because a
human resumed it by hand. Its recorded owner, definition and label are preserved.

## Direct owner is not fork lineage

`parentSessionId` is the current direct owner — the same identity as
`pi_herdsman_parent_session` — so worker A delegating worker B records A. It is
not the root Lead, and it is not Pi's native `parentSession` header, which keeps
its own fork/branch meaning and is never rewritten to express orchestration
ownership.

## Chronological updates

A record is appended at session startup and whenever the effective role or the
direct owner changes. Nothing is rewritten or deleted, so earlier records remain
as history and the latest current-session record is authoritative. An owner that
legitimately continues a saved managed session under a new controller appends a
new record; the session identity and the earlier records are untouched.

An unchanged record is not appended: restarting a session with the same
classification adds nothing.

## Reading a session's metadata

A reader takes the session ID it holds and scans the session's entries in order,
ignoring records whose `sessionId` differs **before** validating their contents,
then interprets the latest record for that ID. A fork that copied its source's
entries therefore inherits nothing: those records name another session and are
skipped, and the fork's own record describes the fork.

A malformed or unsupported-version record for the *current* session is reported
instead of guessed. Herdsman appends a durable `pi_herdsman_session_metadata_error`
entry naming the problem, leaves the classification unresolved, and keeps the
session usable; it never falls back to an earlier record or invents an operator
classification, and a metadata problem never terminates a session.

A legacy `pi-herdsman-agent-definition` session with no metadata has an unknown
owner. Opening its file as an operator neither invents a parent nor records an
operator classification; a later verified managed launch can supply the complete
record.
