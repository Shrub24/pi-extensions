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
import { configConversation, sessionSources, toolboxLines } from "./conversation.js";
import { INTENT_CONSUMER, INTENT_QUESTIONS, INTENT_SPECS, installPack, intentNudges, interpretBands } from "./consumers.js";
import type { Nudge } from "./consumers.js";
import { createJevClient } from "./jev.js";
import type { JevClient } from "./jev.js";
import type { DecisionLog } from "./decision-log.js";
import { deliverNudges } from "./nudges.js";
import { acquireCore, acquireLog, logSink } from "./registry.js";
import type { CoreLease } from "./registry.js";
import { preferredTool, TOOL_CHOICE_QUESTIONS, toolChoiceBand, toolChoiceNudgeText } from "./tool-choice.js";
import type { ToolPolicy } from "./tool-choice.js";
import { loadToolPolicy } from "./tool-policy.js";

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
		surface: "tool_call",
		kind: "tool",
		value,
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
	};
	const alternative = policy ? preferredTool({ ...facts, value }, policy) : undefined;
	if (alternative) {
		facts.preferredTool = alternative.preferred;
		facts.preferredReason = alternative.reason;
	}
	return facts;
}

/** The plan group's interpretation, for a flush this consumer queued. */
export function interpretIntent(readings: Parameters<typeof interpretBands>[0], config: JevConfig, callLine = "") {
	return interpretBands(readings, INTENT_SPECS, config, callLine);
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

	const deliver: ((nudges: readonly Nudge[]) => void) | undefined =
		config.deliverNudges || config.deliverIntentNudges || config.deliverSubagentNudges ? (nudges) => deliverNudges(pi, nudges) : undefined;

	pi.on("session_start", (_event, context) => {
		ctx = context;
		if (loaded.problem) report(loaded.problem);
		try {
			sessionId = (context.sessionManager as { getSessionId?: () => string | undefined }).getSessionId?.() ?? null;
		} catch {
			sessionId = null;
		}
		if (sessionId === null || lease) return;
		const client = (jev ??= deps.jev ?? createJevClient({ model: config.model, timeoutMs: config.timeoutMs, maxRequests: config.maxRequestsPerSession, ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }) }));
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
		lease.core.registerConsumer({
			id: INTENT_CONSUMER,
			questions: INTENT_QUESTIONS,
			// A plan question with no plan in the state is unanswerable, so a call
			// with nothing stated ahead of it is dropped from the flush entirely.
			applies: (action: ActionContext) => action.conversation.declaredPlan !== null,
			interpret: (readings) => interpretIntent(readings, config),
			onAnswers: (delivery) => {
				if (!deliver) return;
				const nudges = intentNudges(delivery.readings, config);
				if (nudges.length > 0) deliver(nudges);
			},
		});

		// The tool-choice consumer rides the same core: it queues on every tool
		// call whose policy names an alternative, and its readings come back with
		// whatever flush answers them. Its nudge text names the policy's reason,
		// because "the policy prefers X" without why teaches nothing.
		lease.core.registerQuestions(
			TOOL_CHOICE_QUESTIONS.map((spec) => ({
				id: spec.id,
				stateProvider: spec.stateProvider,
				owner: TOOL_CHOICE_CONSUMER,
				meta: { role: spec.role, purpose: spec.purpose, measured: spec.measured },
				applies: (action: ActionContext) => spec.applies(action.facts),
				question: (action: ActionContext) => spec.question(action.facts) ?? undefined,
				read: (answer) => {
					const read = spec.read(answer);
					return read ? { probability: read.margin, level: null, detail: { choice: read.choice, margin: read.margin } } : undefined;
				},
			})),
		);
		lease.core.registerConsumer({
			id: TOOL_CHOICE_CONSUMER,
			questions: ["tool.choice"],
			applies: (action: ActionContext) => action.facts.preferredTool != null,
			onAnswers: (delivery) => {
				if (!deliver) return;
				const reading = delivery.readings.find((reading) => reading.question === "tool.choice");
				const detail = reading?.detail as { choice?: string; margin?: number } | undefined;
				const band = toolChoiceBand(detail && detail.choice !== undefined ? { choice: detail.choice, margin: detail.margin ?? 0 } : undefined, delivery.action.facts.preferredTool, toolPolicy);
				if (band.band !== "violated") return;
				// The policy's own reason is the teaching part of the sentence, and the
				// action the flush judged still carries it.
				const preferredReason = (delivery.action as ActionContext | undefined)?.facts.preferredReason ?? null;
				deliver([{ source: band.id, role: band.role, severity: "warn", measured: band.measured, text: toolChoiceNudgeText(band, delivery.action.facts.value, preferredReason) }]);
			},
		});
	});

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
		const action: ActionContext = { facts, conversation };
		if (conversation.declaredPlan !== null) {
			lease.core.queueDecisions({
				action,
				actionKey: facts.requestId,
				consumer: INTENT_CONSUMER,
				questions: INTENT_QUESTIONS,
			});
		}
		if (facts.preferredTool != null) {
			lease.core.queueDecisions({
				action,
				actionKey: facts.requestId,
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
	});

	pi.on("session_shutdown", () => {
		lease?.release();
		lease = undefined;
		logLease?.release();
		ctx = undefined;
		sessionId = null;
	});
}
