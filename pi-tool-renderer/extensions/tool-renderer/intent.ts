/**
 * Per-call intent argument for our tools. When a tool's parameters gain the
 * `intent` property, the caller states — on every call it issues — what it is
 * trying to achieve with that specific call. The phrase renders on the tool row
 * and is stripped before execution, so tools never see it.
 *
 * Modes (setting `intentMode`, class-overridable via `intentModeOverrides`):
 * - "off":      no schema change, no rows, no guard.
 * - "optional": the arg is in the schema but not required; a missing intent
 *               falls back to the deterministic call text.
 * - "required": the arg is in the schema and Pi's `tool_call` guard refuses a
 *               model-issued call that omits it, with guidance naming the
 *               argument. A call another tool made (`parentToolCallId`), such as
 *               a codemode script's nested call or a `tool_batch` item, is
 *               exempt: nothing could have written an intent for it, and a
 *               required JSON-schema property would fail it before a guard
 *               could run.
 *
 * The schema is therefore the same for every caller and mode-on: the intent is
 * always an optional property, and the required policy is enforced per call,
 * context-aware, in one place (`installIntentGuard`). One shared schema is what
 * keeps a codemode script's nested call from failing validation while the
 * model's own call is still refused. `intentHardRequired` is retained for
 * configuration compatibility; it no longer selects the refusal mechanism,
 * because a shared schema cannot mark the field required provider-side.
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

/** The class each intent-aware tool belongs to. Tools outside the map get no intent arg. */
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
	// `codemode` has no intent argument — its purpose is a leading comment in the
	// script it already takes — but it is the `control` class for the policy that
	// decides whether that purpose is required (see `codemodePurposeRefusal`).
	codemode: "control",
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
 * Clone the schema with the intent property added. Schema objects are shared
 * between tools, so mutate a clone. The property is never added to `required`:
 * the schema is the same for the model and for tools that call tools, and the
 * required policy is enforced per call instead (see the module header).
 */
export function withIntentParameter<T extends TSchema>(parameters: T): T {
	const source = parameters as unknown as Record<string, unknown>;
	const next = { ...source } as Record<string, unknown>;
	const properties = { ...((source.properties as Record<string, unknown>) ?? {}) };
	properties[INTENT_FIELD] = { type: "string", description: intentDescription(), minLength: 4, maxLength: 120 };
	next.properties = properties;
	const required = Array.isArray(source.required) ? (source.required as string[]).filter((entry) => entry !== INTENT_FIELD) : [];
	next.required = required;
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

/**
 * Retained for configuration compatibility. The refusal no longer has two
 * mechanisms: with one shared schema the intent cannot be a provider-side
 * required property (a nested call would fail validation before any hook), so
 * `required` always refuses through the `tool_call` guard.
 */
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
	return withIntentParameter(parameters);
}

/**
 * prepareArguments shim: strip the intent arg so tools never see it. Neither
 * mode backfills a fabricated intent into the args — downstream intent analysis
 * must be able to trust that an absent field means the caller did not write one.
 */
export function intentPrepare(_toolName: string, _fallback: string, _cwd?: string) {
	return (args: unknown): unknown => stripIntent(args);
}

// ---------------------------------------------------------------------------
// Codemode root purpose
// ---------------------------------------------------------------------------

/** Pi's `codemode` tool name (the native extension registers it under this name). */
export const CODEMODE_TOOL_NAME = "codemode";

/** Native first-line header: `// @options: {...}` (see Pi's codemode tool docs). */
const CODEMODE_OPTIONS_LINE = /^\/\/\s*@options\s*:/;
/** One leading purpose comment. Case-insensitive so `// Intent:` also counts. */
const CODEMODE_PURPOSE_LINE = /^\/\/\s*intent\s*:\s*(.*)$/i;

/** Length bounds of a meaningful purpose, matching the intent argument schema. */
const PURPOSE_MIN_LENGTH = 4;
const PURPOSE_MAX_LENGTH = 120;

/**
 * The root codemode purpose: exactly one meaningful leading `// intent: ...`
 * comment, after the native `// @options:` line when present.
 *
 * The script's callable interface is unchanged — the purpose is a comment inside
 * the `code` the tool already takes, not a new argument. Only the leading
 * comment block is read: a `// intent:` inside a string literal, after the first
 * executable statement, or a second one at the top is not a leading purpose.
 * Nothing here evaluates or parses the script.
 */
export function parseCodemodePurpose(code: unknown): string | undefined {
	if (typeof code !== "string") return undefined;
	const lines = code.replace(/\r\n?/g, "\n").split("\n");
	let seenOptions = false;
	let purpose: string | undefined;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		if (CODEMODE_OPTIONS_LINE.test(line)) {
			// The options header is only native as the very first line.
			if (seenOptions || purpose !== undefined) break;
			seenOptions = true;
			continue;
		}
		const match = CODEMODE_PURPOSE_LINE.exec(line);
		if (!match) break;
		// A second leading purpose comment makes the purpose ambiguous: refuse
		// rather than silently pick one.
		if (purpose !== undefined) return undefined;
		const text = (match[1] ?? "").trim();
		if (text.length < PURPOSE_MIN_LENGTH || text.length > PURPOSE_MAX_LENGTH) return undefined;
		purpose = text;
	}
	return purpose;
}

/** The purpose declared on a codemode call, or undefined when it declared none. */
export function codemodePurpose(args: unknown): string | undefined {
	return parseCodemodePurpose(args && typeof args === "object" ? (args as Record<string, unknown>).code : undefined);
}

// ---------------------------------------------------------------------------
// Required-policy guard
// ---------------------------------------------------------------------------

/** The `tool_call` fields the guard reads (Pi's `ToolCallEvent`). */
export interface IntentGuardCallEvent {
	toolName: string;
	toolCallId: string;
	/** Set when another tool made this call (a codemode script, a wrapper). */
	parentToolCallId?: string;
	input?: unknown;
}

export interface IntentRefusal {
	block: true;
	reason: string;
}

/**
 * A call another tool made, not a call the model issued. Pi sets
 * `parentToolCallId` on every nested call (`ctx.executeTool`), so a codemode
 * script's call and a wrapper's item are both exempt without any per-call
 * ancestry state to leak or clean up.
 */
export function isToolIssuedCall(event: { parentToolCallId?: string }): boolean {
	return typeof event.parentToolCallId === "string" && event.parentToolCallId.length > 0;
}

/** Guidance returned for a model-issued call that omitted a required intent. */
export function missingIntentReason(toolName: string): string {
	return `The ${toolName} call is missing its required "intent". Add one short sentence stating what this specific call is for, for example { "intent": "read the failing test's expectations" } (at least ${PURPOSE_MIN_LENGTH} characters, at most ${PURPOSE_MAX_LENGTH}), and issue the call again. Calls a codemode script or another tool makes are exempt and need no intent.`;
}

/** Guidance returned for a root codemode call without a leading purpose. */
export function missingCodemodePurposeReason(): string {
	return `The codemode call is missing its purpose. Start the script's \`code\` with one short comment line as its purpose, for example:\n// intent: check the build failure and gather the failing test names\nawait tools.bash({ command: "..." })\nPlace it on the first line, or directly after an existing \`// @options: {...}\` line. Nested calls a script makes need no intent of their own.`;
}

/**
 * The refusal for a model-issued call that omitted a required intent, or
 * undefined when the call may proceed. A tool-issued call is always allowed:
 * its arguments were composed by a tool, not by the model.
 */
export function missingIntentRefusal(toolName: string, event: IntentGuardCallEvent, cwd?: string): IntentRefusal | undefined {
	if (isToolIssuedCall(event)) return undefined;
	if (intentModeFor(toolName, cwd) !== "required") return undefined;
	if (getIntent(event.input)) return undefined;
	return { block: true, reason: missingIntentReason(toolName) };
}

/**
 * The refusal for a root codemode call whose script carries no leading purpose,
 * or undefined when the call may proceed. Honors the same off/optional/required
 * policy as every other tool: only `required` refuses.
 */
export function codemodePurposeRefusal(event: IntentGuardCallEvent, cwd?: string): IntentRefusal | undefined {
	if (isToolIssuedCall(event)) return undefined;
	if (intentModeFor(CODEMODE_TOOL_NAME, cwd) !== "required") return undefined;
	if (codemodePurpose(event.input)) return undefined;
	return { block: true, reason: missingCodemodePurposeReason() };
}

export interface IntentGuardOptions {
	/** The tools this package registered with an intent argument. */
	tools: readonly string[];
	/**
	 * Whether this package owns the codemode root-purpose policy. Only the
	 * package that presents the root codemode row installs it, so one call is
	 * never judged twice.
	 */
	codemodePurpose?: boolean;
}

/** Minimal `pi` surface the guard needs, so tests can install it on a fake. */
export interface IntentGuardHost {
	on(event: "tool_call", handler: (event: IntentGuardCallEvent, ctx?: { cwd?: string }) => unknown): unknown;
}

/**
 * Install the required-policy guard: one `tool_call` handler that refuses a
 * model-issued call of an intent-aware tool — or a root codemode call whose
 * script has no leading purpose — before it executes, and leaves every
 * tool-issued call alone. Pi runs a blocked call's reason as the call's error
 * text, which is how the caller learns what to add.
 */
export function installIntentGuard(pi: IntentGuardHost, options: IntentGuardOptions): void {
	const tools = new Set(options.tools);
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === CODEMODE_TOOL_NAME) {
			return options.codemodePurpose ? codemodePurposeRefusal(event, ctx?.cwd) : undefined;
		}
		if (!tools.has(event.toolName)) return undefined;
		return missingIntentRefusal(event.toolName, event, ctx?.cwd);
	});
}
