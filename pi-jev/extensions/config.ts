/*
 * Settings for the Jev permission authorizer.
 *
 * Read from the user settings file only — never the project-scope file. A
 * repository must not be able to put the judge into `live`, raise its own
 * question thresholds, or redirect the decision log, because all three decide
 * whether a `ask` is answered without a human. `@vanillagreen/pi-extension-manager`
 * renders these keys from the `kendex.extensionManager.settings` block in
 * package.json.
 *
 * Environment overrides exist for tests and headless runs and are read after
 * the file, so a shell can pin them without editing settings.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { STATE_PROVIDER } from "./action-pack.js";

export const CONFIG_ID = "@vanillagreen/pi-jev";

/**
 * Questions one request may carry. pi-typesafe's own cap is 32; this stays under
 * it so a defect in packing lands as a clear refusal rather than a schema error.
 */
export const MAX_QUESTIONS_PER_REQUEST = 32;

/** `shadow` logs what it would decide and defers; `live` may allow or deny. */
export type JevMode = "shadow" | "live";

/** Whether the decision log keeps the state, or only its hash. */
export type StateRetention = "hash" | "full";

export interface JevConfig {
	mode: JevMode;
	/** Name the operator lists in the permission system's `authorizerChain`. */
	authorizerName: string;
	model: string;
	timeoutMs: number;
	/** Band edge a veto question uses until it has its own measured value. */
	defaultThreshold: number;
	/**
	 * Band edge for advisory questions. Lower than the veto edge because a nudge
	 * costs attention rather than authority: a wrong nudge is a wasted sentence,
	 * a wrong veto is refused work.
	 */
	advisoryThreshold: number;
	/** Ban per question id; `satisfied` at p >= t, `violated` at p <= 1 - t. */
	thresholds: Record<string, number>;
	/** Which state the pack reads; the unit a batch group is keyed by. */
	stateProvider: string;
	/** Per-question pack version recorded with every decision. */
	stateRetention: StateRetention;
	/** Attempts this judge may make in one session, across failed ones. */
	maxRequestsPerSession: number;
	maxStateChars: number;
	maxFieldChars: number;
	recentUserMessages: number;
	recentToolCalls: number;
	/** How much of the agent's own plan reaches the state. */
	maxPlanChars: number;
	/** How many tools the toolbox lists, or 0 to omit it. */
	maxToolbox: number;
	/** Deliver the permission consumer's nudges to the agent, or only record them. */
	deliverNudges: boolean;
	/** Deliver the intent consumer's nudges. Its own switch: different consumer, different noise. */
	deliverIntentNudges: boolean;
	/** Deliver the orchestrator's subagent-steering nudges. Off until the log shows the fire rate. */
	deliverSubagentNudges: boolean;
	/**
	 * How long a queued question may wait with no send before the core asks it
	 * anyway, in milliseconds. 0 disables the timer: by default a queued question
	 * is answered by the next send, or at the turn boundary, and nothing spends on
	 * a clock.
	 */
	queueFlushGapMs: number;
	/**
	 * How often the orchestrator's check-in scans child notices and asks the
	 * drift questions, in milliseconds. 0 disables the timer: the questions are
	 * still asked on forwarded asks, but nothing wakes an idle orchestrator.
	 * The wake itself is one steering sentence — a quiet child costs nothing.
	 */
	orchestratorCheckInMs: number;
	/**
	 * The TypeSafe key, when configured here. Unset means pi-typesafe resolves its
	 * own: TYPESAFE_API_KEY in the environment, then the key /typesafe login
	 * stored. A key in the settings file is read by every process that loads the
	 * entry, so prefer the env var on a shared machine.
	 */
	apiKey?: string;
	logFile: string;
}

/**
 * Ceiling for one Jev call inside the permission chain.
 *
 * The judge runs *ahead* of the interactive prompt, so this is time added to a
 * human's wait before they even see the question. Jev answers well under a
 * second; three seconds is already generous, and a timeout costs nothing but
 * the request, because a failure defers and the human is asked anyway.
 */
export const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * Band edge, shared by every question until a question has its own measured
 * value. Deliberately high: this edge decides whether an action runs with no
 * human, so the unclear band (1 - t < p < t) is where the honest answer lives
 * until calibration says otherwise.
 */
export const DEFAULT_THRESHOLD = 0.9;

/**
 * Advisory band edge. A nudge is a sentence the agent reads, not a decision, so
 * the bar sits where pi-heed measured answers to be 94% right rather than 98%.
 */
export const DEFAULT_ADVISORY_THRESHOLD = 0.85;

export const DEFAULTS: JevConfig = {
	mode: "shadow",
	authorizerName: "pi-jev",
	model: "jev-latest",
	timeoutMs: DEFAULT_TIMEOUT_MS,
	defaultThreshold: DEFAULT_THRESHOLD,
	advisoryThreshold: DEFAULT_ADVISORY_THRESHOLD,
	thresholds: {},
	stateProvider: STATE_PROVIDER,
	stateRetention: "hash",
	maxRequestsPerSession: 200,
	maxStateChars: 4_000,
	maxFieldChars: 600,
	recentUserMessages: 2,
	recentToolCalls: 5,
	maxPlanChars: 500,
	maxToolbox: 12,
	deliverNudges: false,
	deliverIntentNudges: false,
	deliverSubagentNudges: false,
	queueFlushGapMs: 0,
	orchestratorCheckInMs: 0,
	logFile: "",
};

/** The Pi agent directory, honouring pi's own override. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_CODING_AGENT_DIR?.trim();
	if (override) {
		const expanded = override === "~" ? homedir() : override.startsWith("~/") ? join(homedir(), override.slice(2)) : override;
		return resolve(expanded);
	}
	return join(homedir(), ".pi", "agent");
}

export function defaultLogFile(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "pi-jev", "decisions.jsonl");
}

function userSettingsPath(env: NodeJS.ProcessEnv): string {
	return join(agentDir(env), "settings.json");
}

/** The `kendex.extensionManager.config[CONFIG_ID]` block, or an empty record. */
export function readSettingsFile(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
	const path = userSettingsPath(env);
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			kendex?: { extensionManager?: { config?: Record<string, unknown> } };
		};
		const config = parsed?.kendex?.extensionManager?.config?.[CONFIG_ID];
		return config && typeof config === "object" && !Array.isArray(config)
			? (config as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function pickMode(value: unknown): JevMode | undefined {
	return value === "shadow" || value === "live" ? value : undefined;
}

function pickNumber(value: unknown, min: number, max: number): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
	}
	return undefined;
}

function pickString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Thresholds keyed by question id. A value outside (0.5, 1] is dropped rather
 * than clamped: a threshold of 0.5 or below makes the satisfied and violated
 * bands overlap, which would let the same probability both permit and refuse.
 */
export function readThresholds(value: unknown, base: Record<string, number>): Record<string, number> {
	const thresholds: Record<string, number> = { ...base };
	if (!value || typeof value !== "object" || Array.isArray(value)) return thresholds;
	for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
		const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
		if (Number.isFinite(parsed) && parsed > 0.5 && parsed <= 1) thresholds[id] = parsed;
	}
	return thresholds;
}

/** Merge file settings and environment over the defaults, in that order. */
export function resolveConfig(
	settings: Record<string, unknown> = {},
	env: NodeJS.ProcessEnv = process.env,
): JevConfig {
	const config: JevConfig = {
		...DEFAULTS,
		thresholds: readThresholds(settings.thresholds, DEFAULTS.thresholds),
		logFile: defaultLogFile(env),
	};

	const mode = pickMode(env.PI_JEV_MODE) ?? pickMode(settings.mode);
	if (mode) config.mode = mode;

	const name = pickString(env.PI_JEV_AUTHORIZER_NAME) ?? pickString(settings.authorizerName);
	if (name) config.authorizerName = name;

	const model = pickString(env.PI_JEV_MODEL) ?? pickString(settings.model);
	if (model) config.model = model;

	const timeout = pickNumber(env.PI_JEV_TIMEOUT_MS, 200, 60_000) ?? pickNumber(settings.timeoutMs, 200, 60_000);
	if (timeout !== undefined) config.timeoutMs = timeout;

	// A band edge of 0.5 or below makes the satisfied and violated bands meet,
	// which would let one probability both permit and refuse.
	const threshold = pickNumber(env.PI_JEV_THRESHOLD, 0.5001, 1) ?? pickNumber(settings.defaultThreshold, 0.5001, 1);
	if (threshold !== undefined) config.defaultThreshold = threshold;

	const advisory = pickNumber(settings.advisoryThreshold, 0.5001, 1);
	if (advisory !== undefined) config.advisoryThreshold = advisory;

	const retention = env.PI_JEV_STATE_RETENTION ?? settings.stateRetention;
	if (retention === "hash" || retention === "full") config.stateRetention = retention;

	const maxStateChars = pickNumber(settings.maxStateChars, 500, 60_000);
	if (maxStateChars !== undefined) config.maxStateChars = maxStateChars;

	const maxRequests = pickNumber(settings.maxRequestsPerSession, 1, 100_000);
	if (maxRequests !== undefined) config.maxRequestsPerSession = maxRequests;

	const maxFieldChars = pickNumber(settings.maxFieldChars, 80, 8_000);
	if (maxFieldChars !== undefined) config.maxFieldChars = maxFieldChars;

	const userMessages = pickNumber(settings.recentUserMessages, 0, 20);
	if (userMessages !== undefined) config.recentUserMessages = userMessages;

	const toolCalls = pickNumber(settings.recentToolCalls, 0, 40);
	if (toolCalls !== undefined) config.recentToolCalls = toolCalls;

	const planChars = pickNumber(settings.maxPlanChars, 0, 4_000);
	if (planChars !== undefined) config.maxPlanChars = planChars;

	const toolbox = pickNumber(settings.maxToolbox, 0, 64);
	if (toolbox !== undefined) config.maxToolbox = toolbox;

	if (typeof settings.deliverNudges === "boolean") config.deliverNudges = settings.deliverNudges;
	if (typeof settings.deliverIntentNudges === "boolean") config.deliverIntentNudges = settings.deliverIntentNudges;
	if (typeof settings.deliverSubagentNudges === "boolean") config.deliverSubagentNudges = settings.deliverSubagentNudges;

	const gap = pickNumber(settings.queueFlushGapMs, 0, 600_000);
	if (gap !== undefined) config.queueFlushGapMs = gap;

	const checkIn = pickNumber(env.PI_JEV_CHECK_IN_MS ?? settings.orchestratorCheckInMs, 0, 3_600_000);
	if (checkIn !== undefined) config.orchestratorCheckInMs = checkIn;

	const file = pickString(env.PI_JEV_LOG) ?? pickString(settings.logFile);
	if (file) config.logFile = file.startsWith("~/") ? join(homedir(), file.slice(2)) : resolve(file);

	const apiKey = pickString(env.PI_JEV_API_KEY) ?? pickString(settings.apiKey);
	if (apiKey) config.apiKey = apiKey;

	return config;
}
