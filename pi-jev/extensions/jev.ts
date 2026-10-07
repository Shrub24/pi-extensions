/* The native classifier transport, adapted to the decision core's ask contract. */

import type { ClassifierContext, ClassifierModel, ClassifierApi } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { JevAnswer, JevAskAnswer, JevQuestions } from "./types.js";

export type JevModels = Pick<ModelRegistry, "getModelOfType" | "getApiKeyForProvider" | "classify">;

export interface JevClientOptions {
	model: string;
	timeoutMs: number;
	maxRequests: number;
	ratePerMinute?: number;
	ratePerHour?: number;
	apiKey?: string;
	/** Resolve the current session context, including after a reload. */
	models: () => JevModels;
	now?: () => number;
}

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;

function createLimiter(now: () => number, perMinute: number, perHour: number) {
	const admitted: number[] = [];
	return {
		refusal(): string | undefined {
			const t = now();
			while (admitted.length > 0 && t - (admitted[0] as number) >= ONE_HOUR_MS) admitted.shift();
			if (perMinute > 0) {
				let inMinute = 0;
				for (let i = admitted.length - 1; i >= 0 && t - (admitted[i] as number) < ONE_MINUTE_MS; i -= 1) inMinute += 1;
				if (inMinute >= perMinute) return `pi-jev rate limit: ${perMinute} requests per minute reached; this one was skipped rather than spent.`;
			}
			if (perHour > 0 && admitted.length >= perHour) return `pi-jev rate limit: ${perHour} requests per hour reached; this one was skipped rather than spent.`;
			return undefined;
		},
		admit(): void {
			admitted.push(now());
		},
	};
}

export function budgetFrom(config: {
	maxRequestsPerSession: number;
	rateLimitPerMinute: number;
	rateLimitPerHour: number;
}): Pick<JevClientOptions, "maxRequests" | "ratePerMinute" | "ratePerHour"> {
	return {
		maxRequests: config.maxRequestsPerSession,
		ratePerMinute: config.rateLimitPerMinute,
		ratePerHour: config.rateLimitPerHour,
	};
}

export interface JevClient {
	readonly model: string;
	ask(state: unknown, questions: JevQuestions, options?: { signal?: AbortSignal }): Promise<JevAskAnswer>;
	/** Check model and credentials locally, without spending a request. */
	probe(): Promise<void>;
	unavailable(): string | undefined;
}

export function createJevClient(options: JevClientOptions): JevClient {
	const now = options.now ?? (() => Date.now());
	const limiter = createLimiter(now, options.ratePerMinute ?? 0, options.ratePerHour ?? 0);
	let attempts = 0;
	let problem: string | undefined;

	const resolve = async (): Promise<{ models: JevModels; model: ClassifierModel<ClassifierApi> } | undefined> => {
		const models = options.models();
		const model = models.getModelOfType("classifier", "typesafe", options.model)
			?? models.getModelOfType("classifier", "typesafe", "jev-latest");
		if (!model) {
			problem = "The TypeSafe classifier is unavailable in the model registry.";
			return undefined;
		}
		if (!options.apiKey && !await models.getApiKeyForProvider("typesafe")) {
			problem = "No TypeSafe API key. Set TYPESAFE_API_KEY or log in to the typesafe provider in Pi.";
			return undefined;
		}
		problem = undefined;
		// The catalog lists jev-latest; pinned TypeSafe versions remain valid API model ids.
		return { models, model: { ...model, id: options.model } };
	};

	return {
		model: options.model,
		unavailable: () => problem,
		async probe() {
			await resolve();
		},
		async ask(state, questions, askOptions = {}) {
			try {
				const active = await resolve();
				if (!active) return { ok: false, error: problem as string, errorCode: "configuration" };
				if (attempts >= options.maxRequests) return { ok: false, error: "pi-jev session request cap reached.", errorCode: "budget" };
				const refusal = limiter.refusal();
				if (refusal) return { ok: false, error: refusal, errorCode: "rate" };
				limiter.admit();
				attempts += 1;
				const started = now();
				const context = {
					state,
					questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => [
						id, question.type === "noul" ? { ...question, type: "bool" } : question,
					])),
				} as ClassifierContext;
				const result = await active.models.classify(active.model, context, {
					timeoutMs: options.timeoutMs,
					signal: askOptions.signal,
					...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
				});
				if (result.stopReason !== "stop") return {
					ok: false,
					error: result.errorMessage ?? "The TypeSafe classifier failed.",
					errorCode: result.stopReason === "aborted" ? "aborted" : "response",
				};
				const answers: Record<string, JevAnswer> = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [
					id, answer.type === "bool" ? { type: "noul" as const, noul: answer.probability } : answer,
				]));
				return {
					ok: true, answers, model: result.model,
					usage: { input_tokens: result.usage?.input ?? 0, output_tokens: result.usage?.output ?? 0 },
					elapsedMs: now() - started,
				};
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : "The judge failed.", errorCode: "response" };
			}
		},
	};
}
