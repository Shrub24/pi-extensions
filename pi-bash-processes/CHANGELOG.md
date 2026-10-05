# Changelog

## Consumer-impacting changes

### Unreleased

- An exit during a run that Pi started without `before_agent_start` (a queued follow-up, or another extension's trigger-turn wake) is now held until the run settles, and reading or stopping the task consumes it. Previously such an exit was sent immediately as a follow-up the agent had already acted on, which surfaced as a stale "Background task finished" turn after a `get` or `stop`. A `stop` of a task that had already ended renders as "already <outcome>" instead of reading like a failed stop, and exit wakes no longer tell the agent to `bg_task stop` a task that has finished.
- Managed bash no longer rewrites a trailing `| head` / `| tail`: the command reaches the shell exactly as written, and the "applied to the completed output" footer is gone. The agent contract now says plainly not to trim output (`| tail`, `| head`, `2>/dev/null`) because oversized results are already bounded and saved in full and a trim hides failures and forces re-runs; the guidance is in `instructions.md` and the `bash` tool guidelines.
- Bash and zsh shells started by the extension now run with `pipefail`, so a failing pipeline stage fails the command. A producer cut off by `head` can therefore exit 141 (SIGPIPE); set `managedShellPipefail` to `false` to restore the previous exit codes.
- The declared tool surface now depends on the Pi session mode. An interactive TUI session gets `bg_task` with exactly `spawn`, `get`, `stop`, `list` and `extend`, and no `bg_status` tool; `print`, `json`, `rpc` and any mode this build does not recognize keep the compatibility surface — the full action set including the bounded `wait`, plus `bg_status`. There is nothing to configure, and an explicit `--tools`/`--exclude-tools` selection is preserved rather than repaired. The guidance the model reads follows the surface: no wake, acknowledgement or schema text names an operation the mode does not declare.
- Reading a task's log file no longer acknowledges its completion. The `pi-bg path`, `pi-bg peek` and `pi-bg read` helpers, the managed-bash read shim, the per-process consume logs and the interactive sleep-as-wait path are removed; those helpers now exit `2` with a migration message naming `pi-bg get <task-id> [--output]`. `pi-bg get` remains the supported route, and it acknowledges only after the requested write succeeds.
- Every background task now gets a soft timeout (10 minutes by default; `defaultSoftTimeoutMs`, per-spawn `softTimeoutMs`, 0 disables). At soft expiry the process keeps running and the agent receives one progress wake per interval asking it to continue (it will ask again in the same interval, or re-arm with `bg_task action: "extend" id:... softTimeoutMs:...`, which starts a fresh window from now, keeps the current interval when `softTimeoutMs` is omitted, and never changes the hard timeout), inspect the result, or stop. Each delivered reminder is itself a review, so the interval is measured from it and the reminder repeats while the task runs; the deadline is persisted across restarts, where a restored live task re-arms it and an already-fired one does not replay. Reminders are excluded from exit/output wake accounting — a later real exit still wakes normally. The interactive TUI now declares `extend`, so the agent can lengthen, shorten or disable a running task's reminder interval instead of only choosing it at spawn.
- Publishes the managed-Bash interop marker so `@vanillagreen/pi-tool-renderer` leaves its execution override intact.
- A TUI session inside Herdr now advertises its running background tasks on its own pane as `pi_bg_running`, `pi_bg_tasks` and `pi_bg_started` (source `pi-bash-processes`). The tokens describe outstanding work rather than the session's state, so a task spawned mid-turn is visible while the agent is still working; they expire after 30 seconds, refresh every 15 seconds while a task runs, and clear at the last completion and on shutdown. Headless and non-Herdr sessions publish nothing, and no command, output or path is ever published.

### 2.1.1

- Session startup keeps fresh task logs when their working directory exists and its name ends in whitespace. Cleanup previously trimmed the name and could delete these files.

### 2.1.0

- New task logs go into one directory per session in the task directory's `lanes/` folder. A session's log directory is deleted once its working directory is gone (a merged worktree), and any log older than 5 days is deleted, when the next session starts. The prune reads only `lanes/`, and in it only real directories this user owns that the package marked as its own, so other folders in the task directory are never touched. Logs written before 2.1.0 stay where they are and are not deleted by the prune, `clear` or the task bound.
- A task's process handle and in-memory output are released once it has exited and its last log write has finished; `log` and exit wakes read the end of the log file instead. A task whose last log write failed or stalled keeps its in-memory output as the record, and a log that cannot be read shows `[log unreadable: <error>]` instead of empty output. At most 50 finished tasks are kept: past that, the oldest finished task is removed with its log. `clear` now deletes the logs of the tasks it removes. A forked session keeps the logs of tasks it copied from the original session. The task list is released when a session ends; the next session restores it from the saved snapshots.

### 2.0.4

- A task that prints a lot no longer makes Pi write the task log synchronously, save the full task state and redraw the widget for every output chunk. Slow task log writes no longer block Pi; the task waits on its output instead.
- A log write that fails loses its bytes, and a log write that stalls loses the output that arrives past a bounded buffer; the log marks each loss with its byte count. In 2.0.3 and earlier a failed write lost its bytes with no mark, and a stalled write blocked Pi.
- Checks of this session's tasks that outlived a Pi restart or reload no longer block Pi at startup or on their 30-second recheck.
- Startup and reload with a long task history no longer slow down.

### 2.0.3

- Settings reads come from memory. A read is answered for one second without touching disk, then the settings files are read again. A change made in the extension manager, or a new session, applies at once; a hand edit to `settings.json` applies within one second. Before, every read went to disk.

### 2.0.2

- The npm install and uninstall helper reports each refusal as an `append-system: <key>=<value>` line followed by the explanation.
- An appendSystem source file that cannot be read is reported and skipped instead of throwing, so the npm install still completes.

### 2.0.1

- Finished tasks disappear from the inline widget after `widgetFinishedRetentionSeconds` without waiting for another task event. Long retention periods use bounded timer waits, and hiding the widget or ending the session clears the timer.
- The extension uses `PI_CODING_AGENT_DIR` only when root-anchored — a drive or UNC share on Windows, a leading `/` on POSIX. Anything else uses `~/.pi/agent`. The install helper is unchanged.

### 2.0.0

- **Breaking**: the settings namespace is renamed from `vstack` to `kendex`, with no compatibility fallback. Configuration previously read from `vstack.extensionManager.config["@vanillagreen/pi-background-tasks"]` in `.pi/settings.json` is now read from `kendex.extensionManager.config["@vanillagreen/pi-background-tasks"]`; settings still stored under the old key are ignored and this package silently falls back to its defaults until the key is renamed. The `package.json` block that declares these settings is renamed from `"vstack"` to `"kendex"` to match.
- **Breaking**: cross-extension interop symbols move from the `vstack.*` to the `kendex.*` `Symbol.for` registry (`kendex.background-tasks.installed`, `kendex.pi.activity`, `kendex.pi.mini-dashboard-stack`, `kendex.pi.modal-lock`, `kendex.pi.project-trust`). Symbol identity is the interop contract, so a package on the old namespace cannot see one on the new namespace — upgrade every installed `@vanillagreen` Pi extension together rather than one at a time.
- Project-root detection recognizes `.kendex-lock.json` instead of `.vstack-lock.json`.
- Repository, homepage, issue-tracker, and README asset URLs now point at `vanillagreencom/kendex`.

### 1.6.3

- Documentation only, no runtime change. This version ships what landed on main after 1.6.2 was published: the packaged README trimmed to the consumer contract — what the extension does, its tools, settings, and setup — with contributor-facing internals moved to the unpublished `DEVELOPMENT.md` (#1473). Published so the npm and pi.dev gallery pages carry the current copy; `extensions/` and `scripts/` are byte-identical to 1.6.2.

### 1.6.2

- Baseline: changelog introduced at this version. Consumer-impacting changes — behavior deltas, new/renamed/removed exports, settings and config changes, protocol/audit-shape changes — are recorded here from this version forward.
