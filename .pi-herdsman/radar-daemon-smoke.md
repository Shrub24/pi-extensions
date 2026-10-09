# Herdsman Radar consumer smoke — certified run

Date: 2026-10-09 (local system clock)

## Result

The actual Herdsman Radar client, publisher, and execution adapter modules were exercised against the
real Radar daemon binary in disposable `/var/tmp` state. The certified rerun passed **24/24** checks:
`/var/tmp/radar-consumer-certified-5RgUsz/result.json`.

Passing behaviour, all read back from the real daemon through `agent.get`/`agent.list`:

- an absent daemon returns a nonblocking `absent` result;
- **the same client whose first registry attempt failed negotiates and registers once the daemon
  appears** (the negotiation-cache P1 from `result:radar-review#2` is fixed and verified end to end);
- protocol 1 plus the `agent_registry` capability is negotiated;
- execution activity, nested-dialog restoration, questionnaire mapping, and settled idle/finished
  outcome are published as facts;
- the managed child's private binding names its exact `agent_id` and incarnation (sidecar mode `0600`);
- execution `working` and owner assignment `waiting` are independently readable on one subject, with
  assignment provenance naming the owner;
- a deliberately dropped publish acknowledgement replays the identical request (same writer handle,
  sequence, lease, observed time, snapshot);
- daemon restart restores execution and assignment as `restored:true`/`freshness:"stale"` with the
  registration ID and both writer generations retained, and both channels become fresh again after
  `reopen()` under the **same** subject;
- an expired writer's explicit successor is accepted at generation 2, and the old writer reports one
  bounded fence diagnostic and cannot mutate the channel afterwards;
- after a full daemon state-root loss the child re-registers the identical incarnation, receives a new
  daemon-issued `agent_id`, rewrites the exact owner binding, and the owner's assignment is readable on
  the re-registered subject.

Both daemon processes exited `0`; no live daemon, mailbox, pane, or mux state was touched.

## What changed since the previous certified attempt

The earlier attempt timed out waiting for post-restart refresh. That was a harness pacing artifact, not
a product defect: the child execution channel runs the production defaults (30 s lease, 15 s heartbeat)
while the assignment channel was configured with 1 s parameters, and the harness only waited 8 s. In
this run execution became fresh at ~14.25 s (the first 15 s heartbeat) and assignment well before that.
Two harness expectations were also updated to match approved fixes:

- the negotiation check was inverted from "registry stays `absent` on the same client" (recorded
  defect) to "the same client recovers registration after the daemon appears" (fixed behaviour);
- the refresh wait window was widened from 8 s to 25 s to cover the production heartbeat.

## Command and inputs

- Herdsman project: `/home/saurabhj/Projects/dev/custom/pi-extensions/pi-herdsman`
- Actual imported production modules: `extension/radar-client.ts`, `extension/radar-publication.ts`,
  `extension/radar-execution.ts` (the working-tree versions carrying the three reviewed fixes).
- Radar binary: `/home/saurabhj/Projects/dev/agent-radar/target/debug/radar`; `--version` is not
  supported by this binary. Radar source revision HEAD
  `4af0ff6beb6e0d28ddd6e26563dd20f0bf661d70`, wire/doc baseline `92ea9d37fdabafae88b1b41dfc7964b657d6c911`
  (an ancestor). Live `ping` returned protocol `1` with capability `agent_registry`.
- Harness: `/var/tmp/radar-consumer-smoke/final-smoke.mts` (scratch, untracked). The intermediate
  `/var/tmp/radar-consumer-smoke/restart-mini.mts` isolated the restart-refresh timing question.
- Exact invocation: `cd /var/tmp/radar-consumer-smoke && node final-smoke.mts`
- Isolated socket/state/store rooted at `/var/tmp/radar-consumer-certified-5RgUsz/`: socket
  `sock/control.sock`, state roots `state/` and `clean/`, private Herdsman store `data/radar/`.
- The owner test channel used a 1000 ms lease and 1000 ms heartbeat with a scratch-only accelerated
  scheduler pump; the execution adapter used its production default lease/heartbeat.

## Mutable session-context extension

The scratch harness supplied a canonical session UUID via Herdsman's actual `session_start` adapter and
queried the local Radar daemon. It passed **25/25** checks at
`/var/tmp/radar-consumer-certified-nqpW7H/result.json`: the context is visible as a fresh public
projection (source/incarnation/generation/sequence/lease plus the UUID), while registration still omits
session, owner, run and label. The run also repeated restart refresh, state-root reset, exact replay and
fencing. The local daemon source was at `f05f045f`, whose ancestry includes the required feature pin
`4e376978`; the fixture/reference validator was pinned separately at `da0ba99a`. This is a disposable
real-daemon consumer smoke, not live-session adoption. The initial run's single failure was a harness
timing assertion that read before asynchronous republish; widening the assertion to wait for the expected
fact yielded 25/25.

## Limits

This validates the actual TS consumer path against an isolated real daemon; it does not certify live
adoption. The owner-facing storage-containment and unsafe-private-read fixes from `result:radar-review#2`
are covered by unit regressions, not by this smoke. Live adoption still needs one controlled real
assignment after the package gate passes.
