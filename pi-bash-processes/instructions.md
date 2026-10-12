## pi-background-tasks — `bg_task`

Bash commands that exceed the foreground wait (20 seconds by default) return a `Running` task ID and keep executing. Completion wakes you in a new turn with the output tail. A caller that cannot end its response before it has the result (a child or headless session, for example) should use the bounded wait this mode's guidance describes, when it offers one.

Operations are declared by this mode's own tool schema. Do not assume an action exists because another mode has it.

Results: read them through the declared operation, never by reading a log file. A `get` hands over the result and acknowledges its completion notification once. `output:"full"` hands over the complete immutable snapshot; an oversized snapshot is saved to a readable artifact, not truncated. A read that cannot certify a complete capture says so and acknowledges nothing. A plain `cat`, `tail`, or `grep` of a log reports bytes without settling the capture and without cancelling the completion wake.

Timeouts: the soft reminder (default 10 minutes, `softTimeoutMs` per spawn, scheduled from the last successful review) is not an exit and stops nothing. The hard `timeoutSeconds` is an absolute process-lifetime ceiling; no read, listing, reminder, or soft reset extends it, and a task without a hard limit never gains one through retrieval.

Stopping: `stop` returns the confirmed or explicitly unconfirmed outcome under the same task ID and leaves the result retrievable. A sent signal is never reported as a stopped task.

Wakes: exits notify by default (`notifyOnExit`). `notifyOnOutput` with `notifyPattern` wakes on matching new output; `notifyMode` is `always`, `transition`, or `first-match-only`. Exits in the same window arrive batched, and a missed wake replays at most once. Stop turn-scoped tasks you no longer need before ending the turn.

CLI: `pi-bg get <task-id> [--output]` writes the result, or the complete snapshot, to stdout with metadata on stderr. `pi-bg list` lists tasks. `pi-bg stop <task-id>` stops one and reports the confirmed result. A handle belongs to the session that created it. An expired handle reports an explicit error, not an empty result.

Output: do not trim a command's output (`| tail`, `| head`, `2>/dev/null`) when you need its result. Oversized output is saved in full to the file the result names. Managed shells run with `pipefail`.

Resource controls (opt-in, off by default): heavy tasks can run through a `systemd-run` transient service or a `nice`/`ionice` fallback, keeping log capture, wakeups, timeouts, and `/bg:stop`.
