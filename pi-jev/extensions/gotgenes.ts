/*
 * Locating the permission system's service, robustly.
 *
 * The permission system publishes one service per *node* — one Pi session
 * runtime each, including an in-process subagent — into a session-keyed map
 * held on `globalThis` under `Symbol.for("@gotgenes/pi-permission-system:session-services")`.
 * Its own docs say why: every node builds its own module loader, so two
 * extensions in one process share no module state, only process globals. A
 * consumer's own copy of the module therefore reads the same map the provider
 * wrote, whoever's copy it is.
 *
 * Two consequences this module encodes:
 *
 *   - The service is resolved per use, never cached across a session's life.
 *     A `/reload` publishes a new service object under the same session id, and
 *     a registration held against the old one would decide nothing.
 *   - The channel names are imported from the provider's module when it is
 *     present. `permissions:ready` and `permissions:decision` are documented as
 *     stable, but the constants are where that promise lives, so preferring
 *     their values over our copies costs one dynamic import.
 */

import type { PermissionsReadyEvent, PermissionDecisionEvent, PermissionsService } from "./types.js";

/**
 * Fallback channel names, used when the provider module cannot be imported.
 *
 * The permission system's public contract is "fields may be added, but existing
 * fields will not be removed or renamed without a semver-major version bump",
 * and these two constants are part of it. Subscribing with our copies means a
 * listener is already attached before the provider's first `session_start`,
 * which is what makes the first ready event observable.
 */
export const PERMISSIONS_READY_CHANNEL = "permissions:ready";
export const PERMISSIONS_DECISION_CHANNEL = "permissions:decision";

const PROVIDER_SPECIFIER = "@gotgenes/pi-permission-system";

export interface GotgenesSeam {
	/** The service of the node whose session is `sessionId`, or undefined. */
	getPermissionsService(sessionId: string): PermissionsService | undefined;
	readyChannel: string;
	decisionChannel: string;
}

interface ProviderModule {
	getPermissionsService: (sessionId: string) => PermissionsService | undefined;
	PERMISSIONS_READY_CHANNEL?: unknown;
	PERMISSIONS_DECISION_CHANNEL?: unknown;
}

export interface SeamLocatorOptions {
	/** Module loader, injected by tests. */
	load?: () => Promise<unknown>;
	now?: () => number;
}

export interface SeamLocator {
	/** The provider seam, or undefined when the permission system is absent. */
	resolve(): Promise<GotgenesSeam | undefined>;
}

/** How long an absent provider is trusted before the import is attempted again. */
export const PROVIDER_COOLDOWN_MS = 30_000;

async function defaultLoad(): Promise<unknown> {
	const specifier: string = PROVIDER_SPECIFIER;
	return import(specifier);
}

function isProvider(value: unknown): value is ProviderModule {
	if (typeof value !== "object" || value === null) return false;
	return typeof (value as Partial<ProviderModule>).getPermissionsService === "function";
}

export function createSeamLocator(options: SeamLocatorOptions = {}): SeamLocator {
	const now = options.now ?? (() => Date.now());
	let seam: GotgenesSeam | undefined;
	let blockedUntil = 0;

	return {
		async resolve() {
			if (seam) return seam;
			if (now() < blockedUntil) return undefined;
			let loaded: unknown;
			try {
				loaded = await (options.load ?? defaultLoad)();
			} catch {
				blockedUntil = now() + PROVIDER_COOLDOWN_MS;
				return undefined;
			}
			if (!isProvider(loaded)) {
				blockedUntil = now() + PROVIDER_COOLDOWN_MS;
				return undefined;
			}
			seam = {
				getPermissionsService: loaded.getPermissionsService,
				readyChannel: typeof loaded.PERMISSIONS_READY_CHANNEL === "string" ? loaded.PERMISSIONS_READY_CHANNEL : PERMISSIONS_READY_CHANNEL,
				decisionChannel: typeof loaded.PERMISSIONS_DECISION_CHANNEL === "string" ? loaded.PERMISSIONS_DECISION_CHANNEL : PERMISSIONS_DECISION_CHANNEL,
			};
			return seam;
		},
	};
}

/** Narrow a bus payload to the facts `permissions:ready` promises. */
export function readReadyEvent(payload: unknown): PermissionsReadyEvent | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const event = payload as { sessionId?: unknown; adjudicatesLocally?: unknown };
	// A missing id reads as "no keyed service", the same as an explicit null: a
	// payload from a wrapper that re-emitted the event without its id can still
	// reach a handler, and acting on it is a no-op either way.
	if (event.sessionId !== undefined && event.sessionId !== null && typeof event.sessionId !== "string") return undefined;
	return {
		sessionId: typeof event.sessionId === "string" ? event.sessionId : null,
		adjudicatesLocally: event.adjudicatesLocally === true,
	};
}

/**
 * A decision event as this package records it: the payload's facts, with the
 * forwarding context reduced to the one bit a record needs.
 */
export type RecordedDecision = Omit<PermissionDecisionEvent, "forwarding"> & {
	forwarded: boolean;
};

/** Narrow a bus payload to the facts `permissions:decision` promises. */
export function readDecisionEvent(payload: unknown): RecordedDecision | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const event = payload as Record<string, unknown>;
	if (typeof event.requestId !== "string" || event.requestId === "") return undefined;
	if (event.result !== "allow" && event.result !== "deny") return undefined;
	const text = (value: unknown): string => (typeof value === "string" ? value : "");
	const nullable = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
	return {
		requestId: event.requestId,
		surface: text(event.surface),
		value: text(event.value),
		result: event.result,
		resolution: text(event.resolution) === "" ? "unknown" : text(event.resolution),
		origin: nullable(event.origin),
		matchedPattern: nullable(event.matchedPattern),
		agentName: nullable(event.agentName),
		forwarded: event.forwarding !== undefined && event.forwarding !== null,
	};
}
