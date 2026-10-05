# Radar bus publisher — result artifact

Change: `openspec/changes/bash-processes-radar-bus` (publisher half of Agent
Radar's local bus, contract `agent-radar/docs/radar-bus.md` v1).
Owner: worker. Scope: `pi-bash-processes`, the change directory, this file.

## State

| Item | State |
| --- | --- |
| Durable artifact | current |
| Recon of the partial implementation | done |
| Contract corrections | done |
| Production lifecycle test | done (spawn, exit, review, empty list, session change, shutdown, passive) |
| README + tasks.md | done |
| Focused gates | pass (21 tests) |
| Full package gate | pass — `npm test`: 364 pass, 0 fail, 101 files, exit 0 |
| Strict change validation | pass — `openspec validate bash-processes-radar-bus --strict` |

## Corrections made to the partial implementation

1. **List cap removed.** `MAX_BUS_TASKS = 256` silently truncated a message the
   contract calls the complete list; nothing derived it. Every unresolved task
   is sent (Radar's 1 MiB line limit is the protocol's own bound).
2. **Throttle ordering.** A state change arriving while a counter-only message
   was parked in the throttle window used to wait for it (up to 1 s). A state
   change now cancels the pending window and goes out at once; a list identical
   to the one already on the wire is not re-sent.
3. **Output-counter hook.** Nothing re-published while a task ran, so
   `output_bytes`/`last_output_at` would have been reported once at spawn and
   never again. The coalesced 200 ms UI refresh (`refreshUi`) now drives the bus,
   and the bus's own throttle coalesces that to one message per second.
4. **Not pane-gated.** The publisher required `activeCtx.mode === "tui"`, which
   contradicted its own spec ("a session with at least one unresolved task SHALL
   connect") and Radar's optional-pane, session-UUID join. The bus now follows
   the session; the pane tokens stay TUI-only.
5. **Trust-check retry.** A directory that failed the trust check scheduled a
   1 s reconnect timer. It is now simply not a target: nothing is dialled, no
   timer exists, and the next update re-resolves the path. This also stopped the
   bus's 1 s timer from colliding with the spawn fixtures that assert exact timer
   sets (`widget-lifecycle`, `write-path`, `soft-timeout`, `bounded-task-wait`,
   `resource-stop-integration`), which was the cause of 6 failures on the first
   full run of this slice.
6. **No publishing after the shutdown clear** (`publishPaneFacts` returns while
   `shuttingDown`): a killed task's close event lands after the clear and used to
   reopen whichever publisher had just been closed.

## Verified

- `bun test extensions/__tests__/radar-bus.test.ts tests/radar-bus-lifecycle.test.ts tests/pane-facts-gating.test.ts tests/pane-facts-lifecycle.test.ts`
  → 21 pass, 0 fail (run repeatedly, stable).
- `npm test` in `pi-bash-processes` (`bun test --parallel=4 ./tests ./extensions/__tests__`)
  → **364 pass, 0 fail**, 2346 expects, 101 files, exit 0. Baseline before this
  slice: 358 pass, 1 fail (359 tests).
- `openspec validate bash-processes-radar-bus --strict` → valid.
- Vendored `tests/fixtures/radar-bus.fixture.json` is byte-identical to
  `agent-radar/docs/radar-bus.fixture.json` (`diff` empty) and the publisher
  tests read only the vendored copy — no sibling-repository dependency.
- Timestamps are Unix ms (`started_at`/`last_output_at` asserted against
  `Date.now()` in the lifecycle test, so a seconds value fails).
- The failing suite entry `tests/pane-facts-lifecycle.test.ts` was a stale
  expectation, not a product defect (diagnosed with a temporary host run, since
  removed): `stop all` leaves both tasks unresolved as `flushing` → `review` with
  `pi_bg_running=0`; clearing happens when the results are read. The test now
  asserts that, and its bounded wait fails loudly instead of dereferencing
  `undefined`.

## Deliberate behaviour, recorded

- The bus publishes for every Pi session with an unresolved task, TUI or not,
  with `pane` present only when `HERDR_PANE_ID` is set (design D3).
- A silent running task that started before Radar appears is not picked up until
  its next state change or output; the path is re-resolved then (design D4).

## Follow-ups (not done here)

- Herdsman publishing on the bus (non-goal of the change).
- Redaction policy for `command`/`cwd` (non-goal; both stay absent).
- `bumpSettlementRevision` calls `publishPaneFacts` twice on some transitions
  (pre-existing, suppressed by the bus's identical-list check; the pane
  publisher still coalesces).

## Owner acceptance (parent verification, 2026-10-05)

Accepted. Verified independently of the worker's report:

- `npm test` in `pi-bash-processes` (`bun test --parallel=4 ./tests ./extensions/__tests__`)
  → **364 pass, 0 fail, exit 0**, 101 files. The reported lifecycle timeout is gone.
- `openspec validate bash-processes-radar-bus --strict` → valid.
- Vendored fixture is `diff`-identical to `agent-radar/docs/radar-bus.fixture.json`.
- `tests/radar-bus-lifecycle.test.ts` is a real end-to-end check (real extension
  host, real tasks, real unix server): `hello` first, `running` with counters,
  `flushing` before `review`, `exit_code`, Unix-ms timestamps, one connection for
  the session, and `resultResolution` undefined until `get` then `delivered`.
- Transport read against the contract: one writer, latest-list-only queue,
  explicit empty list on the same connection, new session id → new connection,
  shutdown close, trust check on the socket directory.

Owner additions to the artifacts (decisions the report left implicit):

- design D8 records that a `tasks` message is never truncated and that nothing
  publishes after the shutdown clear; the spec gains the matching requirement.
- The trust-check deviation is accepted and stays in D4: a path that fails the
  check holds no timer and is re-resolved on the next update. Cost: a task that
  was already silent when Radar appeared is first published at its next state or
  output change; the pane tokens still advertise that the task exists.

Still open for the owner: `command`/`cwd` redaction policy, and the pre-existing
double `publishPaneFacts` on some settlement transitions (harmless — the bus
drops a list identical to the one already on the wire).
