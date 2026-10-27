import { readFileSync } from "node:fs";
import { readReporters, type ReporterReadings } from "./registry.js";

export interface Sample {
	ts: string;
	pid: number;
	session: string;
	turn?: number;
	/** process.memoryUsage(): what the JavaScript heap and the runtime hold. */
	heapUsed: number;
	heapTotal: number;
	external: number;
	arrayBuffers: number;
	/** Resident set, and its anonymous part from /proc/self/smaps_rollup. Anonymous is the memory no file backs. */
	rss: number;
	anon?: number;
	reporters: ReporterReadings;
}

/** Reads `Rss:` and `Anonymous:` from smaps_rollup text, converted from kB to bytes. */
export function parseSmapsRollup(text: string): { rss?: number; anon?: number } {
	const kb = (key: string): number | undefined => {
		const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(text);
		return m ? Number(m[1]) * 1024 : undefined;
	};
	return { rss: kb("Rss"), anon: kb("Anonymous") };
}

export function readSmapsRollup(): { rss?: number; anon?: number } {
	try {
		return parseSmapsRollup(readFileSync("/proc/self/smaps_rollup", "utf8"));
	} catch {
		return {};
	}
}

export function takeSample(session: string, turn?: number): Sample {
	const usage = process.memoryUsage();
	const smaps = readSmapsRollup();
	return {
		ts: new Date().toISOString(),
		pid: process.pid,
		session,
		turn,
		heapUsed: usage.heapUsed,
		heapTotal: usage.heapTotal,
		external: usage.external,
		arrayBuffers: usage.arrayBuffers,
		rss: smaps.rss ?? usage.rss,
		anon: smaps.anon,
		reporters: readReporters(),
	};
}
