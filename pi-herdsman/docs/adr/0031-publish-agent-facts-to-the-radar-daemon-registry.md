# Publish agent facts to the Radar daemon registry

## Decision

Herdsman publishes two independent streams to Agent Radar's control-socket
registry (contract version 1): Pi execution facts on the `execution` channel,
authored by the running process, and owner assignment facts on the `assignment`
channel, authored by the Herdsman that owns the assignment. Publisher code lives
in `extension/radar-client.ts`, `extension/radar-publication.ts` and
`extension/radar-execution.ts`, wired from `extension/index.ts`. The generic
execution adapter is role-independent: it also reports an ordinary or
operator-owned Pi session that merely loads Herdsman, and it omits owner, run and
label when no assignment exists rather than inventing one.

Subject identity is the OS process, not the Pi session. The publisher incarnation
lives in a `Symbol.for` process slot, so an extension reload in a live process
reuses the same registered subject, while a genuinely new process — including one
that resumes the same saved session or reuses the same pane — registers its own.
Each incarnation keeps its private record, its writer binding and its pending
publication under `~/.pi/agent/pi-herdsman/radar/`. Linux
`{boot_id, pid, start_ticks}` is an optional claim that is omitted when it cannot
be read; it never supplies identity.

Registration carries only facts that are stable for the life of the process.
Location, launch specification, current session and mutable assignment context
are deliberately not published; mutable session association is a Radar contract
gap that is neither faked in a prose field nor frozen into process identity. The
owner learns the child's exact `agent_id` from a private binding record that is
validated against the run, owner, label and process generation before it is used.

Publication is best-effort and never load-bearing. An absent daemon, an
unreachable socket, a corrupt private record or a fenced writer produces a
bounded local diagnostic at most, and never delays or fails delegation,
settlement, mailbox cleanup or extension initialization. Negotiation caches only
success: a failed handshake is retried on the next registry attempt. Trusted
reads open with `O_NOFOLLOW | O_NONBLOCK` and validate the record, its namespace
directory and the root before use, so a FIFO or a symlinked namespace fails
closed instead of blocking the event loop or following the link. Ordering is
durable and exact: pending content is persisted before it is sent, a lost
acknowledgment is replayed byte-identically, and a sequence only moves forward.

Existing Herdr usage in Herdsman — launch readiness, presence proofs and the
control-state word — is unchanged, and no second Herdr publication path was
added. The native Herdr Pi reporter keeps running until those consumers are
replaced by a separately scoped coordinator cutover.

## Rationale

Herdsman's own model already separates mux transport from execution authority;
the daemon registry lets that separation become real rather than aspirational.
Radar owns the multiplexer and the registry is backend-independent, so
publication needs no Herdr call and works for sessions Herdsman never launched.
Keeping the daemon read-only toward lifecycle preserves the existing rule that
only Pi's own lifecycle events, correlated with a live process generation and an
assignment, decide execution and settlement.

Process-as-subject is the only definition that survives reload and restart
honestly. A resumed session is a different execution even when the transcript is
the same; a reloaded extension is the same execution even though it re-registers
its listeners. PID and session UUID cannot express either distinction, and
treating a lease as process evidence would let publication freshness masquerade
as liveness authority — which the earlier lifecycle work exists to prevent.

Best-effort containment is required because Herdsman's work must not depend on a
monitoring daemon. That is also why the fail-closed rules sit on the private
store rather than on the wire: the store is the only part that can block or throw
inside Pi's event loop.

## Alternatives considered

**Publish only for managed children.** Rejected: the native reporter already
reported an operator's own TUI session, and dropping it would degrade Radar's
existing view for every ordinary session.

**Keep mirroring state into Herdr metadata alongside the daemon.** Rejected:
Radar is mux-agnostic and the mirror would preserve exactly the coupling this
change removes. Preserving the native reporter as a transition dependency is
different from adding a second publication path.

**Derive subject identity from `/proc` start time** (or from the Pi session
UUID). Rejected: `/proc` evidence is unavailable off Linux and is a claim, not an
identity; a session UUID is shared by any process that resumes it. Both would
mint either duplicate or fictitious subjects.

**A durable process-generation file or lock.** Rejected: it adds a second
authority over liveness to solve a problem a process-lifetime slot already
solves, and it cannot distinguish a recycled PID from the original process
without the very evidence it claims to replace.

**Register a new subject whenever the Pi session changes.** Rejected: it would
rotate a live process's identity and orphan its writer binding, which is the
fictitious-incarnation failure in the opposite direction.

**Trust the socket, not the store.** Rejected: the socket trust check is not
same-user authentication, and a FIFO or symlinked namespace under the state root
can hang or redirect a reader inside Pi's event loop.

## Consequences

Live adoption still depends on deployment: a lead and a child must run the
built extension against a live daemon, and that controlled-assignment check has
not been performed. Until then the port is verified by regressions, an isolated
real-daemon consumer smoke and the contract fixtures only.

Radar cannot yet render the registry in its TUI, so acceptance is measured
through `agent.get` and `agent.list`. The registry has no pruning: private
records and daemon registrations accumulate one per process incarnation, and an
assignment writer whose target vanished keeps one failed acquire per heartbeat
until that child closes. Both are recorded as bounded debt to be resolved with
Radar rather than worked around here.

A daemon-side epoch change makes restored facts stale rather than fresh; the
client therefore replays what it is uncertain about and then republishes a newer
complete snapshot, instead of trusting its own clock. Writer replacement stays
explicit — a successor must name the exact incumbent generation and handle, and a
fenced publisher stops and reports instead of rotating identity to get back in.

Process claim remains a claim. The daemon verifies it independently, and no
publication, lease or retirement state qualifies as proof of process exit,
assignment completion or permission to launch, stop or resume anything.
