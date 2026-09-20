import { expect, test } from "bun:test";

import { createDecisionCore } from "../extensions/decision-core.js";
import type { CoreRecordContext, DecisionCore, QuestionEntry, StateBundle } from "../extensions/decision-core.js";
import { noul, score } from "./fixtures/fakes.js";
import type { JevAnswer, JevQuestion, JevQuestions } from "../extensions/types.js";

interface Action {
	call: string;
	plan?: string;
	value?: string;
}

/** A bundle whose state is whatever the action says, plus its own marker. */
function bundle(id: string, marker: string): StateBundle<Action> {
	return {
		id,
		buildState: (action) => ({ state: { marker, call: action.call }, stateHash: `${marker}-${action.call}`, chars: 10, truncated: [] }),
	};
}

function entry(overrides: Partial<QuestionEntry<Action>> & { id: string; stateProvider: string; owner: string }): QuestionEntry<Action> {
	return {
		question: () => ({ type: "noul" } as JevQuestion),
		read: (answer) => (answer && answer.type === "noul" ? { probability: answer.noul } : undefined),
		...overrides,
	};
}

/** A judge that answers everything with a table, and counts its requests. */
function judge(answers: Record<string, JevAnswer> = {}) {
	const calls: { state: unknown; questions: JevQuestions }[] = [];
	return {
		calls,
		async ask(state: unknown, questions: JevQuestions) {
			calls.push({ state, questions });
			return {
				ok: true as const,
				answers: Object.fromEntries(Object.entries(answers).filter(([id]) => id in questions)) as Record<string, JevAnswer>,
				model: "test",
				usage: { input_tokens: 5, output_tokens: 1 },
				elapsedMs: 3,
			};
		},
	};
}

function core(overrides: Parameters<typeof createDecisionCore<Action>>[0]) {
	const records: CoreRecordContext[] = [];
	const created: DecisionCore<Action> = createDecisionCore<Action>({ ...overrides, record: (context) => records.push(context) });
	const offBundle = created.registerBundle(bundle("surface-v1", "surface"));
	const offQuestions = created.registerQuestions([
		entry({ id: "surface.risk", stateProvider: "surface-v1", owner: "permission" }),
		entry({ id: "surface.scope", stateProvider: "surface-v1", owner: "permission" }),
		entry({ id: "plan.matches", stateProvider: "plan-v1", owner: "intent" }),
	]);
	return { core: created, records, offBundle, offQuestions };
}

const ACTION: Action = { call: "bash gg", plan: "read the log" };

test("queueing is per consumer, deduplicated, and asks for nothing", () => {
	const client = judge();
	const { core: created } = core({ ask: client.ask });

	expect(created.queueDecisions({ action: ACTION, actionKey: "call-1", consumer: "monitor", questions: ["surface.risk"] })).toEqual(["surface.risk"]);
	expect(created.queueDecisions({ action: ACTION, actionKey: "call-1", consumer: "cache", questions: ["surface.risk"] })).toEqual(["surface.risk"]);
	expect(created.queueDecisions({ action: ACTION, actionKey: "call-1", consumer: "monitor", questions: ["surface.risk"] })).toEqual([]);
	expect(client.calls).toHaveLength(0);
	expect(created.queued("call-1")).toHaveLength(2);
});

test("a send carries every active consumer's questions, and asks once", async () => {
	const client = judge({ "surface.risk": noul(0.2), "surface.scope": noul(0.9), "plan.matches": noul(0.95) });
	const { core: created } = core({ ask: client.ask });
	created.registerBundle(bundle("plan-v1", "plan"));
	created.registerConsumer({ id: "monitor", questions: ["surface.scope"] });
	created.registerConsumer({ id: "intent", questions: ["plan.matches"] });

	// One send from one consumer, and the whole active set rides it.
	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk"] });
	expect(client.calls).toHaveLength(2);
	const asked = client.calls.flatMap((call) => Object.keys(call.questions)).sort();
	expect(asked).toEqual(["plan.matches", "surface.risk", "surface.scope"]);
	expect(result.readings["plan.matches"]?.probability).toBe(0.95);
});

test("a consumer's applies() narrows what gets queued", () => {
	const { core: created } = core({ ask: judge().ask });
	created.registerConsumer({ id: "permission", questions: ["surface.risk"], applies: (action) => action.call.startsWith("bash") });
	created.registerConsumer({ id: "intent", questions: ["plan.matches"], applies: (action) => action.plan !== undefined });

	// A read call has a plan but is not a bash call: only intent queues.
	expect(created.queueDecisions({ action: { call: "read x", plan: "check the log" }, actionKey: "call-2", consumer: "intent", questions: ["plan.matches"] })).toEqual(["plan.matches"]);
	// A bash call with no plan: only permission queues.
	expect(created.queueDecisions({ action: { call: "bash x" }, actionKey: "call-3", consumer: "permission", questions: ["surface.risk"] })).toEqual(["surface.risk"]);
});

test("a flush groups queued questions by state provider: one request per group", async () => {
	const client = judge({ "surface.risk": noul(0.2), "surface.scope": noul(0.9), "plan.matches": noul(0.95) });
	const { core: created, records } = core({ ask: client.ask });
	created.registerBundle(bundle("plan-v1", "plan"));
	created.registerConsumer({ id: "permission", questions: ["surface.risk", "surface.scope"] });
	created.registerConsumer({ id: "intent", questions: ["plan.matches"] });

	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk", "surface.scope"] });

	expect(client.calls).toHaveLength(2);
	const byState = client.calls.map((call) => (call.state as { marker: string }).marker).sort();
	expect(byState).toEqual(["plan", "surface"]);
	expect(Object.keys(client.calls.find((call) => (call.state as { marker: string }).marker === "surface")?.questions ?? {})).toEqual([
		"surface.risk",
		"surface.scope",
	]);
	expect(Object.keys(client.calls.find((call) => (call.state as { marker: string }).marker === "plan")?.questions ?? {})).toEqual(["plan.matches"]);

	expect(result.ok).toBe(true);
	expect(result.readings["surface.risk"]).toMatchObject({ probability: 0.2, owner: "permission", ok: true });
	expect(result.readings["plan.matches"]).toMatchObject({ probability: 0.95, owner: "intent", ok: true });
	expect(records).toHaveLength(2);
	expect(records.map((record) => record.stateProvider).sort()).toEqual(["plan-v1", "surface-v1"]);
	expect(records.map((record) => record.stateHash).sort()).toEqual(["plan-bash gg", "surface-bash gg"]);
});

test("each consumer is handed only its own questions", async () => {
	const client = judge({ "surface.risk": noul(0.2), "surface.scope": noul(0.9), "plan.matches": noul(0.95) });
	const { core: created } = core({ ask: client.ask });
	created.registerBundle(bundle("plan-v1", "plan"));
	const deliveries: { consumer: string; ids: string[]; ok: boolean }[] = [];
	created.registerConsumer({ id: "permission", questions: ["surface.risk", "surface.scope"], onAnswers: (delivery) => deliveries.push({ consumer: delivery.consumer, ids: delivery.readings.map((reading) => reading.question), ok: delivery.ok }) });
	created.registerConsumer({ id: "intent", questions: ["plan.matches"], onAnswers: (delivery) => deliveries.push({ consumer: delivery.consumer, ids: delivery.readings.map((reading) => reading.question), ok: delivery.ok }) });

	await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk", "surface.scope"] });

	expect(deliveries).toEqual([
		{ consumer: "permission", ids: ["surface.risk", "surface.scope"], ok: true },
		{ consumer: "intent", ids: ["plan.matches"], ok: true },
	]);
});

test("a consumer arriving after the flush is served from memory, asking nothing new", async () => {
	const client = judge({ "surface.risk": noul(0.2) });
	const { core: created } = core({ ask: client.ask });

	const first = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk"] });
	expect(client.calls).toHaveLength(1);
	expect(first?.requests).toHaveLength(1);

	// The second consumer wants the same question: no request, no latency.
	const second = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "monitor", questions: ["surface.risk"] });
	expect(client.calls).toHaveLength(1);
	expect(second?.requests).toHaveLength(0);
	expect(second?.reused).toEqual(["surface.risk"]);
	expect(second?.readings["surface.risk"]?.probability).toBe(0.2);
});

test("a consumer arriving later with a new question asks only for the difference", async () => {
	const client = judge({ "surface.risk": noul(0.2), "surface.scope": noul(0.9) });
	const { core: created } = core({ ask: client.ask });

	await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk"] });
	const second = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "intent", questions: ["surface.risk", "surface.scope"] });

	expect(client.calls).toHaveLength(2);
	expect(Object.keys(client.calls[1]?.questions ?? {})).toEqual(["surface.scope"]);
	expect(second?.reused).toEqual(["surface.risk"]);
	expect(second?.readings["surface.scope"]?.probability).toBe(0.9);
});

test("a batched request queues and is answered by the next send", async () => {
	const client = judge({ "surface.risk": noul(0.2) });
	const { core: created } = core({ ask: client.ask });

	created.queueDecisions({ action: ACTION, actionKey: "call-1", consumer: "monitor", questions: ["surface.risk"] });
	expect(client.calls).toHaveLength(0);
	expect(created.queued("call-1")).toEqual([{ question: "surface.risk", consumer: "monitor" }]);

	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission" });
	expect(client.calls).toHaveLength(1);
	expect(result.readings["surface.risk"]?.probability).toBe(0.2);
	expect(created.queued("call-1")).toEqual([]);
});

test("a queued question is asked anyway once the gap passes with no send", async () => {
	const timers: { run: () => void; ms: number }[] = [];
	const client = judge({ "surface.risk": noul(0.3) });
	const created = createDecisionCore<Action>({
		ask: client.ask,
		flushGapMs: 250,
		schedule: (run, ms) => {
			timers.push({ run, ms });
			return () => {
				const index = timers.findIndex((timer) => timer.run === run);
				if (index >= 0) timers.splice(index, 1);
			};
		},
	});
	created.registerQuestions([entry({ id: "surface.risk", stateProvider: "surface-v1", owner: "monitor" })]);

	created.queueDecisions({ action: ACTION, actionKey: "call-1", consumer: "monitor", questions: ["surface.risk"] });
	expect(timers).toHaveLength(1);
	expect(timers[0]?.ms).toBe(250);
	expect(client.calls).toHaveLength(0);

	// The gap passes with nothing sending: the queue is asked anyway, late.
	timers[0]?.run();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(client.calls).toHaveLength(1);
	expect(created.queued("call-1")).toEqual([]);
});

test("a send cancels the idle flush it would otherwise duplicate", async () => {
	const timers: { run: () => void }[] = [];
	const client = judge({ "surface.risk": noul(0.3) });
	const created = createDecisionCore<Action>({
		ask: client.ask,
		flushGapMs: 250,
		schedule: (run) => {
			timers.push({ run });
			return () => {
				const index = timers.findIndex((timer) => timer.run === run);
				if (index >= 0) timers.splice(index, 1);
			};
		},
	});
	created.registerQuestions([entry({ id: "surface.risk", stateProvider: "surface-v1", owner: "monitor" })]);

	created.queueDecisions({ action: ACTION, actionKey: "call-1", consumer: "monitor", questions: ["surface.risk"] });
	await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission" });
	expect(timers).toHaveLength(0);
	expect(client.calls).toHaveLength(1);
});

test("flushPending asks everything left queued, for a host boundary", async () => {
	const client = judge({ "surface.risk": noul(0.3) });
	const { core: created } = core({ ask: client.ask });

	created.queueDecisions({ action: ACTION, actionKey: "call-1", consumer: "monitor", questions: ["surface.risk"] });
	created.queueDecisions({ action: ACTION, actionKey: "call-2", consumer: "monitor", questions: ["surface.risk"] });
	const results = await created.flushPending();
	expect(results).toHaveLength(2);
	expect(client.calls).toHaveLength(2);
	expect(await created.flushPending()).toEqual([]);
});

test("a send's ceiling aborts what is still in flight", async () => {
	const timers: { run: () => void; ms: number }[] = [];
	const created = createDecisionCore<Action>({
		ask: async (state, questions, options) => {
			if (options?.signal) {
				await new Promise((resolve) => options.signal?.addEventListener("abort", resolve, { once: true }));
				return { ok: false, error: "TypeSafe request cancelled before submission.", errorCode: "aborted" };
			}
			return { ok: true, answers: {}, model: "test", usage: { input_tokens: 1, output_tokens: 0 }, elapsedMs: 1 };
		},
		schedule: (run, ms) => {
			timers.push({ run, ms });
			return () => {
				const index = timers.findIndex((timer) => timer.run === run);
				if (index >= 0) timers.splice(index, 1);
			};
		},
	});
	created.registerQuestions([entry({ id: "surface.risk", stateProvider: "surface-v1", owner: "monitor" })]);

	const pending = created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "monitor", questions: ["surface.risk"], timeoutMs: 50 });
	expect(timers[0]?.ms).toBe(50);
	timers[0]?.run();
	const result = await pending;
	expect(result.ok).toBe(false);
	expect(result.requests[0]?.error?.code).toBe("aborted");
});

test("two concurrent asks for one action share a single request", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const client = judge({ "surface.risk": noul(0.4) });
	const ask = async (state: unknown, questions: JevQuestions) => {
		await gate;
		return client.ask(state, questions);
	};
	const { core: created } = core({ ask });

	const both = Promise.all([
		created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk"] }),
		created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "monitor", questions: ["surface.risk"] }),
	]);
	release?.();
	const [first, second] = await both;
	expect(client.calls).toHaveLength(1);
	// One of them asked and got a request; the other waited on the same promise.
	expect([first?.requests.length, second?.requests.length].sort()).toEqual([0, 1]);
	expect([first?.reused.length, second?.reused.length].sort()).toEqual([0, 1]);
	expect(first?.ok).toBe(true);
	expect(second?.ok).toBe(true);
	expect(first?.readings["surface.risk"]?.probability).toBe(0.4);
	expect(second?.readings["surface.risk"]?.probability).toBe(0.4);
});

test("a failed request is an atomic failure for its consumers, and other groups still answer", async () => {
	const calls: JevQuestions[] = [];
	const { core: created, records } = core({
		ask: async (state, questions) => {
			calls.push(questions);
			if ((state as { marker: string }).marker === "surface") return { ok: false, error: "TypeSafe request timed out.", errorCode: "timeout" };
			return { ok: true, answers: { "plan.matches": noul(0.93) }, model: "test", usage: { input_tokens: 5, output_tokens: 1 }, elapsedMs: 3 };
		},
	});
	created.registerBundle(bundle("plan-v1", "plan"));
	const deliveries: { consumer: string; ok: boolean; ids: string[] }[] = [];
	created.registerConsumer({ id: "permission", questions: ["surface.risk", "surface.scope"], onAnswers: (delivery) => deliveries.push({ consumer: delivery.consumer, ok: delivery.ok, ids: delivery.readings.map((reading) => reading.question) }) });
	created.registerConsumer({ id: "intent", questions: ["plan.matches"], onAnswers: (delivery) => deliveries.push({ consumer: delivery.consumer, ok: delivery.ok, ids: delivery.readings.map((reading) => reading.question) }) });

	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk", "surface.scope"] });

	expect(result.ok).toBe(false);
	// The permission consumer holds no partial set: both of its questions are missing.
	expect(result.readings["surface.risk"]).toMatchObject({ ok: false, probability: null });
	expect(result.readings["surface.scope"]).toMatchObject({ ok: false });
	expect(deliveries.find((delivery) => delivery.consumer === "permission")).toEqual({ consumer: "permission", ok: false, ids: ["surface.risk", "surface.scope"] });
	// The other group answered and was delivered normally.
	expect(deliveries.find((delivery) => delivery.consumer === "intent")).toEqual({ consumer: "intent", ok: true, ids: ["plan.matches"] });
	const failed = records.filter((record) => !record.request.ok);
	expect(failed).toHaveLength(1);
	expect(failed[0]?.request.error?.code).toBe("timeout");
});

test("a consumer set larger than one request is not silently split", async () => {
	const calls: JevQuestions[] = [];
	const { core: created } = core({
		maxQuestionsPerRequest: 2,
		ask: async (state, questions) => {
			calls.push(questions);
			return { ok: true, answers: {}, model: "test", usage: { input_tokens: 1, output_tokens: 0 }, elapsedMs: 1 };
		},
	});
	created.registerQuestions([
		entry({ id: "big.a", stateProvider: "surface-v1", owner: "big" }),
		entry({ id: "big.b", stateProvider: "surface-v1", owner: "big" }),
		entry({ id: "big.c", stateProvider: "surface-v1", owner: "big" }),
	]);
	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "big", questions: ["big.a", "big.b", "big.c"] });
	expect(calls).toHaveLength(1);
	expect(Object.keys(calls[0] ?? {})).toEqual(["big.a", "big.b", "big.c"]);
	expect(result?.requests).toHaveLength(1);
});

test("whole sets fill chunks greedily, so one request still carries several consumers", async () => {
	const calls: JevQuestions[] = [];
	const { core: created } = core({
		maxQuestionsPerRequest: 4,
		ask: async (state, questions) => {
			calls.push(questions);
			return { ok: true, answers: {}, model: "test", usage: { input_tokens: 1, output_tokens: 0 }, elapsedMs: 1 };
		},
	});
	created.registerQuestions([
		entry({ id: "b.a", stateProvider: "surface-v1", owner: "b" }),
		entry({ id: "b.b", stateProvider: "surface-v1", owner: "b" }),
		entry({ id: "c.a", stateProvider: "surface-v1", owner: "c" }),
		entry({ id: "c.b", stateProvider: "surface-v1", owner: "c" }),
		entry({ id: "d.a", stateProvider: "surface-v1", owner: "d" }),
	]);
	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "all", questions: ["b.a", "b.b", "c.a", "c.b", "d.a"] });
	expect(calls).toHaveLength(2);
	expect(Object.keys(calls[0] ?? {})).toEqual(["b.a", "b.b", "c.a", "c.b"]);
	expect(Object.keys(calls[1] ?? {})).toEqual(["d.a"]);
	expect(result?.requests.flatMap((request) => request.questions)).toEqual(["b.a", "b.b", "c.a", "c.b", "d.a"]);
});

test("an unregistered question is a missing reading, never a throw", async () => {
	const client = judge();
	const { core: created } = core({ ask: client.ask });
	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "monitor", questions: ["nobody.owns.this"] });
	expect(client.calls).toHaveLength(0);
	expect(result?.readings["nobody.owns.this"]).toEqual({ question: "nobody.owns.this", owner: "unregistered", probability: null, level: null, ok: false });
});

test("a question whose applies() says no is a missing reading with its owner named", async () => {
	const client = judge();
	const { core: created } = core({ ask: client.ask });
	created.registerQuestions([entry({ id: "surface.only-reads", stateProvider: "surface-v1", owner: "permission", applies: (action) => action.call.startsWith("read") })]);
	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.only-reads"] });
	expect(client.calls).toHaveLength(0);
	expect(result?.readings["surface.only-reads"]).toMatchObject({ owner: "permission", ok: false });
});

test("a score answer is normalized as a level, not a probability", async () => {
	const client = judge({ "surface.rev": score(3) });
	const { core: created } = core({ ask: client.ask });
	created.registerQuestions([
		entry({
			id: "surface.rev",
			stateProvider: "surface-v1",
			owner: "permission",
			read: (answer) => (answer && answer.type === "score" ? { level: Math.round(answer.score) } : undefined),
		}),
	]);
	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.rev"] });
	expect(result?.readings["surface.rev"]).toMatchObject({ question: "surface.rev", owner: "permission", probability: null, level: 3, ok: true });
});

test("the interpreter's output rides the request record, and its defects cannot fail one", async () => {
	const client = judge({ "surface.risk": noul(0.8) });
	const { core: created, records } = core({ ask: client.ask });
	const result = await created.sendDecisions({
		action: ACTION,
		actionKey: "call-1",
		consumer: "permission",
		questions: ["surface.risk"],
		interpret: (readings) => ({ would: readings[0]?.probability === 0.8 ? "allow" : "deny" }),
	});
	expect(records[0]?.interpreted).toEqual({ would: "allow" });
	expect(result?.ok).toBe(true);

	const angry = core({ ask: client.ask });
	await angry.core.sendDecisions({
		action: ACTION,
		actionKey: "call-2",
		consumer: "permission",
		questions: ["surface.risk"],
		interpret: () => {
			throw new Error("bad interpreter");
		},
	});
	expect(angry.records[0]?.interpreted).toBeUndefined();
	expect(angry.records).toHaveLength(1);
});

test("a question whose state provider is missing still asks, with an empty state", async () => {
	const client = judge({ "ghost.q": noul(0.5) });
	const records: CoreRecordContext[] = [];
	const created = createDecisionCore<Action>({ ask: client.ask, record: (context) => records.push(context) });
	created.registerQuestions([entry({ id: "ghost.q", stateProvider: "ghost-v1", owner: "monitor" })]);

	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "monitor", questions: ["ghost.q"] });
	expect(client.calls[0]?.state).toEqual({});
	expect(result?.readings["ghost.q"]?.probability).toBe(0.5);
	expect(records[0]?.stateHash).toBe("");
});

test("answers are remembered per action, and forget() drops them", async () => {
	const client = judge({ "surface.risk": noul(0.1) });
	const { core: created } = core({ ask: client.ask });
	await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk"] });
	await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk"] });
	expect(client.calls).toHaveLength(1);

	created.forget("call-1");
	await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk"] });
	expect(client.calls).toHaveLength(2);
});

test("the cache is bounded: the least recently used action is dropped first", async () => {
	const client = judge({ "surface.risk": noul(0.1) });
	const { core: created } = core({ ask: client.ask, maxRememberedActions: 2 });
	for (const key of ["a", "b", "c"]) {
		await created.sendDecisions({ action: ACTION, actionKey: key, consumer: "permission", questions: ["surface.risk"] });
	}
	expect(client.calls).toHaveLength(3);
	// `a` was evicted by `c`; asking again pays a request.
	await created.sendDecisions({ action: ACTION, actionKey: "a", consumer: "permission", questions: ["surface.risk"] });
	expect(client.calls).toHaveLength(4);
	// `c` is still remembered.
	await created.sendDecisions({ action: ACTION, actionKey: "c", consumer: "permission", questions: ["surface.risk"] });
	expect(client.calls).toHaveLength(4);
});

test("disposers remove bundles, questions, and consumer interest", async () => {
	const client = judge({ "surface.risk": noul(0.7) });
	const { core: created, offBundle, offQuestions } = core({ ask: client.ask });
	const offConsumer = created.registerConsumer({ id: "permission", questions: ["surface.risk"] });

	expect(created.questionIds()).toEqual(["surface.risk", "surface.scope", "plan.matches"]);
	expect(created.queueDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk"] })).toEqual(["surface.risk"]);

	offConsumer();
	expect(created.queueDecisions({ action: ACTION, actionKey: "call-2", consumer: "permission", questions: ["surface.risk"] })).toEqual(["surface.risk"]);

	offQuestions();
	offBundle();
	expect(created.questionIds()).toEqual([]);
	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-3", consumer: "permission", questions: ["surface.risk"] });
	expect(client.calls).toHaveLength(0);
	expect(result?.readings["surface.risk"]?.ok).toBe(false);
});

test("a consumer that throws on delivery does not stop the others", async () => {
	const client = judge({ "surface.risk": noul(0.2), "surface.scope": noul(0.3) });
	const { core: created } = core({ ask: client.ask });
	const seen: string[] = [];
	created.registerConsumer({
		id: "angry",
		questions: ["surface.risk"],
		onAnswers: () => {
			throw new Error("no");
		},
	});
	created.registerConsumer({ id: "calm", questions: ["surface.scope"], onAnswers: () => seen.push("calm") });

	created.queueDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk", "surface.scope"] });
	await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission" });
	expect(seen).toEqual(["calm"]);
});

test("a bundle selected by id asks for everything that reads it", async () => {
	const client = judge({ "surface.risk": noul(0.4), "surface.scope": noul(0.4), "plan.matches": noul(0.4) });
	const { core: created } = core({ ask: client.ask });
	created.registerBundle(bundle("plan-v1", "plan"));
	const result = await created.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", bundle: "surface-v1" });
	expect(client.calls).toHaveLength(1);
	expect(Object.keys(client.calls[0]?.questions ?? {})).toEqual(["surface.risk", "surface.scope"]);
	expect(result?.requests).toHaveLength(1);
});
test("the idle flush never runs while the host is idle", async () => {
	const timers: Array<() => void> = [];
	const armed = (isRunning?: () => boolean) => {
		const client = judge({});
		const created = core({ ask: client.ask, flushGapMs: 50, schedule: (run) => { timers.push(run); return () => {}; }, isRunning });
		return { created, client };
	};

	// Idle: nothing arms, nothing is spent.
	const idle = armed(() => false);
	idle.created.core.queueDecisions({ action: ACTION, actionKey: "a", consumer: "monitor", questions: ["surface.risk"] });
	expect(timers).toHaveLength(0);
	expect(idle.client.calls).toHaveLength(0);

	// Mid-turn: it arms, and a turn that ended before it fires does not spend.
	const running = { value: true };
	const live = armed(() => running.value);
	live.created.core.queueDecisions({ action: ACTION, actionKey: "a", consumer: "monitor", questions: ["surface.risk"] });
	expect(timers).toHaveLength(1);
	running.value = false;
	timers[0]!();
	await Promise.resolve();
	expect(live.client.calls).toHaveLength(0);

	// The boundary drains it instead, which costs nothing extra.
	expect(await live.created.core.flushPending()).toHaveLength(1);
	expect(live.client.calls).toHaveLength(1);
});

test("draining disarms the timer it would otherwise duplicate", async () => {
	const client = judge({});
	const timers: Array<() => void> = [];
	const created = core({ ask: client.ask, flushGapMs: 50, schedule: (run) => { timers.push(run); return () => {}; } });
	created.core.queueDecisions({ action: ACTION, actionKey: "a", consumer: "monitor", questions: ["surface.risk"] });
	expect(timers).toHaveLength(1);
	await created.core.flushPending();
	expect(timers).toHaveLength(1);
	expect(client.calls).toHaveLength(1);
});

test("a reworded question is asked again instead of served from the old answer", async () => {
	let call = 0;
	const client = judge();
	const created = core({
		ask: (state, questions) => {
			call += 1;
			return client.ask(state, {
				...questions,
				"surface.scope": call === 1 ? { type: "choice", criteria: { a: "first wording" } } : { type: "choice", criteria: { b: "second wording" } },
			});
		},
	});
	created.core.registerQuestions([
		entry({
			id: "surface.scope",
			stateProvider: "surface-v1",
			owner: "permission",
			question: () => (call === 1 ? { type: "choice", criteria: { a: "first wording" } } : { type: "choice", criteria: { b: "second wording" } }),
			read: (answer) => (answer?.type === "choice" ? { probability: 1, choice: answer.choice } : undefined) as never,
		}),
	]);

	await created.core.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.scope"] });
	// Same action, same question id, different wording: the cached reading does not
	// apply, so this is a second request, not a reuse.
	const second = await created.core.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.scope"] });
	expect(client.calls).toHaveLength(2);
	expect(second.reused).toEqual([]);
});

test("an unchanged wording is still served from memory", async () => {
	const client = judge({});
	const created = core({ ask: client.ask });
	await created.core.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk"] });
	const second = await created.core.sendDecisions({ action: ACTION, actionKey: "call-1", consumer: "permission", questions: ["surface.risk"] });
	expect(client.calls).toHaveLength(1);
	expect(second.reused).toEqual(["surface.risk"]);
});
