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
	actionBlocks,
	actionQuestionEntries,
	composeVerdict,
	denyReason,
	nudgeText,
	pendingCallLine,
	readBands,
	stateBudget,
	BLOCK_PLAN,
	SUBAGENT_PACK,
	thresholdFor,
} from "./action-pack.js";
import type { ActionContext, BandReading, QuestionSpec, Signal } from "./action-pack.js";
import type { DecisionCore, Reading, Subject } from "./decision-core.js";
import type { JevConfig } from "./config.js";
import type { AuthorizerVerdict, JevQuestion } from "./types.js";
import { TOOL_CHOICE_QUESTIONS, toolChoiceBand } from "./tool-choice.js";
import type { ToolPolicy } from "./tool-choice.js";

export const PERMISSION_CONSUMER = "permission";
export const INTENT_CONSUMER = "intent";
export const SUBAGENT_CONSUMER = "subagent";
export const TOOL_CHOICE_CONSUMER = "tool-choice";

/**
 * The surface a check-in's synthetic action carries, so the consumer can tell a
 * timer-driven read from a forwarded ask. The two want different delivery: an
 * ask happens while a human is already waiting and its finding rides the gate as
 * a steer, while a check-in is the only thing that will speak to an idle
 * orchestrator — its finding must be the wake itself.
 */
export const CHECK_IN_SURFACE = "subagent_check_in";

/** The tool questions, registered wherever the pack is, asked by whichever flush runs. */
export const TOOL_QUESTION_IDS: readonly string[] = TOOL_CHOICE_QUESTIONS.map((spec) => spec.id);

/**
 * Questions the permission consumer asks, and so the questions a gate's flush
 * carries: the whole pack, plus the tool questions. The tool pair is asked for
 * the record rather than the verdict — a gate is the one place every call in a
 * session passes through, so it is where the tool policy's judgement piles up —
 * and it cannot refuse anything, because both are advisory.
 */
export const PERMISSION_QUESTIONS: readonly string[] = [...ACTION_QUESTION_IDS, ...TOOL_QUESTION_IDS];

/** The plan group's questions: the ones the intent consumer reads and nudges on. */
export const INTENT_SPECS: readonly QuestionSpec[] = ACTION_PACK.filter((spec) => spec.blocks.includes(BLOCK_PLAN));

export const INTENT_QUESTIONS: readonly string[] = INTENT_SPECS.map((spec) => spec.id);

/** The subagent group's questions: the ones the orchestrator reads and steers on. */
export const SUBAGENT_SPECS: readonly QuestionSpec[] = SUBAGENT_PACK;

export const SUBAGENT_QUESTIONS: readonly string[] = SUBAGENT_SPECS.map((spec) => spec.id);

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

/**
 * The tool questions' bands, from the same readings, stated in the pack's shape
 * so one record holds every reading a flush produced. A choice question's
 * probability is the margin between the judge's pick and the runner-up, and its
 * band is the policy's own reading: violated when the judge endorses the policy's
 * alternative over the tool this call used.
 */
export function toolBands(readings: readonly Reading[], preferredTool: string | null, policy: ToolPolicy): BandReading[] {
	const choice = readings.find((reading) => reading.question === "tool.choice");
	const detail = choice?.detail as { choice?: string; margin?: number } | undefined;
	const band = toolChoiceBand(detail && typeof detail.choice === "string" ? { choice: detail.choice, margin: detail.margin ?? 0 } : undefined, preferredTool, policy);
	return [
		{
			id: band.id,
			role: band.role,
			kind: "choice",
			band: band.band,
			probability: band.margin,
			level: null,
			edge: policy.margin,
			purpose: band.purpose,
			measured: band.measured,
		},
	];
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
	// Every block the pack defines is registered once per core; a question names
	// the ones it reads, and a flush builds only those.
	for (const block of actionBlocks(stateBudget(config))) core.registerBlock(block);
	core.registerQuestions(actionQuestionEntries<ActionContext>());
	core.registerQuestions(
		TOOL_CHOICE_QUESTIONS.map((spec) => ({
			id: spec.id,
			blocks: spec.blocks,
			owner: TOOL_CHOICE_CONSUMER,
			meta: { role: spec.role, purpose: spec.purpose, measured: spec.measured },
			applies: (context: ActionContext) => spec.applies(context.facts),
			question: (context: ActionContext) => spec.question(context.facts) ?? undefined,
			read: (answer) => {
				const read = spec.read(answer);
				return read ? { probability: read.margin, level: null, detail: { choice: read.choice, margin: read.margin } } : undefined;
			},
		})),
	);
	core.registerQuestions(
		SUBAGENT_PACK.map((spec) => ({
			id: spec.id,
			blocks: spec.blocks,
			owner: SUBAGENT_CONSUMER,
			meta: { role: spec.role, purpose: spec.purpose, measured: spec.measured },
			applies: (context: ActionContext) => spec.applies(context.facts),
			question: (context: ActionContext) => spec.question(context.facts) ?? ({ type: "noul" } as JevQuestion),
			read: (answer) => {
				const read = spec.read(answer);
				return read ? { probability: read.probability, level: read.level } : undefined;
			},
		})),
	);
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
	/** What this mode actually returned to the permission chain. */
	verdict?: string;
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
	tool?: { policy: ToolPolicy; preferredTool: string | null },
): AskInterpretation {
	// Only the questions this ask actually carried: a question nobody asked is not
	// a missing answer, and recording it as one would poison every tally of how
	// often a question fails to answer.
	const asked = specs.filter((spec) => readings.some((reading) => reading.question === spec.id));
	const bands = [...bandFor(asked, readings, config), ...(tool ? toolBands(readings, tool.preferredTool, tool.policy) : [])];
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
		verdict: returnedKind(config.mode, composed.kind),
		decidedBy: composed.decidedBy ?? null,
		signals: composed.signals.map((signal) => signal.source),
	};
}

/**
 * What a mode actually returns for a would-be verdict. One mapping, used by the
 * record and the runtime, so a log row's `would` and `verdict` can never say
 * different things about the same mode.
 */
export function returnedKind(mode: JevConfig["mode"], would: string): string {
	if (mode === "live") return would;
	if (mode === "advisory") return "allow";
	return "defer";
}

/** The same mapping as a verdict object, keeping a live mode's deny reason. */
export function returnedVerdict(mode: JevConfig["mode"], would: AuthorizerVerdict): AuthorizerVerdict {
	const kind = returnedKind(mode, would.kind);
	return kind === would.kind ? would : ({ kind } as AuthorizerVerdict);
}

/** The permission consumer's verdict, and the pack's reading of the same answers. */
export async function askPermission(input: {
	core: DecisionCore<ActionContext>;
	context: ActionContext;
	subject: Subject;
	config: JevConfig;
	/** The user's tool policy, when one was loaded: the tool band reads it. */
	policy?: ToolPolicy;
	signal?: AbortSignal;
}): Promise<PermissionOutcome> {
	const callLine = pendingCallLine(input.context.facts);
	// The tool questions ride this ask whether or not the intent entry is loaded,
	// so a gate's record carries the policy's own reading of the call.
	const tool = input.policy ? { policy: input.policy, preferredTool: input.context.facts.preferredTool ?? null } : undefined;
	const result = await input.core.sendDecisions({
		subject: input.subject,
		input: input.context,
		consumer: PERMISSION_CONSUMER,
		questions: PERMISSION_QUESTIONS,
		...(input.signal ? { signal: input.signal } : {}),
		interpret: (readings) => interpretBands(readings, ACTION_PACK, input.config, callLine, tool),
	});

	const raw = result?.readings ? Object.values(result.readings) : [];
	const bands = [...bandAll(raw, input.config), ...(tool ? toolBands(raw, tool.preferredTool, tool.policy) : [])];
	const composed = composeVerdict(bands, callLine);
	const nudges = permissionNudges(composed.signals);

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

/**
 * The permission consumer's nudges: its own bands, veto or advisory alike — a
 * question nobody else rides still has to be able to speak, and a conflict with
 * the user's instruction is exactly the kind of advisory this consumer owns.
 * Signals the intent entry delivers (plan, scope, and the tool pair, which also
 * loads a policy-named skill) are left to it: a second nudge for one signal
 * teaches the agent to ignore the channel.
 */
export function permissionNudges(signals: readonly Signal[]): Nudge[] {
	const owned = new Set<string>([...INTENT_QUESTIONS, ...TOOL_QUESTION_IDS]);
	return nudgesFrom(signals.filter((signal) => !owned.has(signal.source)));
}

/**
 * The orchestrator's nudges: work that departed from its instructions or its
 * role. These are steering sentences for the orchestrator, not refusals — the
 * permission system keeps authority, and the orchestrator is the party that can
 * redirect or retire a child.
 */
export function subagentNudges(readings: readonly Reading[], config: JevConfig): Nudge[] {
	const specs = SUBAGENT_SPECS;
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

/**
 * Register the orchestrator's consumer on a core, once.
 *
 * Both entries want it, and they may share one core. `subscriptions` is keyed by
 * id, so a second registration would overwrite the first — and the two are not
 * interchangeable: the permission entry's is what joins a forwarded ask's flush,
 * while the intent entry's is what a check-in send reports back to. One
 * registration carries both behaviors, guarded per core so whichever entry gets
 * there first is the only one to register.
 *
 * `onViolation` is called for each violated band the check-in should count; the
 * nudge itself goes through `deliver` when the operator has steers on.
 */
const subagentRegistered = new WeakSet<object>();

export function registerSubagentConsumer(
	core: DecisionCore<ActionContext>,
	input: {
		config: JevConfig;
		deliver?: (nudges: readonly Nudge[]) => void;
		/** Every violated band, with the input that produced it. Never gated by the steer switch. */
		onViolation?: (nudges: readonly Nudge[], context: ActionContext) => void;
	},
): void {
	if (subagentRegistered.has(core as object)) return;
	subagentRegistered.add(core as object);
	core.registerConsumer({
		id: SUBAGENT_CONSUMER,
		questions: SUBAGENT_QUESTIONS,
		// Standing interest only where a child genuinely exists: a forwarded ask.
		// The check-in names its own questions on the send, so it does not need
		// standing interest and must not add the group to some other gate's ask.
		applies: (context: ActionContext) => context.facts.forwarded,
		interpret: (readings) => interpretBands(readings, SUBAGENT_SPECS, input.config),
		onAnswers: (delivery) => {
			const nudges = subagentNudges(delivery.readings, input.config);
			if (nudges.length === 0) return;
			// Reported whoever is watching: a check-in's wake decision is about
			// what the judge found, not about whether steers are switched on.
			input.onViolation?.(nudges, delivery.input);
			if (!input.config.deliverSubagentNudges) return;
			// A check-in delivers its own finding, with the wake options an idle
			// orchestrator needs; a steer here would queue unread instead.
			if (delivery.input.facts.surface === CHECK_IN_SURFACE) return;
			input.deliver?.(nudges);
		},
	});
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

