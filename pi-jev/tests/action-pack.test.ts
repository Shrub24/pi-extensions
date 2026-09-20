import { expect, test } from "bun:test";

import {
	ACTION_PACK,
	SUBAGENT_PACK,
	subagentBundle,
	askFactsFrom,
	buildActionState,
	composeVerdict,
	DEFAULT_ADVISORY_EDGE,
	DEFAULT_EDGE,
	denyReason,
	emptyConversation,
	hashState,
	isPathShaped,
	nudgeText,
	pendingCallLine,
	questionSet,
	questionsFor,
	readBands,
	REVERSIBILITY_LEVELS,
	thresholdFor,
} from "../extensions/action-pack.js";
import { conversation, fakeDetails, fakeQuery, noul, score } from "./fixtures/fakes.js";
import { DEFAULTS } from "../extensions/config.js";
import { subagentNudges } from "../extensions/consumers.js";
import type { Reading } from "../extensions/decision-core.js";
import type { JevAnswer } from "../extensions/types.js";

const budget = {
	maxChars: 4_000,
	maxFieldChars: 600,
	maxUserMessages: 2,
	maxToolCalls: 5,
	maxPlanChars: 500,
	maxToolbox: 12,
};

const facts = (overrides: Parameters<typeof fakeDetails>[0] = {}) => askFactsFrom(fakeDetails(overrides), fakeQuery());

/**
 * The core's normalized readings for an answer table, produced by the pack's own
 * readers — the same path a real answer takes, so these tests stay about what the
 * pack does with a reading rather than about how a reading is made.
 */
function readings(answers: Record<string, JevAnswer>): Reading[] {
	return Object.entries(answers).map(([question, answer]) => {
		const spec = [...ACTION_PACK, ...SUBAGENT_PACK].find((entry) => entry.id === question);
		const read = spec?.read(answer);
		return {
			question,
			owner: "permission",
			probability: read && "probability" in read ? (read.probability ?? null) : null,
			level: read && "level" in read ? (read.level ?? null) : null,
			ok: read !== undefined,
		};
	});
}

/** A full set of answers: clean by default, overridable per question. */
function answers(overrides: Record<string, ReturnType<typeof noul> | ReturnType<typeof score>> = {}) {
	return {
		"safety.no_material_harm": noul(0.98),
		"safety.reversibility": score(1),
		"intent.conflicts_with_user": noul(0.97),
		"intent.matches_plan": noul(0.97),
		"scope.supports_active_task": noul(0.97),
		"tool.fit": noul(0.96),
		...overrides,
	};
}

test("ask facts flatten the payload and the policy that asked", () => {
	const ask = facts();
	expect(ask).toMatchObject({
		requestId: "req-1",
		surface: "bash",
		value: "rm -rf build",
		toolName: "bash",
		agentName: "pi",
		forwarded: false,
		policy: { surfaceState: "ask", toolState: "ask" },
	});
});

test("a throwing permission query is a fact, not a failure", () => {
	const ask = askFactsFrom(
		fakeDetails(),
		fakeQuery({
			checkPermission: () => {
				throw new Error("gate blew up");
			},
		}),
	);
	expect(ask.policy.surfaceState).toBe("unknown");
	expect(ask.value).toBe("rm -rf build");
});

test("state leads with the ask, states the authority rule, and carries plan and toolbox", () => {
	const built = buildActionState({
		ask: facts(),
		conversation: conversation({
			userMessages: ["fix the failing test", "also clean the build dir"],
			recentToolCalls: ["bash bun test"],
			declaredPlan: "I will remove the stale build directory now.",
			toolbox: ["grep: search file contents", "semble: semantic code search"],
		}),
		budget,
	});
	expect(Object.keys(built.state)[0]).toBe("ask");
	const intent = built.state.userIntent as { latest: string; history: string[]; ordering: string };
	expect(intent.latest).toBe("also clean the build dir");
	expect(intent.history).toEqual(["fix the failing test"]);
	expect(intent.ordering).toContain("oldest first");
	expect((built.state.plan as { text: string }).text).toContain("remove the stale build directory");
	expect((built.state.toolbox as { tools: string[] }).tools).toHaveLength(2);
	expect(String(built.state.authority)).toContain("never authorizes");
});

test("an absent plan and an empty toolbox leave no empty sections behind", () => {
	const built = buildActionState({ ask: facts(), conversation: emptyConversation(), budget });
	expect(built.state.plan).toBeNull();
	expect(built.state.toolbox).toBeUndefined();
	expect(built.state.recentActivity).toBeUndefined();
});

test("state hashing is stable for identical input and moves with the facts", () => {
	const input = { ask: facts(), conversation: conversation({ userMessages: ["go"] }), budget };
	const first = buildActionState(input);
	expect(first.stateHash).toBe(buildActionState(input).stateHash);
	expect(hashState({ a: 1 })).toBe(hashState({ a: 1 }));
	expect(buildActionState({ ...input, conversation: conversation({ userMessages: ["stop"] }) }).stateHash).not.toBe(first.stateHash);
});

test("the state budget is honoured, and what it dropped is named", () => {
	const long = "x".repeat(5_000);
	const built = buildActionState({
		ask: facts(),
		conversation: conversation({
			userMessages: [long, long, long],
			recentToolCalls: [long, long, long, long, long, long],
			declaredPlan: long,
			toolbox: Array.from({ length: 30 }, (_, index) => `tool${index}: ${long}`),
		}),
		budget,
	});
	expect(built.chars).toBeLessThanOrEqual(budget.maxChars);
	expect(built.truncated.length).toBeGreaterThan(0);
	expect((built.state.ask as { value: string }).value.length).toBeGreaterThan(0);
});

test("a budget at the config floor still fits, keeping the ask and the authority rule", () => {
	const built = buildActionState({
		ask: facts(),
		conversation: conversation({ userMessages: ["y".repeat(900)] }),
		budget: { ...budget, maxChars: 500 },
	});
	expect(built.chars).toBeLessThanOrEqual(500);
	expect((built.state.ask as { value: string }).value.length).toBeGreaterThan(0);
	expect(built.state.authority).toBeDefined();
	expect(built.truncated).not.toContain("over-budget");
});

test("a budget below the irreducible skeleton says so instead of pretending it fits", () => {
	const built = buildActionState({
		ask: facts(),
		conversation: conversation({ userMessages: ["y".repeat(900)] }),
		budget: { ...budget, maxChars: 300 },
	});
	// The ask and the authority rule are what a state cannot do without, so the
	// builder reports the overrun rather than dropping them.
	expect(built.truncated).toContain("over-budget");
	expect((built.state.ask as { value: string }).value.length).toBeGreaterThan(0);
	expect(built.state.authority).toContain("data");
});

test("the pack separates veto from advisory questions", () => {
	const roles = ACTION_PACK.map((question) => `${question.id}=${question.role}`);
	expect(roles).toEqual([
		"safety.no_material_harm=veto",
		"safety.reversibility=veto",
		"intent.conflicts_with_user=veto",
		"intent.matches_plan=advisory",
		"scope.supports_active_task=advisory",
		"tool.fit=advisory",
	]);
	expect(ACTION_PACK.filter((question) => question.role === "veto")).toHaveLength(3);
});

test("the wire question set carries the pack's questions, with the reversibility ladder", () => {
	const ask = facts();
	const set = questionSet(questionsFor(ask), ask);
	expect(Object.keys(set)).toHaveLength(6);
	const harm = set["safety.no_material_harm"] as { type: string; instructions: string; criteria: Record<string, string> };
	expect(harm.type).toBe("noul");
	expect(Object.keys(harm.criteria)).toEqual(["true", "false"]);

	const reversibility = set["safety.reversibility"] as { type: string; criteria: string[] };
	expect(reversibility.type).toBe("score");
	expect(reversibility.criteria).toHaveLength(REVERSIBILITY_LEVELS.length);
	expect(reversibility.criteria[0]).toContain("Only reads");
	expect(reversibility.criteria[3]).toContain("Cannot be undone");
});

test("a tool-fit question needs a tool, and a path ask keeps its path question", () => {
	const asked = facts({ path: "/etc/hosts" });
	const specs = questionsFor(asked);
	expect(specs.map((spec) => spec.id)).toContain("tool.fit");
	expect(isPathShaped(asked)).toBe(true);

	const noTool = askFactsFrom(
		fakeDetails({ payload: { ...fakeDetails().payload, request: { ...fakeDetails().payload.request, toolName: null } }, toolName: undefined }),
		fakeQuery(),
	);
	expect(questionsFor(noTool).map((spec) => spec.id)).not.toContain("tool.fit");
});

test("bands split satisfied, violated, and unclear around one edge", () => {
	const specs = questionsFor(facts());
	const rows = [
		{ name: "satisfied", probability: 0.95, expected: "satisfied" },
		{ name: "violated", probability: 0.04, expected: "violated" },
		{ name: "unclear", probability: 0.5, expected: "unclear" },
		{ name: "advisory edge", probability: 0.87, expected: "satisfied", id: "scope.supports_active_task" },
		{ name: "advisory miss", probability: 0.82, expected: "unclear", id: "scope.supports_active_task" },
	];
	expect.assertions(rows.length + 1);
	expect(rows.length).toBeGreaterThan(0);
	for (const row of rows) {
		const id = row.id ?? "intent.conflicts_with_user";
		const bands = readBands(specs, readings({ [id]: noul(row.probability) }), {});
		expect(bands.find((reading) => reading.id === id)?.band, row.name).toBe(row.expected);
	}
});

test("a graded question bands by level, not by probability", () => {
	const specs = questionsFor(facts());
	const bands = [0, 1, 2, 3].map((level) => readBands(specs, readings({ "safety.reversibility": score(level) }), {}).find((reading) => reading.id === "safety.reversibility")?.band);
	expect(bands).toEqual(["satisfied", "satisfied", "unclear", "violated"]);
});

test("an absent or wrong-typed answer is missing, not a low score", () => {
	const specs = questionsFor(facts());
	const absent = readBands(specs, [], {});
	expect(absent.every((reading) => reading.band === "missing")).toBe(true);
	expect(absent[0]?.probability).toBeNull();

	const wrongType = readBands(specs, readings({ "safety.no_material_harm": score(2) }), {});
	expect(wrongType[0]?.band).toBe("missing");

	const wrongScore = readBands(specs, readings({ "safety.reversibility": noul(0.99) }), {});
	expect(wrongScore.find((reading) => reading.id === "safety.reversibility")?.band).toBe("missing");

	const outOfRange = readBands(specs, readings({ "safety.no_material_harm": noul(7) }), {});
	expect(outOfRange[0]?.band).toBe("missing");

	const offLadder = readBands(specs, readings({ "safety.reversibility": score(9) }), {});
	expect(offLadder.find((reading) => reading.id === "safety.reversibility")?.band).toBe("missing");
});

test("a per-question threshold replaces the default only when it is usable", () => {
	expect(thresholdFor("scope.supports_active_task", { "scope.supports_active_task": 0.97 }, 0.85)).toBe(0.97);
	expect(thresholdFor("scope.supports_active_task", { "scope.supports_active_task": 0.5 }, 0.85)).toBe(0.85);
	expect(thresholdFor("scope.supports_active_task", {}, 0.85)).toBe(0.85);
});

test("composition: a veto violation denies, everything satisfied allows, anything else defers", () => {
	const specs = questionsFor(facts());

	const denied = composeVerdict(readBands(specs, readings(answers({ "safety.no_material_harm": noul(0.02) })), {}), "bash: rm -rf build");
	expect(denied.kind).toBe("deny");
	expect(denied.decidedBy).toBe("safety.no_material_harm");
	expect(denied.reason).toContain("bash: rm -rf build");

	// `safety.reversibility` has no samples behind its bar yet, so a level-3
	// reading defers, names itself, and raises a notice rather than refusing.
	const irreversible = composeVerdict(readBands(specs, readings(answers({ "safety.reversibility": score(3) })), {}), "bash: git push --force");
	expect(irreversible.kind).toBe("defer");
	expect(irreversible.decidedBy).toBe("safety.reversibility");
	expect(irreversible.signals.map((signal) => `${signal.source}:${signal.measured}`)).toEqual(["safety.reversibility:false"]);

	const conflict = composeVerdict(readBands(specs, readings(answers({ "intent.conflicts_with_user": noul(0.03) })), {}));
	expect(conflict.kind).toBe("deny");
	expect(conflict.decidedBy).toBe("intent.conflicts_with_user");

	expect(composeVerdict(readBands(specs, readings(answers()), {})).kind).toBe("allow");
	expect(composeVerdict([]).kind).toBe("defer");
});

test("an unmeasured veto may not refuse work, and a measured one may", () => {
	const specs = questionsFor(facts());
	const unmeasured = composeVerdict(readBands(specs, readings(answers({ "safety.reversibility": score(3) })), {}));
	expect(unmeasured.kind).toBe("defer");
	expect(unmeasured.signals[0]).toMatchObject({ source: "safety.reversibility", role: "veto", severity: "notice", measured: false });

	// Once a question carries samples, its band refuses again.
	const measuredPack = ACTION_PACK.map((question) => (question.id === "safety.reversibility" ? { ...question, measured: true } : question));
	const measured = composeVerdict(readBands(questionsFor(facts(), measuredPack), readings(answers({ "safety.reversibility": score(3) })), {}));
	expect(measured.kind).toBe("deny");
	expect(measured.decidedBy).toBe("safety.reversibility");
	expect(measured.reason).toContain("level 3");
});

test("an advisory violation never denies; it defers and raises a nudge", () => {
	const specs = questionsFor(facts());
	const composed = composeVerdict(readBands(specs, readings(answers({ "intent.matches_plan": noul(0.03) })), {}), "bash: rm -rf build");
	expect(composed.kind).toBe("defer");
	expect(composed.decidedBy).toBe("intent.matches_plan");
	expect(composed.signals).toHaveLength(1);
	expect(composed.signals[0]).toMatchObject({ source: "intent.matches_plan", role: "advisory", severity: "warn" });

	const toolFit = composeVerdict(readBands(specs, readings(answers({ "tool.fit": noul(0.05) })), {}));
	expect(toolFit.kind).toBe("defer");
	expect(toolFit.signals.map((signal) => signal.source)).toEqual(["tool.fit"]);

	const scope = composeVerdict(readBands(specs, readings(answers({ "scope.supports_active_task": noul(0.02) })), {}));
	expect(scope.kind).toBe("defer");
	expect(scope.signals).toHaveLength(1);
});

test("an unclear band defers without nudging, because the middle of the edge is wide", () => {
	const specs = questionsFor(facts());
	const composed = composeVerdict(readBands(specs, readings(answers({ "scope.supports_active_task": noul(0.5) })), {}));
	expect(composed.kind).toBe("defer");
	expect(composed.signals).toEqual([]);
});

test("a missing band defers and says which question never answered", () => {
	const specs = questionsFor(facts());
	const partial = answers();
	delete (partial as Record<string, unknown>)["safety.reversibility"];
	const composed = composeVerdict(readBands(specs, readings(partial), {}), "bash: rm -rf build");
	expect(composed.kind).toBe("defer");
	expect(composed.decidedBy).toBe("safety.reversibility");
});

test("the two edges are separate, and a question's own value wins for both", () => {
	const specs = questionsFor(facts());
	// 0.87 satisfies the advisory edge but not the veto edge.
	const bands = readBands(specs, readings(answers({ "scope.supports_active_task": noul(0.87), "safety.no_material_harm": noul(0.87) })), {});
	expect(bands.find((reading) => reading.id === "scope.supports_active_task")?.band).toBe("satisfied");
	expect(bands.find((reading) => reading.id === "safety.no_material_harm")?.band).toBe("unclear");
	expect(bands.find((reading) => reading.id === "safety.no_material_harm")?.edge).toBe(DEFAULT_EDGE);
	expect(bands.find((reading) => reading.id === "scope.supports_active_task")?.edge).toBe(DEFAULT_ADVISORY_EDGE);

	const tuned = readBands(specs, readings(answers({ "scope.supports_active_task": noul(0.87) })), { "scope.supports_active_task": 0.95 });
	expect(tuned.find((reading) => reading.id === "scope.supports_active_task")?.band).toBe("unclear");
});

test("a deny reason names the question, the reading, and what to do instead", () => {
	const specs = questionsFor(facts());
	const reading = readBands(specs, readings(answers({ "safety.no_material_harm": noul(0.02) })), {}).find((entry) => entry.id === "safety.no_material_harm")!;
	const reason = denyReason(reading, pendingCallLine(facts()));
	expect(reason).toContain("safety.no_material_harm");
	expect(reason).toContain("0.02");
	expect(reason).toContain("0.10");
	expect(reason).toContain("bash: rm -rf build");
	expect(reason.length).toBeLessThanOrEqual(300);
	expect(denyReason({ ...reading, purpose: "x".repeat(400) }).length).toBeLessThanOrEqual(300);
});

test("a deny reason says when the question's bar is unmeasured", () => {
	const specs = questionsFor(facts());
	const reading = readBands(specs, readings(answers({ "safety.reversibility": score(3) })), {}).find((entry) => entry.id === "safety.reversibility")!;
	expect(reading.measured).toBe(false);
	expect(denyReason(reading)).toContain("no labelled samples");

	const measured = readBands(specs, readings(answers({ "safety.no_material_harm": noul(0.02) })), {}).find((entry) => entry.id === "safety.no_material_harm")!;
	expect(measured.measured).toBe(true);
	expect(denyReason(measured)).not.toContain("no labelled samples");
});

test("a nudge names the question, its reading, and the mismatch", () => {
	const specs = questionsFor(facts());
	const [signal] = composeVerdict(readBands(specs, readings(answers({ "intent.matches_plan": noul(0.03) })), {})).signals;
	const text = nudgeText(signal!);
	expect(text).toContain("intent.matches_plan");
	expect(text).toContain("0.03");
	expect(text).toContain("Keep the call and your stated intent in step");
	expect(text.length).toBeLessThanOrEqual(400);
	expect(nudgeText({ ...signal!, purpose: "x".repeat(600) }).length).toBeLessThanOrEqual(400);
});

test("the pending-call line is bounded", () => {
	expect(pendingCallLine(facts())).toBe("bash: rm -rf build");
	expect(pendingCallLine({ toolName: null, surface: "path", value: "z".repeat(400) } as never).length).toBeLessThanOrEqual(120);
});

test("conversation limits reach the state builder", () => {
	const built = buildActionState({
		ask: facts(),
		conversation: conversation({ userMessages: ["a", "b", "c"], recentToolCalls: ["t1", "t2"], declaredPlan: "p".repeat(900), toolbox: ["x: y"] }),
		budget: { ...budget, maxUserMessages: 1, maxToolCalls: 1, maxPlanChars: 100 },
	});
	expect((built.state.userIntent as { latest: string }).latest).toBe("c");
	expect((built.state.userIntent as { history: string[] }).history).toEqual([]);
	expect((built.state.recentActivity as { toolCalls: string[] }).toolCalls).toEqual(["t2"]);
	expect((built.state.plan as { text: string }).text.length).toBeLessThanOrEqual(100);
	expect(built.truncated.some((entry) => entry.startsWith("plan.text"))).toBe(true);
});

test("subagent questions apply only to forwarded asks, and read the subagent state", () => {
	// A local ask has no orchestrator to steer: both questions drop out.
	const local = questionsFor(facts(), SUBAGENT_PACK);
	expect(local).toHaveLength(0);

	// A forwarded ask names its requester and carries both questions.
	const forwarded = facts({
		agentName: "reviewer",
		payload: {
			kind: "bash",
			request: {
				requester: { agentName: "reviewer", forwarded: true, sessionId: "child-1" },
				surface: "bash",
				toolName: "bash",
				invokedToolName: null,
				value: "git push --force origin main",
				matchedPattern: null,
				commandContext: null,
				executedUnit: null,
			},
			evidence: [],
			annotations: [],
		},
	});
	const specs = questionsFor(forwarded, SUBAGENT_PACK);
	expect(specs.map((spec) => spec.id)).toEqual(["orchestrator.intent_alignment", "agent.role_adherence"]);

	// The subagent state leads with who asked, the role, and the task — not the
	// whole action state, which the action-v1 group already carries.
	const built = subagentBundle(budget).buildState({ facts: forwarded, conversation: { userMessages: ["review the auth module"], recentToolCalls: [], declaredPlan: "reviewing the auth module for token handling", toolbox: [] } });
	const state = built.state as { ask: { requestedBy: string }; role: { name: string } | null; task: { text: string } | null; userIntent: { latest: string | null } };
	expect(state.ask.requestedBy).toBe("subagent reviewer");
	expect(state.role?.name).toBe("reviewer");
	expect(state.task?.text).toContain("auth module");
	expect(state.userIntent.latest).toBe("review the auth module");

	// An unknown agent has no role to read; the field says so rather than guessing.
	const unnamed = subagentBundle(budget).buildState({ facts: { ...forwarded, agentName: null }, conversation: { userMessages: [], recentToolCalls: [], declaredPlan: null, toolbox: [] } });
	expect((unnamed.state as { role: unknown }).role).toBeNull();
});

test("subagent bands are advisory: a violation nudges the orchestrator and never denies", () => {
	const forwarded = facts({
		agentName: "reviewer",
		payload: {
			kind: "bash",
			request: {
				requester: { agentName: "reviewer", forwarded: true, sessionId: "child-1" },
				surface: "bash",
				toolName: "bash",
				invokedToolName: null,
				value: "git push --force origin main",
				matchedPattern: null,
				commandContext: null,
				executedUnit: null,
			},
			evidence: [],
			annotations: [],
		},
	});
	const specs = questionsFor(forwarded, SUBAGENT_PACK);
	const bands = readBands(specs, readings({ "orchestrator.intent_alignment": noul(0.04), "agent.role_adherence": noul(0.06) }), {});
	expect(bands.map((band) => band.band)).toEqual(["violated", "violated"]);

	// Composition over the permission pack is unaffected: the subagent bands are
	// the subagent consumer's reading, not the gate's, so a violated alignment
	// question defers nothing and denies nothing.
	const combined = composeVerdict(readBands(questionsFor(facts()), readings(answers()), {}));
	expect(combined.kind).toBe("allow");
	expect(combined.signals).toHaveLength(0);

	// The nudge text addresses the orchestrator about the child.
	const nudges = subagentNudges(
		bands.map((band) => ({ question: band.id, owner: "subagent", probability: band.probability, level: null, ok: true })),
		{ ...DEFAULTS, thresholds: {} },
	);
	expect(nudges).toHaveLength(2);
	expect(nudges[0]?.text).toContain("orchestrator.intent_alignment");
});
