/*
 * The two consumers that read the action pack, and the anchor that pays for it.
 *
 * A consumer is policy, not plumbing: it names the questions it wants, decides
 * what the readings mean, and does something with the result. The core knows
 * none of that — it batches, groups by state, asks once, and hands each consumer
 * its own readings back.
 *
 *   permission   the blocking consumer. It asks `now`, because a permission ask
 *                has a human waiting, and its verdict comes from the pack's
 *                composition: a measured veto refuses, nothing unresolved
 *                allows, everything else defers.
 *   intent       the riding consumer. It never asks on its own: it registers
 *                interest, so when any blocking consumer asks about that action,
 *                the intent questions go out in the same flush — in their own
 *                request, because they read their own minimal state — and the
 *                readings come back as a nudge for the agent.
 *
 * That split is the whole point of the core. Answers are remembered per action
 * and per question, so a consumer that arrives after the flush is served from
 * memory: the anchor pays the latency once, and everyone else reads what it
 * bought.
 */

import {
	ACTION_PACK,
	ACTION_QUESTION_IDS,
	actionBundle,
	actionQuestionEntries,
	composeVerdict,
	denyReason,
	nudgeText,
	pendingCallLine,
	planBundle,
	readBands,
	stateBudget,
	PLAN_STATE_PROVIDER,
	STATE_PROVIDER,
	thresholdFor,
} from "./action-pack.js";
import type { ActionContext, BandReading, QuestionSpec, Signal } from "./action-pack.js";
import type { DecisionCore, Reading } from "./decision-core.js";
import type { JevConfig } from "./config.js";
import type { AuthorizerVerdict } from "./types.js";

export const PERMISSION_CONSUMER = "permission";
export const INTENT_CONSUMER = "intent";

/** Questions the permission consumer needs for its verdict: every group's worth. */
export const PERMISSION_QUESTIONS: readonly string[] = ACTION_QUESTION_IDS;

/** The plan group's questions: the ones the intent consumer reads and nudges on. */
export const INTENT_SPECS: readonly QuestionSpec[] = ACTION_PACK.filter((spec) => spec.stateProvider === PLAN_STATE_PROVIDER);

export const INTENT_QUESTIONS: readonly string[] = INTENT_SPECS.map((spec) => spec.id);

export interface Nudge {
	source: string;
	role: string;
	severity: "notice" | "warn";
	measured: boolean;
	text: string;
}

export interface PermissionOutcome {
	verdict: AuthorizerVerdict;
	bands: readonly BandReading[];
	signals: readonly Signal[];
	nudges: readonly Nudge[];
	/** Questions the ask answered from memory instead of a new request. */
	reused: readonly string[];
	requests: number;
	/** Why a request failed, when one did; the consumer decides what to say about it. */
	errors: readonly { code: string; message: string }[];
}

/** Bands for the whole pack from one core result, in pack order. */
export function bandAll(readings: readonly Reading[], config: JevConfig): BandReading[] {
	return readBands(ACTION_PACK, readings, config.thresholds, config.defaultThreshold, config.advisoryThreshold);
}

/** Bands for one state group, for a consumer that only asked for that group. */
export function bandFor(specs: readonly QuestionSpec[], readings: readonly Reading[], config: JevConfig): BandReading[] {
	return readBands(specs, readings, config.thresholds, config.defaultThreshold, config.advisoryThreshold);
}

/**
 * The pack as the core needs it: state providers and the question catalog, and
 * nothing about who reads the answers. Registering it is the first lease's job,
 * because the core is per session and the catalog is per core.
 */
export function installPack(core: DecisionCore<ActionContext>, config: JevConfig): void {
	core.registerBundle(actionBundle(stateBudget(config)));
	core.registerBundle(planBundle(stateBudget(config)));
	core.registerQuestions(actionQuestionEntries<ActionContext>());
}

/** One band as a record line: everything a threshold review needs, and no more. */
export interface BandLine {
	id: string;
	role: string;
	band: string;
	probability: number | null;
	level: number | null;
	edge: number;
	measured: boolean;
}

/** What every request records about its readings, whatever consumer paid for it. */
export interface AskInterpretation {
	bands: BandLine[];
	would: string;
	decidedBy: string | null;
	signals: string[];
}

/**
 * The per-request log detail: the bands, the pack's would-be verdict over them,
 * and what decided it. One shape for every consumer, so a record says the same
 * thing whichever consumer's ask produced it.
 */
export function interpretBands(
	readings: readonly Reading[],
	specs: readonly QuestionSpec[],
	config: JevConfig,
	callLine = "",
): AskInterpretation {
	const bands = bandFor(specs, readings, config);
	const composed = composeVerdict(bands, callLine);
	return {
		bands: bands.map((band) => ({
			id: band.id,
			role: band.role,
			band: band.band,
			probability: band.probability,
			level: band.level,
			edge: band.edge,
			measured: band.measured,
		})),
		would: composed.kind,
		decidedBy: composed.decidedBy ?? null,
		signals: composed.signals.map((signal) => signal.source),
	};
}

/** The permission consumer's verdict, and the pack's reading of the same answers. */
export async function askPermission(input: {
	core: DecisionCore<ActionContext>;
	context: ActionContext;
	actionKey: string;
	config: JevConfig;
	signal?: AbortSignal;
}): Promise<PermissionOutcome> {
	const result = await input.core.sendDecisions({
		action: input.context,
		actionKey: input.actionKey,
		consumer: PERMISSION_CONSUMER,
		questions: PERMISSION_QUESTIONS,
		...(input.signal ? { signal: input.signal } : {}),
		interpret: (readings) => interpretBands(readings, ACTION_PACK, input.config, pendingCallLine(input.context.facts)),
	});

	const bands = bandAll(result?.readings ? Object.values(result.readings) : [], input.config);
	const composed = composeVerdict(bands, pendingCallLine(input.context.facts));
	// Vetoes are what this consumer gates on, so they are what it says something
	// about; an advisory band belongs to the consumer that rides on it, and a second
	// nudge for one signal teaches the agent to ignore the channel.
	const nudges = vetoNudges(composed.signals);

	return {
		verdict: composed.kind === "deny" ? { kind: "deny", reason: composed.reason } : { kind: composed.kind },
		bands,
		signals: composed.signals,
		nudges,
		reused: result?.reused ?? [],
		requests: result?.requests.length ?? 0,
		errors: (result?.requests ?? []).flatMap((request) => (request.error ? [request.error] : [])),
	};
}

/**
 * Nudges from the composed signals, bounded per ask. The signals are the one
 * place that decides what is worth saying — an advisory band that was violated,
 * or a veto band violated with no samples behind its bar — so delivery reads them
 * rather than re-deriving the filter.
 */
export const MAX_NUDGES_PER_ASK = 2;

export function nudgesFrom(signals: readonly Signal[]): Nudge[] {
	return signals.slice(0, MAX_NUDGES_PER_ASK).map((signal) => ({
		source: signal.source,
		role: signal.role,
		severity: signal.severity,
		measured: signal.measured,
		text: nudgeText(signal),
	}));
}

/** The permission consumer's nudges: veto bands, and nothing else. */
export function vetoNudges(signals: readonly Signal[]): Nudge[] {
	return nudgesFrom(signals.filter((signal) => signal.role === "veto"));
}

/**
 * The intent consumer's nudge decision: advisory bands only, and only the ones
 * that were violated. An unclear band is the wide middle of the edge, so nudging
 * on it would fire on nearly every call.
 */
export function intentNudges(readings: readonly Reading[], config: JevConfig): Nudge[] {
	const specs = INTENT_SPECS.filter((spec) => spec.role === "advisory");
	const bands = bandFor(specs, readings, config);
	const signals: Signal[] = bands
		.filter((band) => band.band === "violated")
		.map((band) => ({
			source: band.id,
			role: band.role,
			band: "violated" as const,
			probability: band.probability,
			level: band.level,
			purpose: band.purpose,
			confident: true,
			measured: band.measured,
			severity: "warn" as const,
		}));
	return nudgesFrom(signals);
}

/** The deny text for one band, exported so a consumer can phrase its own refusal. */
export function refusalText(reading: BandReading, action?: string): string {
	return denyReason(reading, action);
}

/** The edge one question would use, for diagnostics and tests. */
export function edgeOf(spec: QuestionSpec, config: JevConfig): number | null {
	if (spec.levels) return null;
	return thresholdFor(spec.id, config.thresholds, spec.role === "veto" ? config.defaultThreshold : config.advisoryThreshold);
}

export { STATE_PROVIDER, PLAN_STATE_PROVIDER };
