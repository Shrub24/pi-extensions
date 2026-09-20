/*
 * The orchestrator's check-in: a timer-driven read of the subagent fleet.
 *
 * The permission link judges a forwarded ask while a human waits. This is the
 * other trigger: the orchestrator sitting idle while children run. pi-subagents
 * already marks a step `active_long_running` on an elapsed-time threshold and
 * appends a `subagent_control_notice` custom message to the session's branch;
 * this module reads those notices, asks the drift questions about the child
 * they name, and — on a violation — sends the orchestrator a steering sentence
 * with `followUp` + `triggerTurn`, which is the primitive that wakes an idle
 * agent. The wake IS the keep-alive: no separate heartbeat, because a quiet
 * child with nothing to say has nothing to steer.
 *
 * The state is the subagent-v1 group — role, task, instruction — because that is
 * what a check-in can know without a human waiting. The question set is the
 * same pack the forwarded-ask path uses; only the trigger differs, and the
 * answer cache is keyed per subject, so a check-in and a later gate ask about
 * the same child each read fresh.
 */

import type { ConversationFacts } from "./action-pack.js";
import { CHECK_IN_SURFACE, SUBAGENT_QUESTIONS } from "./consumers.js";
import type { Nudge } from "./consumers.js";
import type { JevConfig } from "./config.js";
import type { ActionContext } from "./action-pack.js";

/** The custom message types pi-subagents appends for control events. */
const NOTICE_TYPES = ["subagent_control_notice", "subagent-notify", "subagent-incremental-child-notify"] as const;

export interface ChildNotice {
	/** Stable per-notice id, so a notice is read once no matter how often the branch is scanned. */
	id: string;
	type: string;
	text: string;
}

/** Notices in the branch that `seen` has not recorded, oldest last. */
export function newNotices(entries: readonly unknown[], seen: ReadonlySet<string>, limit = 4): ChildNotice[] {
	const out: ChildNotice[] = [];
	entries.forEach((entry, index) => {
		if (!entry || typeof entry !== "object") return;
		const record = entry as { type?: unknown; customType?: unknown; id?: unknown; content?: unknown };
		if (record.type !== "custom_message" || typeof record.customType !== "string") return;
		if (!(NOTICE_TYPES as readonly string[]).includes(record.customType)) return;
		const id = typeof record.id === "string" && record.id !== "" ? record.id : `${record.customType}#${index}`;
		if (seen.has(id)) return;
		const text = typeof record.content === "string" ? record.content : "";
		if (text.trim() === "") return;
		out.push({ id, type: record.customType, text });
	});
	return out.slice(-limit);
}

/** The subject line one notice becomes: the child it names and what it says. */
export function noticeSubject(notice: ChildNotice): string {
	const line = notice.text.split("\n").find((line) => line.trim() !== "") ?? notice.text;
	return line.length <= 300 ? line : `${line.slice(0, 299)}…`;
}

/**
 * The agent name a notice carries.
 *
 * pi-subagents writes one line per control event, and the name is the first
 * line's tail: `Subagent active but long-running: reviewer`,
 * `Subagent needs attention: fixer-2`, `Subagent failed: critic`. Matching those
 * shapes rather than a loose "agent X" pattern matters — the loose form reads
 * `Subagent active but long-running` as an agent named "active".
 */
export function noticeAgent(notice: ChildNotice): string | null {
	const first = noticeSubject(notice);
	const match = /^subagent\s+[^:]{0,80}:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*$/i.exec(first.trim());
	return match?.[1] ?? null;
}

/**
 * Whether this notice is worth a check-in.
 *
 * The signal is the control event kind, which pi-subagents writes as the first
 * line's prefix: `Subagent active but long-running`, `Subagent needs attention`,
 * `Subagent failed`. A plain completion report is not a drift question — the
 * agent already gets its own turn for a finished child — so it stays out.
 */
export function noticeNeedsAttention(notice: ChildNotice): boolean {
	return /^subagent\s+(?:active but long-running|needs attention|failed)\b/i.test(noticeSubject(notice).trim());
}

/** The latest user instruction, bounded; null when the branch has none. */
export function latestUserMessage(conversation: ConversationFacts): string | null {
	return conversation.userMessages.length > 0 ? (conversation.userMessages[conversation.userMessages.length - 1] ?? null) : null;
}

/** One check-in's subject key: derived from the notice id, unique per notice. */
export function checkInSubjectKey(notice: ChildNotice): string {
	return `child:notice:${notice.id}`;
}

/** The action context one check-in asks about. */
export function checkInAction(notice: ChildNotice, conversation: ConversationFacts | (() => ConversationFacts)): ActionContext {
	return {
		facts: {
			requestId: checkInSubjectKey(notice),
			toolCallId: null,
			surface: CHECK_IN_SURFACE,
			kind: "subagent",
			value: noticeSubject(notice),
			toolName: null,
			invokedToolName: null,
			matchedPattern: null,
			commandContext: null,
			executedUnit: null,
			agentName: noticeAgent(notice),
			forwarded: false,
			policy: { surfaceState: "unknown", toolState: null },
			path: null,
		},
		conversation,
	};
}

/** The questions a check-in asks: the whole subagent pack, standing interest. */
export const CHECK_IN_QUESTIONS: readonly string[] = SUBAGENT_QUESTIONS;

/** Scan interval, derived from the config so the operator owns the cadence. */
export function checkInIntervalMs(config: JevConfig): number {
	return config.orchestratorCheckInMs;
}

/**
 * Whether the agent is idle enough to steer. A check-in that fires mid-turn
 * queues its nudge as a steer (the nudge path already does that); this
 * predicate governs the wake, because waking an agent that is mid-turn would
 * just stack a second queue entry.
 */
export function shouldWake(deliveries: number): boolean {
	// The check-in itself is not a turn: the wake is the only thing that costs
	// the orchestrator's attention, and it fires only when a violation was found.
	return deliveries > 0;
}

/**
 * One message for a whole scan.
 *
 * Each finding is a sentence about a different question, and the wake is what
 * costs a turn: three children with one violation each should be one message
 * the orchestrator reads, not three it queues. The combined nudge keeps the
 * weakest evidence claim of its parts, so a scan that rests on an unmeasured
 * bar still says so.
 */
export function combineFindings(findings: readonly Nudge[]): Nudge | undefined {
	if (findings.length === 0) return undefined;
	const text = findings.map((finding) => finding.text).join("\n\n");
	return {
		source: findings.length === 1 ? (findings[0]?.source ?? "orchestrator.check_in") : "orchestrator.check_in",
		role: "advisory",
		severity: findings.some((finding) => finding.severity === "warn") ? "warn" : "notice",
		measured: findings.every((finding) => finding.measured),
		text: text.length <= MAX_WAKE_CHARS ? text : `${text.slice(0, MAX_WAKE_CHARS - 1)}…`,
	};
}

/** A wake is read in one glance; past this it is a report, and the log has it. */
const MAX_WAKE_CHARS = 1_200;
