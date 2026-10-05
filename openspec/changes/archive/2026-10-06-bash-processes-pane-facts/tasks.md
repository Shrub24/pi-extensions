# Tasks

## 1. Publisher

- [x] 1.1 Add a module that builds the three token values from the running-task
  inventory, with the cap, the terminal-safe transformation and the 80-character
  bound. Test the empty, single, several, over-cap and unsafe-character cases.
- [x] 1.2 Invoke `herdr pane report-metadata <pane> --source <source> --ttl-ms <n>
  --token ...` for the current pane, tolerating a failure without surfacing an
  error to the model turn.
- [x] 1.3 Clear the keys with `--clear-token` when the facts no longer apply.

## 2. Lifecycle

- [x] 2.1 Publish on every task state change: spawn, exit, settlement and result
  review. Publication is independent of the session's own state, so a task spawned
  mid-turn is advertised while the session is still working.
- [x] 2.2 Refresh on a timer while at least one task runs, with a TTL that
  outlives the refresh interval. Test that a task running past the TTL is still
  advertised.
- [x] 2.3 Clear the keys when the last running task ends.
- [x] 2.4 Clear the keys on shutdown, awaiting the clear before the process exits.
- [x] 2.5 Gate publication on a TUI session, a Herdr pane id and a non-zero
  running count. Test each gate independently.

## 3. Integration

- [x] 3.1 Cover the inventory-to-facts path against the real task store, including
  a task that ends between the refresh and the next publish.
- [x] 3.2 Cover that no task content reaches a published value.

## 4. Documentation and gates

- [x] 4.1 Document the keys in the package documentation as the consumer contract
  for Radar, naming the source, the TTL and the clearing behaviour.
- [x] 4.2 Run the package suite (`bun test --parallel=4 ./tests ./extensions/__tests__`)
  and record the counts and the source checkpoint. 345 pass / 0 fail across 98
  files at git `5b778a04`, jj change `wtkylqrrmmqknqzvyysrlrqypnuslyru`.
- [x] 4.3 Strict OpenSpec validation for this change.
- [x] 4.4 Tell the Radar session the token set so it can render the waiting
  presentation. (Owner-level: cross-session message.)
