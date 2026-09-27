/**
 * Per-call intent argument for our tools. When a tool's parameters gain the
 * `intent` property, the model states — on every call — what it is trying to
 * achieve with that specific call. The phrase renders on the tool row and is
 * stripped before execution, so tools never see it.
 *
 * Modes (setting `intentMode`, class-overridable via `intentModeOverrides`):
 * - "off":      no schema change, no rows.
 * - "optional": the arg is in the schema but not required; a missing intent
 *               falls back to the deterministic call text.
 * - "required": the arg joins the schema's required list. `intentHardRequired`
 *               decides between provider-side validation (hard) and a
 *               prepareArguments backfill (soft).
 */
import type { TSchema } from "@earendil-works/pi-coding-agent";

export const INTENT_FIELD = "intent";

export type IntentMode = "off" | "optional" | "required";

export const INTENT_CLASS_MODES: Record<string, IntentMode> = {
	read: "optional",
	search: "optional",
	mutation: "required",
	bash: "required",
	control: "required",
};

/** Which class a tool belongs to. Tools outside the map get no intent arg. */
export const TOOL_INTENT_CLASS: Record<string, string> = {
	read: "read",
	grep: "search",
	find: "search",
	ls: "search",
	edit: "mutation",
	write: "mutation",
	tool_batch: "control",
	bg_task: "control",
	bash: "bash",
};

export function intentDescription(): string {
	return "One short sentence stating what you want to achieve with this specific call. Written for the user; shown on the tool row. Never include secrets.";
}

/** True when the schema already carries an intent property. */
export function hasIntentParameter(parameters: unknown): boolean {
	return Boolean(
		parameters && typeof parameters === "object"
		&& (parameters as Record<string, unknown>).properties
		&& INTENT_FIELD in (parameters as Record<string, unknown>).properties,
	);
}

/**
 * Clone the schema with the intent property added/removed and the required
 * list adjusted. Schema objects are shared between tools, so mutate a clone.
 */
export function withIntentParameter<T extends TSchema>(parameters: T, mode: "optional" | "required"): T {
	const source = parameters as unknown as Record<string, unknown>;
	const next = { ...source } as Record<string, unknown>;
	const properties = { ...((source.properties as Record<string, unknown>) ?? {}) };
	properties[INTENT_FIELD] = { type: "string", description: intentDescription(), minLength: 4, maxLength: 120 };
	next.properties = properties;
	const required = Array.isArray(source.required) ? [...(source.required as string[])] : [];
	const withField = required.includes(INTENT_FIELD) ? required : [...required, INTENT_FIELD];
	next.required = mode === "required" ? withField : required.filter((entry) => entry !== INTENT_FIELD);
	return next as unknown as T;
}

/** Remove the intent arg before execute/prepareArguments see it. */
export function stripIntent<T>(args: T): T {
	if (args && typeof args === "object" && INTENT_FIELD in (args as Record<string, unknown>)) {
		const clone = { ...(args as Record<string, unknown>) };
		delete clone[INTENT_FIELD];
		return clone as T;
	}
	return args;
}

export function getIntent(args: unknown): string | undefined {
	const value = args && typeof args === "object" ? (args as Record<string, unknown>)[INTENT_FIELD] : undefined;
	return typeof value === "string" && value.trim().length >= 4 ? value.trim() : undefined;
}

import { settingBoolean, settingString } from "./settings.js";

/** Effective mode for one tool: class override first, then global intentMode. */
export function intentModeFor(toolName: string, cwd?: string): IntentMode {
	const global = settingString("intentMode", "optional", cwd);
	const overridesRaw = settingString("intentModeOverrides", "{}", cwd);
	let overrides: Record<string, string> = {};
	try {
		const parsed = JSON.parse(overridesRaw) as Record<string, unknown>;
		if (parsed && typeof parsed === "object") {
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value === "string") overrides[key] = value;
			}
		}
	} catch {
		// Malformed overrides fall back to the global mode.
	}
	const toolClass = TOOL_INTENT_CLASS[toolName];
	const configured = overrides[toolName] ?? overrides[toolClass ?? ""];
	const resolved = configured === "off" || configured === "optional" || configured === "required"
		? configured
		: global === "off" || global === "required"
			? global
			: "optional";
	if (resolved === "off" || !toolClass) return "off";
	return resolved;
}

export function intentHardRequired(cwd?: string): boolean {
	return settingBoolean("intentHardRequired", false, cwd);
}

/** Row suffix for a declared intent: dim ` — phrase`. Empty when absent. */
import type { Theme } from "@earendil-works/pi-coding-agent";

export function intentSuffix(args: unknown, theme: Theme): string {
	const intent = getIntent(args);
	return intent ? theme.fg("dim", ` — ${intent}`) : "";
}

/**
 * Schema with the intent argument added for this tool's effective mode.
 * "off" (or unknown tools) returns the schema untouched.
 */
export function intentParameters<T extends TSchema>(toolName: string, parameters: T, cwd?: string): T {
	const mode = intentModeFor(toolName, cwd);
	if (mode === "off") return parameters;
	return withIntentParameter(parameters, mode);
}

/**
 * prepareArguments shim: strip the intent arg so tools never see it. Soft
 * mode never backfills a fabricated intent into the args — downstream intent
 * analysis must be able to trust that an absent field means the model did not
 * write one. Rows render a neutral fallback instead; with intentHardRequired
 * the schema's required[] does the enforcement provider-side.
 */
export function intentPrepare(_toolName: string, _fallback: string, _cwd?: string) {
	return (args: unknown): unknown => stripIntent(args);
}
