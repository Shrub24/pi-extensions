# Background-task pane facts — implementation result

Status: complete (task 4.4 left to the owner)
Owner brief: complete the approved `openspec/changes/bash-processes-pane-facts`
change through the pi-bash-processes production lifecycle.

## 1. What already existed (inherited)

- `pi-bash-processes/extensions/pane-facts.ts` — partial publisher module
  (`PANE_FACTS_SOURCE = "pi-bash-processes"`, `PANE_FACTS_TTL_MS = 30_000`,
  cap 6, 80-char terminal-safe bound, `paneFacts`, `factsArgs`,
  `createPaneFactsPublisher`). Not wired to any production path.
- `pi-bash-processes/extensions/__tests__/pane-facts.test.ts` — 8 module tests.
- No `pi.exec`/`herdr` usage anywhere in the package.

## 2. Findings (verified)

- The production task lifecycle has no single "state changed" hook; the
  transitions that matter are `spawnTask` (bg_task spawn), `finalizeTask`
  (child `close`/`error`, stop, timeout), `recordResultResolution` (settlement
  / result review), `session_start` (restore) and `session_shutdown`.
- Pane-gating reference is `pi-herdsman/extension/index.ts:2489` (gate
  `ctx.mode === "tui"` + `HERDR_ENV` + `HERDR_PANE_ID`) with
  `herdr.ts:318 runHerdr` = `pi.exec("herdr", args, …)`. The brief's gate is
  TUI + `HERDR_PANE_ID` only (no `HERDR_ENV`), so that is what is implemented.
- `createPaneFactsPublisher.close()` sent the shutdown clear while an in-flight
  snapshot write could still land after it, re-advertising tasks that had
  finished. Fixed: abort and await the in-flight write before the clear.
- The design doc said TTL 60 s / refresh 20 s while the module and brief use
  30 s / 15 s; the design now matches the implementation.

## 3. Changes made

- `extensions/pane-facts.ts` — `close()` aborts and awaits the in-flight
  publication before sending the clear, and uses a fresh signal for the clear.
  No other module shape changed.
- `extensions/background-tasks.ts` — imports the module, adds
  `publishPaneFacts()` (gate: `ctx.mode === "tui"` + `HERDR_PANE_ID`; skips the
  pane write when nothing was ever published and nothing is running; rebuilds
  the facts from the live task inventory on every call) and
  `clearPaneFacts()`. Wired at:
  - `spawnTask` (spawn),
  - `finalizeTask` (exit / stop / timeout),
  - `recordResultResolution` (settlement / result review),
  - `session_start` after restore,
  - `session_shutdown`, where the clear is awaited.
  The `send` implementation is `pi.exec("herdr", args, { cwd, signal,
  timeout: 10_000 })`; a non-zero/killed result throws into the publisher,
  which swallows it and retries on the next update or TTL refresh, so a
  reporting failure never fails a model turn.
- `tests/fixtures/extension-host.ts` — the host `pi` mock now implements
  `exec` and exposes `execCalls` so tests can observe the Herdr writes.
- `tests/pane-facts-lifecycle.test.ts` (new, mode `tui`) — production path:
  no pane id publishes nothing; running tasks are advertised *while the
  session is mid-turn* (`agent_start` dispatched first); a second task raises
  the count and the list; `stop all` clears exactly the three owned keys; no
  command text (marker command) reaches any published value.
- `tests/pane-facts-gating.test.ts` (new, mode `print` + pane id) — a non-TUI
  session publishes nothing.
- `extensions/__tests__/pane-facts.test.ts` — added the close-race regression:
  `["write-start", "write-aborted", "clear"]`.
- Docs: `README.md` "Background pane facts" section (token table, source, TTL,
  clearing), `CHANGELOG.md` Unreleased entry.
- OpenSpec: `design.md` D4 cadence corrected to 30 s / 15 s; `spec.md`
  requirement wording aligned with the ids-only list (was "their states");
  `tasks.md` checkboxes marked to verified state.

## 4. Validation

- Focused: `bun test --parallel=4 ./extensions/__tests__/pane-facts.test.ts
  ./tests/pane-facts-lifecycle.test.ts ./tests/pane-facts-gating.test.ts`
  → **12 pass / 0 fail, 35 expect() calls, 3 files**.
- Full isolated package script `bun run test`
  (`bun test --parallel=4 ./tests ./extensions/__tests__`)
  → **345 pass / 0 fail, 2247 expect() calls, 98 files, 19.13 s**.
  Source checkpoint: git `5b778a0429c33395728d83d2dcf039cb22f13fce`,
  jj change `wtkylqrrmmqknqzvyysrlrqypnuslyru` (`@`).
- `openspec validate bash-processes-pane-facts --strict` → valid.

## 5. Open limits / follow-ups

- Task 4.4 (tell the Radar session the token set) is a cross-session message
  the owner must send; not done here.
- Not exercised live against a real Herdr server (no live smoke); the exec
  surface is covered by the host fixture, matching how the rest of the package
  tests the lifecycle.
- `paneFacts` cap is 6 ids while the count stays exact; a consumer showing ids
  sees at most 6 (design D3 accepted this).
- `recordResultResolution` re-publishes an unchanged inventory (the facts are
  inventory-derived); harmless, kept because the plan names settlement and
  result review as publish points. Could be dropped if the extra Herdr write
  is ever unwanted.
- Adjacent: `pi-herdsman/docs/reference/pane-metadata.md` documents the pane
  limits and one-publisher-per-token rule but does not yet list the new
  `pi_bg_*` names as another publisher on the same panes. That doc belongs to
  the herdsman worker/owner, so it is recorded here rather than edited.

## 6. Decisions to record

1. **pi-bash-processes publishes its own tasks' facts** as `pi_bg_running`,
   `pi_bg_tasks`, `pi_bg_started` under source `pi-bash-processes`; herdsman
   keeps its `pi_herdsman_*` projection and the official integration keeps
   semantic state. Rejected: routing the facts through herdsman (a second
   publisher for another extension's facts; Radar would still need detail
   tokens from their owner). Revisit if a pane ever needs one consolidated
   facts publisher.
2. **TTL 30 s, refresh 15 s, clear on last exit and shutdown.** Rejected
   60 s/20 s (slower stale-fact bound for a crashed session) and an
   elapsed-duration `pi_bg_started` (needs re-publish to stay accurate). The
   TTL is the only cleanup for a crashed session.
3. **No `HERDR_ENV` gate**, unlike herdsman: a TUI mode plus a pane id is
   enough, matching the approved plan.

Suggested `keep-the-why` home: the change's `design.md` already carries
D1–D7; if a durable context/ADR entry is wanted, it should state decision 1
(one publisher per token name; `pi_bg_*` ownership) and decision 2 with its
TTL/rejected alternatives.
