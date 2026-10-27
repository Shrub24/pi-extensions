# pi-memtrace

On-demand memory tracing for Pi-Bolt. Load it only when you are chasing growth; it does nothing otherwise.

## Commands

- `/memtrace` — interactive menu showing current memory and sampling state, with actions to toggle per-turn sampling, inspect object counts, compare a forced GC, and write a heap snapshot. Sampling changes apply to the current process and reset when it restarts.
- `/memstat` — RSS, anonymous memory, swap, heap, and every size reporter now. `/memstat types` adds object-type counts (a full heap walk).
- `/heapsnap [label]` — writes a V8-format heap snapshot of this process to `$PI_MEMTRACE_DIR/snapshots/`. Diff two snapshots from different points in a session to see what is retained between them.

## Per-turn sampling

Off by default. Set `PI_MEMTRACE_EVERY=N` to append a sample to `$PI_MEMTRACE_DIR/<session>.jsonl` every N turns. Set `PI_MEMTRACE_TYPES_EVERY=N` to also append object-type counts every N samples to `<session>.types.jsonl`.

`PI_MEMTRACE_DIR` defaults to `~/.local/share/pi-memtrace`. A forced-GC comparison saves complete `heapStats()` results and process samples before and after collection to `<session>.gc.jsonl`. Object-type counts are counts, not byte sizes. Heap walks, forced GC, and snapshots may pause the process or increase memory usage.

## Size reporters

Any extension that holds caches can say what it holds. Register a reporter on the shared registry without importing this package:

```ts
const reporters = ((globalThis as any)[Symbol.for("pi-memtrace.reporters")] ??= new Map());
reporters.set("my-extension.sessions", () => ({ entries: sessions.size }));
```

A reporter runs at every sample, so keep it to counts and `estimateShallowMemoryUsageOf` from `bun:jsc`. A reporter that throws is recorded as an error and does not stop the others.

## Runtime

Requires Bun for heap snapshots and object-type counts. Samples use `process.memoryUsage()` and `/proc/self/smaps_rollup`, so they work anywhere Linux does.
