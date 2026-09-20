/*
 * The registry: one core per session, whatever entry reaches it first.
 *
 * These are the properties the split depends on. A second core would mean a second
 * request for the same action and two consumers disagreeing about the same
 * answers; a core that outlives its session would serve the next one from stale
 * memory.
 */

import { beforeEach, expect, test } from "bun:test";

import { noul } from "./fixtures/fakes.js";
import { acquireCore, acquireLog, coreFor, resetRegistry } from "../extensions/registry.js";
import type { ActionContext } from "../extensions/action-pack.js";
import type { CoreRecordContext, DecisionCore } from "../extensions/decision-core.js";

beforeEach(() => resetRegistry());

const ACTION: ActionContext = { facts: {} as never, conversation: { userMessages: [], recentToolCalls: [], declaredPlan: null, toolbox: [] } };

/** A judge that answers one question and counts what it was asked. */
function judge(answer = 0.9) {
	const calls: { state: unknown; questions: unknown }[] = [];
	return {
		calls,
		async ask(state: unknown, questions: unknown) {
			calls.push({ state, questions });
			const ids = Object.keys(questions as Record<string, unknown>);
			return {
				ok: true as const,
				answers: Object.fromEntries(ids.map((id) => [id, noul(answer)])),
				model: "test",
				usage: { input_tokens: 1, output_tokens: 0 },
				elapsedMs: 1,
			};
		},
	};
}

function setup(core: DecisionCore<ActionContext>): void {
	core.registerBundle({ id: "one-v1", buildState: () => ({ state: { marker: 1 }, stateHash: "h", chars: 1, truncated: [] }) });
	core.registerQuestions([
		{
			id: "one.risk",
			stateProvider: "one-v1",
			owner: "someone",
			question: () => ({ type: "noul" }),
			read: (answer) => (answer && answer.type === "noul" ? { probability: answer.noul } : undefined),
		},
	]);
}

test("a second entry joins the core the first one made", async () => {
	const first = judge();
	const second = judge();
	const records: CoreRecordContext[] = [];
	const setupCalls: string[] = [];

	const a = acquireCore({
		sessionId: "s1",
		options: { ask: first.ask, record: (context) => records.push(context) },
		setup: (core) => {
			setupCalls.push("a");
			setup(core);
		},
	});
	const b = acquireCore({
		sessionId: "s1",
		options: { ask: second.ask, record: () => records.push({} as CoreRecordContext) },
		setup: () => setupCalls.push("b"),
	});

	expect(b.core).toBe(a.core);
	// The first lease owns the judge, and so answers for it.
	expect([a.created, b.created]).toEqual([true, false]);
	// The pack is installed once: a second registration would be a second catalog.
	expect(setupCalls).toEqual(["a"]);
	expect(a.core.questionIds()).toEqual(["one.risk"]);

	await a.core.sendDecisions({ action: ACTION, actionKey: "a1", consumer: "first", questions: ["one.risk"] });
	// The first lease's judge answered, and only one line was written for it: the
	// second lease's sink would have duplicated the record.
	expect(first.calls).toHaveLength(1);
	expect(second.calls).toHaveLength(0);
	expect(records).toHaveLength(1);
});

test("the last entry out drops the core, so a session leaves nothing behind", () => {
	const a = acquireCore({ sessionId: "s1", options: { ask: judge().ask }, setup });
	const b = acquireCore({ sessionId: "s1", options: { ask: judge().ask }, setup });
	expect(coreFor("s1")).toBe(a.core);

	a.release();
	a.release(); // releasing twice is a no-op, not a way to drop a live core
	expect(coreFor("s1")).toBeDefined();

	b.release();
	expect(coreFor("s1")).toBeUndefined();
});

test("separate sessions get separate cores and separate judges", () => {
	const one = judge();
	const two = judge();
	const a = acquireCore({ sessionId: "s1", options: { ask: one.ask }, setup });
	const b = acquireCore({ sessionId: "s2", options: { ask: two.ask }, setup });
	expect(b.core).not.toBe(a.core);
	expect(coreFor("s1")).toBe(a.core);
	expect(coreFor("s2")).toBe(b.core);
});

test("either entry's turn boundary gates the idle flush", async () => {
	const timers: (() => void)[] = [];
	const client = judge(0.4);
	const a = acquireCore({
		sessionId: "s1",
		options: { ask: client.ask, flushGapMs: 25, schedule: (run) => { timers.push(run); return () => {}; } },
		setup,
	});
	const b = acquireCore({ sessionId: "s1", options: { ask: client.ask }, setup });

	// Idle: nothing arms.
	b.core.queueDecisions({ action: ACTION, actionKey: "a1", consumer: "later", questions: ["one.risk"] });
	expect(timers).toHaveLength(0);

	// The second entry reports the turn, and the same core arms.
	b.setRunning(true);
	expect(timers).toHaveLength(0); // arming happens at the queue, not the boundary

	const c = acquireCore({ sessionId: "s1", options: { ask: client.ask }, setup });
	c.core.queueDecisions({ action: ACTION, actionKey: "a2", consumer: "later", questions: ["one.risk"] });
	expect(timers).toHaveLength(1);

	// And the first entry's report of the turn ending stops it.
	a.setRunning(false);
	timers[0]!();
	await Promise.resolve();
	expect(client.calls).toHaveLength(0);
});

test("two entries share one log for one path, and it stays open until both let go", () => {
	const first = acquireLog("/tmp/pi-jev-registry-test.jsonl");
	const second = acquireLog("/tmp/pi-jev-registry-test.jsonl");
	expect(second.log).toBe(first.log);

	first.release();
	first.release();
	expect(acquireLog("/tmp/pi-jev-registry-test.jsonl").log).toBe(first.log);
	second.release();
});
