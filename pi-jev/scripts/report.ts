/*
 * Read a decision log and report what the shadow judge would have done.
 *
 * This is the first half of the calibration loop: the runtime writes unlabelled
 * ask records and the permission system's own decisions label them, and this
 * prints the join. When pi-typesafe is installed it also hands each question's
 * samples to `pi-typesafe/calibrate` — the sweep, AUC, and recommendation come
 * from that package rather than from a second implementation here.
 *
 *   bun scripts/report.ts                  # the default log
 *   bun scripts/report.ts --log /tmp/x.jsonl
 *   bun scripts/report.ts --question safety.no_material_harm
 *
 * Reading is a pure function of the file: nothing here calls the judge, so a
 * report never costs a request.
 */

import { existsSync } from "node:fs";

import { defaultLogFile } from "../extensions/config.js";
import { decisionMetrics, joinRecords, samplesFrom } from "../extensions/decision-record.js";
import { parseJsonl } from "../extensions/decision-log.js";
import { readFileSync } from "node:fs";

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return undefined;
	const value = process.argv[index + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

const logPath = argument("log") ?? process.env.PI_JEV_LOG ?? defaultLogFile();
const questionFilter = argument("question");

if (!existsSync(logPath)) {
	console.log(`No decision log at ${logPath}.`);
	console.log("Shadow mode writes one only after a permission ask reaches the judge; run a session with the link named in authorizerChain first.");
	process.exit(0);
}

const records = parseJsonl(readFileSync(logPath, "utf8"));
if (records.length === 0) {
	console.log(`No records in ${logPath}.`);
	process.exit(0);
}

const asks = records.filter((record) => record.record === "ask");
const decisions = records.filter((record) => record.record === "decision");
const events = records.filter((record) => record.record === "event");
const result = joinRecords(records);
const metrics = decisionMetrics(result.joined);

console.log(`log ${logPath}`);
console.log(`${asks.length} asks, ${decisions.length} decisions, ${result.joined.length} labelled pairs`);
if (events.length > 0) {
	console.log(`${events.length} lifecycle events: ${[...new Set(events.map((event) => event.event))].join(", ")}`);
}
console.log(`${result.unmatchedAsks} asks unresolved, ${result.decisionsWithoutAsk} decisions from asks this judge never saw, ${result.unlabelled} matched without a human answer, ${result.truncatedStates} scored against a trimmed state`);

if (asks.length > 0) {
	const models = new Set(asks.map((ask) => ask.judge.model ?? "unknown"));
	const packs = new Set(asks.map((ask) => ask.judge.packVersion));
	const latencies = asks.map((ask) => ask.latencyMs).sort((a, b) => a - b);
	const percentile = (fraction: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))] ?? 0;
	const errors = asks.filter((ask) => ask.error !== null);
	// Broken down by code, because the codes mean different things: `budget` and
	// `rate` are this package's own ceilings refusing to spend, the rest are the
	// judge or the network failing.
	const errorCodes = new Map<string, number>();
	for (const ask of errors) {
		const code = ask.error?.code ?? "unknown";
		errorCodes.set(code, (errorCodes.get(code) ?? 0) + 1);
	}
	const codes = errorCodes.size === 0 ? "" : ` (${[...errorCodes].map(([code, count]) => `${code} ${count}`).join(", ")})`;
	console.log(`judge ${[...models].join(", ")} | pack ${[...packs].join(", ")} | latency p50 ${percentile(0.5)}ms p95 ${percentile(0.95)}ms | ${errors.length} failed calls${codes}`);
}

console.log(
	`\nwould allow ${metrics.wouldAllow} (${metrics.falseAllow} the human refused), would deny ${metrics.wouldDeny} (${metrics.falseDeny} the human approved), would defer ${metrics.wouldDefer}`,
);

// What the mode did with those readings. The mode decides what is returned; the
// judge's own reading is the `would`, and in a fail-open mode that reading is the
// steering signal rather than a refusal. Printing both is what makes a fail-open
// session measurable: how often did the judge object, and to what.
const byMode = new Map<string, { asks: number; would: Map<string, number>; returned: Map<string, number> }>();
for (const ask of asks) {
	const entry = byMode.get(ask.mode) ?? { asks: 0, would: new Map(), returned: new Map() };
	entry.asks++;
	entry.would.set(ask.would, (entry.would.get(ask.would) ?? 0) + 1);
	entry.returned.set(ask.verdict, (entry.returned.get(ask.verdict) ?? 0) + 1);
	byMode.set(ask.mode, entry);
}
for (const [mode, entry] of byMode) {
	const count = (map: Map<string, number>, kind: string): number => map.get(kind) ?? 0;
	const would = `would allow ${count(entry.would, "allow")}, would deny ${count(entry.would, "deny")}, would defer ${count(entry.would, "defer")}`;
	const returned = `returned ${count(entry.returned, "allow")} allow, ${count(entry.returned, "deny")} deny, ${count(entry.returned, "defer")} defer`;
	console.log(`${mode}: ${entry.asks} asks — ${would}; ${returned}`);
}

console.log(`humans approved ${metrics.approved}, refused ${metrics.denied}`);
console.log(`agreement ${metrics.agreement === null ? "n/a" : `${(metrics.agreement * 100).toFixed(1)}%`} over ${metrics.decided} decided asks`);
console.log("a veto edge is a precision problem: what matters is how many denies the human would have approved, above and below.");
console.log("an advisory edge is a recall problem: what matters is how often the nudge fires on something worth mentioning, and how often it stays quiet when it should not.");

// Signals are recorded before they are delivered, so this is the advisory
// bands' precision evidence: how often a nudge would have fired, and on what.
const signalCounts = new Map<string, { fired: number; asked: number; measured: boolean }>();
for (const ask of asks) {
	for (const band of ask.bands) {
		const entry = signalCounts.get(band.id) ?? { fired: 0, asked: 0, measured: band.measured };
		entry.asked++;
		if (band.band === "violated" && band.role === "advisory") entry.fired++;
		signalCounts.set(band.id, entry);
	}
}
if (signalCounts.size > 0) {
	console.log("\nper question: band counts, and for advisories how often a nudge would fire");
	for (const [id, entry] of signalCounts) {
		const bands = asks.flatMap((ask) => ask.bands.filter((band) => band.id === id));
		const role = bands[0]?.role ?? "?";
		const count = (band: string) => bands.filter((item) => item.band === band).length;
		const unmeasured = entry.measured ? "" : " [unmeasured]";
		const fireRate = role === "advisory" && entry.asked > 0 ? `, nudge fires on ${Math.round((entry.fired / entry.asked) * 100)}%` : "";
		console.log(`  ${id} [${role}]${unmeasured}: satisfied ${count("satisfied")}, violated ${count("violated")}, unclear ${count("unclear")}, missing ${count("missing")}${fireRate}`);
	}
}

// The objections, with what the judge read when it made them. This is the loop
// for rewording a question: the band says which one fired, the evidence says why.
const objections = asks.filter((ask) => ask.evidence !== undefined);
const objectionLimit = Number(argument("objections") ?? 0);
if (objectionLimit > 0) {
	if (objections.length === 0) {
		console.log("\nno objections with evidence in this log");
	} else {
		console.log(`\nlast ${Math.min(objectionLimit, objections.length)} of ${objections.length} objections, with the state the judge read`);
		for (const ask of objections.slice(-objectionLimit)) {
			const violated = ask.bands.filter((band) => band.band === "violated").map((band) => `${band.id}(${band.probability === null ? "level" : band.probability.toFixed(2)})`);
			console.log(`\n  ${ask.ts}  ${ask.mode}  ${violated.join(", ")}  [${ask.questions.join(", ")}]`);
			for (const item of ask.evidence ?? []) console.log(`    ${item.block}: ${item.text.replace(/\n/g, " ⏎ ")}`);
		}
	}
}

// Bands whose refused boundary is not the mirror of the satisfied one: the
// number that decides a deny, so a threshold review has to see it.
const asymmetric = new Map<string, number>();
for (const ask of asks) for (const band of ask.bands) if (typeof band.violatedAt === "number") asymmetric.set(band.id, band.violatedAt);
if (asymmetric.size > 0) {
	console.log(`\nrefused boundaries declared by the pack: ${[...asymmetric].map(([id, at]) => `${id} <= ${at}`).join(", ")}`);
}

const questions = [...new Set(asks.flatMap((ask) => ask.bands.filter((band) => band.probability !== null).map((band) => band.id)))].filter(
	(id) => questionFilter === undefined || id === questionFilter,
);

if (questions.length === 0) {
	console.log("\nNo answered questions to calibrate.");
	process.exit(0);
}

async function calibrate(samples: { label: boolean; score: number; id?: string }[], name: string): Promise<void> {
	try {
		const specifier: string = "pi-typesafe/calibrate";
		const module = (await import(specifier)) as {
			calibrate?: (name: string, samples: unknown, options?: unknown) => unknown;
			formatCalibration?: (calibration: unknown) => string;
		};
		if (typeof module.calibrate !== "function" || typeof module.formatCalibration !== "function") {
			throw new Error("calibrate is not exported");
		}
		console.log(`\n${module.formatCalibration(module.calibrate(name, samples, { minPrecision: 0.95 }))}`);
	} catch {
		console.log(`  ${samples.length} scored samples (install pi-typesafe for AUC and a threshold sweep)`);
	}
}

console.log(`\nquestions: ${questions.join(", ")}`);
for (const question of questions) {
	const samples = samplesFrom(result.joined, question);
	if (samples.length === 0) {
		console.log(`\n${question}: no scored asks`);
		continue;
	}
	const positives = samples.filter((sample) => sample.label).length;
	console.log(`\n${question}: ${samples.length} scored (${positives} approved, ${samples.length - positives} refused)`);
	await calibrate(samples, question);
}
