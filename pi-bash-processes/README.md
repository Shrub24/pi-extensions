# @vanillagreen/pi-background-tasks

A Pi extension for shell commands that run while the conversation continues. It supports builds, development servers and log monitors.

![Spawning background tasks](https://raw.githubusercontent.com/vanillagreencom/kendex/main/pi-extensions/pi-background-tasks/assets/spawn-tasks.png) ![Inline mini-dashboard](https://raw.githubusercontent.com/vanillagreencom/kendex/main/pi-extensions/pi-background-tasks/assets/inline-dashboard.png)

> Extracted from [vanillagreencom/kendex](https://github.com/vanillagreencom/kendex) (import commit `b146363`); maintained here independently since.

## Install

- npm: `pi install npm:@vanillagreen/pi-background-tasks`.
- kendex: add the declaration below to the project's `kendex.toml`, or to `~/.config/kendex/kendex.toml` for user scope. Run `kendex update-pi`.

```toml
[pi-extensions."@vanillagreen/pi-background-tasks"]
source = "kendex"
```

Restart Pi after installation. Use `kendex update-pi --check` to preview the installation.

## Features

- Start, inspect and stop background commands.
- In the interactive TUI, exactly `bg_task spawn/get/stop/list/extend`: completion arrives as a pushed wake, so no bounded wait and no status tool are declared, and `extend` only re-arms a task's soft reminder. Noninteractive and child sessions keep the compatibility surface — the bounded `bg_task wait` (configurable 30s default, 120s maximum) and the `bg_status` status tool — without turning the turn into a polling loop.
- Yield unexpectedly slow model-facing Bash commands into managed background tasks after a configurable foreground wait.
- Notify the agent when a task exits or produces selected output.
- Read full logs and task history in the dashboard.
- Optionally reduce task CPU and disk priority.

## How it works

Every model-facing Bash command starts under the task manager. If it finishes within `foregroundYieldMs` (20 seconds by default), Bash returns its real output and status normally. Otherwise Bash returns a nonterminal task ID while the same process continues; completion is pushed automatically. The explicit background task tool remains available for commands known to be long-lived. `bg_task action: "wait"` blocks the turn for up to `waitSeconds` and returns the terminal result or a truthful Running status; it never stops the task. If no independent work remains, the agent can end its turn and go idle—the completion wake starts a new agent turn. Output is saved to a log and task status appears beside the editor. The agent contract is: never poll a task (no sleep/tail loops, no repeated `get`/`list`/`log` calls); continue independent work and end the turn so the completion wake can arrive. A noninteractive or child caller that must have a shell result before its session closes may call `bg_task action:"wait"` once with a bounded `waitSeconds`: that yields only its own turn and never stops the task.

### Soft timeouts: decide at the reminder, not the kill

Every background task has a soft timeout (10 minutes by default; per-spawn `softTimeoutMs`, 0 disables). When it expires the process is **not** stopped: the agent receives one progress wake per interval with elapsed time and the current output tail, and must choose — let it continue (the next reminder arrives after the same interval), re-arm the interval with `bg_task action: "extend" id:... softTimeoutMs:...` (an omitted `softTimeoutMs` keeps the current interval, `0` disables it), inspect it with `bg_task get`, or stop the task. A delivered reminder is itself a review, so the next interval is measured from it and the reminder repeats while the task runs; the deadline survives restarts, where a restored live task re-arms it and an already-fired one does not replay. The hard `timeoutSeconds` is only a backstop that should rarely fire (default disabled); when both are set, the soft wake also names the remaining hard time so the decision happens long before any kill. Re-arming never changes the hard timeout. Set `softTimeoutMs` generously at spawn for a long-running watcher so the reminder does not interrupt it.

### The declared CLI: asking a session about its own tasks

Managed shells get a `pi-bg` command on `PATH`, backed by a session-private Unix
socket. It answers from the live manager — readiness, the review clock, and a
confirmed stop cannot be read off the filesystem — and it is the only supported
way to retrieve a task's output from inside a command.

```
pi-bg list                   running and finished tasks in this session
pi-bg get <task-id>          state, readiness, and an output preview
pi-bg get <task-id> --output the whole capture, as an immutable snapshot
pi-bg stop <task-id>         stop the task and report the confirmed result
```

Raw output goes to **stdout** and everything else to **stderr**, so a redirect
captures the task's bytes alone and a pipe can be filtered:

```
pi-bg get bg-3 --output > out.txt     # out.txt is the capture, byte for byte
pi-bg get bg-3 --output | grep -c ERR  # metadata never enters the pipe
```

- **Preview vs full.** `get` defaults to a bounded tail of the capture. `--output`
  hands over an immutable artifact instead: for a finished, certified capture that
  is the retained log itself, and for a running one it is a copy of the flushed
  prefix, so output produced afterwards never changes what you were handed. A
  running or uncertified read is labelled as such on stderr (`readiness=running`,
  `captureComplete=false`) and its bytes may already have been dropped from a short
  capture; the exit status then reports the management failure below.
- **Combined streams.** A task's log holds stdout and stderr interleaved as the
  process wrote them, and that is what `--output` hands over. Explicit redirection
  inside the command still applies. No total ordering across the two pipes is
  promised.
- **Exit status.** `0` the operation completed and the whole handoff finished;
  `1` a management failure (no such task, a replaced task, an expired handle, an
  unconfirmed stop, or a capture that cannot be certified complete — partial bytes
  may still have been written); `2` the command line was not a valid `pi-bg`
  request; `3` the session's endpoint is not reachable from this environment.
- **Handoff failure and pipes.** The output is acknowledged only after the
  requested write finishes without error. A closed pipe — `pi-bg get ... --output |
  head -c 64` — is a **failed handoff**: the command exits nonzero, the failure is
  reported on stderr, and the task's completion stays owed rather than looking
  delivered. Re-running the read is safe and commits it. A handoff that finishes
  successfully does not certify that some further consumer read every byte.
- **Scope.** The endpoint is bound to one session. A request naming another
  session, or a task handle from a replaced task, is refused rather than resolved
  by guesswork, and `list` only ever reports this session's tasks.

`pi-bg path`, `peek`, and `read` are **removed**. Each read a log file directly,
which bypassed the completion acknowledgment the declared operations perform, so
they now fail with exit `2` and an actionable migration message naming
`pi-bg get <task-id> [--output]` instead of resolving. Nothing is inferred from a
read any more: reading a retained capture — with `cat`, `tail` or any other
command — changes no notification state.

### Background settlement interface

`extensions/background-work.ts` is the package's public settlement seam: a
session-local, provider-owned view of outstanding managed work for consumers
such as a settlement guard. It speaks the versioned
`background-work/v1` protocol over Pi's own `pi.events` bus (snapshot query,
bind, protect and reply channels plus identity/revision-only change
metadata); it adds no registry, timer, polling loop or second task map. The
provider is this extension itself (`id: "pi-bash-processes"`, version `1`),
registered at `session_start` and disposed first at `session_shutdown`, so an
absent provider is never confused with a registered one.

A snapshot query answers one of: `ready` (the exact active session, a
completed successful restore, and no unresolved work unattributable to the
request), `reconciling` (restore pending, or unresolved tasks quarantined
away from the bound assignment), `error` (a failed restore, a scope asking
over another request's unresolved work, or no binding while unattributable
work exists), `missing` (a provider was expected but nothing current
answered) or `absent` (nothing registered, nothing attached). A query for
another session is rejected as `identity-mismatch`, oversized or malformed
replies fail closed, and no path reports an empty successful snapshot for
work the provider cannot account for.

Binding (`bind`) adopts the assignment: every task spawned afterward records
`assignmentRequestId` in its durable snapshot, and binding refuses while
unresolved work exists that the request cannot claim — foreign-request tasks
and unassociated tasks (restored pre-Group-2 work, or spawns from before the
first bind) must be reconciled explicitly with `get`, `stop` or `clear`
first. Resolved tasks are history: they neither block a later bind nor re-enter
any snapshot.

A task leaves `outstanding` only through a durable result resolution: a
certified result that actually reached the worker — a terminal tool
`get`/`stop`/`wait`/foreground delivery or a declared-CLI receipt
(`resultResolution: "delivered"`) — or an unrecoverable capture error that was
actually handed over (`"error"`, confirmed by the CLI's error receipt).
Host wakes, `list`/`log` inspection and failed handoffs (an early pipe
closure) resolve nothing: a notified-but-unretrieved terminal task stays
`awaiting-result-review`. An observation taken while the 250 ms output flush
is still settling is not a result at all: it records nothing until the
capture certifies — or fails as an `error` — so a flushing inspection is
never delivered as a result.

`protect(scope, true)` marks the bound assignment settlement-waiting: its
tasks' exit wakes become mandatory even under `notifyOnExit: false` (grouped
and coalesced as usual), so the terminal result can be retrieved and
resolved; protection ends with an unprotect or the next bind. Successful `get` or confirmed `stop` deliveries cancel any held
mandatory wake; progress reminders retain their normal schedule. Protecting an
assignment also reconciles work that ended before protection existed: a
suppressed terminal task gets its one wake immediately (a held, mid-turn one
at the run boundary), and never again once its result is retrieved. Herdsman-side
settlement consumption arrives with Group 3; ordinary unprotected task and
CLI behavior is unchanged today.

## Memory and disk use

- A finished task's output is read from its log file; the process handle and the in-memory output are released once the task has exited and its last log write has finished. A task whose last log write failed or stalled keeps its in-memory output instead.
- At most 50 finished tasks are kept; past that, the oldest finished task is removed with its log. `clear` also deletes the logs of the tasks it removes. Neither path may ever remove a terminal result that belongs to a bound assignment and has not been delivered yet: the retention bound keeps it past the 50-task limit, and `clear` skips it and reports a `Kept …` line instead (retrieve it with `get`, then `clear` again to drop it as ordinary history). A forked session removes the tasks it copied from the original session but keeps their logs, which the original session still reads.
- Logs live in one directory per session in the `lanes/` folder of the task directory (`taskDir`, default the system temporary directory's `kendex-pi-bg`). A session's directory is deleted once its working directory is gone (a merged worktree), and any log older than 5 days is deleted. Pi applies both rules when a session starts, to `lanes/` only, and only to directories the package made there.
- A log written before 2.1.0 stays directly in the task directory. The prune, `clear` and the 50-task bound do not delete it; a task restored with such a log is removed from the list without its log.

## Settings

The settings editor writes project values to `.pi/settings.json`. The default user file is `~/.pi/agent/settings.json`. `PI_CODING_AGENT_DIR` changes the user directory. Package values are stored under `kendex.extensionManager.config["@vanillagreen/pi-background-tasks"]`.

Open `/extensions:settings`; settings appear under the **Background Tasks** tab. Project settings in `.pi/settings.json` apply only after Pi marks the workspace trusted.

- `enabled`: package toggle; `glyphStyle` picks Unicode or ASCII symbols, and `pi-tool-renderer`'s global override wins when set.
- Tool surface: the interactive TUI declares `bg_task` (`spawn`, `get`, `stop`, `list`, `extend`) and no `bg_status`; `print`, `json`, `rpc` and any unrecognized mode keep the compatibility surface (bounded `wait`, `bg_status`). There is nothing to configure — the mode Pi reports decides it.
- Auto-backgrounding for user `!` Bash: `autoBackgroundBash`, `autoBackgroundPatterns`, `forcedBackgroundWindowSeconds`, `forcedBackgroundNotifyOnOutput`.
- Execution: `foregroundYieldMs` is the model-facing Bash soft wait; `taskWaitDefaultSeconds` and `taskWaitMaxSeconds` bound one compatibility `bg_task wait` (a TUI session declares no wait at all); `defaultSoftTimeoutMs` is the default soft reminder (10 minutes, 0 disables); `defaultTimeoutSeconds` (hard backstop, default disabled), `forceKillGraceMs`, and the `resourceControl*` group control explicit and auto-background task runtime and resources. Soft waits and soft reminders never kill a process, and resource controls do not wrap ordinary managed Bash commands.
- Wakes and output: `outputSettleMs`, `outputAlertMaxChars`, `outputWakeBudgetMaxWakes`, `outputWakeBudgetMaxBytes`, `outputBufferMaxChars`, `logTailMaxChars`.
- UI: `showWidget`, `widgetPlacement`, `widgetDefaultMode`, `widgetFinishedRetentionSeconds`, `toolRenderMode`, `toolExpandedLogLines`, `dashboardOutputMaxLines`.
- Shortcuts: `backgroundBashShortcut`, `widgetToggleShortcut`, `dashboardShortcut`; `none` disables one, and a change takes effect on restart.
- Storage: `taskDir`; the `PI_BG_TASK_DIR` environment variable overrides it.

Maintainer notes are in [DEVELOPMENT.md](DEVELOPMENT.md). The package is kendex's own, based on the MIT-licensed `@ifi/pi-background-tasks`; see `THIRD_PARTY_NOTICES.md`.

- `wakeMessageStyle`: `line` (default) renders each wake as one dim line, `card` restores the ruled banner, `hidden` renders nothing (the agent is still woken).

## Fork delta

This package is a fork of kendex `pi-extensions/pi-background-tasks`, kept
current through upstream `#3289`. The fork's own features (upstream has no
equivalent — each is fork-only source plus its tests):

- **Managed bash** (`extensions/managed-bash.ts`) — the extension's own bash
  tool wrapping pi-bash-processes semantics, with a bounded task wait
  (`task-wait.ts`) and `pipefail` on bash and zsh shells (`managedShellPipefail:
  false` opts out). Commands run exactly as written: a trailing `| head`/`| tail`
  is no longer rewritten. Awaiting a result is
  a declared operation now: the read shim (`read-shim.ts`) that made a raw log
  read consume the exit wake, the sleep-as-wait interception
  (`sleep-intercept.ts`), and the per-process consume logs are all retired.
- **Declared tool surface per session mode** (`extensions/tool-surface.ts`) — the
  mode from `session_start` decides the tools and the guidance. The TUI declares
  `bg_task` with exactly `spawn/get/stop/list/extend` and no `bg_status`; every other
  mode keeps the compatibility surface. Wake, acknowledgement and wake-budget text
  is generated per mode so it never names an operation the model cannot call, and
  the installed append-system block stays mode-neutral.
- **Soft timeouts** — an advisory per-task reminder that surfaces a decision
  (re-arm its interval, stop, let it run) before the hard kill; the "Soft timeouts" section
  above documents the behaviour.
- **Configurable task policy** — task retention and auto-background behaviour
  exposed through settings.
- **Bounded foreground wait** — foreground bash calls that background themselves
  report a bounded wait instead of blocking the turn.
- **Structured bash results and codemode** — bash declares Pi's output schema
  and returns structured output for completed commands; a yielded task still
  returns a Running acknowledgment. Codemode calls use Pi's foreground bash
  executor, with normal timeout, cancellation, and structured results, rather
  than starting managed tasks. `bg_task` spawn is blocked inside codemode,
  including through nested wrappers. This does not restrict shell syntax such
  as `cmd &`. A script's own tool calls need no `intent`, even when
  `intentMode: "required"` is set: `intent` is an optional schema property for
  every caller, and the required policy is enforced per call by Pi's `tool_call`
  guard, which exempts a call another tool made. A root `codemode` call still
  states its purpose as one leading `// intent: ...` comment in the script,
  after a native `// @options:` line when one is present.
