/**
 * The declared tool surface of a session mode, and the guidance text that
 * depends on it.
 *
 * Two facts have to agree, and this module is the one place either is spelled:
 *
 * 1. `tui` declares `bg_task` with exactly `spawn/get/stop/list/extend` and no
 *    `bg_status`; every other mode — `print`, `json`, `rpc`, and any value this
 *    build does not know — keeps the compatibility surface with the retained
 *    bounded `wait` and the `bg_status` status tool. `extend` is the one action
 *    the narrowed surface shares with the compatibility one: re-arming a task's
 *    soft reminder is neither a bounded wait nor a raw-log read.
 * 2. Every text surface that tells the agent or the operator how to inspect a
 *    task may only name operations that surface actually declares. A TUI wake
 *    that says `bg_task log` or `bg_task action:"wait"` names an operation the
 *    model cannot call, and a live-log path is not a retrieval route in any mode:
 *    the declared `get` operation is.
 *
 * This is a leaf module on purpose: `registrations.ts` (which owns the tool
 * declarations) and `auto-background.ts` / `wake-events.ts` (which own the
 * acknowledgement and wake text) both import it, and neither may import the
 * other.
 */

export type TaskToolSurface = "tui" | "compat";

/** The complete `bg_task` action surface of each mode. */
export const TUI_BG_TASK_ACTIONS = ["spawn", "get", "stop", "list", "extend"] as const;
export const COMPAT_BG_TASK_ACTIONS = ["spawn", "list", "log", "get", "stop", "clear", "wait", "extend"] as const;

/**
 * Which surface a session mode gets. Only the interactive TUI is narrowed; the
 * mode union has no `"unknown"` member, so an unrecognized value falls through
 * to the compatibility surface as a runtime guard.
 */
export function taskToolSurfaceFor(mode: string | undefined): TaskToolSurface {
	return mode === "tui" ? "tui" : "compat";
}

/** The action enum the surface declares, so the schema and the prose agree. */
export function taskSurfaceActions(surface: TaskToolSurface): readonly string[] {
	return surface === "tui" ? TUI_BG_TASK_ACTIONS : COMPAT_BG_TASK_ACTIONS;
}

/**
 * Mode-dependent phrases for text that names an operation. Each field is the
 * only spelling of that advice in the codebase, so a mode that lacks an action
 * can never be handed prose that recommends it.
 */
export interface TaskSurfaceGuidance {
	/** What to do after a `Running` result; shared by the auto-background ack and the managed-bash yield. */
	runningAdvice: string;
	/** How to inspect a task the caller should look at. */
	inspect: string;
	/** How to reach a finished task's complete output. */
	fullResult: string;
	/** How to read a failed batch of tasks. */
	reviewFailures: string;
	/** The reason text for an auto-backgrounded sleep loop. */
	pollingReason: string;
	/** Wording for an already-running identical task. */
	duplicateRunning: string;
	/** Wording for a similar already-running task. */
	similarRunning: string;
	/** Wording for a same-command task that finished recently. */
	recentRerun: (id: string) => string;
	/** What a soft reminder offers: continue (optionally re-arming the interval), inspect, or stop. */
	softReminderChoices: string;
	/** How an unretrieved result is explicitly dismissed when it is no longer wanted. */
	dismiss: (id: string) => string;
}

const TUI_GUIDANCE: TaskSurfaceGuidance = {
	runningAdvice:
		'Do not poll it (no sleep/tail loops, no repeated get calls) — continue independent work or end the turn; the exit wake arrives with an output tail.',
	inspect: 'bg_task action:"get"',
	fullResult: 'bg_task action:"get" output:"full"',
	reviewFailures: "review with bg_task action:\"get\"",
	pollingReason: "polling loop (agent waiting on something? prefer ending the turn and letting the exit wake arrive)",
	duplicateRunning: "Prefer bg_task action:\"get\" on the existing task, or stop it first.",
	similarRunning: "If this was meant to poll or retry it, bg_task action:\"get\" on the existing task is cheaper.",
	recentRerun: (id) => `Rerun only what changed (bg_task action:"get" id: "${id}" shows the captured result) unless the code changed since.`,
	softReminderChoices:
		'Choose one: let it continue (it will ask again in the same interval, or re-arm it now with bg_task action:"extend" id:... softTimeoutMs:...), inspect it with bg_task action:"get", or stop the task with bg_task action:"stop". Nothing was stopped; the exit wake is still armed.',
	dismiss: (id) => `bg_task action:"clear" ids:["${id}"]`,
};

const COMPAT_GUIDANCE: TaskSurfaceGuidance = {
	runningAdvice:
		'Do not poll it (no sleep/tail loops, no repeated list/log calls) — continue independent work or end the turn; the exit wake arrives with an output tail. Need it this turn? bg_task action:"wait" blocks once, bounded.',
	inspect: 'bg_task action:"get"',
	fullResult: 'bg_task action:"get" output:"full"',
	reviewFailures: "review with bg_task log",
	pollingReason: "polling loop (agent waiting on something? prefer bg_task wait or ending the turn)",
	duplicateRunning: "Prefer bg_task wait/log on the existing task, or stop it first.",
	similarRunning: "If this was meant to poll or retry it, bg_task wait on the existing task is cheaper.",
	recentRerun: (id) => `Rerun only what changed (bg_task log ${id} shows the previous tail) unless the code changed since.`,
	softReminderChoices:
		'Choose one: continue (it will ask again in the same interval, or extend it now with bg_task action:"extend" id:... softTimeoutMs:...), inspect it with bg_task action:"get", or stop the task with bg_task action:"stop". Nothing was stopped; the exit wake is still armed.',
	dismiss: (id) => `bg_task action:"clear" ids:["${id}"]`,
};

export function taskSurfaceGuidance(surface: TaskToolSurface): TaskSurfaceGuidance {
	return surface === "tui" ? TUI_GUIDANCE : COMPAT_GUIDANCE;
}

export interface WakeTaskState {
	id: string;
	status?: string;
	exitCode?: number | null;
	resultResolution?: "delivered" | "error" | "dismissed";
}

/**
 * One wake line for one task: what it did, and what its result still owes the
 * reader. A wake reports every task it covers in this shape, so a batch cannot
 * be read as work that is done with, and a finished task is never confused with
 * one whose result has been handed over.
 */
export function wakeTaskLine(task: WakeTaskState, guidance: TaskSurfaceGuidance): string {
	if (task.status === "running") return `${task.id} · still running · result pending`;
	const outcome = task.exitCode == null ? "ended without an exit code" : `exit ${task.exitCode}`;
	// `unretrieved` is the only state that still owes the reader something; a
	// resolution — delivery, capture error, or an explicit dismissal — does not.
	const owed = task.resultResolution === undefined
		? `result unretrieved — ${guidance.inspect} id: ${task.id}, or dismiss it with ${guidance.dismiss(task.id)}`
		: "result already resolved";
	return `${task.id} · ${outcome} · ${owed}`;
}
