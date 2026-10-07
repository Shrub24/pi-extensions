import { expect, test } from "bun:test";
import type { ClassifierModel, ClassifierApi, ClassifierResult } from "@earendil-works/pi-ai";
import { budgetFrom, createJevClient, type JevModels } from "../extensions/jev.js";

function registry() {
	const calls: { model: unknown; context: unknown; options: unknown }[] = [];
	const model = { id: "jev-latest", provider: "typesafe", api: "typesafe-system-one", type: "classifier" } as ClassifierModel<ClassifierApi>;
	const result = {
		api: model.api, provider: "typesafe", model: "jev-latest", timestamp: 0, stopReason: "stop",
		answers: { q: { type: "bool", probability: 0.97 }, score: { type: "score", score: 2, confidence: 0.9 } },
	} as ClassifierResult;
	const models: JevModels = {
		getModelOfType: (() => model) as JevModels["getModelOfType"],
		getApiKeyForProvider: async () => "key",
		classify: async (model, context, options) => {
			calls.push({ model, context, options });
			return result;
		},
	};
	return { models, calls, result };
}

const questions = { q: { type: "noul" as const, instructions: "Allowed?", criteria: { true: "yes", false: "no" } } };

function client(built: ReturnType<typeof registry>, extra = {}) {
	return createJevClient({ models: () => built.models, model: "jev-latest", timeoutMs: 2500, maxRequests: 10, ...extra });
}

test("native classification preserves the ask contract and request options", async () => {
	const built = registry();
	const signal = new AbortController().signal;
	const jev = client(built, { apiKey: "override" });
	const answer = await jev.ask({ ask: "test" }, questions, { signal });
	expect(answer).toMatchObject({ ok: true, answers: { q: { type: "noul", noul: 0.97 }, score: { type: "score", score: 2 } }, usage: { input_tokens: 0, output_tokens: 0 } });
	expect(built.calls[0]).toMatchObject({ context: { state: { ask: "test" }, questions: { q: { type: "bool", instructions: "Allowed?" } } }, options: { timeoutMs: 2500, apiKey: "override", signal } });
});

test("a pinned model id uses the native TypeSafe transport without changing the configured model", async () => {
	const built = registry();
	built.models.getModelOfType = ((_, __, id) => id === "jev-latest" ? { id, provider: "typesafe", api: "typesafe-system-one" } : undefined) as JevModels["getModelOfType"];
	await client(built, { model: "jev-1.13.0" }).ask({}, questions);
	expect(built.calls[0]?.model).toMatchObject({ id: "jev-1.13.0", provider: "typesafe" });
});

test("missing auth reports unavailability and recovers when the provider gets a key", async () => {
	const built = registry();
	built.models.getApiKeyForProvider = async () => undefined;
	const jev = client(built);
	await jev.probe();
	expect(jev.unavailable()).toContain("TYPESAFE_API_KEY");
	expect(await jev.ask({}, questions)).toMatchObject({ ok: false, errorCode: "configuration" });
	expect(built.calls).toHaveLength(0);
	built.models.getApiKeyForProvider = async () => "key";
	expect(await jev.ask({}, questions)).toMatchObject({ ok: true });
	expect(jev.unavailable()).toBeUndefined();
});

test("native errors and cancellation remain deferring failures", async () => {
	const built = registry();
	built.result.stopReason = "error";
	built.result.errorMessage = "network failure";
	expect(await client(built).ask({}, questions)).toMatchObject({ ok: false, error: "network failure", errorCode: "response" });
	built.result.stopReason = "aborted";
	expect(await client(built).ask({}, questions)).toMatchObject({ ok: false, errorCode: "aborted" });
});

test("session caps and rate windows still stop requests before the native call", async () => {
	const built = registry();
	const capped = client(built, { maxRequests: 1 });
	await capped.ask({}, questions);
	expect(await capped.ask({}, questions)).toMatchObject({ ok: false, errorCode: "budget" });
	let now = 0;
	const limited = client(built, { ratePerMinute: 1, now: () => now });
	await limited.ask({}, questions);
	expect(await limited.ask({}, questions)).toMatchObject({ ok: false, errorCode: "rate" });
	now = 60_001;
	expect(await limited.ask({}, questions)).toMatchObject({ ok: true });
	expect(built.calls).toHaveLength(3);
	expect(budgetFrom({ maxRequestsPerSession: 5000, rateLimitPerMinute: 60, rateLimitPerHour: 1000 })).toEqual({ maxRequests: 5000, ratePerMinute: 60, ratePerHour: 1000 });
});
