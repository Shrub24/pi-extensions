import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { takeSample, type Sample } from "./sample.js";

// Off unless asked for. PI_MEMTRACE_EVERY=N writes a sample every N turns; PI_MEMTRACE_TYPES_EVERY=N also
// walks the heap for object-type counts every N samples (a full heap walk, so keep it sparse).
const DIR = process.env.PI_MEMTRACE_DIR ?? `${process.env.HOME}/.local/share/pi-memtrace`;
const EVERY = Number(process.env.PI_MEMTRACE_EVERY ?? 0);
const TYPES_EVERY = Number(process.env.PI_MEMTRACE_TYPES_EVERY ?? 0);

type Bun = { generateHeapSnapshot?: (format: "v8") => string };

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

function line(sample: Sample): string {
	return JSON.stringify(sample);
}

function describe(sample: Sample): string[] {
	const mb = (n?: number) => (n === undefined ? "n/a" : `${(n / 1048576).toFixed(0)} MB`);
	const out = [
		`rss ${mb(sample.rss)}  anon ${mb(sample.anon)}  heapUsed ${mb(sample.heapUsed)}  heapTotal ${mb(sample.heapTotal)}  external ${mb(sample.external)}`,
	];
	for (const [name, reading] of Object.entries(sample.reporters)) {
		out.push(`  ${name}: ${"error" in reading ? `error ${reading.error}` : JSON.stringify(reading)}`);
	}
	return out;
}

export default function piMemtrace(pi: ExtensionAPI): void {
	let samples = 0;
	let currentSession = "unknown";

	pi.on("turn_end", (event: any, ctx: any) => {
		currentSession = sessionOf(ctx);
		if (EVERY <= 0 || event?.turnIndex === undefined || event.turnIndex % EVERY !== 0) return;
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
			const bun = (globalThis as { Bun?: Bun }).Bun;
			if (typeof bun?.generateHeapSnapshot !== "function") {
				ctx?.ui?.notify("heapsnap needs Bun's generateHeapSnapshot", "error");
				return;
			}
			const label = String(args ?? "").trim().replace(/[^\w-]+/g, "-") || "manual";
			const session = sessionOf(ctx);
			const started = performance.now();
			try {
				const snapshot = bun.generateHeapSnapshot("v8");
				const dir = `${DIR}/snapshots`;
				mkdirSync(dir, { recursive: true });
				const path = `${dir}/${session}-${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.heapsnapshot`;
				writeFileSync(path, snapshot);
				const ms = Math.round(performance.now() - started);
				ctx?.ui?.notify(`heap snapshot ${(snapshot.length / 1048576).toFixed(1)} MB in ${ms} ms\n${path}`, "info");
			} catch (err) {
				ctx?.ui?.notify(`heapsnap failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
