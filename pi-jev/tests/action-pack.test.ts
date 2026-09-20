import { expect, test } from "bun:test";

import {
	ACTION_PACK,
	SUBAGENT_PACK,
	actionBlocks,
	askBlock,
	childWorkBlock,
	userIntentBlock,
	askFactsFrom,
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

test("each block builds its own section, and the pack names one per section", () => {
	const context = {
		facts: facts(),
		conversation: conversation({
			userMessages: ["fix the failing test", "also clean the build dir"],
			recentToolCalls: ["bash bun test"],
			declaredPlan: "I will remove the stale build directory now.",
			toolbox: ["grep: search file contents", "semble: semantic code search"],
		}),
	};
	// The block ids are the section names a question's instructions refer to.
	expect(actionBlocks(budget).map((block) => block.id)).toEqual(["ask", "user_intent", "plan", "tool_history", "toolbox", "authority", "child_work"]);

	const ask = askBlock(budget).buildState(context).state as { action: string; requestedBy: string };
	expect(ask.action).toBe("bash: rm -rf build");
	expect(ask.requestedBy).toBe("agent pi");

	const intent = userIntentBlock(budget).buildState(context).state as { latest: string; history: string[]; ordering: string };
	expect(intent.latest).toBe("also clean the build dir");
	expect(intent.history).toEqual(["fix the failing test"]);
	expect(intent.ordering).toContain("oldest first");

	const plan = actionBlocks(budget)[2]?.buildState(context).state as { text: string } | null;
	expect(plan?.text).toContain("remove the stale build directory");
	const toolbox = actionBlocks(budget)[4]?.buildState(context).state as { tools: string[] } | null;
	expect(toolbox?.tools).toHaveLength(2);
	const authority = actionBlocks(budget)[5]?.buildState(context).state;
	expect(String(authority)).toContain("never authorizes");
});

test("an absent plan, history, or toolbox yields a null section rather than an empty one", () => {
	const built = actionBlocks(budget).map((block) => block.buildState({ facts: facts(), conversation: emptyConversation() }));
	const byId = new Map(actionBlocks(budget).map((block, index) => [block.id, built[index]?.state]));
	expect(byId.get("plan")).toBeNull();
	expect(byId.get("tool_history")).toBeNull();
	expect(byId.get("toolbox")).toBeNull();
	// The ask and the authority rule are always there: a question with nothing
	// else to read still knows what is being asked and who wrote it.
	expect(byId.get("ask")).toBeDefined();
	expect(byId.get("authority")).toBeDefined();
});

test("a block hashes its own section, stably and sensitively", () => {
	const input = { facts: facts(), conversation: conversation({ userMessages: ["go"] }) };
	const block = userIntentBlock(budget);
	const first = block.buildState(input);
	expect(first.stateHash).toBe(block.buildState(input).stateHash);
	expect(hashState({ a: 1 })).toBe(hashState({ a: 1 }));
	expect(block.buildState({ ...input, conversation: conversation({ userMessages: ["stop"] }) }).stateHash).not.toBe(first.stateHash);
});

test("each block caps its own section and names what it cut", () => {
	const long = "x".repeat(5_000);
	const context = {
		facts: facts({
			payload: {
				kind: "bash",
				request: {
					requester: { agentName: "pi", forwarded: false, sessionId: null },
					surface: "bash",
					toolName: "bash",
					invokedToolName: null,
					value: long,
					matchedPattern: null,
					commandContext: null,
					executedUnit: null,
				},
				evidence: [],
				annotations: [],
			},
		}),
		conversation: conversation({
			userMessages: [long, long, long],
			recentToolCalls: [long, long, long, long, long, long],
			declaredPlan: long,
			toolbox: Array.from({ length: 30 }, (_, index) => `tool${index}: ${long}`),
		}),
	};
	// A block has no global staging to lean on any more: it caps its own fields
	// and records every cut against the field it made.
	const ask = askBlock(budget).buildState(context);
	expect((ask.state as { value: string }).value.length).toBeLessThanOrEqual(budget.maxFieldChars);
	expect(ask.truncated).toContain("ask.value");

	const intent = userIntentBlock(budget).buildState(context);
	expect(intent.truncated).toContain("user_intent.latest");
	expect(intent.truncated.some((entry) => entry.startsWith("user_intent.history"))).toBe(true);

	const history = actionBlocks(budget)[3]?.buildState(context);
	expect((history?.state as { toolCalls: string[] }).toolCalls).toHaveLength(budget.maxToolCalls);
	expect(history?.truncated.some((entry) => entry.includes("[-"))).toBe(true);

	const toolbox = actionBlocks(budget)[4]?.buildState(context);
	expect((toolbox?.state as { tools: string[] }).tools).toHaveLength(budget.maxToolbox);

	// Every block reports a hashed section whatever it had to cut.
	for (const block of actionBlocks(budget)) expect(block.buildState(context).stateHash).toMatch(/^[0-9a-f]{16}$/);
});

test("an ask with an empty value still yields its section", () => {
	const built = askBlock(budget).buildState({ facts: { ...facts(), value: "" }, conversation: emptyConversation() });
	const state = built.state as { action: string; value: string };
	// The action line is the tool and its argument; an empty argument leaves the
	// tool name, which is still what the judge is being asked about.
	expect(state.value).toBe("");
	expect(state.action).toBe("bash: ");
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

test("conversation limits reach the blocks that read them", () => {
	const small = { ...budget, maxUserMessages: 1, maxToolCalls: 1, maxPlanChars: 100 };
	const context = {
		facts: facts(),
		conversation: conversation({ userMessages: ["a", "b", "c"], recentToolCalls: ["t1", "t2"], declaredPlan: "p".repeat(900), toolbox: ["x: y"] }),
	};
	const intent = userIntentBlock(small).buildState(context).state as { latest: string; history: string[] };
	expect(intent.latest).toBe("c");
	expect(intent.history).toEqual([]);

	const history = actionBlocks(small)[3]?.buildState(context).state as { toolCalls: string[] } | null;
	expect(history?.toolCalls).toEqual(["t2"]);

	const plan = actionBlocks(small)[2]?.buildState(context);
	expect((plan?.state as { text: string }).text.length).toBeLessThanOrEqual(100);
	expect(plan?.truncated.some((entry) => entry.startsWith("plan.text"))).toBe(true);
});

test("subagent questions read the subject, the role, and the task, whatever the trigger", () => {
	// The questions themselves are trigger-agnostic: a forwarded ask, a
	// long-running notice, or an orchestrator's own check-in all name a subject.
	// WHO asks is the consumer's decision, not the pack's.
	expect(SUBAGENT_PACK.map((spec) => spec.id)).toEqual(["orchestrator.intent_alignment", "agent.role_adherence"]);

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
	expect(questionsFor(forwarded, SUBAGENT_PACK)).toHaveLength(2);

	// The child block names the agent and what it said it was doing; the
	// instruction the orchestrator is serving comes from the intent block.
	const context = { facts: forwarded, conversation: { userMessages: ["review the auth module"], recentToolCalls: [], declaredPlan: "reviewing the auth module for token handling", toolbox: [] } };
	const child = childWorkBlock(budget).buildState(context).state as { agent: string; role: { name: string } | null; task: { text: string } | null };
	expect(child.agent).toBe("reviewer");
	expect(child.role?.name).toBe("reviewer");
	expect(child.task?.text).toContain("auth module");
	expect((userIntentBlock(budget).buildState(context).state as { latest: string | null }).latest).toBe("review the auth module");

	// No agent name and no stated plan leave those fields null rather than
	// guessing: the judge answers with a middling probability instead.
	const bare = childWorkBlock(budget).buildState({ facts: { ...forwarded, agentName: null }, conversation: emptyConversation() }).state as { role: unknown; task: unknown };
	expect(bare.role).toBeNull();
	expect(bare.task).toBeNull();
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
