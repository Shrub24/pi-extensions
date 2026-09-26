/*
 * The intent consumer: what the agent said it would do, against what it is doing.
 *
 * This is the first consumer that is not a gate. It has no blocking seam and no
 * verdict — it watches tool calls, and when a call contradicts the plan the agent
 * stated a moment earlier, it says so. Two consequences follow, and both are
 * deliberate:
 *
 *   It queues rather than sends. Asking on every tool call would spend a request
 *   per call against pi-typesafe's own request cap. A queue entry costs nothing,
 *   and the questions go out with the next flush — the permission gate's ask for a
 *   gated call, or the turn boundary otherwise — so a call nothing gated is read
 *   once per turn at most.
 *
 *   Its nudge can be late. A boundary flush happens after the turn, too late to
 *   steer that turn; a gated call is nudged while the human is already being
 *   asked. `queueFlushGapMs` is the middle ground for a host that wants a bounded
 *   wait instead. The reading is recorded either way, which is what the edge gets
 *   measured from — and what decides whether this consumer ever earns `live`.
 *
 * It is a separate entry point from the permission link on purpose: a consumer is
 * policy, so it loads, registers, and fails on its own. What it shares with the
 * permission link is the core, by way of the registry, which is what keeps one
 * action's questions in one request.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ActionAskFacts, ActionContext } from "./action-pack.js";
import { MAX_QUESTIONS_PER_REQUEST, readSettingsFile, resolveConfig } from "./config.js";
import type { JevConfig } from "./config.js";
import { configConversation, sessionSources, skillLoaded, toolboxLines } from "./conversation.js";
import type { Nudge } from "./consumers.js";
import { budgetFrom, createJevClient } from "./jev.js";
import type { JevClient } from "./jev.js";
import type { DecisionLog } from "./decision-log.js";
import { createNudgeDelivery, deliverNudges } from "./nudges.js";
import type { NudgeDelivery } from "./nudges.js";
import { checkInAction, checkInSubjectKey, checkInIntervalMs, combineFindings, newNotices, noticeNeedsAttention, CHECK_IN_QUESTIONS } from "./check-in.js";
import { INTENT_CONSUMER, INTENT_QUESTIONS, INTENT_SPECS, SUBAGENT_CONSUMER, installPack, intentNudges, interpretBands, registerSubagentConsumer } from "./consumers.js";
import { acquireCore, acquireLog, logSink } from "./registry.js";
import type { CoreLease } from "./registry.js";
import { skillLoadText, TOOL_CHOICE_QUESTIONS, toolAvoidNudgeText, toolChoiceBand, toolChoiceNudgeText } from "./tool-choice.js";
import { callSubject, conversationOf } from "./action-pack.js";
import type { ToolPolicy } from "./tool-choice.js";
import { loadToolPolicy, applyGuidance } from "./tool-policy.js";

export interface IntentDeps {
	config?: JevConfig;
	log?: DecisionLog;
	jev?: JevClient;
	now?: () => Date;
	policy?: ToolPolicy;
}

/** The tool call, structurally: the entry point has the host's own type. */
export interface ToolCallLike {
	toolName?: unknown;
	toolCallId?: unknown;
	input?: unknown;
}

/** Field names tools use for the one string that decides what a call does. */
const VALUE_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "target", "prompt", "skill"] as const;

function stringField(input: Record<string, unknown>, keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

/**
 * What the call changes, when the tool reports it, in one flat line.
 *
 * `value` names the target — which is what the policy matches on — and this is
 * the content, because a question about whether a call does what the plan
 * describes cannot be answered from a path. Phrased as replacements rather than
 * a diff: state fields are single lines by construction (`truncate` flattens
 * whitespace), and `- old + new` flattened is ambiguous where `replace "old"
 * with "new"` is not. Null for tools that report no change, such as a shell
 * command.
 */
export function changeSummary(input: unknown, max = 400): string | null {
	if (input === null || typeof input !== "object") return null;
	const record = input as Record<string, unknown>;
	const parts: string[] = [];
	const pair = (oldText: unknown, newText: unknown): void => {
		const before = typeof oldText === "string" ? oldText.trim() : "";
		const after = typeof newText === "string" ? newText.trim() : "";
		if (before !== "" && after !== "") parts.push(`replace "${before}" with "${after}"`);
		else if (after !== "") parts.push(`insert "${after}"`);
		else if (before !== "") parts.push(`remove "${before}"`);
	};
	pair(record.oldText, record.newText);
	if (Array.isArray(record.edits)) {
		for (const edit of record.edits.slice(0, 3)) {
			if (edit !== null && typeof edit === "object") {
				const hunk = edit as Record<string, unknown>;
				pair(hunk.oldText, hunk.newText);
			}
		}
	}
	if (typeof record.content === "string" && record.content.trim() !== "") parts.push(`write "${record.content.trim()}"`);
	if (parts.length === 0) return null;
	const joined = parts.join("; ");
	return joined.length <= max ? joined : `${joined.slice(0, Math.max(1, max - 1))}…`;
}

/** The decision-relevant part of a tool call's arguments, in the pack's terms. */
export function callValue(input: unknown): string {
	if (typeof input === "string") return input;
	if (input === null || typeof input !== "object") return "";
	const record = input as Record<string, unknown>;
	const named = stringField(record, VALUE_KEYS);
	if (named !== null) return named;
	try {
		return JSON.stringify(record) ?? "";
	} catch {
		return "";
	}
}

/**
 * The facts for a call that reached no gate.
 *
 * `policy` says so rather than guessing: an ungated call is not a policy allow,
 * and a judge told otherwise would read permission where there was none.
 */
export function toolCallFacts(event: ToolCallLike, fallbackId: string, policy?: ToolPolicy): ActionAskFacts {
	const toolName = typeof event.toolName === "string" && event.toolName !== "" ? event.toolName : "unknown";
	const requestId = typeof event.toolCallId === "string" && event.toolCallId !== "" ? event.toolCallId : fallbackId;
	const input = (event.input ?? {}) as Record<string, unknown>;
	const value = callValue(event.input);
	const facts: ActionAskFacts = {
		requestId,
		toolCallId: requestId,
		surface: "tool_call",
		kind: "tool",
		value,
		change: changeSummary(event.input),
		intent: stringField(input, ["intent"]),
		toolName,
		invokedToolName: null,
		matchedPattern: null,
		commandContext: null,
		executedUnit: null,
		agentName: null,
		forwarded: false,
		policy: { surfaceState: "ungated", toolState: null },
		path: stringField(input, ["path", "file_path", "filePath"]),
		preferredTool: null,
		preferredReason: null,
		rankedAlternatives: [],
		policyIntent: null,
		policyDirectives: [],
		policyAvoid: null,
	};
	return applyGuidance(facts, policy);
}

/** The plan group's interpretation, for a flush this consumer queued. */
export function interpretIntent(
	readings: Parameters<typeof interpretBands>[0],
	config: JevConfig,
	callLine = "",
	tool?: { policy: ToolPolicy; preferredTool: string | null },
) {
	return interpretBands(readings, INTENT_SPECS, config, callLine, tool);
}

/** The second consumer this entry runs: tool choice against the user's policy. */
export const TOOL_CHOICE_CONSUMER = "tool-choice";

export function wireIntentConsumer(pi: ExtensionAPI, deps: IntentDeps = {}): void {
	const config = deps.config ?? resolveConfig(readSettingsFile());
	// The log and the core are process-wide, so a second entry joins rather than
	// opens a second copy of either.
	const logLease = deps.log ? undefined : acquireLog(config.logFile);
	const log = deps.log ?? logLease?.log;
	const now = deps.now ?? (() => new Date());
	// Created on first use: an entry that joins an existing core never builds a
	// second judge client, and so never doubles the per-client request cap.
	let jev: JevClient | undefined = deps.jev;

	let ctx: ExtensionContext | undefined;
	let sessionId: string | null = null;
	let lease: CoreLease | undefined;
	let calls = 0;
	let checkInTimer: ReturnType<typeof setTimeout> | undefined;
	/** Notices already asked about, so a scan reads each one once. */
	const seenNotices = new Set<string>();
	const reported = new Set<string>();
	const loaded = deps.policy ? { policy: deps.policy } : loadToolPolicy();
	const toolPolicy: ToolPolicy = loaded.policy;

	const report = (problem: string): void => {
		if (reported.has(problem)) return;
		reported.add(problem);
		try {
			(ctx?.ui as { notify?: (message: string, level?: string) => void } | undefined)?.notify?.(problem, "warning");
		} catch {
			// A notice that cannot be shown changes nothing.
		}
	};

	const deliver: NudgeDelivery | undefined =
		config.deliverNudges || config.deliverIntentNudges || config.deliverSubagentNudges
			? createNudgeDelivery(pi, () => lease?.core, { cooldownMs: config.nudgeCooldownMs })
			: undefined;

	/** Collected by the shared subagent consumer while a check-in runs. */
	let checkInFindings: Nudge[] = [];

	pi.on("session_start", (_event, context) => {
		ctx = context;
		if (loaded.problem) report(loaded.problem);
		try {
			sessionId = (context.sessionManager as { getSessionId?: () => string | undefined }).getSessionId?.() ?? null;
		} catch {
			sessionId = null;
		}
		if (sessionId === null || lease) return;
		const client = (jev ??= deps.jev ?? createJevClient({ model: config.model, timeoutMs: config.timeoutMs, ...budgetFrom(config), ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }) }));
		lease = acquireCore({
			sessionId,
			options: {
				ask: (state, questions, askOptions) => client.ask(state, questions, askOptions),
				...(log ? { record: logSink({ log, now, mode: config.mode, model: client.model }) } : {}),
				maxQuestionsPerRequest: MAX_QUESTIONS_PER_REQUEST,
				flushGapMs: config.queueFlushGapMs,
				schedule: (run, ms) => {
					const timer = setTimeout(run, ms);
					return () => clearTimeout(timer);
				},
			},
			setup: (core) => installPack(core, config),
		});
		// The entry that supplied the judge reports on it; a second one joining
		// would only repeat the same warning in the same session.
		if (lease.created) {
			void client
				.probe()
				.then(() => {
					const unavailable = client.unavailable();
					if (unavailable) report(`pi-jev: ${unavailable} Intent nudges are off.`);
					return unavailable ? undefined : client.warm();
				});
		}
		// One interpretation, registered by both consumers: the record then carries
		// the plan bands and the tool band together, and a boundary flush — whose
		// owners are both of them — still has a reading to write down.
		const sharedInterpret = (readings: Parameters<typeof interpretBands>[0], input?: ActionContext) =>
			interpretIntent(readings, config, "", { policy: toolPolicy, preferredTool: input?.facts.preferredTool ?? null });

		lease.core.registerConsumer({
			id: INTENT_CONSUMER,
			questions: INTENT_QUESTIONS,
			// A plan question with no plan in the state is unanswerable, so a call
			// with nothing stated ahead of it is dropped from the flush entirely.
			applies: (context: ActionContext) => conversationOf(context).declaredPlan !== null,
			// The tool band rides this record too: an ungated call never passes the
			// gate, so the turn boundary is the only place its tool reading is
			// written down.
			interpret: sharedInterpret,
			onAnswers: (delivery) => {
				if (!deliver) return;
				const nudges = intentNudges(delivery.readings, config);
				if (nudges.length > 0) deliver(nudges, delivery.input.facts.toolCallId ?? delivery.input.facts.requestId);
			},
		});

		// The orchestrator's steering consumer, shared with the permission entry:
		// whichever lands first registers it, and this entry's `onViolation` is
		// what the check-in's wake decision reads.
		registerSubagentConsumer(lease.core, {
			config,
			...(deliver ? { deliver } : {}),
			onViolation: (nudges) => {
				checkInFindings.push(...nudges);
			},
		});

		// The tool-choice consumer rides the same core: it queues on every tool
		// call whose policy names an alternative, and its readings come back with
		// whatever flush answers them. Its nudge text names the policy's reason,
		// because "the policy prefers X" without why teaches nothing.
		// The questions themselves are registered with the pack (`installPack`), so a
		// gate's flush carries them even when this entry is not loaded; what this
		// entry adds is the delivery — who reads the answers and what they say.
		lease.core.registerConsumer({
			id: TOOL_CHOICE_CONSUMER,
			questions: ["tool.choice", "tool.fit"],
			applies: (context: ActionContext) => context.facts.preferredTool != null || context.facts.policyAvoid != null,
			interpret: sharedInterpret,
			onAnswers: (delivery) => {
				if (!deliver) return;
				const nudges: Nudge[] = [];
				// The avoid warning first: it is the stronger claim — the policy says
				// this tool is wrong for such calls — and it is the one the agent can
				// act on without knowing what the alternative would have been.
				if (delivery.input.facts.policyAvoid) {
					const fitReading = delivery.readings.find((reading) => reading.question === "tool.fit");
					// The avoid nudge needs the judge to agree the fit is poor; a fit
					// reading that is missing or confident-true stays quiet. The edge
					// is the policy's avoidMargin: how clearly the judge must disagree
					// with the call before the policy's warning becomes a sentence.
					const probability = fitReading?.probability;
					if (typeof probability === "number" && probability <= 1 - (toolPolicy.avoidMargin ?? toolPolicy.margin)) {
						nudges.push({ source: "tool.fit", finding: "policy.avoid", role: "advisory", severity: "warn", measured: false, text: toolAvoidNudgeText(delivery.input.facts.value, delivery.input.facts.policyAvoid.reason) });
					}
				}
				const reading = delivery.readings.find((reading) => reading.question === "tool.choice");
				const detail = reading?.detail as { choice?: string; margin?: number } | undefined;
				const band = toolChoiceBand(detail && detail.choice !== undefined ? { choice: detail.choice, margin: detail.margin ?? 0 } : undefined, delivery.input.facts.preferredTool, toolPolicy);
				if (band.band === "violated") {
					// The policy's own reason is the teaching part of the sentence, and the
					// action the flush judged still carries it.
					const preferredReason = delivery.input?.facts.preferredReason ?? null;
					const skill = delivery.input.facts.policySkill ?? null;
					nudges.push({ source: band.id, finding: "policy.choice", role: band.role, severity: "warn", measured: band.measured, text: toolChoiceNudgeText(band, delivery.input.facts.value, preferredReason) });
					// A rule that names a skill wants the agent working from it, not merely
					// told about it: the nudge says why, and — when the switch is on and the
					// session has not loaded it — the skill is loaded for real. Loading
					// forces a turn, which is the cost that keeps this off by default.
					if (skill) {
						nudges.push({ source: band.id, finding: "policy.skill", role: "advisory", severity: "notice", measured: band.measured, text: skillLoadText(skill) });
						if (config.loadSkills && !skillAlreadyLoaded(skill.name)) void pi.sendUserMessage(`/skill:${skill.name}`, { deliverAs: "steer", expandPromptTemplates: true });
					}
				}
				if (nudges.length > 0) deliver(nudges, delivery.input.facts.toolCallId ?? delivery.input.facts.requestId);
			},
		});
	});

	/** Whether the branch already carries evidence this skill was pulled in. */
	const skillAlreadyLoaded = (name: string): boolean => {
		try {
			const entries = (ctx?.sessionManager as { getBranch?: () => readonly unknown[] } | undefined)?.getBranch?.() ?? [];
			return skillLoaded(entries, name);
		} catch {
			return false;
		}
	};

	// The orchestrator's check-in: on the configured interval, scan the branch
	// for child notices nobody has asked about, queue the drift questions, and
	// flush. A violation wakes the idle orchestrator with one sentence — the
	// wake is the keep-alive, so a quiet child costs nothing and a busy one is
	// read at most once per notice.
	const runCheckIn = async (): Promise<void> => {
		checkInTimer = undefined;
		if (!lease || sessionId === null || !ctx) return;
		if (checkInIntervalMs(config) <= 0) return;
		let entries: readonly unknown[] = [];
		try {
			entries = (ctx.sessionManager as { getBranch?: () => readonly unknown[] }).getBranch?.() ?? [];
		} catch {
			entries = [];
		}
		const fresh = newNotices(entries, seenNotices).filter(noticeNeedsAttention);
		if (fresh.length === 0) return;
		for (const notice of fresh) seenNotices.add(notice.id);
		const conversation = configConversation(sessionSources(ctx, pi as never), config);
		const findings: Nudge[] = [];
		for (const notice of fresh) {
			try {
				await lease.core.sendDecisions({
					subject: { key: checkInSubjectKey(notice), kind: "child" },
					input: checkInAction(notice, () => configConversation(sessionSources(ctx, pi as never), config)),
					consumer: SUBAGENT_CONSUMER,
					questions: CHECK_IN_QUESTIONS,
				});
				// The shared consumer's onAnswers ran inside that flush and pushed
				// whatever it found into `checkInFindings`; the check-in owns only
				// the delivery, which is the part that wakes an idle orchestrator.
				findings.push(...checkInFindings);
				checkInFindings = [];
			} catch {
				// A failed check-in is a failed request, recorded by the core; it is
				// not a reason to stop scanning the rest of the fleet.
			}
		}
		const wake = combineFindings(findings);
		if (wake && config.deliverSubagentNudges) {
			// One wake for the whole scan: every message here is a turn the
			// orchestrator spends, and its findings read as one paragraph anyway.
			deliverNudges(pi, [wake], { mode: "followUp", triggerTurn: true });
		}
	};

	const armCheckIn = (): void => {
		const interval = checkInIntervalMs(config);
		if (interval <= 0 || checkInTimer !== undefined) return;
		checkInTimer = setTimeout(() => {
			// The cadence repeats: a scan re-arms itself, so an orchestrator that
			// stays idle across several intervals is read at each one. The notice
			// is still judged once whatever the cadence does.
			void runCheckIn().finally(armCheckIn);
		}, interval);
	};

	// The trigger: a tool call is the moment a plan can be contradicted, and the
	// moment a policy preference can be honoured instead of missed.
	pi.on("tool_call", (event, context) => {
		ctx = context;
		if (!lease) return;
		let facts: ActionAskFacts;
		try {
			facts = toolCallFacts(event as ToolCallLike, `call-${++calls}`, toolPolicy);
		} catch (error) {
			report(`pi-jev: a tool call could not be read (${error instanceof Error ? error.message : String(error)}).`);
			return;
		}
		let conversation: ReturnType<typeof configConversation>;
		try {
			conversation = configConversation(sessionSources(ctx, pi as never), config);
		} catch (error) {
			report(`pi-jev: the conversation could not be read (${error instanceof Error ? error.message : String(error)}).`);
			return;
		}
		// The call is the subject. Its input carries the frozen facts and a thunk
		// for the conversation, so a flush that happens later — the turn boundary —
		// reads the session as it is then rather than replaying this moment.
		const input: ActionContext = { facts, conversation: () => configConversation(sessionSources(ctx, pi as never), config) };
		// The same subject the gate will use for this call: the key is Pi's tool
		// call id, so what the intent consumer queues here is flushed by the
		// permission ask rather than waiting for the turn boundary.
		const subject = callSubject({ toolCallId: facts.toolCallId, requestId: facts.requestId });
		if (conversation.declaredPlan !== null) {
			lease.core.queueDecisions({
				subject,
				input,
				consumer: INTENT_CONSUMER,
				questions: INTENT_QUESTIONS,
			});
		}
		if (facts.preferredTool != null) {
			lease.core.queueDecisions({
				subject,
				input,
				consumer: TOOL_CHOICE_CONSUMER,
				questions: ["tool.choice"],
			});
		}
	});

	pi.on("turn_start", () => {
		lease?.setRunning(true);
	});

	pi.on("turn_end", () => {
		lease?.setRunning(false);
		// Its own boundary: a call nothing gated is still read, once per turn. A
		// second flush for the same action finds an empty queue and spends nothing.
		void lease?.core.flushPending().catch(() => {
			// A failure is already recorded as a failed request.
		});
		// The check-in cadence resumes at every boundary: an idle orchestrator is
		// scanned on the interval, a busy one is scanned by its own turns.
		armCheckIn();
	});

	pi.on("agent_settled", () => {
		// The agent has stopped for real — no retry, no follow-up left. One scan
		// now, and the interval takes over from here.
		void runCheckIn();
		armCheckIn();
	});

	pi.on("session_shutdown", () => {
		if (checkInTimer !== undefined) clearTimeout(checkInTimer);
		checkInTimer = undefined;
		lease?.release();
		lease = undefined;
		logLease?.release();
		ctx = undefined;
		sessionId = null;
	});
}
