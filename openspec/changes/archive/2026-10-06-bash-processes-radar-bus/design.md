# Design

## Context

`paneFacts()` already projects the unresolved tasks (running, flushing, review)
from the task store. The bus needs the same set with more fields per task. The
contract is Radar's `docs/radar-bus.md` v1; this change only implements the
publisher half and does not restate the protocol.

## Decisions

### D1 — One projection of "unresolved"

The bus list is built from the same filter `paneFacts` uses (`resultIsResolved`
and `taskReadiness`), so a task is on the bus exactly when it is in
`pi_bg_tasks`. The phase word is the same three-word vocabulary
(`running`, `flushing`, `review`). Only the extra per-task fields differ.

### D2 — Full list per change, one writer, one connection

Every change to the unresolved set, and the throttled counter refresh, sends one
`tasks` message with every unresolved task. A single writer owns the connection:
messages are queued and written in order, never interleaved. An empty list is
sent explicitly when the last task resolves and the connection stays open.

### D3 — Connection lifecycle follows the Pi session

`hello` is sent once per connection with the exact Pi session UUID and, when
`HERDR_PANE_ID` is set, the pane. The connection is not gated on the pane or on
the session mode: a print/rpc run inside a Herdr pane has the same session and
pane, and Radar joins by session first. A new session id (`/new`, `/resume`)
closes the old connection and opens a new one with its own `hello` and a full
list. The connection is opened lazily when there is something to say (a task
exists) and is closed on `session_shutdown`. A session that never has a task
never connects.

### D4 — Never block, never throw

Dialling, writing and reconnecting happen off the turn path. The queue holds only
the latest list (older lists are superseded by definition, since each is
complete), so memory is bounded. A failed connect, write or a closed peer is
swallowed. Reconnect uses capped exponential backoff (1 s to 30 s) and only while
at least one task is unresolved; with nothing to publish there is nothing to
retry, and Radar has already cleared the rows when the connection closed. A path
that fails the trust check is not dialled and holds no timer at all: it is
re-resolved on the next update, so a session without Radar schedules nothing and
a Radar started later is picked up by the next state or output change.

### D5 — Socket trust check before connecting

The publisher resolves the path the same way Radar binds (`RADAR_SOCKET`, then
`$XDG_RUNTIME_DIR/agent-radar/radar.sock`, then
`/tmp/agent-radar-<uid>/radar.sock`) and refuses to connect unless the parent
directory is owned by the current uid, has mode `0700` and is not a symlink. A
`RADAR_SOCKET` override is trusted as given, as it is for tests and nested runs.

### D6 — Throttle

A state change (the set of ids or any state word) is sent promptly. Changes that
only move `output_bytes` or `last_output_at` are coalesced to one message per
second. The existing pane-facts refresh timer is not reused: its cadence exists
to beat a token TTL, which the bus does not have.

### D7 — What is sent

Per task: `id`, `state`, `pid` while alive, `started_at`, `last_output_at`
(omitted when no output yet), `output_bytes`, `exit_code` once exited (omitted
when unknown, never `0` by default), and `command` and `cwd` bounded to 256
characters. `command` and `cwd` are the row's only human-useful content, and the
contract already defines them as optional and sensitive: they are sent, and the
socket directory check is what keeps them to the same user. A log path is never
sent — a path invites reading the file, and `last_output_at` with `output_bytes`
already show activity. No settings key: the bus is on whenever a Radar socket is
present and trusted.

### D8 — The list is complete, and nothing is published after shutdown

A `tasks` message is the whole unresolved set, so it is never truncated: the
task store already bounds how many tasks exist, and a partial list would make
Radar's view silently wrong in a way no later message corrects. The protocol's
line limit is the only bound. Publication also stops for good once the shutdown
clear has run: a killed task's close event arrives after it, and without that
guard the publisher it just closed would be reopened.

### D9 — Passive only

The publisher reads task state. It must not call anything that marks a result
delivered, reviewed or acknowledged, and it must not accept inbound messages.
`ops` in `hello` is always `[]`.

## Non-Goals

- Receiving commands from Radar, or any lifecycle operation over the bus.
- Redaction policy for `command` and `cwd`; they stay absent until it is decided.
- Herdsman publishing on the bus.

## Risks

- Counter refresh traffic while a chatty task runs: bounded by the one-per-second
  throttle and the single-latest-list queue.
- A stale `pid` for a restored task: sent only while the task is alive; a
  restored task whose process cannot be proved alive omits it.
