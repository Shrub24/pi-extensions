# Herdr-free acceptance: disposable tmux run and failure attribution

Scope: the acceptance the cutover plan requires before any Herdr removal. Changed
paths are listed at the end. Nothing is pushed, committed or deployed.

## Verdict

- **Disposable tmux acceptance: partial.** Six of the owner's ten items passed against the
  pinned daemon on a named tmux server with Herdr unreachable. Four were not reached:
  the Herdsman startup acknowledgment, the first assignment and result, and saved-session
  continuation. The run exits 1 for that reason, by design.
- **Whole-package `npm run check`: exit 1**, 1101 tests, 1086 pass, 14 fail, 1 skipped, no
  suite-deadline cut-off. Every failure is attributed below by name and file. Ten of the
  fourteen did pass at the parent commit, so they are regressions from the cutover, not
  pre-existing. This contradicts the relaunch-slice trace, which called the controller-api
  and recovery failures pre-existing. Correction below.
- No live adoption is claimed. The run used a bare Node child process with Herdsman's own
  Radar client, not the Herdsman extension running under Pi.

## Pinned daemon and binary

- Pinned commit: `f87348032a808967c50a4e84b7e1c766a64ebfe3` (agent-radar, exists locally).
- Binary: `/var/tmp/radar-v2-build.nqEwCO/target/debug/radar`
- SHA-256: `62e6bf391df649fd0c3c308624df71ddbe70247737dd4fada3bd6234db00ee13`
- Build revision: the binary has no `--version` flag, so provenance rests on source identity.
  `git archive f87348032a80…` was extracted to a temporary directory and compared with the
  build source with `diff -rq` (excluding `target/`). The diff was empty. `cargo build --offline`
  then reported `Finished` with no rebuild, so the binary matches the pinned source.
  If the artifact is gone, rebuild from an export of the pinned commit and pass the new path as
  `RADAR_BIN`; the script records the binary's SHA-256 in its output.
- The daemon was started with `RADAR_CONTROL_BACKEND=tmux` and `RADAR_TMUX_SERVER=<unique name>`
  only. No fallback was attempted, and the handshake confirmed `backend: tmux`,
  `instance: <name>`.

## How Herdr was proven unavailable

Each claim below is a recorded observation from the run, not an assertion:

1. **PATH.** The harness builds a directory of symlinks to every executable on `PATH` except
   `herdr`. `herdr` and `tmux` share one profile directory, so dropping the directory would have
   removed tmux too. The probe `sh -c 'command -v herdr'` run under this environment returned
   exit 1, recorded as `herdrOnSanitisedPath: "absent"`.
2. **Environment.** Every `HERDR_*` and `TMUX`/`TMUX_PANE` name is removed from the harness
   environment, and `HERDR_SOCKET_PATH` is set to a path that does not exist
   (`herdrSocketExists: false`). That one name is the only `HERDR_*` name present in the daemon
   and in the child (`daemonHerdrNames`, `childHerdrNames`). It names an unreachable path, so a
   Herdr fallback could not succeed.
3. **Child binaries.** The child reports which directories on its own `PATH` hold a `herdr`
   executable. The list was empty (`childHerdrBinariesOnPath: []`).
4. **Backend.** The daemon's own `ping` reported `backend: tmux`. A tmux backend never dials the
   Herdr socket.

## Per-item results (run `herdr-free-acceptance.mjs`, final recorded run)

| # | Owner item | Result | Evidence |
|---|---|---|---|
| 1 | Handshake: tmux backend on named server | passed | `backend=tmux instance=<server>`; `spawn.v1`, `spawn.close.v1`, `events.v1`, `registry.v1` advertised |
| 2 | Launch under a daemon-created pane | passed | `spawn` completed `created` and `launched` in pane `tmux:<server>:%N` under a registered operator |
| 3 | Exact child agent_id binding | passed | `spawn.bound.agent_id` equals the child's own registration `agent_id` |
| 4 | Readiness (Radar process verdict) | passed | `agent.get` process `verification: verified`, `claimed: true` |
| 4b | Readiness (Herdsman startup acknowledgment) | **not reached** | Needs a Herdsman operator launch and the Herdsman child extension; there is no non-LLM entry point and no control socket |
| 5 | First assignment and result | **not reached** | Needs a Herdsman mailbox assignment to a live child and a model turn |
| 6 | Context publication (client seam, read back via `agent.get`) | passed | `result.agent.context.context.session` equals the child's published session. Herdsman's own client wrote it, not the full extension |
| 7 | Close | passed | `childClose` returned `completed`; the identical request ID replayed and returned the stored outcome; the pane no longer appears in `mux.observe` |
| 8 | Saved-session continuation | **not reached** | Needs a Herdsman continuation of a completed worker |
| 9 | Event reconciliation after resync (Radar side only) | passed | `events.read` paged to sequence 10; a stale epoch returned `cursor_expired` with the new epoch; resuming from the expired cursor delivered no replay; `spawn.get` re-read the same bound agent. The Herdsman watcher's reaction was **not** reached |

Passing items: 1, 2, 3, 4, 6, 7, 9. Items 1–4 and 6 pass for the Radar daemon, not for Herdsman
behaviour. Not reached: 4b, 5, 8.

## Reproducibility

- Invocation (recorded in `docs/development/smoke-testing.md`):
  `RADAR_BIN=<pinned radar binary> node pi-herdsman/scripts/herdr-free-acceptance.mjs`
- Three consecutive runs gave identical per-item statuses and exit code 1. The labels of items
  9 and 6 were renamed after the first two runs, so their statuses are compared, not their text.
- Each run removes its tmux server, its tmux socket file, its temporary root and its daemon.
  After the runs, `/run/user/1000/tmux-1000/` and `/tmp/pihfa-*` held no `pihfa` entries.
- Stderr was empty in every run.
- Herdr is excluded by the environment and PATH described above. The run does not claim the
  daemon reads no other user configuration; it was not checked.

## Whole-package attribution

Authoritative run: `npm run check` (`scripts/check.mjs`), unpiped, exit captured; log
`/tmp/pi-herdsman-1000/herdr-free-check.log` (bg-1432). The background task's own status reads
`exit 0`, but that is the wrapper's trailing `echo`, which always returns 0. The authoritative
code is the `npm_run_check_exit=1` line the command wrote to the log. Totals: 1101 tests, 1086 pass, 14 fail,
1 skipped, 0 cancelled, `npm_run_check_exit=1`.

**Pre-cutover baseline.** The parent commit `a53f56746` was exported in full and the three
failing files were run there with the same flags (`--test-concurrency=1 --test-timeout=60000`),
exit captured per file (bg-1466). Two earlier attempts ran from an incomplete export and are
discarded. A sibling-package export was missing, so those runs measured nothing.

| Suite | Parent `a53f56746` | Current | Failing names in the current run |
|---|---|---|---|
| agent-runtime | 100 tests, 4 fail | 90 tests, 6 fail | 4 predate the cutover; 2 cutover regressions |
| controller-api | 111 tests, 0 fail | 71 tests, 6 fail | all 6 cutover regressions |
| recovery | 103 tests, 1 fail | 104 tests, 2 fail | both cutover regressions |

**The 14 failures, attributed by suite and name:**

Predate the cutover (fail identically at `a53f56746`):
1. agent-runtime: `unfinished background work holds settlement through a flush and late work`
2. agent-runtime: `a recovered worker settles with an unretrieved prior-request result named in its answer`
3. agent-runtime: `only unfinished work holds while unreviewed terminal results settle`
4. agent-runtime: `settlement publishes an unread terminal result without a post-review response`

Introduced by the cutover (pass at `a53f56746`, fail now; the commit does not split by slice):
5. agent-runtime: `parent settlement waits for agent delivery and ignores result cleanup lag`
6. agent-runtime: `a stray agent variable does not suppress the active Lead tool surface`
7. controller-api: `parent list omits unrelated unknown mailbox diagnostics`
8. controller-api: `parent controls only direct children and enforces session allowlists`
9. controller-api: `assignment retains its request when acknowledgement never arrives`
10. controller-api: `lead steers a blocked parent waiting for direct-child work`
11. controller-api: `assignment status normalization fails closed safely`
12. controller-api: `agent_extend defers one worker's next digest and later windows revert`
13. recovery: `a digest entry for a worker awaiting an answer lists reply, not interrupt`
14. recovery: `a resolved assignment is never included in a later digest`

So the controller-api eight (6 failures) and recovery two (2 failures) that the relaunch trace
called "pre-existing Herdr-era fixture failures" are cutover regressions by this evidence. Their
mechanism is not diagnosed in this slice. Several assertions show presence reported as `unknown`
where the old fixture expected `settling` or an idle state, which points at the Radar presence
change, but I have not confirmed that per test.

**Test-set change (by name, status markers stripped).** Removed/added against the parent:
- agent-runtime: 10 removed (Herdr presentation-metadata publisher tests), 0 added.
- controller-api: 49 removed (about 40 Manager worktree/identity tests, plus project-delivery and
  continuation tests), 10 added (relaunch and Radar-authority tests).
- recovery: 12 removed, 13 added.

**Reconciliation with the earlier 42-failure gate.** The earlier 1189-test/42-failure figure was
recorded before the cutover commit and I have not reproduced it. I mapped the 49-name ledger in
`radar-remaining-failures.md` onto this run's check log (`herdr-free-check.log`):
- 27 Manager names: absent, removed by the cutover (not failing).
- 7 retained-worker names: 5 pass, 1 absent (renamed to `a retained worker whose pane is gone relaunches only on a proved absent process`), 1 failing (`assignment retains its request…`, counted in item 9 above).
- 1 control-restart name: absent; the relaunch slice added a positive restart test.
- 5 agent-runtime names: 4 fail (predate, items 1–4); `a stray agent variable…` fails now but passes at the parent, so the ledger's "pristine baseline" label for it was wrong (item 6).
- 8 commands/TUI names: 7 pass, 1 absent.
- Ledger total: 7 still fail; new failures not in the ledger: 7 (items 5, 7, 8, 10, 11, 13, 14).

Net: 14 failures = 7 ledger names still failing + 7 new.

## Changed paths

- `pi-herdsman/scripts/herdr-free-acceptance.mjs` (new): the reproducible acceptance. It stays in
  place for the removal slice to reuse.
- `pi-herdsman/docs/development/smoke-testing.md`: invocation section.
- `.pi-herdsman/herdr-free-acceptance.md` (this file).

## Open items and decisions

- **Four items not reached.** Herdsman's startup acknowledgment, the first assignment and result,
  and saved-session continuation need a driven Herdsman child under Pi. That needs an owner
  decision on the harness shape, since no non-LLM Herdsman entry point exists.
- **Ten cutover regressions.** Decide whether each is a production fault or a stale fixture before the
  removals build on the current tree. This slice did not diagnose them.
- **Relaunch-slice trace correction needed.** The trace's "pre-existing" characterisation of the
  controller-api and recovery failures is contradicted by the parent run. I did not edit that
  trace, since it is outside this slice's scope; the owner should record the correction.
- **Absence proof** is still verified only against the fake daemon in the unit suites. This run is
  the first real-daemon evidence, and it covers only the Radar side (`agent.get` verdict `verified`
  for a live process).
- **Evidence logs** are under `/tmp/pi-herdsman-1000/` (check log, attribution logs in `attr/` and
  `attr2/`, acceptance JSON runs A/B/final). They are temporary and not committed; the tables above
  are the durable record.
