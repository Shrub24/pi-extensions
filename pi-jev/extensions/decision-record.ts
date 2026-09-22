/*
 * Runtime decision records, and the joins and metrics that turn them into
 * calibration input.
 *
 * Two record kinds, written as they happen and joined later by `requestId`:
 *
 *   ask       one Jev evaluation: what was asked, what came back, and what the
 *             judge would have decided. Written even when the call failed, so
 *             a deferral caused by a timeout is visible in the data.
 *   decision  the permission system's own resolution of that ask, carrying the
 *             human's answer when there was one.
 *
 * This is deliberately NOT pi-typesafe/calibrate's schema. Calibration data is
 * labelled (`ReplayCase`, `ScoredSample`); live records are unlabelled and
 * carry provenance a calibration input has no slot for — model, question-pack
 * version, state hash, latency, usage. The conversion in `samplesFrom` and
 * `replayCasesFrom` is where labels are attached, which keeps the runtime
 * record free of assumptions about when a label shows up.
 *
 * No raw state is stored unless `stateRetention` is `full`. The hash alone is
 * enough to tell that two asks shared a state, and enough to join records; a
 * calibration run that needs to re-score states opts into storing them.
 */

import type { JevUsage } from "./types.js";
import type { BandReading } from "./action-pack.js";
import type { CoreRecordContext } from "./decision-core.js";

export const RECORD_VERSION = 1;

/** Every record kind the log may hold, for a reader deciding what to keep. */
export const RECORD_KINDS: readonly string[] = ["ask", "decision", "event"];

/** Every band a question can land in, for a reader that aggregates them. */
export const BANDS: readonly string[] = ["satisfied", "violated", "unclear", "missing"];

export interface AskBandRecord {
	id: string;
	/** `veto` bands refuse the action when violated; `advisory` bands nudge. */
	role: string;
	band: string;
	probability: number | null;
	/** Set for a graded question; null for a yes/no one. */
	level: number | null;
	/** The noul band edge, or null for a graded question. */
	edge: number | null;
	/** False when the question has no labelled samples behind its bar yet. */
	measured: boolean;
}

/**
 * A nudge the pack raised. Recorded in both modes; delivered only when the
 * consumer supplies a delivery seam, so an advisory band proves its precision on
 * the log before it spends the agent's attention.
 */
export interface AskSignalRecord {
	source: string;
	role: string;
	severity: string;
	measured: boolean;
	text: string;
}

export interface AskRecord {
	record: "ask";
	version: number;
	ts: string;
	requestId: string;
	/** The core request this record came from (action:group:chunk). */
	requestKey: string;
	mode: "shadow" | "advisory" | "live";
	judge: {
		model: string | null;
		packVersion: string;
		stateVersion: string;
	};
	/** What the subject was: "call", "child", "session". Answers "about what?". */
	subjectKind: string;
	/**
	 * The context blocks this request carried, in build order. The names say what
	 * the judge could see; the hashes say whether that context had changed since a
	 * previous ask; the truncations say what was cut to fit. A report can compare
	 * two asks about the same subject by diffing these.
	 */
	blocks: { id: string; hash: string; chars: number; truncated: string[] }[];
	stateChars: number;
	/** Present only when state retention is `full`. */
	state?: unknown;
	bands: AskBandRecord[];
	/**
	 * What the judge read, kept only for records where a question was violated.
	 * Present to make a false alarm diagnosable: without it a hash-only log says
	 * an objection happened and nothing about what produced it.
	 */
	evidence?: { block: string; text: string }[];
	signals: AskSignalRecord[];
	/** The question ids this request carried, in the order they were sent. */
	questions: string[];
	/** What the judge would have decided, in either mode. */
	would: "allow" | "deny" | "defer";
	/** What it actually returned to the permission chain. */
	verdict: "allow" | "deny" | "defer";
	reason?: string;
	latencyMs: number;
	usage: JevUsage | null;
	error: { code: string; message: string } | null;
}

export interface DecisionRecord {
	record: "decision";
	version: number;
	ts: string;
	requestId: string;
	resolution: string;
	result: "allow" | "deny";
	surface: string;
	value: string;
	origin: string | null;
	matchedPattern: string | null;
	agentName: string | null;
	forwarded: boolean;
}

/**
 * A lifecycle fact about the link itself — registered, unregistered — written so
 * the most fragile part of the wiring is verifiable from the log alone. It
 * carries no verdict and no answers, and the join ignores it.
 */
export interface EventRecord {
	record: "event";
	version: number;
	ts: string;
	event: string;
	detail: Record<string, unknown>;
}

export type JevRecord = AskRecord | DecisionRecord | EventRecord;

export interface AskRecordOptions {
	ts: string;
	mode: "shadow" | "advisory" | "live";
	model: string;
	packVersion: string;
	stateVersion: string;
}

/**
 * One ask record per request the core ran. The core owns the facts — which
 * questions went out, what came back, what it cost — and the asking consumer
 * owns the reading of them, which is why the interpretation arrives already
 * computed and is stored verbatim.
 */
/**
 * The state behind an objection, bounded.
 *
 * A hash-only log answers "did the judge object" but not "to what", which is the
 * question that has to be answered to reword a question or fix a block. So when a
 * band is violated — and only then — each block the request sent is kept as a
 * short excerpt. Bounded twice: per block, and across the record.
 */
export function objectionEvidence(state: unknown, blocks: readonly { id: string }[], perBlock = 300, total = 1200): { block: string; text: string }[] {
	if (state === null || typeof state !== "object") return [];
	const record = state as Record<string, unknown>;
	const evidence: { block: string; text: string }[] = [];
	let spent = 0;
	for (const block of blocks) {
		if (spent >= total) break;
		const value = record[block.id];
		if (value === undefined) continue;
		let text: string;
		try {
			text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
		} catch {
			continue;
		}
		if (text === "") continue;
		const room = Math.min(perBlock, total - spent);
		const excerpt = text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`;
		evidence.push({ block: block.id, text: excerpt });
		spent += excerpt.length;
	}
	return evidence;
}

export function askRecordFromCore(context: CoreRecordContext, options: AskRecordOptions): AskRecord {
	const interpreted = (context.interpreted ?? {}) as {
		bands?: unknown;
		would?: string;
		verdict?: string;
		decidedBy?: string | null;
		signals?: string[];
	};
	const bands = Array.isArray(interpreted.bands) ? (interpreted.bands as AskBandRecord[]) : [];
	const failed = context.request.readings.some((reading) => !reading.ok);
	return {
		record: "ask",
		version: RECORD_VERSION,
		ts: options.ts,
		requestId: context.subject.correlationId ?? context.subjectKey,
		requestKey: context.request.id,
		mode: options.mode,
		judge: {
			model: context.request.model ?? options.model,
			packVersion: options.packVersion,
			stateVersion: options.stateVersion,
		},
		subjectKind: context.subject.kind,
		blocks: context.request.blocks.map((block) => ({ id: block.id, hash: block.hash, chars: block.chars, truncated: [...block.truncated] })),
		stateChars: context.request.chars,
		bands,
		signals: (failed ? [] : (interpreted.signals ?? [])).map((source) => ({
			source,
			role: "advisory",
			severity: "warn",
			measured: true,
			text: "",
		})),
		questions: [...context.request.questions],
		// Only an objection keeps the state: a log of every state is a transcript,
		// and a log of the ones that went wrong is a diagnosis.
		...(bands.some((band) => band.band === "violated") ? { evidence: objectionEvidence(context.request.state, context.request.blocks) } : {}),
		would: interpreted.would ?? "defer",
		verdict: interpreted.verdict ?? "defer",
		latencyMs: context.request.latencyMs,
		usage: context.request.usage,
		error: context.request.error,
	};
}

export function bandRecords(readings: readonly BandReading[]): AskBandRecord[] {
	return readings.map((reading) => ({
		id: reading.id,
		band: reading.band,
		probability: reading.probability,
		threshold: reading.threshold,
	}));
}

// ── labels ─────────────────────────────────────────────────────────────────

/**
 * The human's answer, when the resolution carries one.
 *
 * Approvals and refusals by policy at this point in the chain are excluded on
 * purpose: they mean the earlier gate already decided, so the record says
 * nothing about what a human would have said about the action itself.
 * `confirmation_unavailable` and `gate_error` are excluded for the same reason
 * — nobody judged the action, so there is no label to attach.
 */
export function labelOf(resolution: string): boolean | undefined {
	switch (resolution) {
		case "user_approved":
		case "user_approved_for_session":
		case "authorizer_allowed":
		case "auto_approved":
			return true;
		case "user_denied":
		case "authorizer_denied":
			return false;
		default:
			return undefined;
	}
}

export interface JoinedRecord {
	ask: AskRecord;
	decision: DecisionRecord;
	label: boolean;
}

export interface JoinResult {
	joined: JoinedRecord[];
	/** Asks with no decision yet: still pending, or decided after the window. */
	unmatchedAsks: number;
	/** Decisions for asks this judge never saw (the link was not consulted). */
	decisionsWithoutAsk: number;
	/** Matched, but the resolution carries no human answer. */
	unlabelled: number;
	/** Asks whose state was trimmed before scoring; their scores are not comparable. */
	truncatedStates: number;
}

export function joinRecords(records: readonly JevRecord[]): JoinResult {
	const asks = records.filter((record): record is AskRecord => record.record === "ask");
	const decisions = new Map<string, DecisionRecord>();
	for (const record of records) {
		if (record.record === "decision") decisions.set(record.requestId, record);
	}

	const joined: JoinedRecord[] = [];
	let unlabelled = 0;
	let truncatedStates = 0;
	const matched = new Set<string>();
	for (const ask of asks) {
		const decision = decisions.get(ask.requestId);
		if (!decision) continue;
		matched.add(ask.requestId);
		if (ask.blocks.some((block) => block.truncated.length > 0)) truncatedStates++;
		const label = labelOf(decision.resolution);
		if (label === undefined) {
			unlabelled++;
			continue;
		}
		joined.push({ ask, decision, label });
	}

	return {
		joined,
		unmatchedAsks: asks.length - matched.size,
		decisionsWithoutAsk: decisions.size - matched.size,
		unlabelled,
		truncatedStates,
	};
}

// ── metrics ────────────────────────────────────────────────────────────────

export interface DecisionMetrics {
	labelled: number;
	approved: number;
	denied: number;
	wouldAllow: number;
	wouldDeny: number;
	wouldDefer: number;
	/** Would have run an action the human refused. The expensive error. */
	falseAllow: number;
	/** Would have refused an action the human approved. The annoying error. */
	falseDeny: number;
	/** Deferred and the human approved: recall the judge never got the chance to show. */
	deferApproved: number;
	deferDenied: number;
	/** Asks the judge answered allow or deny; deferrals are abstentions. */
	decided: number;
	/**
	 * Accuracy over `decided` only. Counting abstentions as misses would let this
	 * number improve by abstaining more, which is not a property of a judge.
	 */
	agreement: number | null;
}

export function decisionMetrics(joined: readonly JoinedRecord[]): DecisionMetrics {
	const metrics: DecisionMetrics = {
		labelled: joined.length,
		approved: 0,
		denied: 0,
		wouldAllow: 0,
		wouldDeny: 0,
		wouldDefer: 0,
		falseAllow: 0,
		falseDeny: 0,
		deferApproved: 0,
		deferDenied: 0,
		decided: 0,
		agreement: null,
	};
	let agreed = 0;
	for (const { ask, label } of joined) {
		if (label) metrics.approved++;
		else metrics.denied++;
		if (ask.would === "allow") {
			metrics.wouldAllow++;
			metrics.decided++;
			if (label) agreed++;
			else metrics.falseAllow++;
		} else if (ask.would === "deny") {
			metrics.wouldDeny++;
			metrics.decided++;
			if (!label) agreed++;
			else metrics.falseDeny++;
		} else {
			metrics.wouldDefer++;
			if (label) metrics.deferApproved++;
			else metrics.deferDenied++;
		}
	}
	metrics.agreement = metrics.decided > 0 ? agreed / metrics.decided : null;
	return metrics;
}

/**
 * One question's probability against the human's answer, in the shape
 * `pi-typesafe/calibrate` scores: `label` is the truth, `score` is the number
 * the question produced. Asks with no answer for the question, or no retained
 * state, are skipped.
 */
export function samplesFrom(
	joined: readonly JoinedRecord[],
	questionId: string,
): { label: boolean; score: number; id: string }[] {
	const samples: { label: boolean; score: number; id: string }[] = [];
	for (const { ask, label } of joined) {
		const band = ask.bands.find((entry) => entry.id === questionId);
		if (!band || band.probability === null) continue;
		samples.push({ label, score: band.probability, id: ask.requestId });
	}
	return samples;
}

/**
 * Replay cases for a scorer that re-runs the question against the stored state.
 * Only record sets written with `stateRetention: "full"` produce any.
 */
export function replayCasesFrom(
	joined: readonly JoinedRecord[],
): { id: string; label: boolean; data: { state: unknown; question: string } }[] {
	const cases: { id: string; label: boolean; data: { state: unknown; question: string } }[] = [];
	for (const { ask, label } of joined) {
		if (ask.state === undefined) continue;
		for (const band of ask.bands) {
			cases.push({
				id: `${ask.requestId}:${band.id}`,
				label,
				data: { state: ask.state, question: band.id },
			});
		}
	}
	return cases;
}
