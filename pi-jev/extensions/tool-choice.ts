/*
 * The tool-choice pack: one question, asked about a tool call.
 *
 * The question is a `choice` — the agent's one tool per call is a single-choice
 * question, not three separate judgements, because the alternatives are the
 * point. Jev answers with the tool it would pick plus per-option probabilities;
 * the readings keep the chosen name and the margin between the best and the
 * runner-up, and the bands are expressed as margins (`wouldReplace` when the
 * margin clears the edge, `standBy` in between).
 *
 * Every choice question is unmeasured. The margin is a plausible reading, not a
 * measured one, until the log says otherwise — and an unmeasured advisory nudges
 * the same way a measured one does, because a wrong nudge costs a sentence; what
 * it may never do is refuse.
 */

import type { ActionAskFacts, QuestionSpec } from "./action-pack.js";
import { STATE_PROVIDER } from "./action-pack.js";
import type { JevAnswer } from "./types.js";

import type { JevQuestion } from "./types.js";

/** The one alternative the policy would rather see for this call. */
export interface ToolPreference {
	/** The preferred tool's name, exactly as the toolbox reports it. */
	tool: string;
	/** When this preference applies, as a substring of the tool name or its arguments. */
	match?: string;
	/** Why the policy prefers it, in one clause. Nudge text quotes this. */
	reason: string;
}

export interface ToolPolicy {
	/** A `name → preferred` map, plus optional per-tool matching clauses. */
	preferences: ToolPreference[];
	/** How much better the preferred tool must look before the nudge fires. */
	margin: number;
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = { preferences: [], margin: 0.2 };

/** The tool name a call used, and the alternative the policy would rather see. */
export function preferredTool(ask: ActionAskFacts, policy: ToolPolicy): { preferred: string; reason: string } | undefined {
	if (ask.toolName === null) return undefined;
	for (const preference of policy.preferences) {
		if (preference.tool === ask.toolName) continue;
		if (preference.match === undefined) continue;
		if (!ask.value.toLowerCase().includes(preference.match.toLowerCase())) continue;
		return { preferred: preference.tool, reason: preference.reason };
	}
	// A bare `name → preferred` mapping: the policy would rather see this tool
	// every time the current one fires.
	const plain = policy.preferences.find((preference) => preference.match === undefined && preference.tool !== ask.toolName && preference.reason.includes(ask.toolName));
	return plain ? { preferred: plain.tool, reason: plain.reason } : undefined;
}

/** What the choice answer reduces to: the pick, and how clearly it won. */
export interface ChoiceReading {
	kind: "choice";
	/** The tool the judge picked. */
	choice: string;
	/** Best probability minus the runner-up's; the answer's own confidence spread. */
	margin: number;
}

export const TOOL_CHOICE_QUESTIONS: readonly QuestionSpec[] = [
	{
		id: "tool.choice",
		stateProvider: STATE_PROVIDER,
		purpose: "another available tool fits this call's intent plainly better",
		role: "advisory",
		applies: (ask) => ask.toolName !== null && ask.preferredTool != null,
		question: (ask) => {
			if (ask.toolName === null || ask.preferredTool == null) return undefined;
			return {
				type: "choice",
				instructions:
					"Pick which available tool best fits the intent of the call in `ask`. The toolbox lists what is available now, with a line each. Answer with the one tool whose purpose covers what this call is trying to do; if the tool used is already the best fit, answer with it. Judge fit by what the call is trying to do, not by which tool is already in use.",
				criteria: {
					[ask.toolName]: "the tool already in use, for the intent in `ask.value`",
					[ask.preferredTool]: `the alternative the user's policy prefers, and why: ${ask.preferredReason ?? ""}`,
				},
			} satisfies JevQuestion;
		},
		read: (answer) => {
			if (!answer || answer.type !== "choice") return undefined;
			const choice = answer.choice;
			if (typeof choice !== "string" || choice === "") return undefined;
			const values = Object.values(answer.probabilities ?? {}).filter((value) => Number.isFinite(value));
			const best = Math.max(0, ...values);
			const runnerUp = [...values].sort((a, b) => b - a)[1] ?? 0;
			return { kind: "choice", choice, margin: best - runnerUp };
		},
		measured: false,
	},
];

export interface ToolChoiceBand {
	id: "tool.choice";
	role: "advisory";
	band: "satisfied" | "violated" | "unclear" | "missing";
	/** The tool the judge picked, when it answered. */
	choice: string | null;
	margin: number | null;
	purpose: string;
	measured: boolean;
}

/**
 * Whether the judge's pick clears the policy's margin.
 *
 * The bands are margins, not probabilities, and the comparison is against the
 * ask's preferred tool — the alternative the policy named for this call, which
 * `preferredTool` resolved and the question's wording offered as an option:
 * `violated` means the judge picked that alternative *and* said so clearly enough
 * (margin ≥ the policy's edge), `satisfied` means it picked the tool already in
 * use or named anything else, and `unclear` is a pick for the alternative without
 * a clear margin — the wide middle that must not fire a nudge on nearly every
 * call.
 */
export function toolChoiceBand(reading: ChoiceReading | undefined, preferredTool: string | null | undefined, policy: ToolPolicy): ToolChoiceBand {
	const base = { id: "tool.choice" as const, role: "advisory" as const, purpose: "another available tool fits this call's intent plainly better", measured: false };
	if (!reading) return { ...base, band: "missing", choice: null, margin: null };
	// The policy's alternative is what a violated band names: the judge endorsing
	// it clearly means the call in front of it picked the lesser tool.
	if (reading.choice === preferredTool && reading.margin >= policy.margin) return { ...base, band: "violated", choice: reading.choice, margin: reading.margin };
	if (reading.choice === preferredTool) return { ...base, band: "unclear", choice: reading.choice, margin: reading.margin };
	return { ...base, band: "satisfied", choice: reading.choice, margin: reading.margin };
}

/** The nudge text for a violated choice band. */
export function toolChoiceNudgeText(band: ToolChoiceBand, callLine: string, reason?: string | null): string {
	const alternative = band.choice ?? "another tool";
	const why = reason ? `: ${reason}` : ".";
	return `pi-jev: your policy prefers ${alternative} for ${callLine}${why} Use it, or say why this call needs the tool it chose.`;
}