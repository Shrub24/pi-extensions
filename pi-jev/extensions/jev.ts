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
 */

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
	 * Attempts this client instance may make, including failed ones. Our own
	 * ceiling, because pi-typesafe's default of 20 is a tool's budget and this
	 * judge asks once per permission prompt; a session cap that trips silently
	 * would look like a judge that stopped working.
	 */
	maxRequests: number;
	/** The key for createTypeSafe; omitted means pi-typesafe resolves its own. */
	apiKey?: string;
	/** Module loader, injected by tests. */
	load?: () => Promise<unknown>;
	/** Clock, injected by tests. */
	now?: () => number;
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

async function defaultLoad(): Promise<unknown> {
	// The specifier is held in a variable so the host's module resolution — not
	// a bundler's — decides whether the package is present.
	const specifier: string = PI_TYPESAFE_SPECIFIER;
	return import(specifier);
}

export function createJevClient(options: JevClientOptions): JevClient {
	const now = options.now ?? (() => Date.now());

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
