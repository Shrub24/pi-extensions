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
import { BLOCK_ASK, BLOCK_PLAN, BLOCK_TOOL_HISTORY, BLOCK_TOOLBOX } from "./action-pack.js";
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

/** A ranked preference for one kind of work: `order[0]` is the tool of choice. */
export interface ToolPrecedence {
	/** What the call is trying to do, matched by the judge, not by code. */
	intent: string;
	/** Ranked tools, best first. Entries beyond 4 are dropped at parse time. */
	order: string[];
	/** Why the policy ranks it this way, in one clause. Nudge text quotes this. */
	reason: string;
}

/** A tool the policy warns against in a stated context. */
export interface ToolAvoid {
	/** The tool being warned about. */
	tool: string;
	/** When the warning applies, as a substring of the call's arguments. */
	when: string;
	/** Why the policy warns against it, in one clause. Nudge text quotes this. */
	reason: string;
}

/** A qualitative directive the judge reads verbatim. Never fires a nudge alone. */
export interface ToolDirective {
	/** When it applies, as a substring of the tool name; absent means every call. */
	when?: string;
	/** The directive itself, one clause. */
	text: string;
}

export interface ToolPolicy {
	/** A `name → preferred` map, plus optional per-tool matching clauses. */
	preferences: ToolPreference[];
	/** Ranked preferences per intent, for the N-option form of the choice question. */
	precedence?: ToolPrecedence[];
	/** Contexts where a tool is warned against, feeding the tool-fit question. */
	avoid?: ToolAvoid[];
	/** Qualitative directives folded into question instructions. */
	directives?: ToolDirective[];
	/** How much better the preferred tool must look before the nudge fires. */
	margin: number;
	/** The avoid question's own bar; falls back to `margin` when unset. */
	avoidMargin?: number;
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = { preferences: [], margin: 0.2 };

/** The most options a choice question carries; the order below the cut is dropped. */
export const MAX_CHOICE_OPTIONS = 4;

/**
 * What the policy says about one call: the alternatives it ranks, and the
 * directives that color the judge's read. Resolution order: an `intent`
 * precedence whose tools include the tool in use beats a per-call `match`, and
 * a per-call `match` beats a bare mapping — the most specific rule wins.
 */
export interface ToolGuidance {
	/** Ranked alternatives to the tool in use, best first, current tool excluded. */
	alternatives: { tool: string; reason: string }[];
	/** Why the policy ranks these this way, for the nudge text. */
	reason: string | null;
	/** The intent clause, when a precedence rule matched. */
	intent: string | null;
	/** Directives that apply to this call, verbatim. */
	directives: string[];
	/** The avoid-pair that matched, when one did. */
	avoid: ToolAvoid | null;
	/** The margin the choice nudge needs; per-rule, then the policy's. */
	margin: number;
	/** The avoid nudge's margin; per-rule `avoidMargin`, then `margin`. */
	avoidMargin: number;
}

export const EMPTY_GUIDANCE: ToolGuidance = { alternatives: [], reason: null, intent: null, directives: [], avoid: null, margin: 0.2, avoidMargin: 0.2 };

/** The tool name a call used, and the alternative the policy would rather see. */
export function preferredTool(ask: ActionAskFacts, policy: ToolPolicy): { preferred: string; reason: string } | undefined {
	const guidance = toolGuidance(ask, policy);
	const first = guidance.alternatives[0];
	return first ? { preferred: first.tool, reason: guidance.reason ?? first.reason } : undefined;
}

/** Whether an avoid-pair matches this call: the tool in use, in the stated context. */
function matchingAvoid(ask: ActionAskFacts, policy: ToolPolicy): ToolAvoid | undefined {
	if (ask.toolName === null) return undefined;
	return (policy.avoid ?? []).find((rule) => rule.tool === ask.toolName && ask.value.toLowerCase().includes(rule.when.toLowerCase()));
}

/** Directives that apply: those with no `when`, or whose `when` names the tool in use. */
function matchingDirectives(ask: ActionAskFacts, policy: ToolPolicy): string[] {
	return (policy.directives ?? [])
		.filter((directive) => directive.when === undefined || (ask.toolName !== null && directive.when.toLowerCase() === ask.toolName.toLowerCase()))
		.map((directive) => directive.text);
}

/**
 * Everything the policy says about one call, resolved once and read by both
 * questions. Specificity order for alternatives: an intent precedence whose
 * `order` contains the tool in use, then a per-call `match`, then a bare
 * mapping. The current tool never appears among the alternatives.
 */
export function toolGuidance(ask: ActionAskFacts, policy: ToolPolicy): ToolGuidance {
	const directives = matchingDirectives(ask, policy);
	const avoid = matchingAvoid(ask, policy);
	const base = { directives, avoid: avoid ?? null, margin: policy.margin, avoidMargin: policy.avoidMargin ?? policy.margin };
	if (ask.toolName === null) return { ...EMPTY_GUIDANCE, ...base };

	// An intent precedence that names the tool in use: the most specific rule.
	const precedence = (policy.precedence ?? []).find((rule) => rule.order.some((tool) => tool === ask.toolName));
	if (precedence) {
		const better = precedence.order.filter((tool) => tool !== ask.toolName).slice(0, MAX_CHOICE_OPTIONS - 1);
		return {
			...base,
			alternatives: better.map((tool) => ({ tool, reason: precedence.reason })),
			reason: precedence.reason,
			intent: precedence.intent,
		};
	}

	// A per-call match: one named alternative for calls whose args contain it.
	for (const preference of policy.preferences) {
		if (preference.tool === ask.toolName || preference.match === undefined) continue;
		// A per-call match has no tool of its own to anchor on — it matches the
		// call's text — so it pays the same guard the other branches do: a rule
		// naming the tool already in use is not an alternative to it.
		if (!ask.value.toLowerCase().includes(preference.match.toLowerCase())) continue;
		return { ...base, alternatives: [{ tool: preference.tool, reason: preference.reason }], reason: preference.reason, intent: null };
	}

	// A bare mapping, matched by the reason naming the tool in use.
	const plain = policy.preferences.find((preference) => preference.match === undefined && preference.tool !== ask.toolName && preference.reason.includes(ask.toolName));
	if (plain) return { ...base, alternatives: [{ tool: plain.tool, reason: plain.reason }], reason: plain.reason, intent: null };

	return { ...EMPTY_GUIDANCE, ...base };
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
		blocks: [BLOCK_ASK, BLOCK_PLAN, BLOCK_TOOL_HISTORY, BLOCK_TOOLBOX],
		purpose: "another available tool fits this call's intent plainly better",
		role: "advisory",
		applies: (ask) => ask.toolName !== null && ask.preferredTool != null,
		question: (ask) => {
			if (ask.toolName === null || ask.preferredTool == null) return undefined;
			// The policy's full guidance rides the wording: ranked alternatives as
			// options, directives as instructions, the intent clause up front. The
			// tool in use is always an option, and always answers it, so "the call
			// was right" is an answer the judge can give rather than a forced pick.
			const options: Record<string, string> = {
				[ask.toolName]: "the tool already in use, for the intent in `ask.value`",
			};
			const ranked = ask.rankedAlternatives ?? [];
			for (const alternative of ranked) options[alternative.tool] = `the alternative the user's policy ranks better for ${alternative.intent ?? "this intent"}: ${alternative.reason}`;
			if (ranked.length === 0) options[ask.preferredTool] = `the alternative the user's policy prefers, and why: ${ask.preferredReason ?? ""}`;
			const directiveLines = (ask.policyDirectives ?? []).map((line) => ` ${line}`).join(";");
			const instructions =
				"Pick which available tool best fits the intent of the call in `ask`. The toolbox lists what is available now, with a line each. Answer with the one tool whose purpose covers what this call is trying to do; if the tool used is already the best fit, answer with it. Judge fit by what the call is trying to do, not by which tool is already in use." +
				(ask.policyIntent ? ` The user's policy says, for this kind of work (${ask.policyIntent}), which tools they would rather see.` : "") +
				(directiveLines ? ` The user's directives for tool choice:${directiveLines}.` : "");
			return {
				type: "choice",
				instructions,
				criteria: options,
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
 * ask's preferred tool — the top-ranked alternative the policy named for this
 * call, which `preferredTool` resolved and the question's wording offered as an
 * option: `violated` means the judge picked that alternative *and* said so
 * clearly enough (margin ≥ the policy's edge), `satisfied` means it picked the
 * tool already in use or named anything else, and `unclear` is a pick for the
 * alternative without a clear margin — the wide middle that must not fire a
 * nudge on nearly every call.
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

/** The nudge text for a matched avoid-pair: warn, quote the policy's reason. */
export function toolAvoidNudgeText(callLine: string, reason: string): string {
	return `pi-jev: your policy warns against this call — ${reason} Do it another way, or say why this call needs the tool it chose.`;
}