# Mutable session context published to the Radar registry — implementation result

Date: 2026-10-09 (local system clock). Worker slice against the Radar daemon contract
the owner pinned; no commit made.

## What landed (working tree, uncommitted)

The pending item in `plan.md` § 15 ("do not implement against a guess") is now
implemented against the shipped daemon support:

- **Wire pin.** Radar feature commit `4e37697826c2ba4a28c92a93e22747df2bc7097e`
  (`feat: add mutable session context publication`). The later commit
  `a46f27ae181978aa0066c7384c2a620eab5079c1` is reference-only (documentation,
  fixture and the daemon's own publisher test) and is **vendored byte-for-byte**
  as `pi-herdsman/docs/reference/agent-registration.fixture.jsonl`; the feature
  set stays pinned to `4e376978`. Both facts are recorded in the vendoring
  comment in `extension/radar-client.test.ts`.
- `extension/radar-client.ts`: `agent.context` — `{agent_id, publisher,
  writer_handle?, replace?, sequence, lease_ms?, observed_at?, context:{session}}`
  encoded as the fixture writes it, reply decoded as `{writer, warning?}` with the
  same writer-binding validation `agent.acquire` uses (extracted into
  `writerBinding`).
- `extension/radar-publication.ts`: a `context` writer on every publication. First
  publish binds the daemon-issued writer (no `writer_handle`, no `replace`); a
  session switch is a newer sequence under that binding; renewal rides the existing
  heartbeat cadence with a strictly newer sequence and the default 30 s lease; an
  unchanged session is not re-sent between heartbeats; a lost reply replays the
  exact request; `not_found` re-registers the identical immutable content and binds
  a fresh sequence; `refused`/`bad_params`/`unknown_method` fence with one
  diagnostic and no takeover; the record is persisted under
  `radar/context/<hash>.json` (0600 in 0700, atomic) so a reload keeps its binding.
- `extension/radar-execution.ts`: `session_start` reports
  `context.sessionManager.getSessionId()` before re-arming the publication, and a
  session Pi cannot name as a canonical UUID is left unreported (never the session
  file path, never the explicit null).
- Regression pins, all fixture-derived where the fixture covers them: the five
  context exchanges in `radar-client.test.ts` (first publish, switch, identical
  replay answered with a warning, explicit null, replacement naming the observed
  incumbent and returning the successor's generation-2 binding) — the replacement
  exchange is pinned from the vendored fixture rather than hand-written; four
  publication regressions; three adapter regressions.

## Verified

- `extension/radar-client.test.ts`, `radar-publication.test.ts`,
  `radar-execution.test.ts`, `extension-contract.test.ts`: 98 pass / 0 fail.
- `node scripts/check.mjs` (whole pi-herdsman suite): 1118 tests, 1117 pass,
  0 fail, 1 skipped.
- Vendored fixture `cmp`-identical to `a46f27ae:docs/agent-registration.fixture.jsonl`.
- The "a replaced session is never renewed as the one it replaced" regression was
  confirmed to fail when the reported session is dropped while the writer is
  stopped, so it pins a real behaviour rather than restating the implementation.

## Deliberate limits (not implemented, reported as follow-ups)

- **Lost reply to a first context publish.** The first publish is the only write
  with no credential; if its reply is lost, the retry is refused because the record
  now exists ("context has a writer this publisher did not present"), and this
  writer fences. Radar's own reference publisher (`examples/agent-publisher/
  publisher.py`) takes the same stand ("A successor has fenced this incarnation.
  Never silently replace it."). The daemon documents the observation channel for a
  successor (the refusal names the incumbent generation/handle), so a future slice
  could adopt the observed incumbent after its lease expires; that is a design
  decision, not a bug fix, and `replace` is therefore supported in the client but
  unused by the publisher — exactly like `acquire({replace})` today.
- **No disposable-daemon smoke of the context record.** Verification is unit- and
  fixture-level; the real-daemon consumer smoke from the registration slice has not
  been extended to `agent.context`.
- **Registry debt unchanged.** Records still accumulate per incarnation; the
  context record inherits that, plus a 30 s lease that goes stale whenever the
  writer stops (session end / shutdown). Stale is "unknown" by contract; no null is
  published on shutdown.
- `warning` is surfaced and now consumed: a warned replay is booked as the send
  time of the report it never replaced, so the local renewal clock keeps the
  daemon's lease origin instead of the replay time. Pinned by the
  "a warned replay renews on the original lease origin, not on the replay"
  regression (one heartbeat in, a renewal's reply is lost; an off-grid reload
  replays it and the daemon answers that identical replay with the warning; the
  next heartbeat tick renews, while an ordinary acceptance half a heartbeat later
  stages nothing). Both halves were shown to fail by temporarily restoring the
  pre-delta accounting (renewal missing: `3 !== 4`) and by making an acceptance
  never advance the clock (spurious renewal: `5 !== 4`); the implementation was
  restored byte-identical (`sha256 eb123880…`).
  A warned replay is only observable off the heartbeat grid, which is why the
  regression drives the reload kick rather than a tick.

## Owner actions proposed

- Commit the slice; the change-level reason belongs in the commit message.
- `plan.md` § 15 and ADR 0031 were updated in place to stop claiming the current
  session is unpublished. Reword if you want different emphasis; both edits are
  status/accuracy, not new decisions.
