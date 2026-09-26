import { beforeEach, expect, test } from "bun:test";

import { checkInAction, checkInSubjectKey, combineFindings, newNotices, noticeAgent, noticeNeedsAttention, noticeSubject, latestUserMessage } from "../extensions/check-in.js";
import type { ChildNotice } from "../extensions/check-in.js";
import { resetRegistry } from "../extensions/registry.js";

beforeEach(() => resetRegistry());

const entry = (overrides: Record<string, unknown> = {}) => ({
	type: "custom_message",
	customType: "subagent_control_notice",
	id: "n1",
	content: "Subagent active but long-running: reviewer\nRun: bg-1 step 1\nSignal: reviewer is still active but long-running",
	...overrides,
});

/** A `ChildNotice` as the scan produces it — the shape the rest of the module reads. */
const notice = (overrides: Record<string, unknown> = {}) => newNotices([entry(overrides)], new Set())[0] as ChildNotice;

test("notices are read once each, and only the kinds pi-subagents writes", () => {
	const entries = [
		entry(),
		entry({ id: "n2", content: "second" }),
		// Not a notice: a user message, and a custom type this judge ignores.
		{ type: "message", role: "user", content: "hello" },
		entry({ id: "n3", customType: "some-other-extension", content: "ignore me" }),
		// A notice with no text says nothing to judge.
		entry({ id: "n4", content: "   " }),
	];
	const fresh = newNotices(entries, new Set());
	expect(fresh.map((entry) => entry.id)).toEqual(["n1", "n2"]);

	// A second scan reads nothing new: the id is the dedupe key.
	expect(newNotices(entries, new Set(["n1", "n2"]))).toEqual([]);

	// An entry with no id still gets a stable one from its position.
	const anonymous = newNotices([entry({ id: undefined })], new Set());
	expect(anonymous[0]?.id).toBe("subagent_control_notice#0");
});

test("the notice scan is bounded, keeping the newest", () => {
	const entries = Array.from({ length: 10 }, (_, index) => entry({ id: `n${index}`, content: `notice ${index}` }));
	expect(newNotices(entries, new Set()).map((entry) => entry.id)).toEqual(["n6", "n7", "n8", "n9"]);
});

test("a notice's subject is its first line, and its agent is parsed when named", () => {
	expect(noticeSubject(notice({ content: `${"x".repeat(400)}\nsecond line` })).length).toBe(300);
	expect(noticeSubject(notice({ content: "first line\nsecond" }))).toBe("first line");

	expect(noticeAgent(notice({ content: "Subagent active but long-running: reviewer\nRun: bg-1" }))).toBe("reviewer");
	expect(noticeAgent(notice({ content: "Subagent needs attention: fixer-2" }))).toBe("fixer-2");
	expect(noticeAgent(notice({ content: "Subagent failed: critic-1" }))).toBe("critic-1");
	// The loose "agent <word>" reading would call this agent "active".
	expect(noticeAgent(notice({ content: "Subagent active but long-running" }))).toBeNull();
	expect(noticeAgent(notice({ content: "something happened" }))).toBeNull();
});

test("only notices that say something is wrong need a check-in", () => {
	expect(noticeNeedsAttention(notice({ content: "Subagent active but long-running: reviewer\nRun: bg-1" }))).toBe(true);
	expect(noticeNeedsAttention(notice({ content: "Subagent needs attention: fixer-2" }))).toBe(true);
	expect(noticeNeedsAttention(notice({ content: "Subagent failed: critic" }))).toBe(true);
	// A completion is not a check-in: pi-subagents already decides whether a
	// finished child deserves a turn of its own.
	expect(noticeNeedsAttention(notice({ content: "Subagent completed: fixer" }))).toBe(false);
	expect(noticeNeedsAttention(notice({ content: "Subagent finished in 3m" }))).toBe(false);
});

test("a check-in's action names its own surface and carries the notice as the subject", () => {
	const action = checkInAction(notice(), { userMessages: ["fix the parser"], recentToolCalls: [], toolTrend: null, declaredPlan: "running the suite", toolbox: [] });
	expect(action.facts.surface).toBe("subagent_check_in");
	expect(action.facts.kind).toBe("subagent");
	expect(action.facts.value).toContain("Subagent active but long-running");
	expect(action.facts.agentName).toBe("reviewer");
	// A check-in is not a forwarded ask: nothing is asking on a child's behalf.
	expect(action.facts.forwarded).toBe(false);
	expect(checkInSubjectKey(notice())).toBe("child:notice:n1");
	expect(latestUserMessage(action.conversation)).toBe("fix the parser");
	expect(latestUserMessage({ userMessages: [], recentToolCalls: [], toolTrend: null, declaredPlan: null, toolbox: [] })).toBeNull();
});

test("a scan's findings become one wake, keeping the weakest evidence claim", () => {
	const measured = { source: "orchestrator.intent_alignment", role: "advisory", severity: "warn", measured: true, text: "first finding" };
	const unmeasured = { source: "agent.role_adherence", role: "advisory", severity: "warn", measured: false, text: "second finding" };

	expect(combineFindings([])).toBeUndefined();

	// One finding keeps its own source, so the log line and the sentence agree.
	expect(combineFindings([measured])?.source).toBe("orchestrator.intent_alignment");

	// Several collapse into one message under one source: the wake is the cost.
	const combined = combineFindings([measured, unmeasured]);
	expect(combined?.source).toBe("orchestrator.check_in");
	expect(combined?.text).toContain("first finding");
	expect(combined?.text).toContain("second finding");
	// A scan resting on a guess says so, even beside a measured finding.
	expect(combined?.measured).toBe(false);

	// A long scan is bounded; the full findings are always in the log.
	const many = Array.from({ length: 40 }, (_, index) => ({ ...measured, text: `finding ${index} ${"x".repeat(60)}` }));
	expect(combineFindings(many)?.text.length).toBe(1_200);
});
