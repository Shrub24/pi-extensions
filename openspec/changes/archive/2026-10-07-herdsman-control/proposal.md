# Owner-side control for managed close and restart

## Why

An operator surface such as Agent Radar can see every managed agent but can
only act through Herdr, which knows nothing about assignments. A direct pane
close on a managed worker orphans its assignment, and Herdsman can only read the
result as `lost`. Herdsman's own controls (`agent_close` and the rest) are
model-facing tools inside the owner lead's Pi session, so no non-model caller
has an entry point, and no transport exists to give it one.

## What Changes

- Herdsman defines `herdsman-control/v1`: a request/result file contract under
  `~/.pi/agent/pi-herdsman/control/<ownerSessionId>/`, by which an operator
  surface asks the owner of a managed worker to close it or restart it.
- The owner executes a request by re-running the preflight `agent_close` already
  applies, at execution time, so every existing refusal survives and a change
  between receipt and effect refuses instead of acting.
- A request is claimed exclusively before it executes, so a crash mid-execution
  can never be repeated silently. Expiry is enforced by the owner, not by a
  requester-side timer.
- Restart is limited to idle retained managed workers, continuing the same Pi
  session. A lead, root or standalone session gets a typed refusal.
- A requester may close a pane directly only with positive evidence that it is
  unmanaged. Metadata absence means unknown.

## Impact

- New capability `herdsman-control`, with a reference page and a fixture both
  sides test against.
- A new watcher in the owner session and a new `pi_herdsman_control` pane token.
- No change to `agent_close`, the assignment projection, or any existing
  tool. No inbound socket and no change to the Radar metadata bus.
- Implementation touches `extension/index.ts` and `extension/core.ts`, which the
  lifecycle workstream edits; it is sequenced after this specification lands.
