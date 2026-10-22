/**
 * The declared `bg_task` surface and the guidance text that names its operations.
 *
 * There is one surface, and it exists only in the interactive TUI: `spawn`, `get`,
 * `stop`, `list` and `extend`. Every other Pi mode runs Pi's own `bash` and has no
 * background tasks, so no text here has to name an operation a mode lacks. Every
 * text that tells the agent how to inspect a task names only these operations; a
 * live-log path is never a retrieval route, `get` is.
 *
 * This is a leaf module on purpose: `registrations.ts` (which owns the tool
 * declarations) and `auto-background.ts` / `wake-events.ts` (which own the
 * acknowledgement and wake text) both import it, and neither may import the
 * other.
 */

/** Shared contract for the coupled managed-bash and bg_task tools. */
export const BASH_TASK_GUIDELINES = [
	"Do not trim managed bash output with `| tail`, `| head` or `2>/dev/null`: it hides failures and forces re-runs. Inside a background task the discarded lines never reach the captured result either, so `get output:\"full\"` cannot return them. Managed shells use pipefail.",
	"Do not sleep to wait: `sleep N; check` and `while ...; do sleep N; done` are polling with extra steps, and a long sleep only builds a timer the task system already runs. End the turn and let the wake arrive, and set `softTimeoutMs` to how often a long task should check in.",
	"A `Running` result is not complete output. Do not poll or repeatedly inspect a running task; use its soft reminders and completion wake to decide what to do next.",
	"Read a finished background task's result with `bg_task action:\"get\" output:\"full\"`; do not read its log file directly. For a confirmed stop, `output:\"full\"` returns the final result in the same call.",
] as const;

/** The complete `bg_task` action surface. */
export const BG_TASK_ACTIONS = ["spawn", "get", "stop", "list", "extend"] as const;

/** The one spelling of each piece of advice that names an operation. */
export const TASK_GUIDANCE = {
	/** What to do after a `Running` result; shared by the auto-background ack and the managed-bash yield. */
	runningAdvice:
		"Do not poll it (no sleep/tail loops, no repeated get calls) — continue independent work or end the turn; the exit wake arrives with an output tail.",
	/** How to inspect a task the caller should look at. */
	inspect: 'bg_task action:"get"',
	/** The reason text for an auto-backgrounded sleep loop. */
	pollingReason: "polling loop (agent waiting on something? prefer ending the turn and letting the exit wake arrive)",
	/** Wording for an already-running identical task. */
	duplicateRunning: "Wait for its completion wake rather than starting it again, or stop it first.",
	/** Wording for a similar already-running task. */
	similarRunning: "If this was meant to poll or retry it, end the turn and let the existing task's completion wake arrive.",
	/** Wording for a same-command task that finished recently. */
	recentRerun: (id: string) => `Rerun only what changed (bg_task action:"get" id: "${id}" shows the captured result) unless the code changed since.`,
	/** What a soft reminder offers: continue (optionally re-arming the interval), or stop. */
	softReminderChoices:
		'Choose one: end your turn and let it ask again in the same interval (or re-arm it now with bg_task action:"extend" id:... softTimeoutMs:...), or stop the task with bg_task action:"stop". Nothing was stopped; the exit wake is still armed.',
} as const;

export interface WakeTaskState {
	id: string;
	status?: string;
	exitCode?: number | null;
}

/** One wake line for one task: its id and what it did. */
export function wakeTaskLine(task: WakeTaskState): string {
	if (task.status === "running") return `${task.id} · still running`;
	return `${task.id} · ${task.exitCode == null ? "ended without an exit code" : `exit ${task.exitCode}`}`;
}

/** The retrieval instruction, stated once per message rather than per task line. */
export function retrievalHint(id = "<id>"): string {
	return `Retrieve ${id === "<id>" ? "a result" : "its result"} with ${TASK_GUIDANCE.inspect} id: ${id}.`;
}
