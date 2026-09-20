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

import type { ToolPolicy } from "./tool-choice.js";
import { DEFAULT_TOOL_POLICY } from "./tool-choice.js";

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
	let margin: number | undefined;

	const lines = text.split("\n");
	let current: { tool?: string; match?: string; reason?: string } | undefined;
	let inPreferences = false;

	const flush = (): void => {
		if (current && typeof current.tool === "string" && current.tool !== "" && typeof current.reason === "string" && current.reason !== "") {
			preferences.push({ tool: current.tool, ...(current.match === undefined ? {} : { match: current.match }), reason: current.reason });
		}
		current = undefined;
	};

	for (const raw of lines) {
		const line = raw.replace(/\t/g, "  ");
		if (/^\s*#/.test(line) || line.trim() === "") continue;
		const top = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
		if (top) {
			const [, key, rest] = top;
			if (key === "preferences") {
				flush();
				inPreferences = rest.trim() === "" || rest.trim() === "|";
				continue;
			}
			if (key === "margin") {
				const value = Number(rest.trim());
				if (Number.isFinite(value) && value > 0 && value < 1) margin = value;
				inPreferences = false;
				continue;
			}
			inPreferences = false;
			continue;
		}
		const item = line.match(/^\s*-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
		if (item && inPreferences) {
			const [, key, rest] = item;
			if (key === "tool") {
				flush();
				current = { tool: rest.trim().replace(/^["']|["']$/g, "") };
				continue;
			}
			if (current && key === "match") {
				current.match = rest.trim().replace(/^["']|["']$/g, "");
				continue;
			}
			if (current && key === "reason") {
				current.reason = rest.trim().replace(/^["']|["']$/g, "");
				continue;
			}
		}
	}
	flush();

	if (preferences.length === 0) return undefined;
	return { preferences, margin: margin ?? DEFAULT_TOOL_POLICY.margin };
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
