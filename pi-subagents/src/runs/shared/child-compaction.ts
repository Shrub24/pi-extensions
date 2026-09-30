/**
 * Child context budget: keep a subagent's context bounded mid-run.
 *
 * Two halves, both inside pi-subagents' own lifecycle rather than in an
 * extension loaded into the child:
 *
 *  1. **Trigger** — the child session's settings manager gets
 *     `compaction.reserveTokens` set so pi's *own* between-turn check
 *     (`contextTokens > contextWindow - reserveTokens`, evaluated in
 *     `_compactBeforeNextAssistantResponse` during `prepareNextTurn`) fires at
 *     the budget. Nothing new triggers compaction; pi already does this for
 *     every session, children included. Children normally inherit the user's
 *     `compaction.enabled: false` (magic-context owns the parent), so the
 *     budget is applied through `SettingsManager.applyOverrides` — in-memory,
 *     never written to `~/.pi/agent/settings.json`.
 *
 *  2. **Summary** — `session_before_compact` gives us the compaction content,
 *     so pi never runs its LLM summarizer. We produce a deterministic
 *     algorithmic summary from the vendored pi-vcc pipeline (see `pi-vcc/`),
 *     falling back to pi's own summarizer if the pipeline yields nothing.
 *
 * Verified by probe (2026-09-30): with this hook registered, `reason:
 * "threshold"` fires mid-run, the compaction entry is written with our summary,
 * and the run continues (messages follow the compaction row).
 */

import type { ExtensionAPI, SessionBeforeCompactEvent, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../extension/config.ts";
import type { ChildHookExtension } from "./child-hooks.ts";
import { compile } from "./pi-vcc/core/summarize.ts";

/**
 * Context budget for a child: the smaller of a fraction of the model's window
 * and an absolute cap, so a small-window child is protected while a 1M-window
 * combo (omniroute `coder-high`) does not get a 300k budget it never needs.
 */
export const CHILD_CONTEXT_BUDGET_RATIO = 0.3;
export const CHILD_CONTEXT_BUDGET_CAP = 250_000;

/** Details marker identifying a compaction this hook produced. */
export const CHILD_COMPACTION_COMPACTOR = "pi-subagents:child-compaction";

/** Window assumed when the child's model reports none (matches pi's own fallback). */
const ASSUMED_WINDOW = 128_000;

/**
 * Budget parameters: `childContextBudget` from the subagents config when set,
 * the defaults above otherwise. Read per launch — the config file is small and
 * already parsed on the launch path.
 */
function configuredBudget(): { ratio: number; cap: number } {
	try {
		const { childContextBudget } = loadConfig();
		return {
			ratio: childContextBudget?.ratio ?? CHILD_CONTEXT_BUDGET_RATIO,
			cap: childContextBudget?.capTokens ?? CHILD_CONTEXT_BUDGET_CAP,
		};
	} catch {
		// A malformed config is the extension's own error to surface, not a reason
		// to leave a child unbounded.
		return { ratio: CHILD_CONTEXT_BUDGET_RATIO, cap: CHILD_CONTEXT_BUDGET_CAP };
	}
}

export interface ChildContextBudget {
	/** Absolute token budget at which the child should compact. */
	budgetTokens: number;
	/** The model's context window the budget was derived from. */
	contextWindow: number;
	/** reserveTokens to hand pi: window − budget. */
	reserveTokens: number;
}

export function resolveChildContextBudget(
	contextWindow: number | undefined,
	options: { ratio?: number; cap?: number } = {},
): ChildContextBudget {
	const window = typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : ASSUMED_WINDOW;
	const configured = configuredBudget();
	const ratio = options.ratio ?? configured.ratio;
	const cap = options.cap ?? configured.cap;
	// A window smaller than the cap must still leave room to respond, so never
	// let the budget swallow the whole context.
	const budgetTokens = Math.max(1, Math.min(Math.floor(window * ratio), cap, window - 1));
	return { budgetTokens, contextWindow: window, reserveTokens: window - budgetTokens };
}

/** Env escape hatch, mirroring pi-subagents' other child switches. */
function contextBudgetDisabled(): boolean {
	const raw = process.env.PI_SUBAGENTS_CHILD_CONTEXT_BUDGET?.trim().toLowerCase();
	return raw === "0" || raw === "false" || raw === "off";
}

/**
 * The structural slice of pi's settings manager this module touches. Declared
 * locally so the child-hook code compiles without importing pi's types.
 */
interface SettingsManagerLike {
	applyOverrides(overrides: Record<string, unknown>): void;
}

export interface ChildContextBudgetState {
	/** Set once the budget has been applied to a settings manager. */
	applied?: ChildContextBudget;
	/** Compactions this child performed, in order (for the orchestrator wake). */
	compactions: ChildCompactionRecord[];
	/** Notified when a compaction lands, so callers can wake the orchestrator. */
	onCompact?: (record: ChildCompactionRecord) => void;
}

/** One mid-run compaction a child performed under its context budget. */
export interface ChildCompactionRecord {
	at: number;
	tokensBefore: number;
	/** The child's budget at the time, or 0 when the budget was not applied. */
	budgetTokens: number;
	reason: string;
}

export function createChildContextBudgetState(): ChildContextBudgetState {
	return { compactions: [] };
}

/**
 * Apply the child's context budget to its settings manager.
 *
 * Called from the child factory once the model is resolved. Model-aware: pi
 * resolves `reserveTokens` per model at check time, so a mid-run `/model`
 * switch keeps the same *budget* semantics only if the model reports the same
 * window; the ordinary setting is the fallback either way.
 */
export function applyChildContextBudget(
	settingsManager: SettingsManagerLike,
	model: { contextWindow?: number } | undefined,
	state: ChildContextBudgetState,
	options: { ratio?: number; cap?: number } = {},
): ChildContextBudget | undefined {
	if (contextBudgetDisabled()) return undefined;
	const budget = resolveChildContextBudget(model?.contextWindow, options);
	settingsManager.applyOverrides({
		compaction: {
			enabled: true,
			reserveTokens: budget.reserveTokens,
			keepRecentTokens: Math.min(20_000, Math.max(1_000, Math.floor(budget.budgetTokens / 4))),
		},
	});
	state.applied = budget;
	return budget;
}

/**
 * Child hook: own the compaction summary on every path (threshold, manual,
 * overflow) so a child's compaction costs no model call and stays
 * deterministic.
 */
export function createChildCompactionHooks(state: ChildContextBudgetState): ChildHookExtension[] {
	return [
		{
			name: "pi-subagents:child-compaction",
			factory: (pi: ExtensionAPI) => {
				pi.on("session_before_compact", (event: SessionBeforeCompactEvent) => {
					const { preparation } = event;
					const firstKeptEntryId = preparation.firstKeptEntryId;
					const tokensBefore = preparation.tokensBefore;
					if (!firstKeptEntryId || typeof tokensBefore !== "number") return;
					// A split turn (the cut point lands mid-turn, which is the common case
					// for a threshold compaction during a long tool loop) puts the current
					// turn's earlier messages in `turnPrefixMessages` and leaves history in
					// `messagesToSummarize`. Both are discarded, so both must be summarized —
					// declining when only the history list is empty hands the work back to
					// pi's model-based summarizer for no reason.
					const messages = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
					if (messages.length === 0) return;
					let summary = "";
					try {
						summary = compile({
							messages: messages as never,
							previousSummary: preparation.previousSummary,
						});
					} catch {
						// Fail open to pi's summarizer rather than blocking compaction.
						return;
					}
					if (!summary.trim()) return;
					return {
						compaction: {
							summary,
							firstKeptEntryId,
							tokensBefore,
							details: { compactor: CHILD_COMPACTION_COMPACTOR, budgetTokens: state.applied?.budgetTokens },
						},
					};
				});
				pi.on("session_compact", (event: SessionCompactEvent) => {
					const entry = event.compactionEntry as { tokensBefore?: number; details?: { compactor?: string } };
					// Only count compactions we produced; pi's own fallback path is
					// already reported by the runner through usage, and counting it
					// twice would double-wake the orchestrator.
					if (entry?.details?.compactor !== CHILD_COMPACTION_COMPACTOR) return;
					const record = {
						at: Date.now(),
						tokensBefore: entry.tokensBefore ?? 0,
						budgetTokens: state.applied?.budgetTokens ?? 0,
						reason: String(event.reason ?? "threshold"),
					};
					state.compactions.push(record);
					state.onCompact?.(record);
				});
			},
		},
	];
}

/** Human-readable notice for the orchestrator wake. */
export function formatChildCompactionNotice(
	record: ChildCompactionRecord,
	agent: string | undefined,
): string {
	const subject = agent ? `${agent} ` : "";
	const budget = record.budgetTokens > 0 ? ` (budget ${record.budgetTokens.toLocaleString()})` : "";
	return `Child ${subject}compacted its context mid-run at ${record.tokensBefore.toLocaleString()} tokens${budget} — deterministic summary, no model call. The run continues; steer it if the remaining work no longer fits.`;
}
