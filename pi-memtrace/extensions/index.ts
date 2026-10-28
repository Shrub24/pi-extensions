import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { takeSample, type Sample } from "./sample.js";

// Sampling is on for every session while the RSS growth here is unexplained; the menu turns it off. PI_MEMTRACE_TYPES_EVERY also
// walks the heap for object-type counts, which is expensive enough to keep sparse.
const DIR = process.env.PI_MEMTRACE_DIR ?? `${process.env.HOME}/.local/share/pi-memtrace`;
const EVERY = Number(process.env.PI_MEMTRACE_EVERY ?? 1);
const TYPES_EVERY = Number(process.env.PI_MEMTRACE_TYPES_EVERY ?? 25);

type Bun = { generateHeapSnapshot?: (format: "v8") => string; gc?: (force: boolean) => void };

function sessionOf(ctx: any): string {
	const id = ctx?.sessionManager?.getSessionId?.();
	if (id) return id;
	const file = ctx?.sessionManager?.getSessionFile?.();
	if (file) return file.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") ?? `ephemeral-${process.pid}`;
	return `ephemeral-${process.pid}`;
}

/** Bun's JSC introspection, or undefined on another runtime. Dynamic so the package still loads under Node. */
async function jsc(): Promise<any | undefined> {
	try {
		return await import("bun:jsc");
	} catch {
		return undefined;
	}
}

async function typeCounts(top = 15): Promise<[string, number][] | undefined> {
	const j = await jsc();
	if (!j) return undefined;
	const counts: Record<string, number> = j.heapStats().objectTypeCounts;
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, top);
}

function writeSnapshot(session: string, label: string): { path: string; size: number; ms: number } {
	const bun = (globalThis as { Bun?: Bun }).Bun;
	if (!bun?.generateHeapSnapshot) throw new Error("heapsnap needs Bun's generateHeapSnapshot");
	const started = performance.now();
	const snapshot = bun.generateHeapSnapshot("v8");
	const dir = `${DIR}/snapshots`;
	mkdirSync(dir, { recursive: true });
	const path = `${dir}/${session}-${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.heapsnapshot`;
	writeFileSync(path, snapshot);
	return { path, size: snapshot.length, ms: Math.round(performance.now() - started) };
}

function line(sample: Sample): string {
	return JSON.stringify(sample);
}

function describe(sample: Sample): string[] {
	const mb = (n?: number) => (n === undefined ? "n/a" : `${(n / 1048576).toFixed(0)} MB`);
	const out = [
		`rss ${mb(sample.rss)}  anon ${mb(sample.anon)}  swap ${mb(sample.swap)}  heapUsed ${mb(sample.heapUsed)}  heapTotal ${mb(sample.heapTotal)}  external ${mb(sample.external)}`,
	];
	for (const [name, reading] of Object.entries(sample.reporters)) {
		out.push(`  ${name}: ${"error" in reading ? `error ${reading.error}` : JSON.stringify(reading)}`);
	}
	return out;
}

export default function piMemtrace(pi: ExtensionAPI): void {
	let samples = 0;
	let currentSession = "unknown";
	let every = EVERY;

	pi.on("turn_end", (event: any, ctx: any) => {
		currentSession = sessionOf(ctx);
		if (every <= 0 || event?.turnIndex === undefined || event.turnIndex % every !== 0) return;
		try {
			samples += 1;
			const sample = takeSample(currentSession, event.turnIndex);
			mkdirSync(DIR, { recursive: true });
			appendFileSync(`${DIR}/${currentSession}.jsonl`, `${line(sample)}\n`);
			if (TYPES_EVERY > 0 && samples % TYPES_EVERY === 0) {
				void typeCounts().then((types) => {
					if (types) appendFileSync(`${DIR}/${currentSession}.types.jsonl`, `${JSON.stringify({ ts: sample.ts, turn: event.turnIndex, types })}\n`);
				});
			}
		} catch {
			/* a diagnostic must never break a turn */
		}
	});

	pi.registerCommand("memtrace", {
		description: "Memory diagnostics and sampling controls",
		handler: async (_args: string, ctx: any) => {
			for (;;) {
				const sample = takeSample(sessionOf(ctx));
				const choice = await ctx.ui.select(
					`Memory diagnostics · ${describe(sample)[0]} · sampling ${every > 0 ? `every ${every} turns` : "off"}`,
					[
						"Show memory and object counts",
						"Compare before and after forced GC",
						every > 0 ? "Disable sampling" : "Enable sampling (every turn)",
						"Write heap snapshot",
					],
				);
				if (!choice) return;
				if (choice === "Show memory and object counts") {
					const types = await typeCounts();
					ctx.ui.notify([...describe(sample), ...(types ? types.map(([name, n]) => `  ${name}: ${n}`) : ["object-type counts need Bun"])].join("\n"), "info");
					return;
				}
				if (choice === "Compare before and after forced GC") {
					const bun = (globalThis as { Bun?: Bun }).Bun;
					const j = await jsc();
					if (!bun?.gc || !j) {
						ctx.ui.notify("GC comparison needs Bun and bun:jsc", "error");
						return;
					}
					const before = { sample: takeSample(sessionOf(ctx)), heap: j.heapStats() };
					bun.gc(true);
					const after = { sample: takeSample(sessionOf(ctx)), heap: j.heapStats() };
					mkdirSync(DIR, { recursive: true });
					const path = `${DIR}/${sessionOf(ctx)}.gc.jsonl`;
					appendFileSync(path, `${JSON.stringify({ before, after })}\n`);
					ctx.ui.notify(`Before: ${describe(before.sample)[0]}\nAfter: ${describe(after.sample)[0]}\nFull heap statistics: ${path}`, "info");
					return;
				}
				if (choice === "Disable sampling" || choice === "Enable sampling (every turn)") {
					every = every > 0 ? 0 : 1;
					continue;
				}
				if (choice === "Write heap snapshot") {
					try {
						const snapshot = writeSnapshot(sessionOf(ctx), "manual");
						ctx.ui.notify(`heap snapshot ${(snapshot.size / 1048576).toFixed(1)} MB in ${snapshot.ms} ms\n${snapshot.path}`, "info");
					} catch (err) {
						ctx.ui.notify(`heapsnap failed: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
					return;
				}
			}
		},
	});

	pi.registerCommand("memstat", {
		description: "Memory now: RSS, anonymous, heap, and what extensions report. Add `types` for object-type counts (heap walk).",
		handler: async (args: string, ctx: any) => {
			const sample = takeSample(sessionOf(ctx));
			const lines = describe(sample);
			if (String(args ?? "").trim() === "types") {
				const types = await typeCounts();
				lines.push(...(types ? types.map(([name, n]) => `  ${name.padEnd(28)} ${n}`) : ["object-type counts need Bun"]));
			}
			ctx?.ui?.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("heapsnap", {
		description: "Write a V8-format heap snapshot of this process to the memtrace directory, for diffing two points in a session.",
		handler: async (args: string, ctx: any) => {
			const label = String(args ?? "").trim().replace(/[^\w-]+/g, "-") || "manual";
			try {
				const snapshot = writeSnapshot(sessionOf(ctx), label);
				ctx?.ui?.notify(`heap snapshot ${(snapshot.size / 1048576).toFixed(1)} MB in ${snapshot.ms} ms\n${snapshot.path}`, "info");
			} catch (err) {
				ctx?.ui?.notify(`heapsnap failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
