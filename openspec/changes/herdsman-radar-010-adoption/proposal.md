# Radar 0.12 adoption

## Why

Radar 0.7.0 (wire revision 10) and pi-radar 0.12.0 make a child's durable key its `subject_id`, move launch readiness, deadlines and scope placement into Radar, and make the baseline pi-radar extension the one publisher per Pi process. Herdsman still builds its own publisher, keys children on registration ids, runs its own startup acknowledgment and calls retired launch options.

## Changes

- Pin pi-radar 0.12.0 and Radar 0.7.0 / wire revision 10; regenerate the npm lock and Nix integrity from the registry.
- Obtain the baseline runtime through `requestRadarRuntime` instead of creating a publisher; control children through `runtime.children`.
- Launch with `launchRadarWorker({client, publication, launch, signal})`; store the child's `subject_id`; match handoffs on `sender.subject_id`.
- Remove Herdsman's mailbox startup acknowledgment and generation: Radar's granted presence is readiness.
- Continue a released child with `continues`; restart a live child with `children.restart`.
- Replace the socket-level fake daemon with SDK-typed port fakes and keep one isolated real-daemon join test.
- Package and activate Radar's baseline alongside Herdsman, including children whose optional extension discovery is disabled.
- Keep the existing typecheck visible; repair its unrelated baseline separately rather than weakening it.

## Non-goals

No migration of old registration-keyed entries, no compatibility branch for older SDKs, no systemd or scope handling, no change to assignment or result semantics, no repair of unrelated compiler diagnostics or legacy test failures (separate change after this one).
