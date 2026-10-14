# Focus panes through the Radar daemon

## Decision

Every physical focus Herdsman performs moves to Agent Radar's control plane:
selecting a live row in the Chief overview (`focusSupervisedLead` in
`extension/index.ts`), `/chief` on a runtime where a Chief already holds the
lease (`focusExistingChief`), and `/agents` Running. Each consumer keeps its own
identity proof and moves only the physical effect.

The proofs are unchanged: the lead path reloads supervision state and requires
exactly one Herdr agent matching the lead's
`workspace_id`/`tab_id`/`pane_id`, Pi kind and resolved session id; the chief
path requires the verified descriptor plus the one Herdr agent it names, with the
session relation that proof used; Running requires a fresh status row with the
same label, pane and published session id. A shared seam then asks the daemon to
`observe` — requiring the `observe` capability — and accepts the effect only if
that fresh inventory holds exactly one agent satisfying the consumer's own
identity check at the proved location. It focuses that observation's `pane_id`,
requiring the `focus` capability, with the caller's own operation UUID. If the
daemon answers with a failure that does not prove non-dispatch, the seam reads the
record back with `request` under the same UUID and reports the outcome instead of
retrying.

An observation that does not prove exactly one such agent is reported as an
inability to confirm — `Radar could not confirm the lead from a fresh
observation; reopen staff.` — because the daemon resolves duplicate pane records
itself and a refusal there does not establish that anything changed.

Typed `observe` and `focus` methods from the published `pi-radar` client serve
these consumers; no other mux methods are added. `focus` success means the daemon
performed a focus. It is never evidence of process liveness, startup readiness or
assignment completion.

## Rationale

Focus is the one mux effect Herdsman performs that carries no process semantics:
it needs no launch, readiness, stop or restart contract, so it can move to the
daemon while launch and close stay on the direct adapter. `observe` is read-only,
and the daemon's normalized inventory supplies the opaque pane handle a focus
target requires — a handle the daemon, not Herdsman, names.

Keeping the Herdr proof while Radar performs the effect is additive: identity
policy (ADR 0003, ADR 0030) is untouched, and the daemon sees a second, immediate
observation rather than a weaker proof. The extra read is what lets each action
refuse a pane whose occupant changed between the proof and the effect.

## Alternatives considered

- **Keep dispatching `herdr agent focus`.** That is the state this decision
  replaces; deferring it leaves the only live mux effect that needs no launch,
  readiness or close contract on the direct adapter.
- **Fall back to Herdr focus when the daemon is absent or lacks the
  capability.** Rejected. A capability absence is an explicit refusal, and after
  an uncertain dispatch a second adapter is a second effect. Whether a
  non-daemon deployment should keep a template/mux fallback is a separate
  decision; these actions fail with a stated reason instead of guessing.
- **Trust the Radar agent registry instead of mux inventory.** Rejected.
  Registry records describe publications, not panes, and never prove which
  observation currently sits at a location.
- **Resolve the target from the Herdr alias or name.** Rejected. Aliases are
  run-scoped (ADR 0030) and the daemon takes opaque location handles only.
  Running's label is presentation, not identity: an unproven row is refused
  rather than focused by name.
- **Retry an unresolved focus with a fresh UUID.** Rejected by the wire contract:
  a possibly dispatched mutation is never resent, and never resent through
  another adapter.

## Consequences

The three focus actions now require a reachable Radar daemon that advertises
`observe` and `focus`. Without one they fail with a notice and perform no effect,
including no direct-Herdr fallback, so a daemon that is not running is visible
instead of silently masked. No `herdr agent focus` call site remains.

Each consumer correlates the observation with the identity its own proof had. The
lead and Running compare the session id the daemon reports or resolves, and the
chief reuses the id-or-exact-session-path relation its Herdr proof applies, so a
chief remains focus-able before its session file exists. `/agents` Running
requires both a proved pane and a published `pi_session_id` before it asks the
daemon anything, so a row missing either is refused rather than focused on its
label and pane alone.

Unlike the previous direct call, focus no longer takes an abort signal: an
abandoned wait leaves a possibly dispatched operation that only the durable
record can resolve.

`RadarClient.call` takes a caller-supplied envelope id for mutations, because the
durable record — and therefore any readback — is keyed by the id on the wire.

Each action builds its own client per invocation, paying one extra handshake, so
it shares no capability cache with the always-on publication adapter.
