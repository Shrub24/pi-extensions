# pi-memtrace

On-demand memory tracing for Pi-Bolt. Load it only when you are chasing growth; it does nothing otherwise.

## Commands

- `/memstat` — RSS, anonymous memory, heap, and every size reporter now. `/memstat types` adds object-type counts (a full heap walk).
- `/heapsnap [label]` — writes a V8-format heap snapshot of this process to `$PI_MEMTRACE_DIR/snapshots/`. Diff two snapshots from different points in a session to see what is retained between them.

## Per-turn sampling

Off by default. Set `PI_MEMTRACE_EVERY=N` to append a sample to `$PI_MEMTRACE_DIR/<session>.jsonl` every N turns. Set `PI_MEMTRACE_TYPES_EVERY=N` to also append object-type counts every N samples to `<session>.types.jsonl`.

`PI_MEMTRACE_DIR` defaults to `~/.local/share/pi-memtrace`.

## Size reporters

Any extension that holds caches can say what it holds. Register a reporter on the shared registry without importing this package:

```ts
const reporters = ((globalThis as any)[Symbol.for("pi-memtrace.reporters")] ??= new Map());
reporters.set("my-extension.sessions", () => ({ entries: sessions.size }));
```

A reporter runs at every sample, so keep it to counts and `estimateShallowMemoryUsageOf` from `bun:jsc`. A reporter that throws is recorded as an error and does not stop the others.

## Runtime

Requires Bun for heap snapshots and object-type counts. Samples use `process.memoryUsage()` and `/proc/self/smaps_rollup`, so they work anywhere Linux does.
