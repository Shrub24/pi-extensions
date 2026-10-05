# Tasks

## 1. Message building

- [x] 1.1 Project the unresolved tasks into the bus task object from the same
  filter as `paneFacts`; omit absent fields rather than sending null. Test
  running, flushing, review-with-exit-code and a task with no output yet.
- [x] 1.2 Frame messages as one JSON line each. Test `hello` with and without a
  pane and the empty list. Assert every line the builder emits is accepted by a
  check against `radar-bus.fixture.json` shapes (field names and types).
- [x] 1.3 Send `command` and `cwd` bounded to 256 characters, omit them when
  absent, and assert no log path can appear in any emitted line.

## 2. Transport

- [x] 2.1 Resolve the socket path in Radar's order and refuse to connect unless
  the directory is owned by the uid, mode 0700 and not a symlink (a
  `RADAR_SOCKET` override excepted). Test each failing property.
- [x] 2.2 One writer with a single-latest-list queue; ordered writes, never
  interleaved. Test a burst collapses to the last list.
- [x] 2.3 Capped exponential reconnect, only while a task is unresolved. Test no
  retry when nothing is outstanding.
- [x] 2.4 Every failure (connect, write, peer close) is swallowed and never
  reaches a turn, task or result. Test with a refusing and a hanging peer.

## 3. Lifecycle

- [x] 3.1 Connect lazily on the first unresolved task; send `hello` then the full
  list. A session that never spawns a task opens no connection.
- [x] 3.2 Send the explicit empty list when the last task resolves; keep the
  connection.
- [x] 3.3 A new Pi session id closes the old connection and sends a fresh `hello`
  and full list.
- [x] 3.4 Close on `session_shutdown`.
- [x] 3.5 Throttle counter-only changes to one message per second while sending
  set or state changes promptly.

## 4. Integration

- [x] 4.1 Run the publisher against a real unix socket server in a test that
  spawns, finishes and reviews real tasks, asserting the sequence of lines.
- [x] 4.2 Assert the publisher never marks a result delivered or reviewed.
- [x] 4.3 Document the bus in the package README beside the pane tokens.
