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
- Wait for a background task with one bounded `bg_task wait` call (configurable 30s default, 120s maximum) without turning the turn into a polling loop.
- Yield unexpectedly slow model-facing Bash commands into managed background tasks after a configurable foreground wait.
- Notify the agent when a task exits or produces selected output.
- Read full logs and task history in the dashboard.
- Optionally reduce task CPU and disk priority.

## How it works

Every model-facing Bash command starts under the task manager. If it finishes within `foregroundYieldMs` (20 seconds by default), Bash returns its real output and status normally. Otherwise Bash returns a nonterminal task ID while the same process continues; completion is pushed automatically. The explicit background task tool remains available for commands known to be long-lived. `bg_task action: "wait"` blocks the turn for up to `waitSeconds` and returns the terminal result or a truthful Running status; it never stops the task. If no independent work remains, the agent can end its turn and go idle—the completion wake starts a new agent turn. Output is saved to a log and task status appears beside the editor. The agent contract is: never poll a task (no sleep/tail loops, no repeated list or log calls); continue independent work, use one bounded `bg_task wait` when the result is a dependency barrier, or end the turn.

### Soft timeouts: decide at the reminder, not the kill

Every background task has a soft timeout (10 minutes by default; per-spawn `softTimeoutMs`, 0 disables). When it expires the process is **not** stopped: the agent receives exactly one progress wake with elapsed time, the current output tail, and the log path, and must choose — continue (optionally extend with `bg_task action: "extend" id:... softTimeoutMs:...`, which starts a fresh window from now), inspect the log, or stop the task. The reminder is one-shot and survives restarts; a restored live task re-arms it, a fired one stays fired. The hard `timeoutSeconds` is only a backstop that should rarely fire (default disabled); when both are set, the soft wake also names the remaining hard time so the decision happens long before any kill. Extending never changes the hard timeout.

## Settings

The settings editor writes project values to `.pi/settings.json`. The default user file is `~/.pi/agent/settings.json`. `PI_CODING_AGENT_DIR` changes the user directory. Package values are stored under `kendex.extensionManager.config["@vanillagreen/pi-background-tasks"]`.

Open `/extensions:settings`; settings appear under the **Background Tasks** tab. Project settings in `.pi/settings.json` apply only after Pi marks the workspace trusted.

- `enabled`: package toggle; `glyphStyle` picks Unicode or ASCII symbols, and `pi-tool-renderer`'s global override wins when set.
- Auto-backgrounding for user `!` Bash: `autoBackgroundBash`, `autoBackgroundPatterns`, `forcedBackgroundWindowSeconds`, `forcedBackgroundNotifyOnOutput`.
- Execution: `foregroundYieldMs` is the model-facing Bash soft wait; `taskWaitDefaultSeconds` and `taskWaitMaxSeconds` bound one `bg_task wait`; `defaultSoftTimeoutMs` is the default soft reminder (10 minutes, 0 disables); `defaultTimeoutSeconds` (hard backstop, default disabled), `forceKillGraceMs`, and the `resourceControl*` group control explicit and auto-background task runtime and resources. Soft waits and soft reminders never kill a process, and resource controls do not wrap ordinary managed Bash commands.
- Wakes and output: `outputSettleMs`, `outputAlertMaxChars`, `outputWakeBudgetMaxWakes`, `outputWakeBudgetMaxBytes`, `outputBufferMaxChars`, `logTailMaxChars`.
- UI: `showWidget`, `widgetPlacement`, `widgetDefaultMode`, `widgetFinishedRetentionSeconds`, `toolRenderMode`, `toolExpandedLogLines`, `dashboardOutputMaxLines`.
- Shortcuts: `backgroundBashShortcut`, `widgetToggleShortcut`, `dashboardShortcut`; `none` disables one, and a change takes effect on restart.
- Storage: `taskDir`; the `PI_BG_TASK_DIR` environment variable overrides it.

Maintainer notes are in [DEVELOPMENT.md](DEVELOPMENT.md). The package is kendex's own, based on the MIT-licensed `@ifi/pi-background-tasks`; see `THIRD_PARTY_NOTICES.md`.

- `wakeMessageStyle`: `line` (default) renders each wake as one dim line, `card` restores the ruled banner, `hidden` renders nothing (the agent is still woken).
