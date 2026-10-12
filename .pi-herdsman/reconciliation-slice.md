# Reconciliation slice: Herdr lifecycle subscription to Radar events

Pinned contract: agent-radar `f87348032a808967c50a4e84b7e1c766a64ebfe3`, read with
`git show` (`docs/control-plane.md`, `docs/daemon.md`,
`openspec/changes/archive/2026-10-12-lifecycle-events/specs/mux-control-plane/spec.md`).
The canonical working tree is detached with uncommitted files, so it is not used as the pin.

## 1. Trace (before any edit)

Every site of the Herdr lifecycle subscription, and what it caused:

| Site | Effect today |
| --- | --- |
| `herdr.ts` `watchHerdrLifecycle` (socket, `events.subscribe` with five pane/tab/workspace types, reconnect, abort) | Opened the Herdr socket. Every line, whatever its type, ran the same callback. The body was never read. |
| `herdr.ts` constants and `node:net` import | Used only by the watcher. |
| `index.ts` scanner startup (gated on `HERDR_SOCKET_PATH`) | Callback: `requestStatusRefresh()` and `requestHealthScan()`. |
| `herdr.test.ts` lifecycle test | Subject: the socket's framing, subscription acknowledgement, reconnect and abort. |

The callback's two effects read Radar, not Herdr:

- `refreshStatus` → `agentSnapshotView` → `managedAgentSnapshots`, which reads `radarFleetInventory()` (`mux.observe`) and `radarChildObservations`.
- `scanAgentHealth` → `managedAgentSnapshots`, then wake messages, attention reminders and loss publication.

`herdrSessionSnapshot` had no production caller left, so no Herdr read gated either effect. The change removes the trigger, not a state source.

The pinned journal has registry, publication, spawn and close facts only. It has no pane-level events, so Herdr's `pane.closed`, `pane.exited`, `pane.moved`, `tab.closed` and `workspace.closed` have no Radar equivalent.

Periodic fallback (already present, not added): `schedule()` re-runs the health scan every `STALE_SCAN_MS` (30 s), and the status timer refreshes the widget every 2 s.

## 2. Design as built

- `radar-client.ts`: `RADAR_EVENTS_CONTRACT = "events.v1"`. New `events({after, epoch?, wait_ms})` member, gated by `withCapability` like every other method. It decodes two outcomes: a page (`{kind: "page", epoch, sequence, more}`) where `sequence` is the last DELIVERED event, and an expiry (`{kind: "expired", epoch, sequence}`) carrying the daemon's new epoch and cursor.
- `watchRadarEvents(client: Pick<RadarClient, "events">, signal, {wake, refused})`: a long-poll loop.
  - A page with events advances the cursor to its last delivered sequence and calls `wake()` once. A page with `more` is read again at once, so backlog drains and is never skipped.
  - `cursor_expired` adopts the new epoch and cursor and calls `wake()` once. No event is replayed. The wake is a pointer; the scan reads truth.
  - A refused contract (`unsupported`) is diagnosed once per outage. The outage ends only when a read succeeds, so a contract that is lost again warns again. A transport error is retried silently after 1 s with the cursor unchanged.
  - A throwing `wake` is diagnosed once per run of failures. A later successful wake starts a new run. The loop reads on past the throw.
- `wake` takes no argument, so an event body cannot set state. The reconciliation read is the existing observation-based scan.
- `index.ts`: replaces the Herdr subscription with `watchRadarEvents(radarClient, …)`. The `diagnose` callback raises `ctx.ui.notify(message, "warning")`. A daemon without `events.v1` is refused visibly, not silently degraded. There is no Herdr fallback and no second poller.

## 3. Deviation from the brief (owner-confirmed)

The brief asked each event to trigger `agent.get` and `spawn.get` reads. These are not added. Nothing consumes their answers: presence and loss are decided from `mux.observe` inside `managedAgentSnapshots`. Per-event reads enter only if the presence decision moves presence off the observation onto registry reads, which is still open in the cutover plan.

## 4. Accepted behaviour change (owner-confirmed)

Pane and tab loss are no longer event-driven. Loss detection and the attention reminders move to the 30 s health scan. The status widget still refreshes every 2 s from the observation. Destructive actions still require proven identity and stay fail-closed, so a late notice cannot cause a wrong close. If pane-loss latency must become immediate again, that is a Radar contract addition to request, never a Herdr subscription to restore.

## 5. Deletions and replacements

| Deleted | Replacement |
| --- | --- |
| `herdr.test.ts` "lifecycle watcher subscribes, reconciles, reconnects, and aborts" | Subject (Herdr socket framing) has no successor: the socket is gone. Its reconnect-on-failure behaviour is covered at the new seam by the `watchRadarEvents` retry test. |
| `herdr.test.ts` "session snapshot accepts only coherent pane and agent inventories" | None. `herdrSessionSnapshot` has no production caller and its subject is removed. |
| `herdr.ts` `herdrSessionSnapshot` and `HerdrSessionSnapshot` | None (dead after the trigger moved). |
| `herdr.ts` lifecycle constants and `node:net` import | None (used only by the removed watcher). |
| `index.ts` `watchHerdrLifecycle` import and subscription | `watchRadarEvents` at the same scanner-startup point. |

## 6. Tests added

`radar-client.test.ts` (42/42):
- events without `events.v1` is an explicit refusal and dispatches only `daemon.ping`.
- A page decodes to its last delivered sequence, not the tail.
- `cursor_expired` decodes to the new epoch and the journal cursor; the request carried the old epoch.
- A malformed reply is a protocol failure, never a silent page.
- The watcher drains a backlog from the last delivered sequence (`after` 0 → 2 → 3).
- `cursor_expired` produces exactly one wake and adopts the new epoch without replay (the existing test). The following page is read from the new cursor and wakes once (added: `a page after cursor_expired delivers its wake once and reads from the new cursor`).
- Refusal dedup, both sides of an outage: three refusals warn once; a restored contract ends the outage; the next refusal warns again. Two warnings across six reads.
- A throwing wake is diagnosed once per run of failures, and the loop reads on past every throw.
- A rejected events read is diagnosed once (`event watch stopped`) rather than escaping as an unhandled rejection.
- A throwing `diagnose` is contained: a refusal's notice can fail and the next page still wakes.

Mutation checks: removing the once-per-outage guard turns the dedup test red; removing the fault dedup turns the throw test red; removing the `.catch` turns the rejected-read test red; removing the `diagnose` containment turns the throwing-diagnose test red. Each was restored byte-identical.

Covered by construction, not by a test:
- Wake-versus-truth. `wake` takes no argument and the watcher never reads event bodies. The only thing a page contributes to the watcher is its sequence, which is a cursor. So an event body cannot reach state, and no test is needed to prove what the type already forbids.

Not covered by a test, stated plainly:
- Double-apply on resync: the scanner's attention reminders are keyed by episode and the scan is observation-driven, so a repeated wake is idempotent by design. No test pins that.
- The `index.ts` notice mapping (`diagnose` to `ctx.ui.notify`) is a one-line wiring, exercised only through the seam's callback.

## 7. Fake daemon

`support-radar.ts` gains `events.v1` in its default capabilities, a journal (`appendEvent`, `restartJournal`, `dropEventsBefore`), `events.read` with `cursor_expired` on epoch change or retention loss, and a hold for an empty long poll. The journal resets with the daemon.

## 8. Loop survival and scanner sites

**Invariant.** `follow()` ends only through its signal, because `client.events()` resolves rather than rejects: `call()` turns every fault into a result. This holds today. The one synchronous step before `call()`'s promise, `radarControlSocketPath`, cannot throw, and `untrustedControlSocket` catches its own errors. The invariant is stated in a comment at `void follow()`. If it stops holding, the `.catch` diagnoses the failure once and nothing retries it; the periodic scan keeps state correct meanwhile.

**One loop per client: proven disjoint, no guard added.** `watchRadarEvents` is called from one place, `runAgentHealthScanner`, which is called from two sites:
- Site 1 (`session_start`, lead path) sits inside `if (controllerScope)` and returns early for `managed-agent`. It therefore runs only when the scope is `lead`.
- Site 2 (managed-agent `session_start`) is gated on `delegationEnabled`, which needs a non-empty `PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS`. Site 2 also throws unless the scope is `managed-agent`.
- `controllerScope` is a `const` derived from `role()` once per process: `lead` when the role is `lead`, `managed-agent` only when allowed definitions are non-empty, and `undefined` otherwise. So the two sites cannot both run in one process.
- Re-entry within one site is also safe. Each `session_start` aborts the previous signal before creating the next (`controllerAbortController` at 15003, `metadataAbortController` at 16214). A superseded loop checks its signal before it wakes, so at most one in-flight long-poll overlaps a session switch, for up to 1 s, and it cannot add a wake.

**Expiry cursor.** An expired reply's cursor comes from the daemon's `cursor.sequence`. The decoder returns no reply when that sequence is missing, so a 0 cannot arrive through the decode path. The test `a cursor_expired read wakes once and adopts the new epoch without replaying` asserts the next request carries `after: 9` and `epoch: "e2"`, with the daemon's cursor. The decode test `events decodes cursor_expired to the new epoch and the journal's cursor` asserts sequence 12 from the cursor.

**The two inspection-verified items.**
- Pause abort-listener removal: no test. The removal is observable only as a listener count on a session-lifetime signal, so a test would couple to Node's listener introspection to pin a three-line cleanup. It was verified by reading.
- `diagnose` containment: tested, as the counterpart of the wake containment, with the throwing-diagnose test.

## 9. Open risks

- Resolved in this pass: a throwing wake ended the watcher silently. It is now diagnosed once per run and the loop continues. A throwing `diagnose` is also contained, because a notice that cannot be delivered must not end the watcher.
- Resolved in this pass: the retry pause added an abort listener on every retry and removed it only when the signal fired, so a long outage accumulated listeners. The listener is now removed when the pause ends.
- `radar-client.test.ts` already fails `tsc` on `support-radar.ts:1140` (`Promise.withResolvers`, pre-existing in `holdNextObserve`).
