/*
 * Shared fakes for the pi-jev suites: a judge that answers from a table, a log
 * that keeps records in memory, and the two permission-side seams an ask
 * arrives through. Nothing here touches a network, a session, or the disk, so
 * the decision path under test is the one a real ask takes.
 */

import type { JevConfig } from "../../extensions/config.js";
import { DEFAULTS } from "../../extensions/config.js";
import type { DecisionLog } from "../../extensions/decision-log.js";
import type { JevRecord } from "../../extensions/decision-record.js";
import type { ConversationFacts } from "../../extensions/action-pack.js";
import type {
	JevAnswer,
	JevAskAnswer,
	JevJudge,
	JevQuestion,
	JevRequest,
	PermissionQuery,
	PromptPermissionDetails,
} from "../../extensions/types.js";

export function noul(probability: number): JevAnswer {
	return { type: "noul", noul: probability };
}

export function score(level: number, legend = "level"): JevAnswer {
	return { type: "score", score: level, legend, probabilities: {}, confidence: 1 };
}

export interface FakeJudge extends JevJudge {
	readonly requests: JevRequest[];
}

/** A judge answering from a table, or from a function for per-question control. */
export function fakeJudge(answers: Record<string, JevAnswer> | ((request: JevRequest) => Record<string, JevAnswer>)): FakeJudge {
	const requests: JevRequest[] = [];
	return {
		requests,
		async evaluate(request) {
			requests.push(request);
			const resolved = typeof answers === "function" ? answers(request) : answers;
			// Answer only what was asked, as the API does.
			const filtered: Record<string, JevAnswer> = {};
			for (const id of Object.keys(request.questions)) {
				const answer = resolved[id];
				if (answer) filtered[id] = answer;
			}
			return { answers: filtered, model: "jev-test", usage: { input_tokens: 10, output_tokens: 0 }, elapsedMs: 1 };
		},
	};
}

export interface FakeLog extends DecisionLog {
	readonly records: JevRecord[];
}

export function fakeLog(): FakeLog {
	const records: JevRecord[] = [];
	return {
		path: ":memory:",
		records,
		write: (record) => {
			records.push(record);
		},
		read: () => [...records],
	};
}

export interface FakeJevClient {
	requests: { state: unknown; questions: Record<string, JevQuestion> }[];
	model: string;
	unavailable: () => string | undefined;
	probe(): Promise<void>;
	warm(): Promise<void>;
	ask(
		state: unknown,
		questions: Record<string, JevQuestion>,
		options?: { signal?: AbortSignal },
	): Promise<JevAskAnswer>;
}

/** A judge client that answers from a table without pi-typesafe being present. */
export function fakeJevClient(
	answers: Record<string, JevAnswer> | JevAskAnswer | ((questions: Record<string, JevQuestion>) => JevAskAnswer),
	unavailable?: string,
): FakeJevClient {
	const requests: { state: unknown; questions: Record<string, JevQuestion> }[] = [];
	return {
		requests,
		model: "jev-test",
		unavailable: () => unavailable,
		async probe() {},
		async warm() {},
		async ask(state: unknown, questions: Record<string, JevQuestion>) {
			requests.push({ state, questions });
			if (typeof answers === "function") return answers(questions);
			if ("ok" in answers) return answers;
			// Answer only what the table holds, like a backend that returned an
			// unexpected shape: the missing-answer path must stay reachable.
			return {
				ok: true as const,
				answers: Object.fromEntries(Object.entries(answers).filter(([id]) => id in questions)) as Record<string, JevAnswer>,
				model: "jev-test",
				usage: { input_tokens: 10, output_tokens: 0 },
				elapsedMs: 7,
			};
		},
	};
}

export function testConfig(overrides: Partial<JevConfig> = {}): JevConfig {
	return { ...DEFAULTS, logFile: ":memory:", ...overrides };
}

export function conversation(overrides: Partial<ConversationFacts> = {}): ConversationFacts {
	return { userMessages: [], recentToolCalls: [], toolTrend: null, declaredPlan: null, toolbox: [], ...overrides };
}

/** A conversation source backed by an array of branch entries. */
export function sourcesFrom(entries: readonly unknown[], toolbox: string[] = []) {
	return { entries: () => entries, toolbox: () => toolbox };
}

export function fakeQuery(overrides: Partial<PermissionQuery> = {}): PermissionQuery {
	return {
		checkPermission: () => ({ toolName: "bash", state: "ask", source: "bash", origin: "project" }),
		getToolPermission: () => "ask",
		...overrides,
	};
}

export function fakeDetails(overrides: Partial<PromptPermissionDetails> = {}): PromptPermissionDetails {
	const base: PromptPermissionDetails = {
		requestId: "req-1",
		source: "tool_call",
		agentName: "pi",
		payload: {
			kind: "bash",
			request: {
				requester: { agentName: "pi", forwarded: false, sessionId: null },
				surface: "bash",
				toolName: "bash",
				invokedToolName: null,
				value: "rm -rf build",
				matchedPattern: "rm *",
				commandContext: null,
				executedUnit: null,
			},
			evidence: [],
			annotations: [],
		},
		toolName: "bash",
	};
	return { ...base, ...overrides };
}

/** The state the fake judge was last asked about. */
export function lastState(requests: readonly JevRequest[]): unknown {
	const last = requests[requests.length - 1];
	return last?.state;
}
