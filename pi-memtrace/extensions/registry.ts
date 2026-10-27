// Size reporters: an extension that holds caches exposes their sizes, and pi-memtrace reads them all.
//
// The registry lives on globalThis under Symbol.for("pi-memtrace.reporters") so that no package imports
// another. An extension opts in with:
//
//   const reporters = ((globalThis as any)[Symbol.for("pi-memtrace.reporters")] ??= new Map());
//   reporters.set("my-extension.sessions", () => ({ entries: sessions.size, bytes: estimateBytes(sessions) }));
//
// A reporter runs at every sample, so it must be cheap: counts and estimateShallowMemoryUsageOf, never a heap walk.

export type SizeReporter = () => Record<string, number>;

export type ReporterReadings = Record<string, Record<string, number> | { error: string }>;

const KEY = Symbol.for("pi-memtrace.reporters");

export function reporters(): Map<string, SizeReporter> {
	const g = globalThis as Record<symbol, unknown>;
	let map = g[KEY] as Map<string, SizeReporter> | undefined;
	if (!map) {
		map = new Map();
		g[KEY] = map;
	}
	return map;
}

/** Runs every reporter. One that throws is recorded as an error and does not stop the others. */
export function readReporters(): ReporterReadings {
	const out: ReporterReadings = {};
	for (const [name, read] of reporters()) {
		try {
			out[name] = read();
		} catch (err) {
			out[name] = { error: err instanceof Error ? err.message : String(err) };
		}
	}
	return out;
}
