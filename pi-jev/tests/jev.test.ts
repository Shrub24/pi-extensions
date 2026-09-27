import { expect, test } from "bun:test";

import { budgetFrom, createJevClient, installedPiTypesafe } from "../extensions/jev.js";
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

test("a checkout falls back to the copy Pi installed", () => {
	const asked: string[] = [];
	const href = installedPiTypesafe({ PI_CODING_AGENT_DIR: "/agent" } as NodeJS.ProcessEnv, (path) => {
		asked.push(path);
		return true;
	});
	expect(asked).toEqual(["/agent/npm/node_modules/pi-typesafe/dist/index.js"]);
	expect(href).toBe("file:///agent/npm/node_modules/pi-typesafe/dist/index.js");

	// Nothing installed: the bare specifier stands as the only answer, so the
	// loader reports what it always reported.
	expect(installedPiTypesafe({ PI_CODING_AGENT_DIR: "/agent" } as NodeJS.ProcessEnv, () => false)).toBeUndefined();
});

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

test("a burst past the minute window is skipped with a rate code, and recovers when the window slides", async () => {
	const built = moduleWith();
	let clock = 1_000_000;
	const client = createJevClient({
		model: "m",
		timeoutMs: 1_000,
		maxRequests: 100,
		ratePerMinute: 2,
		ratePerHour: 0,
		load: async () => built.module,
		now: () => clock,
	});
	expect((await client.ask({}, { q: { type: "noul" } })).ok).toBe(true);
	expect((await client.ask({}, { q: { type: "noul" } })).ok).toBe(true);
	const third = await client.ask({}, { q: { type: "noul" } });
	expect(third.ok).toBe(false);
	expect((third as { errorCode?: string }).errorCode).toBe("rate");
	// The judged requests reached the client; the skipped one did not.
	expect(built.askCalls.length).toBe(2);

	clock += 60_001;
	const fourth = await client.ask({}, { q: { type: "noul" } });
	expect(fourth.ok).toBe(true);
	expect(built.askCalls.length).toBe(3);
});

test("the hour window holds when the minute window does not", async () => {
	const built = moduleWith();
	let clock = 0;
	const client = createJevClient({
		model: "m",
		timeoutMs: 1_000,
		maxRequests: 100,
		ratePerMinute: 0,
		ratePerHour: 2,
		load: async () => built.module,
		now: () => clock,
	});
	await client.ask({}, { q: { type: "noul" } });
	clock += 60_000;
	await client.ask({}, { q: { type: "noul" } });
	clock += 60_000;
	const third = await client.ask({}, { q: { type: "noul" } });
	expect(third.ok).toBe(false);
	expect((third as { errorCode?: string }).errorCode).toBe("rate");

	clock += 3_600_001;
	expect((await client.ask({}, { q: { type: "noul" } })).ok).toBe(true);
});

test("the day cap reaches pi-typesafe's client, and 0 leaves it out", async () => {
	const seen: Record<string, unknown>[] = [];
	const built = moduleWith({
		create: () => {
			return built.judge;
		},
	});
	// createTypeSafe must receive the day cap; the fake records what it was given.
	const recording = {
		createTypeSafe: (options: Record<string, unknown>) => {
			seen.push(options);
			return built.judge;
		},
		ask: built.module.ask,
	};
	const withCap = createJevClient({ model: "m", timeoutMs: 1_000, maxRequests: 10, maxRequestsPerDay: 400, load: async () => recording, now: () => 0 });
	await withCap.ask({}, { q: { type: "noul" } });
	expect(seen[0]?.maxRequestsPerDay).toBe(400);
	expect(seen[0]?.maxRequests).toBe(10);

	const withoutCap = createJevClient({ model: "m", timeoutMs: 1_000, maxRequests: 10, load: async () => recording, now: () => 0 });
	await withoutCap.ask({}, { q: { type: "noul" } });
	expect("maxRequestsPerDay" in (seen[1] as Record<string, unknown>)).toBe(false);
});

test("budgetFrom carries the config's numbers and omits a disabled day cap", async () => {
	const built = moduleWith();
	const seen: Record<string, unknown>[] = [];
	const recording = {
		createTypeSafe: (options: Record<string, unknown>) => {
			seen.push(options);
			return built.judge;
		},
		ask: built.module.ask,
	};
	const client = createJevClient({
		model: "m",
		timeoutMs: 1_000,
		...budgetFrom({ maxRequestsPerSession: 5_000, maxRequestsPerDay: 0, rateLimitPerMinute: 60, rateLimitPerHour: 1_000 }),
		load: async () => recording,
		now: () => 0,
	});
	await client.ask({}, { q: { type: "noul" } });
	expect(seen[0]).toMatchObject({ maxRequests: 5_000 });
	expect("maxRequestsPerDay" in (seen[0] as Record<string, unknown>)).toBe(false);
});
