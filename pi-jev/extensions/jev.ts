/*
 * The Jev call, and the client that carries it.
 *
 * pi-typesafe owns everything below this line: key resolution, the spending
 * ledger, per-day caps, request admission, timeouts, and — the part that
 * matters most here — `ask`, which never throws and returns pi-typesafe's own
 * error code instead. A judge that throws into a permission chain makes the
 * chain's failure semantics the author's problem; a judge that returns
 * `{ ok: false }` lets this package map every failure to `defer` in one place.
 *
 * The import is dynamic and cached, so `pi-typesafe` absent (or not logged in
 * yet) is an ordinary state rather than a load error, and a key that appears
 * mid-session — `/typesafe login` in another extension writes the same store —
 * is picked up without a reload. Failed resolutions are retried on a cooldown
 * so a missing key cannot become a request per ask.
 *
 * Two places can answer for the package, because this extension is loaded two
 * ways. Installed by `pi install`, pi-typesafe sits beside it and the bare
 * specifier resolves. Loaded from a checkout — the dev setup — nothing sits
 * beside it, and the copy Pi's extension manager installed is the same package
 * the session is already running, so that copy answers instead.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentDir } from "./config.js";
import type { JevAskAnswer, JevJudge, JevQuestions } from "./types.js";

/** The package pi-typesafe publishes; resolved through Pi's own node_modules. */
const PI_TYPESAFE_SPECIFIER = "pi-typesafe";

interface PiTypesafeModule {
	createTypeSafe: (options: Record<string, unknown>) => unknown;
	ask: (judge: JevJudge, request: unknown, options: unknown) => Promise<JevAskAnswer>;
}

export interface JevClientOptions {
	model: string;
	timeoutMs: number;
	/**
	 * Attempts this client instance may make, including failed ones. A backstop
	 * against a runaway loop, not a budget: the day cap and the rate limits below
	 * are what shape ordinary use, and this number is only reached by a defect.
	 */
	maxRequests: number;
	/**
	 * Requests per local day, counted by pi-typesafe's ledger, which persists
	 * across restarts and rolls over at the local midnight. A spend guard — at
	 * our state sizes a few thousand requests is cents.
	 */
	maxRequestsPerDay?: number;
	/** Requests inside one minute before the rest are skipped. 0 disables it. */
	ratePerMinute?: number;
	/** Requests inside one hour before the rest are skipped. 0 disables it. */
	ratePerHour?: number;
	/** The key for createTypeSafe; omitted means pi-typesafe resolves its own. */
	apiKey?: string;
	/** Module loader, injected by tests. */
	load?: () => Promise<unknown>;
	/** Clock, injected by tests. */
	now?: () => number;
}

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;

/**
 * The spike guard, in front of the request.
 *
 * A session cap alone cannot tell a busy afternoon from a runaway loop: both
 * arrive at the same total, one of them an hour early. This counts the recent
 * window instead, so a loop that queues a thousand asks in a minute spends its
 * first N and skips the rest — visible in the log as `rate`, never silently.
 */
function createLimiter(now: () => number, perMinute: number, perHour: number) {
	/** Timestamps of admitted requests inside the hour window, oldest first. */
	const admitted: number[] = [];
	return {
		/** Why the next request must be skipped, when it must be. */
		refusal(): string | undefined {
			const t = now();
			while (admitted.length > 0 && t - (admitted[0] as number) >= ONE_HOUR_MS) admitted.shift();
			if (perMinute > 0) {
				let inMinute = 0;
				for (let i = admitted.length - 1; i >= 0 && t - (admitted[i] as number) < ONE_MINUTE_MS; i -= 1) inMinute += 1;
				if (inMinute >= perMinute) {
					return `pi-jev rate limit: ${perMinute} requests per minute reached; this one was skipped rather than spent.`;
				}
			}
			if (perHour > 0 && admitted.length >= perHour) {
				return `pi-jev rate limit: ${perHour} requests per hour reached; this one was skipped rather than spent.`;
			}
			return undefined;
		},
		admit(): void {
			admitted.push(now());
		},
	};
}

/**
 * The budget knobs one config hands a client. Structural on purpose: the caller
 * passes its config, this file stays free of a config import.
 */
export function budgetFrom(config: {
	maxRequestsPerSession: number;
	maxRequestsPerDay: number;
	rateLimitPerMinute: number;
	rateLimitPerHour: number;
}): Pick<JevClientOptions, "maxRequests" | "maxRequestsPerDay" | "ratePerMinute" | "ratePerHour"> {
	return {
		maxRequests: config.maxRequestsPerSession,
		...config.maxRequestsPerDay > 0 ? { maxRequestsPerDay: config.maxRequestsPerDay } : {},
		ratePerMinute: config.rateLimitPerMinute,
		ratePerHour: config.rateLimitPerHour,
	};
}

export interface JevClient {
	readonly model: string;
	/** One evaluation. Never throws. */
	ask(
		state: unknown,
		questions: JevQuestions,
		options?: { signal?: AbortSignal },
	): Promise<JevAskAnswer>;
	/**
	 * Resolve the module and build the client without asking anything. Building a
	 * client is local — no request, no cost — so this is the cheap way to learn
	 * whether the judge is usable *before* an ask needs it.
	 */
	probe(): Promise<void>;
	/** Why the judge cannot call out, when an attempt to resolve it has failed. */
	unavailable(): string | undefined;
	/**
	 * Resolve the client and warm the connection with a call that spends no
	 * request budget: pi-typesafe's `listModels` verifies the key and is not
	 * counted against maxRequests. pi-heed measured the first request of a
	 * process at ~900 ms against ~330 ms once warm, and the first request here is
	 * one a human is waiting on.
	 */
	warm(): Promise<void>;
}

/** How long a failed resolution is trusted before it is attempted again. */
export const RESOLUTION_COOLDOWN_MS = 30_000;

const MISSING_MODULE = "pi-typesafe is not installed; install it and run /typesafe login.";

function isModule(value: unknown): value is PiTypesafeModule {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<PiTypesafeModule>;
	return typeof candidate.createTypeSafe === "function" && typeof candidate.ask === "function";
}

/**
 * The entry point of the pi-typesafe Pi installed, if there is one. A blank or
 * absent result means the bare specifier is the only way to find the package.
 */
export function installedPiTypesafe(
	env: NodeJS.ProcessEnv = process.env,
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	const entry = join(agentDir(env), "npm", "node_modules", "pi-typesafe", "dist", "index.js");
	return exists(entry) ? pathToFileURL(entry).href : undefined;
}

async function defaultLoad(): Promise<unknown> {
	// The specifier is held in a variable so the host's module resolution — not
	// a bundler's — decides whether the package is present.
	try {
		return await import(PI_TYPESAFE_SPECIFIER);
	} catch (error) {
		const installed = installedPiTypesafe();
		if (!installed) throw error;
		return await import(installed);
	}
}

export function createJevClient(options: JevClientOptions): JevClient {
	const now = options.now ?? (() => Date.now());
	const limiter = createLimiter(now, options.ratePerMinute ?? 0, options.ratePerHour ?? 0);

	let module: PiTypesafeModule | undefined;
	let judge: JevJudge | undefined;
	let moduleBlockedUntil = 0;
	let judgeBlockedUntil = 0;
	/** Undefined until an attempt has actually failed: absence is not a diagnosis. */
	let judgeError: string | undefined;

	const resolveModule = async (): Promise<PiTypesafeModule | undefined> => {
		if (module) return module;
		if (now() < moduleBlockedUntil) return undefined;
		try {
			const loaded = await (options.load ?? defaultLoad)();
			if (!isModule(loaded)) {
				moduleBlockedUntil = now() + RESOLUTION_COOLDOWN_MS;
				return undefined;
			}
			module = loaded;
			return module;
		} catch {
			moduleBlockedUntil = now() + RESOLUTION_COOLDOWN_MS;
			return undefined;
		}
	};

	const resolveJudge = async (): Promise<JevJudge | undefined> => {
		if (judge) return judge;
		if (now() < judgeBlockedUntil) return undefined;
		const loaded = await resolveModule();
		if (!loaded) {
			judgeError = MISSING_MODULE;
			judgeBlockedUntil = now() + RESOLUTION_COOLDOWN_MS;
			return undefined;
		}
		try {
			// A key that has not been entered yet throws here, by design: the
			// client is constructed only from a resolvable key.
			const client = loaded.createTypeSafe({
				model: options.model,
				timeoutMs: options.timeoutMs,
				maxRequests: options.maxRequests,
				...(options.maxRequestsPerDay === undefined ? {} : { maxRequestsPerDay: options.maxRequestsPerDay }),
				...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
			});
			if (typeof (client as { evaluate?: unknown }).evaluate !== "function") {
				judgeError = "pi-typesafe returned a client without evaluate().";
				judgeBlockedUntil = now() + RESOLUTION_COOLDOWN_MS;
				return undefined;
			}
			judge = client as JevJudge;
			judgeError = undefined;
			return judge;
		} catch (error) {
			judgeError = error instanceof Error ? error.message : "Could not create the TypeSafe client.";
			judgeBlockedUntil = now() + RESOLUTION_COOLDOWN_MS;
			return undefined;
		}
	};

	return {
		model: options.model,
		unavailable: () => judgeError,
		async probe() {
			await resolveJudge();
		},
		async warm() {
			const active = await resolveJudge();
			if (!active) return;
			try {
				await (active as { listModels?: (options?: unknown) => Promise<unknown> }).listModels?.();
			} catch {
				// Warming is best-effort; the probe already reported a broken key.
			}
		},
		async ask(state, questions, askOptions = {}) {
			const active = await resolveJudge();
			if (!active) return { ok: false, error: judgeError ?? MISSING_MODULE, errorCode: "configuration" };
			const refusal = limiter.refusal();
			if (refusal !== undefined) return { ok: false, error: refusal, errorCode: "rate" };
			limiter.admit();
			const loaded = module as PiTypesafeModule;
			try {
				return await loaded.ask(
					active,
					{ state, questions },
					{ timeoutMs: options.timeoutMs, signal: askOptions.signal },
				);
			} catch (error) {
				// `ask` is documented never to throw; a throw here is a defect in
				// the seam rather than a failed request, and it defers like one.
				return { ok: false, error: error instanceof Error ? error.message : "The judge failed.", errorCode: "response" };
			}
		},
	};
}
