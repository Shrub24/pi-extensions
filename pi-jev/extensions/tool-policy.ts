/*
 * The tool policy: a file the user owns, read once per session.
 *
 * The file is the user's voice about their own tooling — which tool they would
 * rather see for what, and why — and it is read from the agent directory like the
 * settings file, never from a project. A project must not be able to steer the
 * agent's tool choice by dropping a policy into the repo; that would make the
 * nudge an attack surface rather than a preference.
 *
 * Shape, deliberately minimal — the file says which tool is preferred, when it
 * applies, and why:
 *
 * ```yaml
 * preferences:
 *   - tool: grep            # the tool the policy would rather see
 *     match: "rg "          # optional: only when the call's value contains this
 *     reason: ripgrep is faster for content search and streams matches
 * margin: 0.2              # how clearly the judge must prefer it before a nudge
 * ```
 *
 * A malformed file is reported once and ignored: a policy that cannot be parsed
 * must not become a nudge per tool call.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ToolAvoid, ToolDirective, ToolGuidance, ToolPolicy, ToolPrecedence } from "./tool-choice.js";
import { DEFAULT_TOOL_POLICY, MAX_CHOICE_OPTIONS, toolGuidance } from "./tool-choice.js";
import type { ActionAskFacts } from "./action-pack.js";

export const POLICY_FILE = "tool-policy.yaml";

/** Where the policy lives: the agent directory, beside the settings file. */
export function policyPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_JEV_TOOL_POLICY?.trim();
	if (override) {
		const home = override === "~" || override.startsWith("~/") ? (env.HOME ?? "") : "";
		return override.startsWith("~/") ? join(home, override.slice(2)) : override;
	}
	const agent = env.PI_CODING_AGENT_DIR?.trim();
	const base = agent ? (agent === "~" || agent.startsWith("~/") ? join(env.HOME ?? "", agent.slice(agent.startsWith("~/") ? 2 : 1)) : agent) : join(env.HOME ?? "", ".pi", "agent");
	return join(base, "pi-jev", POLICY_FILE);
}

/**
 * The few YAML keys this policy needs, read structurally rather than with a
 * dependency: `preferences` (a list of {tool, match?, reason}) and `margin`. A
 * hand-written file with two keys does not justify a parser dependency, and the
 * loader fails closed on anything it cannot read.
 */
export function parseToolPolicy(text: string): ToolPolicy | undefined {
	const preferences: ToolPolicy["preferences"] = [];
	const precedence: ToolPrecedence[] = [];
	const avoid: ToolAvoid[] = [];
	const directives: ToolDirective[] = [];
	let margin: number | undefined;
	let avoidMargin: number | undefined;

	const lines = text.split("\n");
	let current: { tool?: string; match?: string; reason?: string } | undefined;
	let inPreferences = false;
	/** The multi-line block being read, when any: `precedence`, `avoid`, `directives`. */
	let section: "precedence" | "avoid" | "directives" | undefined;
	/** The current item of the active section. */
	let item: { intent?: string; order?: string[]; reason?: string; tool?: string; when?: string; text?: string; skill?: string; skillReason?: string } | undefined;

	const flush = (): void => {
		if (current && typeof current.tool === "string" && current.tool !== "" && typeof current.reason === "string" && current.reason !== "") {
			preferences.push({ tool: current.tool, ...(current.match === undefined ? {} : { match: current.match }), reason: current.reason });
		}
		current = undefined;
		if (section === "precedence" && item && typeof item.intent === "string" && item.intent !== "" && Array.isArray(item.order) && item.order.length > 0 && typeof item.reason === "string" && item.reason !== "") {
			precedence.push({
				intent: item.intent,
				order: item.order.slice(0, MAX_CHOICE_OPTIONS),
				reason: item.reason,
				...(item.skill === undefined ? {} : { skill: item.skill }),
				...(item.skillReason === undefined ? {} : { skillReason: item.skillReason }),
			});
		}
		if (section === "avoid" && item && typeof item.tool === "string" && item.tool !== "" && typeof item.when === "string" && item.when !== "" && typeof item.reason === "string" && item.reason !== "") {
			avoid.push({ tool: item.tool, when: item.when, reason: item.reason });
		}
		if (section === "directives" && item && typeof item.text === "string" && item.text !== "") {
			directives.push({ ...(item.when === undefined ? {} : { when: item.when }), text: item.text });
		}
		item = undefined;
	};

	for (const raw of lines) {
		const line = raw.replace(/\t/g, "  ");
		if (/^\s*#/.test(line) || line.trim() === "") continue;
		const top = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
		if (top) {
			const [, key, rest] = top;
			if (key === "preferences") {
				flush();
				section = undefined;
				inPreferences = rest.trim() === "" || rest.trim() === "|";
				continue;
			}
			if (key === "precedence" || key === "avoid" || key === "directives") {
				flush();
				inPreferences = false;
				section = rest.trim() === "" || rest.trim() === "|" ? key : undefined;
				continue;
			}
			if (key === "margin") {
				const value = Number(rest.trim());
				if (Number.isFinite(value) && value > 0 && value < 1) margin = value;
				inPreferences = false;
				section = undefined;
				continue;
			}
			if (key === "avoidMargin") {
				const value = Number(rest.trim());
				if (Number.isFinite(value) && value > 0 && value < 1) avoidMargin = value;
				inPreferences = false;
				section = undefined;
				continue;
			}
			// An unknown top-level key ends whatever was being read; the pending
			// record flushes first, or a section followed by anything else would
			// silently lose its items.
			flush();
			inPreferences = false;
			section = undefined;
			continue;
		}
		const named = line.match(/^\s+-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
		if (named) {
			// A list item opens a new record in the active section — `preferences`,
			// `precedence`, `avoid`, or `directives` — or is dropped when no section
			// is being read.
			const [, key, rest] = named;
			const value = rest.trim().replace(/^["']|["']$/g, "");
			if (section === undefined) {
				if (inPreferences && key === "tool") {
					flush();
					current = { tool: value };
				}
				continue;
			}
			flush();
			if (section === "precedence" && key === "intent") item = { intent: value };
			else if (section === "avoid" && key === "tool") item = { tool: value };
			else if (section === "directives" && key === "text") item = { text: value };
			else if (section === "directives" && key === "when") item = { when: value };
			continue;
		}
		// An indented key under the current record: `order: [a, b]`, `match:`,
		// `reason:`, `when:`, `text:`. This branch is what makes preference
			// match/reason lines readable at all — the original parser matched only
			// top-level keys and `- ` items, so an indented field was silently
			// dropped and every preference parsed as a bare tool name.
		const field = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
		if (field && section === undefined && current && inPreferences) {
			const [, key, rawRest] = field;
			const rest = rawRest.trim().replace(/^["']|["']$/g, "");
			if (key === "match" && current.match === undefined) current.match = rest;
			else if (key === "reason" && current.reason === undefined) current.reason = rest;
			continue;
		}
		if (field && item && section !== undefined) {
			const [, key, rawRest] = field;
			const rest = rawRest.trim();
			if (key === "order" && section === "precedence") {
				const inner = rest.replace(/^\[|\]$/g, "");
				item.order = inner
					.split(",")
					.map((tool) => tool.trim().replace(/^["']|["']$/g, ""))
					.filter((tool) => tool !== "");
			} else if (key === "reason") {
				item.reason = rest.replace(/^["']|["']$/g, "");
			} else if (key === "when" && section === "avoid") {
				item.when = rest.replace(/^["']|["']$/g, "");
			} else if (key === "text" && section === "directives") {
				item.text = rest.replace(/^["']|["']$/g, "");
			} else if (key === "tool" && section === "avoid" && item.tool === undefined) {
				item.tool = rest.replace(/^["']|["']$/g, "");
			} else if (key === "intent" && section === "precedence" && item.intent === undefined) {
				item.intent = rest.replace(/^["']|["']$/g, "");
			} else if (key === "skill" && section === "precedence" && item.skill === undefined) {
				item.skill = rest.replace(/^["']|["']$/g, "");
			} else if (key === "skillReason" && section === "precedence") {
				item.skillReason = rest.replace(/^["']|["']$/g, "");
			}
			continue;
		}
	}
	flush();

	const usable = preferences.length + precedence.length + avoid.length + directives.length;
	if (usable === 0) return undefined;
	return {
		preferences,
		...(precedence.length > 0 ? { precedence } : {}),
		...(avoid.length > 0 ? { avoid } : {}),
		...(directives.length > 0 ? { directives } : {}),
		margin: margin ?? DEFAULT_TOOL_POLICY.margin,
		...(avoidMargin === undefined ? {} : { avoidMargin }),
	};
}

/**
 * Stamp a policy's ruling for this call onto already-built ask facts.
 *
 * Both fact builders call this — the gate rebuilds its facts from the ask's
 * details and would otherwise never see what the policy said about the call,
 * and the tool_call hook needs the same fields for the same questions. Lives in
 * the policy module, not the pack: the pack cannot import from here without a
 * cycle, since the choice question's spec reads pack constants.
 */
export function applyGuidance(facts: ActionAskFacts, policy?: ToolPolicy): ActionAskFacts {
	if (!policy) return facts;
	const guidance = toolGuidance(facts, policy);
	const first = guidance.alternatives[0];
	if (first) {
		facts.preferredTool = first.tool;
		facts.preferredReason = guidance.reason ?? first.reason;
	}
	facts.rankedAlternatives = guidance.alternatives.map((alternative) => ({ tool: alternative.tool, reason: alternative.reason, ...(guidance.intent ? { intent: guidance.intent } : {}) }));
	facts.policyIntent = guidance.intent;
	facts.policyDirectives = guidance.directives;
	facts.policyAvoid = guidance.avoid ? { reason: guidance.avoid.reason } : null;
	facts.policySkill = guidance.skill;
	return facts;
}

/** The loaded policy, or the default when the file is absent or unreadable. */
export function loadToolPolicy(env: NodeJS.ProcessEnv = process.env): { policy: ToolPolicy; problem?: string } {
	let text: string;
	try {
		text = readFileSync(policyPath(env), "utf8");
	} catch {
		return { policy: DEFAULT_TOOL_POLICY };
	}
	try {
		const policy = parseToolPolicy(text);
		if (!policy) return { policy: DEFAULT_TOOL_POLICY, problem: `pi-jev: ${policyPath(env)} holds no usable preferences; the default policy is in force.` };
		return { policy };
	} catch {
		return { policy: DEFAULT_TOOL_POLICY, problem: `pi-jev: ${policyPath(env)} could not be parsed; the default policy is in force.` };
	}
}
