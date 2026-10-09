# Herdsman adoption of Radar's daemon registry

Status: proposed implementation plan; no production implementation approved by this document.
Baseline: pi-extensions `b27bf1dfd`; Radar wire/docs/fixture `92ea9d37fdabafae88b1b41dfc7964b657d6c911`.
Evidence: `radar-daemon-adoption-recon.md` in this directory. Recon is source-read evidence, not a live integration test.

## Goal

Publish Pi execution and Herdsman assignment facts directly to Radar's backend-independent daemon.
Preserve useful native Herdr Pi reporter behavior without introducing another Herdr publication path.
Registration and publication are this change; mux lifecycle replacement is not.

Acceptance is registry observations through `agent.get` and `agent.list`, not a Radar TUI row: the TUI
registry consumer is not implemented at the pinned Radar revision.

## Placement

Start with modules inside pi-herdsman, not another extension package:

- `radar-client.ts`: trusted control socket, v1 request/reply transport and strict bounded decoding.
- `radar-publication.ts`: durable subject/writer binding, ordered publish/replay and heartbeat lifecycle.
- `radar-execution.ts`: generic Pi execution adapter, independent of role, assignment or Herdr.
- Existing owner projection feeds the assignment channel through the publication module.

These are functional seams, not a prescribed number of files: merge helpers when no independent
consumer/test boundary warrants a file. The execution adapter may later become a separate extension;
it must accept identity and transport dependencies rather than import Herdsman's assignment internals.
There is one execution publisher per subject and one owner assignment publisher, not two extensions
competing to report the same execution. No separate-package migration is needed for the first port.

Cover lead/controller, managed child, and unmanaged/operator Pi sessions that load Herdsman. Sessions
that do not load Herdsman are outside initial deployment coverage. Optional owner/run/label fields stay
absent when there is no actual assignment; do not manufacture a taxonomy for ordinary sessions.

## Native reporter behavior to carry over

The deployed native reporter is byte-identical to Herdr 0.9.3's version-9 Pi integration. Its useful
behavior is session association, working/blocked/idle reporting, nested dialog blocking precedence,
reload-mid-run initialization, and non-blocking best-effort delivery.

| Existing behavior | Radar adapter behavior |
| --- | --- |
| Session association at startup and run start | Correlate Pi session with subject under the immutable-registration policy; see gate G1 below |
| Working on agent start | Pi run events supply execution activity; tool-call completion is not assignment completion |
| Settled → idle | Consume Pi 1.1.0 settled outcome separately from activity; an abort is not assignment cancellation |
| Dialog blocked > working > idle | Preserve nested dialog accounting; support the existing `herdr:blocked` event as an input hook, not a Herdr transport; include rpiv questionnaire events without double counting |
| Reload while working | Initialize from Pi context, not an assumed idle default; recreate no false process incarnation |
| Best-effort queue/retry | Bounded asynchronous drain; daemon absence never delays delegation, tool turns or result settlement |
| Herdr pane gate and TUI-only gate | Do not require Herdr to publish. Location is optional. Explicitly test supported Pi modes rather than copying the reporter's PTY-specific restriction |

Execution `last_outcome` reflects Pi run outcome (including aborted/error), not the owner's assignment
result. Assignment `last_outcome` reflects the validated delivered/failed assignment. Keep these facts
separate even when they disagree. Never copy owner `available_tools` onto the execution channel.

## Identity and correlation

A Pi session UUID is not a process identity. A new worker process gets a new subject registration even
if it resumes the same session or reuses the same pane. Publisher reconnect is not a new subject.

Prefer subject self-registration: the running Pi process owns immutable registration content and its
execution binding. It knows its actual PID and startup identity; the owner does not guess a child PID
from a shell. A small Linux birth-identity reader may claim `{boot_id,pid,start_ticks}` with exact wire
fields; unsupported/unreadable identity must remain omitted/unavailable, never absent. This reader is
not a process supervisor. Reuse an existing suitable reader if discovered; otherwise test the bounded
parser at its boundary. Process claim is useful evidence, not authority to restart.

For managed children, use a private publication sidecar under Herdsman's data root to convey the exact
`agent_id` and subject incarnation to the owner. Bind it to run/session/label plus process generation;
validate it against the owned assignment before acquiring an assignment writer. No mailbox schema
change, no session-UUID-only lookup, no global registry search, and no secret credentials in the sidecar
read by the owner. Writer handles remain private to their publisher store. Atomic replacement and
ownership/mode/symlink validation follow existing private-file patterns.

Omit launch specs in the first slice: they are optional and inert, and collecting/reconstructing argv
adds no consumer here. Do not register a shell-quoted terminal input line as semantic launch argv.
Location includes only known backend-qualified facts, never guessed tab identifiers.

Radar's owner confirmed the immutable-registration policy against `92ea9d37`: register stable process
facts only. Omit session/location/owner/run/label wherever they can change for the same process; include
managed run/owner only when fixed for its lifetime. Session switch or in-process fork does not rotate
subject identity or retire writers. Mutable current-session context is published through `agent.context`
using the same writer with a newer sequence. Registration remains immutable and retries stay identical.

## Publication ownership and vocabulary

- Execution: authored in-process from Pi lifecycle and dialog events; activity `idle`, `working`,
  `blocked`; compaction/outcome remains separate where the wire supports it.
- Assignment: authored only by the actual Herdsman owner, using the existing assignment projection
  (`working`, `waiting`, `blocked`, `settling`, `idle`, `lost`, `unknown`) without redefining it.
- Waiting reason: use actual questionnaire/background/child evidence, bounded and without task text.
- Actions: owner assignment channel may advertise existing eligible tool names, bounded by the wire;
  do not silently truncate an oversized list. Execution advertises none initially.
- Outcome details: bounded diagnostic summary only; no full prompt, output transcript, path or writer
  credentials in public fields. Keep private session paths out of public registration/snapshot content.

Loss, uncertainty and publication freshness are independent. A stale lease is not proof of a dead
process; a fresh report is not permission to close; retired channels do not certify assignment delivery.
Saved-session discovery is a different feature and must not mint process registrations for history.

## Transport and durable reconnect

Use `RADAR_CONTROL_SOCKET`, then `$XDG_RUNTIME_DIR/agent-radar/control.sock`, then the documented
UID-specific fallback. Never use the background-task `radar.sock` resolver. Validate parent/socket
ownership, type, permissions and symlink boundaries before dialing. Negotiate protocol 1 and
`agent_registry`, with no mux capability requirement.

One serialized publisher drain per channel. Persist before sending: immutable register content,
publisher incarnation, current writer binding/generation, accepted sequence, and the exact pending
publish request (sequence, snapshot, lease and observed time). Private files/directories use 0600/0700,
bounded reads and atomic replacement. A lost reply replays identical content; a newer heartbeat uses a
new sequence. Do not let latest-only coalescing overwrite an unresolved in-flight request.

Daemon restart: preserve identity/binding, replay uncertain content, then publish a newer complete
snapshot so restored facts become fresh. The client does not derive freshness from its own clock.
Fencing: stop the affected channel and surface one bounded diagnostic; never retry replacement or
mint another subject to evade fencing. A deliberate publisher replacement uses the exact incumbent
handle/generation and explicit handoff; no automatic lease-expiry takeover.

Transport deadlines and backoff never sit in an awaited assignment path. Timers and listeners are
owned by the adapter and disposed on shutdown/reload. Retiring a channel is best-effort asynchronous
cleanup with retained pending content where necessary, not a new assignment-settlement dependency.

## Stages and validation

### 1. Contract/client and durable publisher

Vendor the exact registration JSONL fixture with its upstream pin. Implement only the methods used by
registration/acquire/publish/retire; do not build a generic mux client in this slice.

Tests: trust rejection, capability mismatch, bounded malformed replies, immutable registration replay,
lost publish acknowledgment, exact-content retry, monotonic sequence/heartbeat, daemon epoch restart,
stale writer fencing, private persistence and optional daemon absence. Use temporary directories and
fake sockets; real-daemon checks use an isolated disposable state root, never live runtime data.

### 2. Generic execution adapter

Wire startup, run start, settled outcome, dialog blocking, reload and shutdown for every supported
Herdsman-loaded Pi role. Pin startup/reload in a working run, nested dialogs, aborted vs finished run,
provider error vs assignment failure, missing location, and multiple process subjects sharing one Pi
session UUID. Session switching must keep the same subject and omit mutable session association. No Herdr CLI/socket invocation is permitted
by this adapter.

### 3. Managed owner assignment publication

Consume the verified child binding and existing owner projection. Pin one child subject with separate
execution/assignment writers, waiting and unread-result states, delivery/close retirement, retained
worker staying the same subject, and relaunched worker becoming a new subject. Publish on the existing
projection boundary, not a second mailbox scanner or recurring transcript reader.

### 4. Integration/deployment

Run the package gate with the existing normalized test bootstrap and isolated publisher fixtures.
Run a disposable daemon fixture smoke for register/get/publish/reconnect/fence/privacy. Then deploy
both publishers in lead and child and record a controlled live assignment's identities and channel
facts. Coordinate AOT packaging only if the new modules need staging adaptation; plain source changes
should not introduce import.meta.url asset discovery or variable dynamic imports.

Do not claim the old reporter is removable until the readiness/presence consumers below have a
replacement. No new Herdr mirror is part of any stage.

## Transition dependencies — no compatibility feature

Current launch readiness, exact session/presence checks, control state and the Herdr operator display
still consume the existing native reporter/agent registry. The daemon's current physical API does not
replace launch/readiness/events/managed termination. First publication adoption leaves those existing
paths untouched; it neither adds a mirror nor promises complete Herdr independence.

Removing the installed native reporter requires a separate coordinator/execution-layer cutover. If the
owner requires its removal in this first change, the scope must expand explicitly rather than silently
breaking launch readiness. Preserve its behavior in Radar now; retire its transport with those consumers.

## Contract gates and follow-ups sent to Radar

G1 resolved and implemented: Radar feature pin `4e37697826c2ba4a28c92a93e22747df2bc7097e` adds source-labelled `agent.context`; fixture-validation/reference pin `da0ba99a09643736e39c44903d69ffdc1e5df65b` corrects the canonical fixture and validates full response equality. Publish only the current session UUID or explicit null through the same writer with a strictly newer sequence. Session changes do not re-register or change subject, agent_id or writer generation. Renew on the existing 15-second publication cadence under the default 30-second lease. A warned identical replay does not renew local accepted time. Session paths remain private; never overload registration or execution/assignment snapshots.

G2 corrected by Radar owner: pagination already exists in `92ea9d37`; the reference omitted it.
`agent.list` takes `limit` (1..100, default 50) and optional `after`; its result contains `agents` and
`next`. Continue with `after=next` until null, never infer completion from page length. Order is stable
lexicographic agent_id, but not a frozen fleet snapshot. Known `agent.get` IDs remain the owner path.
Retention/pruning of accumulated registrations remains a Radar follow-up; no client workaround.

G3 resolved by Radar owner: the Herdsman-local binding sidecar is the supported first seam. Store the
exact agent_id with subject birth/run identity and validate it atomically; Do not use session UUID as unique registry identity.

Writer handoff across a genuine owner replacement remains explicit; no new ownership/recovery lifecycle
is introduced here. Ordinary sessions with no owner/run/label are permitted by the current wire; their
TUI rendering is a Radar consumer follow-up, not a reason to invent managed identities.

## Done

The first port is done when daemon reads show correctly correlated independent execution/assignment
facts, reconnect/fencing/privacy tests pass, optional daemon absence has no effect on work, native
reporter behaviors are represented where supported, and the remaining physical Herdr dependencies
are stated honestly. No launch/stop/resume, retention redesign, saved-session implementation,
pi-subagents work, or terminal-input workaround belongs to this change.

## Process-lifetime identity seam (implemented)

Owner decision: subject identity is a process-local incarnation UUID held in a namespaced
`Symbol.for("pi-herdsman.radar.process-slot")` slot on `globalThis`. A new OS process starts with an
empty slot and mints a fresh UUID even when it resumes the same Pi session; an extension reload runs
inside the same process, so it reuses the slot, the subject and the one serialized publisher.

Reason: a resumed session is a different subject from the process that owned it before — the earlier
writer may still hold the daemon's lease — while a reload is the same subject and must not mint a
second one. Neither PID nor Pi session UUID can express that distinction: PIDs are reused, and a
session UUID is not unique to a live process.

Rejected alternatives: publishing only on Linux, using `/proc` start time as the subject identity
(absent elsewhere, and any later observer could re-read a different value); a durable
process-generation/lock subsystem under the data root (more state than the distinction needs, and it
would have to survive exactly the crashes it cannot observe).

Privacy and immutability: private persistence is keyed by the incarnation, not by PID or session UUID.
Immutable registration content — source, owner/run/label, and the Linux birth claim when the platform
reports one — is written once with the incarnation's private subject record, so a later successful
`/proc` read cannot change what this incarnation is registered as. Birth identity is optional verifier
evidence: when unavailable it is omitted, never inferred. Session UUID, session paths, prompts and
writer handles are in neither registration nor snapshot content.

Known ceiling: a dialog `active` event that is never withdrawn leaves its label as the subject's
blocked reason until the next session boundary. Retirement is best-effort and asynchronous.
