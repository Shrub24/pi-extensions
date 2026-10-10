// Shared completion-lifecycle primitives for background-task retrieval.
//
// Three clocks decide what a retrieval may report, and they do not end
// together:
//
//   * process clock — the child closed and `finalizeTask` ran,
//   * output clock  — the log writer's flush for that file settled,
//   * review clock  — the last deliberate inspection of a running task.
//
// `taskReadiness` isolates the first two. It exists because `finalizeTask`
// closes the process *before* it waits on `taskLogs.flush`, so
// `status !== "running"` on its own is exactly the late-output race the
// retrieval contract forbids reporting as a complete result. The transition is
// recorded on the task by `beginResultFinalization` / `completeResultFinalization`
// so the state is explicit rather than re-derived from a weak set.
// `completeResultFinalization` records the capture's integrity alongside it,
// and `taskSnapshot` persists both: after a restart there is no process to
// flush and no writer queue to consult, so a short capture has to survive the
// round trip as a durable fact instead of being re-derived from an empty queue.
//
// `buildTaskResultObservation` is the one result-preparation path every
// adapter (tool get, CLI get, stop, foreground delivery) is meant to share, so
// readiness, deadlines, the changed-output marker, the bounded preview, and
// the `outputComplete` flag cannot drift between them. `outputComplete` is the
// second half of readiness: a terminal task whose log writer never settled (a
// failed or still-stalled write) has a retained log short by the bytes it
// dropped, and must be reported as short rather than as a complete result.
// It holds only while the task's durable capture record agrees; a restored
// task's own record outvotes the fresh, empty writer queue that a restart
// leaves behind. Output arrives through an injected read: a result is never
// fabricated from a missing log, and a missing retained log is an explicit
// error rather than an empty success.
//
// `acknowledgeCompletion` is the single idempotent completion-acknowledgment
// entry point. It records the obligation durably and, by default, drops any
// completion wake this process still holds for the task — the same call a
// terminal retrieval, a confirmed stop, a foreground delivery, or a host
// notification makes.
//
// `reviewDeadlineFor` / `reviewReminderArmed` are the progress-review clock:
// measured from the most recent successful review, never from output activity,
// and never moving the absolute hard deadline. `selectPrunableFinishedTasks`
// keeps a finished task whose result is still being prepared out of retention
// pruning.
//
// Everything here is pure: no Pi host access and no module-level state, so the
// extension closure and the test suite exercise the same code.

import type { BackgroundTaskStatus, BackgroundTaskTerminationReason } from "./types.js";

/**
 * How far a task has moved along the terminal transition.
 *
 *   running    — the process is active; a retrieval is a partial read.
 *   finalizing — the process ended and *this* process still holds the writer
 *                queue for its last bytes. The state advances on its own.
 *   terminal   — process ended and the flush barrier settled: this is the
 *                result.
 *   incomplete — a rehydrated task whose snapshot recorded an unsettled
 *                flush. The process that owned the writer is gone, so the
 *                state can never advance: the retained bytes are all there
 *                will ever be, and calling it `finalizing` would promise a
 *                completion that is not coming. Never acknowledges completion.
 */
export type TaskReadiness = "running" | "finalizing" | "terminal" | "incomplete";

/**
 * A task whose output is being prepared by a retrieval is protected from the
 * finished-task bound until that preparation ends.
 */
export interface ResultPreparationLease {
	release: () => void;
}

/**
 * `restored` is what separates `incomplete` from `finalizing`. The same
 * unsettled record means "a writer this process owns is still working on it"
 * in the process that wrote the snapshot, and "nothing will ever settle it" in
 * the process that rehydrated it: restore leaves the task with no child, no
 * writer queue and no orphan watcher for a stopped task, so the state is
 * terminal-by-record. A live task is never marked `restored`.
 */
export function taskReadiness(task: { status: BackgroundTaskStatus; resultReady?: boolean; restored?: boolean }): TaskReadiness {
	if (task.status === "running") return "running";
	if (task.resultReady === true) return "terminal";
	return task.restored === true ? "incomplete" : "finalizing";
}

/**
 * Process lifecycle ended, output persistence still settling. Called before
 * the flush barrier so a retrieval that races the flush sees `finalizing`,
 * and so a snapshot written in that window records an explicit "not complete
 * yet" instead of leaving the field absent.
 */
export function beginResultFinalization(task: { resultReady?: boolean; outputComplete?: boolean }): void {
	task.resultReady = false;
	task.outputComplete = false;
}

/**
 * The flush barrier settled: the retained output is now the terminal result.
 * `outputComplete` is the writer's own answer for this file — false when it
 * dropped bytes (a failed or stalled write), which nothing later recovers.
 * Callers pass `taskLogs.settled(task.logFile)`, or `true` for a rehydrated
 * task that has no writer queue left to lose bytes to.
 */
export function completeResultFinalization(task: { resultReady?: boolean; outputComplete?: boolean; restored?: boolean }, outputComplete: boolean): void {
	task.resultReady = true;
	// A rehydrated task has no writer queue of its own, so its durable record is
	// the only evidence of what the *previous* process did with its bytes: a
	// capture the record left uncertified stays uncertified, and no later caller
	// can upgrade it into a complete handoff by asserting completeness for a file
	// it never wrote. A live task's record is not a veto — its own writer decides.
	task.outputComplete = task.restored === true && task.outputComplete === false ? false : outputComplete;
}

/** Full output of `logFile`, or the reason it cannot be handed off. */
export type TaskOutputRead = { ok: true; output: string } | { ok: false; error: string };

export interface RetainedOutputDeps {
	exists: (file: string) => boolean;
	read: (file: string) => string;
}

/**
 * Read a task's retained output. A log that is gone or unreadable is an
 * explicit failure: an expired handle must error rather than report a
 * successful empty result. A log that exists and is empty is a real empty
 * result and stays `ok`.
 */
export function readRetainedOutput(logFile: string, deps: RetainedOutputDeps): TaskOutputRead {
	if (!logFile) return { ok: false, error: "no retained output file for this task" };
	if (!deps.exists(logFile)) return { ok: false, error: `retained output is gone (${logFile}); the task may have expired` };
	try {
		return { ok: true, output: deps.read(logFile) };
	} catch (error) {
		return { ok: false, error: `retained output unreadable (${logFile}): ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** The absolute process-lifetime ceiling, or null when none is configured. */
export type HardDeadline = number | null;

export interface TaskResultTask {
	id: string;
	command: string;
	cwd: string;
	pid: number;
	status: BackgroundTaskStatus;
	resultReady?: boolean;
	exitCode: number | null;
	terminationReason?: BackgroundTaskTerminationReason;
	startedAt: number;
	updatedAt: number;
	/** Set while a stop/shutdown has been requested but not finalized. */
	stopReason?: "user" | "timeout" | "shutdown" | null;
	expiresAt: number | null;
	softTimeoutMs?: number;
	softExpiresAt?: number | null;
	lastReviewedAt?: number;
	reviewRevision?: number;
	outputBytes: number;
	reviewedOutputBytes?: number;
	notifyOnExit: boolean;
	exitNotified?: boolean;
	/**
	 * Durable capture-integrity record (see `BackgroundTaskSnapshot`). False
	 * means the capture is known to be short no matter what this process's
	 * writer queue says, which is the only signal available after a restore.
	 */
	outputComplete?: boolean;
	/**
	 * True only on a task this process rehydrated from a snapshot, which is
	 * what makes an unsettled record unrecoverable rather than merely pending.
	 */
	restored?: boolean;
}

/**
 * One observation of a task, produced the same way for a running, finalizing,
 * or terminal read. Retrieval metadata only: the mutable live log handle is
 * never part of it.
 */
export interface TaskResultObservation {
	id: string;
	command: string;
	cwd: string;
	pid: number;
	readiness: TaskReadiness;
	status: BackgroundTaskStatus;
	exitCode: number | null;
	terminationReason?: BackgroundTaskTerminationReason;
	startedAt: number;
	updatedAt: number;
	elapsedMs: number;
	/** Absolute process-lifetime ceiling; unaffected by any review. */
	hardDeadlineAt: HardDeadline;
	/** When the next progress review falls due, or null when disabled. */
	reviewDeadlineAt: number | null;
	outputBytes: number;
	/** Cheap output marker a later review compares against. */
	outputRevision: number;
	/** Whether captured output changed since the previous successful review. */
	outputChanged: boolean;
	outputPreview: string;
	outputPreviewTruncated: boolean;
	/** Set when the retained output could not be read; preview is then empty. */
	outputError?: string;
	/**
	 * True only when `readiness` is terminal *and* the capture is known whole:
	 * the live writer settled this file and the task's durable record does not
	 * contradict it. A failed or still-stalled write leaves the retained log
	 * short by the bytes it dropped, and a restored task's durable record is
	 * what keeps that true after the writer queue is gone, so a terminal read
	 * with `outputComplete: false` is a short result: the caller must say so
	 * rather than advertise a complete one. Running and finalizing reads are
	 * never complete. `outputError` (unreadable) and this flag are independent.
	 *
	 * A terminal observation with `outputComplete: false` is therefore *not* a
	 * successful complete-output handoff: a caller keeps the partial bytes and
	 * the loss/error metadata accessible, but commits neither terminal
	 * acknowledgment nor a review reset on that handoff. Readiness `incomplete`
	 * is the same rule, one step stronger: the capture can never be completed.
	 * A *running* read is the separate allowed case — a partial snapshot handed
	 * off against a running readiness is an ordinary running handoff. Bytes a
	 * writer dropped are never re-created by a retry.
	 */
	outputComplete: boolean;
	/** True while a completion notification is still owed to this task. */
	completionOwed: boolean;
}

/** What a successful handoff settled. */
export interface TaskResultAck {
	acknowledged: boolean;
	/** `terminal` committed the completion; `review` only reset the review
	 *  clock; `none` settled nothing. */
	committed: "terminal" | "review" | "none";
	reviewed: boolean;
}

/**
 * The shared get operation's outcome: the one prepared result both adapters
 * hand to a caller. The `bg_task` tool and the declared `pi-bg` CLI differ in
 * transport, never in what a prepared handoff is or what commits one.
 *
 * Preparing commits nothing. A caller that did deliver the output commits the
 * handoff through the shared commit rule; a caller that could not must not.
 */
export interface TaskResultHandoff {
	observation: TaskResultObservation;
	/** Present for a full read: an immutable artifact, never a live log path the
	 *  producer may still be writing. */
	artifact?: { bytes: number; complete: boolean; partial: boolean; path: string };
	/** Set when the capture cannot be certified complete. The bytes are real, but
	 *  they are not a complete result, so no handoff may be committed from them. */
	captureError?: string;
	/** Set when the output could not be handed over at all. */
	failure?: { code: "expired" | "internal"; message: string };
}

export interface BuildTaskResultInput {
	task: TaskResultTask;
	now: number;
	/** Characters of captured output to include as the bounded preview. */
	outputPreviewChars: number;
	output: TaskOutputRead;
	/**
	 * Whether the log writer this process owns has settled this task's file,
	 * i.e. has no write in flight, no pending text and no failure marker
	 * outstanding. It is the live half of the completeness question; the task's
	 * durable `outputComplete` is the half that survives a restart.
	 */
	logSettled: boolean;
}

function boundedPreview(text: string, maxChars: number): { preview: string; truncated: boolean } {
	const cap = Math.max(0, Math.floor(maxChars));
	if (text.length <= cap) return { preview: text, truncated: false };
	return { preview: `[...truncated]\n${text.slice(-cap)}`, truncated: true };
}

/** Build the shared observation every retrieval adapter reports. */
export function buildTaskResultObservation(input: BuildTaskResultInput): TaskResultObservation {
	const { task } = input;
	const observation: TaskResultObservation = {
		command: task.command,
		completionOwed: completionOwed(task),
		cwd: task.cwd,
		elapsedMs: Math.max(0, (task.status === "running" ? input.now : task.updatedAt) - task.startedAt),
		exitCode: task.exitCode,
		hardDeadlineAt: task.expiresAt,
		id: task.id,
		outputBytes: task.outputBytes,
		outputChanged: task.reviewedOutputBytes === undefined || task.reviewedOutputBytes !== task.outputBytes,
		outputComplete: input.output.ok && taskReadiness(task) === "terminal" && input.logSettled && task.outputComplete !== false,
		outputPreview: "",
		outputPreviewTruncated: false,
		outputRevision: task.outputBytes,
		pid: task.pid,
		readiness: taskReadiness(task),
		reviewDeadlineAt: reviewDeadlineFor(task),
		startedAt: task.startedAt,
		status: task.status,
		terminationReason: task.terminationReason,
		updatedAt: task.updatedAt,
	};
	if (!input.output.ok) {
		observation.outputError = input.output.error;
		return observation;
	}
	const bounded = boundedPreview(input.output.output, input.outputPreviewChars);
	observation.outputPreview = bounded.preview;
	observation.outputPreviewTruncated = bounded.truncated;
	return observation;
}

/** True while the extension still owes this task a completion notification. */
export function completionOwed(task: { status: BackgroundTaskStatus; notifyOnExit: boolean; exitNotified?: boolean }): boolean {
	return task.status !== "running" && task.notifyOnExit === true && task.exitNotified !== true;
}

/**
 * The instant the current review interval is measured from. A task that has
 * never been reviewed measures from its start, which is what makes the first
 * review fall due at `startedAt + softTimeoutMs`.
 */
export function reviewArmedAt(task: { startedAt: number; lastReviewedAt?: number }): number {
	return Number.isFinite(task.lastReviewedAt) ? (task.lastReviewedAt as number) : task.startedAt;
}

/**
 * The next progress-review deadline, or null when the interval is disabled.
 * Deliberately a function of the last review (never of output activity), so a
 * noisy task cannot postpone its own review, and never of `expiresAt`, which
 * stays absolute.
 */
export function reviewDeadlineFor(task: { startedAt: number; lastReviewedAt?: number; softTimeoutMs?: number }): number | null {
	const softTimeoutMs = Number.isFinite(task.softTimeoutMs) ? Math.max(0, task.softTimeoutMs ?? 0) : 0;
	if (softTimeoutMs <= 0) return null;
	return reviewArmedAt(task) + softTimeoutMs;
}

/** Whether a running task should currently have one review reminder armed. */
export function reviewReminderArmed(task: { status: BackgroundTaskStatus; stopReason?: string | null; resultResolution?: "delivered" | "error" | "dismissed"; startedAt: number; lastReviewedAt?: number; softTimeoutMs?: number }): boolean {
	if (task.stopReason != null || (task.status !== "running" && task.resultResolution !== undefined)) return false;
	return reviewDeadlineFor(task) != null;
}

export interface CompletionAckHooks<T> {
	/** Drop any completion wake this process still holds for the task. */
	cancelHeldWake: (taskId: string) => boolean;
	/** Record the acknowledgment durably (snapshot + persist). */
	persist: (task: T) => void;
}

export interface CompletionAckResult {
	/** True when this call is the one that recorded the acknowledgment. */
	acknowledged: boolean;
	/** True when this call dropped a completion wake the extension still held. */
	heldWakeCancelled: boolean;
}

/**
 * The single idempotent completion-acknowledgment entry point: terminal
 * retrieval, confirmed stop, foreground command delivery, retained bounded
 * wait, and host notification all land here. Recording the obligation is what
 * stops a restart from replaying the wake; it never deletes retained output or
 * invalidates the handle.
 *
 * A task whose completion is already recorded is left without a second
 * snapshot write; a stale held wake it still owns is dropped without one.
 * `cancelHeld: false` is for the caller that is itself *placing* a held wake:
 * acknowledgment then only records the obligation.
 *
 * A retrieval whose capture is not certified (a terminal read with
 * `outputComplete: false`, or readiness `incomplete`) is not a successful
 * handoff of the result and must not call this: the bytes it could not retain
 * are unrecoverable, so the completion obligation stays where it is.
 *
 * Acknowledgment is *notification* state and never implies settlement: it
 * does not write `resultResolution`, so a notified-but-unretrieved task stays
 * outstanding for assignment settlement (openspec tasks 2.2) until an actual
 * result handoff is observed there.
 */
export function acknowledgeCompletion<T extends { id: string; exitNotified?: boolean }>(
	task: T,
	hooks: CompletionAckHooks<T>,
	options: { cancelHeld?: boolean } = {},
): CompletionAckResult {
	const heldWakeCancelled = options.cancelHeld === false ? false : hooks.cancelHeldWake(task.id);
	const acknowledged = task.exitNotified !== true;
	if (acknowledged) {
		task.exitNotified = true;
		// Only the acknowledgment is durable; a held wake lives in this process
		// only, so re-cancelling one writes nothing.
		hooks.persist(task);
	}
	return { acknowledged, heldWakeCancelled };
}

/**
 * Whether a task's result has been *resolved* for assignment settlement
 * (openspec tasks 2.2-2.3): a terminal task whose `resultResolution` records
 * an actual delivery (`delivered`) or a delivered unrecoverable error
 * (`error`). A running task is never resolved, however its flags read, and a
 * terminal task without a recorded resolution is outstanding — waiting,
 * flushing, or awaiting result review — regardless of `exitNotified`.
 */
export function resultIsResolved<T extends { status: BackgroundTaskStatus; resultResolution?: "delivered" | "error" | "dismissed" }>(
	task: T,
): boolean {
	if (task.status === "running") return false;
	return task.resultResolution !== undefined;
}

/**
 * The single eligibility rule for recording a result resolution from a
 * delivered handoff (openspec tasks 2.2-2.3), shared by every delivery path
 * — foreground/wait-owned exit, bounded wait, certified get/stop, declared-CLI
 * receipts — so they cannot disagree about what a delivery means:
 *
 *   running / finalizing → `null`: the capture has not settled, so a
 *                           flushing inspection records nothing and the task
 *                           stays outstanding until a certified handoff.
 *   incomplete           → `"error"`: the process is gone and the capture
 *                           can never certify; handing that over delivers an
 *                           unrecoverable error, never a successful result.
 *   terminal             → `"delivered"` only when the retained capture is
 *                           certified complete and free of read errors;
 *                           otherwise `"error"` — a short or unreadable
 *                           capture handed over as the failure it is.
 */
export function resultResolutionForDelivery(
	observation: Pick<TaskResultObservation, "readiness" | "outputComplete" | "outputError">,
): "delivered" | "error" | null {
	if (observation.readiness === "running" || observation.readiness === "finalizing") return null;
	if (observation.readiness === "incomplete") return "error";
	return observation.outputComplete && !observation.outputError ? "delivered" : "error";
}

/**
 * Oldest finished tasks that exceed the retention bound, in removal order.
 * Running work and any task whose result is still being prepared are never
 * returned, so a terminal retrieval racing the bound keeps its task and log.
 */
export function selectPrunableFinishedTasks<T extends {
	id: string;
	status: BackgroundTaskStatus;
	updatedAt: number;
	assignmentRequestId?: string;
	resultResolution?: "delivered" | "error" | "dismissed";
}>(
	tasks: Iterable<T>,
	options: { maxFinished: number; protectedIds?: ReadonlySet<string> },
): T[] {
	const protectedIds = options.protectedIds ?? new Set<string>();
	const finished = [...tasks].filter(
		(task) =>
			task.status !== "running" &&
			!protectedIds.has(task.id) &&
			// Assignment-owned evidence is never prunable: a terminal task whose
			// result was never delivered is an assignment's outstanding work
			// (openspec tasks 2.1-2.2), and eviction would let a provider query
			// read its disappearance as completion. Resolved history and
			// unassociated tasks remain prunable as before, so the finished-task
			// bound still caps an ordinary session's history.
			!(task.assignmentRequestId !== undefined && !resultIsResolved(task)),
	);
	const excess = finished.length - Math.max(0, Math.floor(options.maxFinished));
	if (excess <= 0) return [];
	return finished.sort((a, b) => a.updatedAt - b.updatedAt).slice(0, excess);
}
