import { expect, test } from "bun:test";

import { createJevClient } from "../extensions/jev.js";
import { fakeJudge, noul } from "./fixtures/fakes.js";

function moduleWith(options: { create?: () => unknown; ask?: (judge: unknown, request: unknown, askOptions: unknown) => Promise<unknown> } = {}) {
	const judge = fakeJudge({ "intent.authorized_by_user": noul(0.97) });
	const askCalls: { judge: unknown; request: any; askOptions: any }[] = [];
	return {
		judge,
		askCalls,
		module: {
			createTypeSafe: options.create ?? (() => judge),
			ask:
				options.ask ??
				(async (active, request, askOptions) => {
					askCalls.push({ judge: active, request, askOptions });
					const evaluation = await (active as ReturnType<typeof fakeJudge>).evaluate(request as never, askOptions as never);
					return { ok: true, answers: evaluation.answers, model: evaluation.model, usage: evaluation.usage, elapsedMs: evaluation.elapsedMs };
				}),
		},
	};
}

test("a fetch failure in the loader is reported and not repeated inside the cooldown", async () => {
	let loads = 0;
	let clock = 1_000;
	const client = createJevClient({
		model: "jev-latest",
		timeoutMs: 3_000,
		maxRequests: 10,
		load: async () => {
			loads++;
			throw new Error("no such package");
		},
		now: () => clock,
	});
	const first = await client.ask({ ask: {} }, { q: { type: "noul" } });
	expect(first.ok).toBe(false);
	expect((first as { errorCode?: string }).errorCode).toBe("configuration");
	expect(client.unavailable()).toContain("pi-typesafe is not installed");

	await client.ask({ ask: {} }, { q: { type: "noul" } });
	expect(loads).toBe(1);

	clock += 30_001;
	await client.ask({ ask: {} }, { q: { type: "noul" } });
	expect(loads).toBe(2);
});

test("a module without the client or ask is treated as not installed", async () => {
	const client = createJevClient({ model: "m", timeoutMs: 1_000, maxRequests: 10, load: async () => ({ createTypeSafe: () => ({}) }), now: () => 0 });
	const result = await client.ask({}, { q: { type: "noul" } });
	expect(result.ok).toBe(false);
	expect((result as { errorCode?: string }).errorCode).toBe("configuration");
});

test("a client that cannot be built reports the configuration message and recovers after the cooldown", async () => {
	let clock = 0;
	let attempts = 0;
	const built = moduleWith({
		create: () => {
			attempts++;
			if (attempts === 1) throw new Error("No API key. Run /typesafe login in Pi, or set TYPESAFE_API_KEY in the environment.");
			return built.judge;
		},
	});
	const client = createJevClient({ model: "m", timeoutMs: 1_000, maxRequests: 10, load: async () => built.module, now: () => clock });

	const refused = await client.ask({ ask: {} }, { q: { type: "noul" } });
	expect(refused.ok).toBe(false);
	expect((refused as { errorCode?: string }).errorCode).toBe("configuration");
	expect(client.unavailable()).toContain("/typesafe login");

	// A key entered mid-session lands in the same store, so the next attempt
	// after the cooldown builds a client instead of caching the absence.
	clock += 30_001;
	const accepted = await client.ask({ ask: { value: "ls" } }, { q: { type: "noul" } });
	expect(accepted.ok).toBe(true);
	expect(attempts).toBe(2);
});

test("a successful ask passes state, questions, model and timeout through", async () => {
	const built = moduleWith();
	const client = createJevClient({ model: "jev-latest", timeoutMs: 2_500, maxRequests: 10, load: async () => built.module, now: () => 0 });
	const result = await client.ask({ ask: { value: "rm -rf build" } }, { "intent.authorized_by_user": { type: "noul" } });
	expect(result.ok).toBe(true);
	expect((result as { answers: Record<string, { noul: number }> }).answers["intent.authorized_by_user"]?.noul).toBe(0.97);

	const call = built.askCalls[0];
	expect(call.request).toEqual({ state: { ask: { value: "rm -rf build" } }, questions: { "intent.authorized_by_user": { type: "noul" } } });
	expect(call.askOptions).toEqual({ timeoutMs: 2_500, signal: undefined });
	expect(call.judge).toBe(built.judge);
	expect(client.model).toBe("jev-latest");
	expect(client.unavailable()).toBeUndefined();
});

test("a throwing ask seam becomes a settled failure, never a throw", async () => {
	const built = moduleWith({
		ask: async () => {
			throw new Error("seam defect");
		},
	});
	const client = createJevClient({ model: "m", timeoutMs: 1_000, maxRequests: 10, load: async () => built.module, now: () => 0 });
	const result = await client.ask({}, { q: { type: "noul" } });
	expect(result.ok).toBe(false);
	expect((result as { errorCode?: string }).errorCode).toBe("response");
});

test("the caller's signal reaches the judge", async () => {
	const built = moduleWith();
	const client = createJevClient({ model: "m", timeoutMs: 1_000, maxRequests: 10, load: async () => built.module, now: () => 0 });
	const controller = new AbortController();
	await client.ask({}, { q: { type: "noul" } }, { signal: controller.signal });
	expect(built.askCalls[0]?.askOptions.signal).toBe(controller.signal);
});
