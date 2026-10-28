# pi-memtrace

On-demand memory tracing for Pi-Bolt. Load it only when you are chasing growth; it does nothing otherwise.

## Commands

- `/memtrace` — interactive menu showing current memory and sampling state, with actions to toggle per-turn sampling, inspect object counts, compare a forced GC, and write a heap snapshot. Sampling changes apply to the current process and reset when it restarts.
- `/memstat` — RSS, anonymous memory, swap, heap, and every size reporter now. `/memstat types` adds object-type counts (a full heap walk).
- `/memtrace` → **Show inotify watches** — this process's instances and marks, the per-user cap, and the heaviest holders on the machine. Reports when the cap is reached, since every new watch then fails with `ENOSPC`.
- `/heapsnap [label]` — writes a V8-format heap snapshot of this process to `$PI_MEMTRACE_DIR/snapshots/`. Diff two snapshots from different points in a session to see what is retained between them.

## Per-turn sampling

On by default, one sample per turn, appended to `$PI_MEMTRACE_DIR/<session>.jsonl`. `/memtrace` turns it off for the current
process. `PI_MEMTRACE_EVERY=N` changes the interval, and `PI_MEMTRACE_EVERY=0` starts with sampling off.
`PI_MEMTRACE_TYPES_EVERY=N` also appends object-type counts every N samples to `<session>.types.jsonl`; the default walks the
heap every 25 samples, and `0` disables it.

`PI_MEMTRACE_DIR` defaults to `~/.local/share/pi-memtrace`. A forced-GC comparison saves complete `heapStats()` results and process samples before and after collection to `<session>.gc.jsonl`. Object-type counts are counts, not byte sizes. Heap walks, forced GC, and snapshots may pause the process or increase memory usage.

## Inotify

Every sample carries `pi-memtrace.inotify` — the instances and marks this process holds. A recursive file watch
registers one mark per directory, and the budget is shared by every process for the whole user, so a single watcher can
starve the machine. Counting stays bounded: an instance holding more than ~8,000 marks is reported with `capped` rather
than read in full, and the system-wide sweep runs only from the menu.


Any extension that holds caches can say what it holds. Register a reporter on the shared registry without importing this package:

```ts
const reporters = ((globalThis as any)[Symbol.for("pi-memtrace.reporters")] ??= new Map());
reporters.set("my-extension.sessions", () => ({ entries: sessions.size }));
```

A reporter runs at every sample, so keep it to counts and `estimateShallowMemoryUsageOf` from `bun:jsc`. A reporter that throws is recorded as an error and does not stop the others.

## Runtime

Requires Bun for heap snapshots and object-type counts. Samples use `process.memoryUsage()` and `/proc/self/smaps_rollup`, so they work anywhere Linux does.
