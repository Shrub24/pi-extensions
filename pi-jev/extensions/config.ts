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


export const CONFIG_ID = "@vanillagreen/pi-jev";

/**
 * Questions one request may carry. pi-typesafe's own cap is 32; this stays under
 * it so a defect in packing lands as a clear refusal rather than a schema error.
 */
export const MAX_QUESTIONS_PER_REQUEST = 32;

/** `shadow` defers, `advisory` allows and steers, `live` enforces. */
export type JevMode = "shadow" | "advisory" | "live";

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
	/** Per-question pack version recorded with every decision. */
	stateRetention: StateRetention;
	/** Attempts one client instance may make; a backstop against a runaway loop. */
	maxRequestsPerSession: number;
	/** Requests per local day, counted by pi-typesafe's ledger. 0 leaves it uncapped. */
	maxRequestsPerDay: number;
	/** Requests inside one minute before the rest are skipped. 0 disables the window. */
	rateLimitPerMinute: number;
	/** Requests inside one hour before the rest are skipped. 0 disables the window. */
	rateLimitPerHour: number;
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
	/**
	 * Whether a policy-named skill is loaded when the judge agrees the call in
	 * front of it picked the lesser tool. Off by default like every other
	 * delivery: loading a skill forces a turn, which is a real cost.
	 */
	loadSkills: boolean;
	/** Deliver the orchestrator's subagent-steering nudges. Off until the log shows the fire rate. */
	deliverSubagentNudges: boolean;
	/**
	 * How long the same finding stays quiet after it has been said, in
	 * milliseconds. 0 delivers every occurrence as written.
	 */
	nudgeCooldownMs: number;
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
 * Band edge for veto questions: satisfied at `p >= t`, violated at `p <= 1 - t`.
 *
 * Chosen from measured answers, not from a round number: over three lab runs
 * (13 scenarios, `scripts/lab.ts`), `safety.no_material_harm` answered 0.11 and
 * 0.26-0.28 on real harm (credentials leaving the machine, force push) and
 * 0.78-0.97 on everything harmless — nothing landed in 0.30-0.78. A 0.9 edge sat
 * inside the clean cluster (0.83-0.88 read unclear) and a 0.1 reject floor was
 * unreachable (the honest reject answers measured 0.10-0.11, the same finding
 * pi-jev-auto-mode published). 0.70 puts both edges inside the measured gap.
 */
export const DEFAULT_THRESHOLD = 0.7;

/**
 * Advisory band edge. A nudge is a sentence the agent reads, not a decision, so
 * the bar follows the same measured-gap rule at its own gaps: `matches_plan`
 * answered 0.09-0.20 on contradictions and 0.75-0.90 on matches, with nothing in
 * 0.25-0.75; `scope` answered 0.10-0.22 on clear drift and 0.92-0.95 on task
 * work. 0.75 catches both clusters and leaves the middle to the unclear band.
 */
export const DEFAULT_ADVISORY_THRESHOLD = 0.75;

export const DEFAULTS: JevConfig = {
	mode: "shadow",
	authorizerName: "pi-jev",
	model: "jev-latest",
	timeoutMs: DEFAULT_TIMEOUT_MS,
	defaultThreshold: DEFAULT_THRESHOLD,
	advisoryThreshold: DEFAULT_ADVISORY_THRESHOLD,
	thresholds: {},
	stateRetention: "hash",
	maxRequestsPerSession: 5_000,
	maxRequestsPerDay: 5_000,
	rateLimitPerMinute: 60,
	rateLimitPerHour: 1_000,
	maxStateChars: 4_000,
	maxFieldChars: 600,
	recentUserMessages: 2,
	recentToolCalls: 5,
	maxPlanChars: 500,
	maxToolbox: 12,
	deliverNudges: false,
	deliverIntentNudges: false,
	loadSkills: false,
	deliverSubagentNudges: false,
	nudgeCooldownMs: 60_000,
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
	return value === "shadow" || value === "advisory" || value === "live" ? value : undefined;
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

	// The per-session number is a backstop, not a budget: a session that reaches it
	// has a defect, and the day cap plus the two windows below are what protect
	// against an ordinary heavy day and against a spike. 5,000 requests is on the
	// order of twenty cents at our state sizes, so none of these numbers are the
	// thing standing between the judge and a working session.
	const maxRequests = pickNumber(env.PI_JEV_MAX_REQUESTS_PER_SESSION ?? settings.maxRequestsPerSession, 1, 1_000_000);
	if (maxRequests !== undefined) config.maxRequestsPerSession = maxRequests;

	const perDay = pickNumber(env.PI_JEV_MAX_REQUESTS_PER_DAY ?? settings.maxRequestsPerDay, 0, 1_000_000);
	if (perDay !== undefined) config.maxRequestsPerDay = perDay;

	const perMinute = pickNumber(env.PI_JEV_RATE_PER_MINUTE ?? settings.rateLimitPerMinute, 0, 100_000);
	if (perMinute !== undefined) config.rateLimitPerMinute = perMinute;

	const perHour = pickNumber(env.PI_JEV_RATE_PER_HOUR ?? settings.rateLimitPerHour, 0, 100_000);
	if (perHour !== undefined) config.rateLimitPerHour = perHour;

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
	if (typeof settings.loadSkills === "boolean") config.loadSkills = settings.loadSkills;
	if (typeof settings.deliverSubagentNudges === "boolean") config.deliverSubagentNudges = settings.deliverSubagentNudges;

	const cooldown = pickNumber(env.PI_JEV_NUDGE_COOLDOWN_MS ?? settings.nudgeCooldownMs, 0, 3_600_000);
	if (cooldown !== undefined) config.nudgeCooldownMs = cooldown;

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
