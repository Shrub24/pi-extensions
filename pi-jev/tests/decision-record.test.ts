import { expect, test } from "bun:test";

import { decisionMetrics, joinRecords, labelOf, replayCasesFrom, samplesFrom } from "../extensions/decision-record.js";
import type { AskRecord, DecisionRecord } from "../extensions/decision-record.js";

function ask(overrides: Partial<AskRecord> & { requestId: string }): AskRecord {
	return {
		record: "ask",
		version: 1,
		ts: "2026-09-19T00:00:00.000Z",
		mode: "shadow",
		judge: { model: "jev-latest", packVersion: "permission-pack-v1", stateVersion: "permission-state-v1" },
		stateHash: "abc123",
		stateChars: 100,
		truncated: [],
		bands: [{ id: "intent.authorized_by_user", band: "satisfied", probability: 0.96, threshold: 0.9 }],
		would: "allow",
		verdict: "defer",
		latencyMs: 120,
		usage: { input_tokens: 100, output_tokens: 0 },
		error: null,
		...overrides,
	};
}

function decision(overrides: Partial<DecisionRecord> & { requestId: string }): DecisionRecord {
	return {
		record: "decision",
		version: 1,
		ts: "2026-09-19T00:00:01.000Z",
		resolution: "user_approved",
		result: "allow",
		surface: "bash",
		value: "rm -rf build",
		origin: "project",
		matchedPattern: "rm *",
		agentName: "pi",
		forwarded: false,
		...overrides,
	};
}

test("only a person's answer is a label", () => {
	const rows = [
		{ resolution: "user_approved", expected: true },
		{ resolution: "user_approved_for_session", expected: true },
		{ resolution: "authorizer_allowed", expected: true },
		{ resolution: "auto_approved", expected: true },
		{ resolution: "user_denied", expected: false },
		{ resolution: "authorizer_denied", expected: false },
		{ resolution: "policy_allow", expected: undefined },
		{ resolution: "policy_deny", expected: undefined },
		{ resolution: "gate_error", expected: undefined },
		{ resolution: "confirmation_unavailable", expected: undefined },
		{ resolution: "something_new", expected: undefined },
	];
	expect.assertions(rows.length + 1);
	expect(rows.length).toBeGreaterThan(0);
	for (const row of rows) expect(labelOf(row.resolution), row.resolution).toBe(row.expected);
});

test("records join by request id and account for what did not match", () => {
	const result = joinRecords([
		ask({ requestId: "a" }),
		decision({ requestId: "a" }),
		ask({ requestId: "b", would: "deny" }),
		decision({ requestId: "b", resolution: "user_denied", result: "deny" }),
		ask({ requestId: "c" }),
		decision({ requestId: "d", resolution: "policy_allow" }),
		decision({ requestId: "c", resolution: "gate_error" }),
	]);
	expect(result.joined).toHaveLength(2);
	expect(result.unmatchedAsks).toBe(0);
	expect(result.decisionsWithoutAsk).toBe(1);
	expect(result.unlabelled).toBe(1);
});

test("metrics separate a false allow from a false deny", () => {
	const result = joinRecords([
		ask({ requestId: "a", would: "allow" }),
		decision({ requestId: "a", resolution: "user_approved" }),
		ask({ requestId: "b", would: "allow" }),
		decision({ requestId: "b", resolution: "user_denied", result: "deny" }),
		ask({ requestId: "c", would: "deny" }),
		decision({ requestId: "c", resolution: "user_approved" }),
		ask({ requestId: "d", would: "defer" }),
		decision({ requestId: "d", resolution: "user_denied", result: "deny" }),
	]);
	const metrics = decisionMetrics(result.joined);
	expect(metrics).toMatchObject({
		labelled: 4,
		approved: 2,
		denied: 2,
		wouldAllow: 2,
		wouldDeny: 1,
		wouldDefer: 1,
		falseAllow: 1,
		falseDeny: 1,
		deferDenied: 1,
		decided: 3,
	});
	// Two of the three decisions were wrong, and the deferral is not one of them.
	expect(metrics.agreement).toBeCloseTo(1 / 3, 5);
});

test("a question's probabilities become calibrated samples", () => {
	const result = joinRecords([
		ask({ requestId: "a" }),
		decision({ requestId: "a", resolution: "user_approved" }),
		ask({
			requestId: "b",
			bands: [{ id: "intent.authorized_by_user", band: "violated", probability: 0.04, threshold: 0.9 }],
		}),
		decision({ requestId: "b", resolution: "user_denied", result: "deny" }),
		ask({ requestId: "c", bands: [] }),
		decision({ requestId: "c", resolution: "user_approved" }),
	]);
	const samples = samplesFrom(result.joined, "intent.authorized_by_user");
	expect(samples).toEqual([
		{ label: true, score: 0.96, id: "a" },
		{ label: false, score: 0.04, id: "b" },
	]);
	expect(samplesFrom(result.joined, "safety.no_material_harm")).toEqual([]);
});

test("replay cases need a retained state", () => {
	const stored = joinRecords([
		ask({ requestId: "a", state: { ask: { value: "ls" } } }),
		decision({ requestId: "a", resolution: "user_approved" }),
	]);
	const hashOnly = joinRecords([ask({ requestId: "b" }), decision({ requestId: "b", resolution: "user_approved" })]);
	expect(replayCasesFrom(stored.joined)).toEqual([
		{ id: "a:intent.authorized_by_user", label: true, data: { state: { ask: { value: "ls" } }, question: "intent.authorized_by_user" } },
	]);
	expect(replayCasesFrom(hashOnly.joined)).toEqual([]);
});

test("trimmed states are counted, because their scores are not comparable", () => {
	const result = joinRecords([
		ask({ requestId: "a", truncated: ["ask.value:halved"] }),
		decision({ requestId: "a" }),
		ask({ requestId: "b" }),
		decision({ requestId: "b" }),
	]);
	expect(result.truncatedStates).toBe(1);
	expect(result.joined).toHaveLength(2);
});
