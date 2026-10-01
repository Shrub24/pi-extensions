import type { ChildProcess } from "node:child_process";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped" | "timed_out";

export type ResourceControlMode = "auto" | "systemd-run" | "nice-ionice" | "off";
export type ResourceControlAppliedMode = "systemd-run" | "nice-ionice";

export interface ResourceControlMetadata {
	mode: ResourceControlAppliedMode;
	requestedMode: ResourceControlMode;
	unitName?: string;
	warning?: string;
}

/**
 * Why a tracked task left the running state. Surfaced on `bg_status list`,
 * the wake-event payload, and persisted snapshots so callers can distinguish
 * a clean self-exit from an external kill.
 *
 * - `self-exit`: child closed on its own with no stop request. Reserved for
 *   `completed` (exitCode 0) and `failed` (non-zero exitCode). `external` is
 *   the same close path with `exitCode === null`, which means the child was
 *   killed by a signal we did not issue.
 * - `extension-stop`: this extension issued the kill via `bg_status stop`.
 * - `session-shutdown`: this extension issued the kill on `session_shutdown`.
 * - `timeout`: the task's `timeoutSeconds` budget elapsed.
 * - `reconcile-on-restart`: a Pi restart probed the recorded pid and found
 *   it gone; the task was coerced running -> stopped in
 *   `restoredTaskFromSnapshot`. The actual cause of death is unknown to us
 *   (Pi may have crashed mid-bg_task, the OS may have OOM-killed the child,
 *   or an unrelated session-leader cascade may have hit it).
 * - `orphaned-pid-gone` / `orphaned-pid-reused`: the orphan-watcher polled
 *   a restored alive task and found the pid gone or recycled.
 */
export type BackgroundTaskTerminationReason =
	| "self-exit"
	| "extension-stop"
	| "cancelled-by-user"
	| "session-shutdown"
	| "timeout"
	| "external"
	| "reconcile-on-restart"
	| "orphaned-pid-gone"
	| "orphaned-pid-reused";
export type TaskEventType = "output" | "exit" | "soft-timeout";
export type WakeEventType = Exclude<TaskEventType, "soft-timeout">;
export type NotifyMode = "always" | "transition" | "first-match-only";

export type WakeDropReason =
	| "empty-output"
	| "first-match-only-suppressed"
	| "cleared-on-task-exit"
	| "notify-exit-disabled"
	| "notify-output-disabled"
	| "notify-pattern-no-match"
	| "output-after-stop-suppressed"
	| "output-transition-dedupe"
	| "output-wake-rescheduled"
	| "shutting-down"
	| "voided"
	| "wake-budget-exhausted";

// Cumulative per-task accounting for the output-wake budget guard.
// Persisted so a session restart preserves the cap and a chatty task cannot
// reset its inline-wake budget by triggering a Pi reload.
export interface OutputWakeBudgetState {
	wakes: number;
	bytes: number;
	exhausted: boolean;
	announcedAt: number | null;
}

export interface WakeEventRecord {
	deliveredAt: number | null;
	droppedReason?: WakeDropReason;
	eventAt: number;
	eventType: WakeEventType;
	sequence: number;
	taskStatusAtEmit: BackgroundTaskStatus;
}

export interface WakePendingRecord {
	eventAt: number;
	eventType: WakeEventType;
	sequence: number;
}

export interface WakeDiagnostic {
	action?: "stop" | "clear" | "shutdown";
	dedupeKey?: string;
	deliveredAt?: number | null;
	eventAt?: number;
	eventType?: WakeEventType;
	matchedPattern?: string;
	reason:
		| WakeDropReason
		| "voided-wake-fired"
		| "wake-voided";
	sequence?: number;
	stopReason?: "user" | "timeout" | "shutdown";
	taskId: string;
	taskStatus: BackgroundTaskStatus;
	timestamp: number;
}

// Identity tuple that detects PID reuse on restore or poll. The kernel
// may recycle a PID for an unrelated process; a bare `kill -0` check
// would then return alive and the bg_task would be considered still
// running against a foreign process. startToken is the process start
// time (jiffies-since-boot on Linux via /proc/<pid>/stat field 22, or
// the absolute `ps -o lstart=` string everywhere else), which is
// unique per PID lifetime. comm is the kernel comm name, a defensive
// secondary signal. Mismatch on either field treats the original task
// as gone.
export interface ProcessIdentity {
	pid: number;
	startToken: string;
	comm: string;
}

export interface kendexModalLock {
	depth: number;
}

export type kendexConfig = Record<string, unknown>;

export interface BackgroundTaskSnapshot {
	id: string;
	title: string;
	command: string;
	cwd: string;
	pid: number;
	logFile: string;
	startedAt: number;
	updatedAt: number;
	lastOutputAt: number | null;
	expiresAt: number | null;
	status: BackgroundTaskStatus;
	exitCode: number | null;
	notifyOnExit: boolean;
	notifyOnOutput: boolean;
	notifyPattern?: string;
	notifyMode?: NotifyMode;
	dedupeKey?: string;
	outputBytes: number;
	wakeSequence?: number;
	wakeEvents?: WakeEventRecord[];
	voidedWakeSequences?: number[];
	pendingWakes?: WakePendingRecord[];
	lastOutputDedupeHash?: string;
	lastOutputDedupeByKey?: Record<string, string>;
	outputPatternMatched?: boolean;
	/**
	 * Per-task budget accounting for output wakes. Persists so a
	 * session restart preserves the cap. Absent on snapshots persisted by
	 * versions <1.4.0 (this is the version that introduces the field) —
	 * treated as a fresh budget on restore.
	 */
	outputWakeBudget?: OutputWakeBudgetState;
	/** Soft progress deadline and one-shot delivery state, in milliseconds. */
	softTimeoutMs?: number;
	softExpiresAt?: number | null;
	softTimeoutNotified?: boolean;
	/**
	 * When the last successful review of this running task happened, and the
	 * output length it observed. The next progress-review deadline is measured
	 * from `lastReviewedAt` (falling back to `startedAt`); output activity never
	 * moves it. Absent on snapshots written before this field existed, which
	 * restores to the previous `startedAt + softTimeoutMs` deadline.
	 */
	lastReviewedAt?: number;
	reviewedOutputBytes?: number;
	/**
	 * Bumps on every successful review and on every delivered progress
	 * reminder, so an armed reminder that was overtaken by a review (or by a
	 * terminal transition) is recognisably stale at dispatch time.
	 */
	reviewRevision?: number;
	/**
	 * Output readiness latch: true once the process has ended *and* its log
	 * flush settled. `status !== "running"` alone is not a terminal-ready
	 * signal, because finalizeTask closes the process before awaiting the
	 * flush. Absent means not yet established (see taskReadiness). Written by
	 * every snapshot this version takes, so its presence marks a snapshot as
	 * modern: a rehydrated task whose record says `false` restores as an
	 * unrecoverable incomplete capture (readiness `incomplete`), because the
	 * process that owned the writer is gone and nothing can settle it.
	 */
	resultReady?: boolean;
	/**
	 * Durable capture-integrity record: true only when the process had ended,
	 * its log flush had settled, and the writer kept every byte of this file.
	 * Persisted so a restore cannot upgrade a short capture into a complete
	 * one: a rehydrated task has no process left to flush and a fresh, empty
	 * writer queue, so re-deriving completeness after a restart answers
	 * "complete" for bytes that never reached disk. Written only for terminal
	 * tasks — a running snapshot records neither a certified capture nor
	 * completeness, so its restore is resolved by `resultReady` alone. Absent
	 * on snapshots written before this field existed, which
	 * `restoredTaskFromSnapshot` reads as "not recorded" and resolves by
	 * reconciliation.
	 */
	outputComplete?: boolean;
	/** Set when a newer identical task superseded this one; suppresses its exit wake. */
	supersededBy?: string;
	// True after sendTaskEvent('exit') has fired for this task. Persisted so
	// a session restart can replay missed exit wakeups for tasks that hit
	// terminal state (notably the running->stopped coercion in
	// restoredTaskFromSnapshot) without ever notifying the agent.
	// A same-session snapshot replays unless this flag is persisted true: the
	// running->stopped coercion at restore forces false, and an absent or
	// false flag stays false.
	exitNotified?: boolean;
	// Pi session id captured when the snapshot was persisted. Restore uses it
	// to gate replay ("this snapshot belongs to a different session"
	// short-circuits cross-session leaks) and to make audit logs explicit.
	sessionId?: string;
	// Process identity captured at spawn for PID-reuse-safe liveness
	// checks on restore + orphan polls. Absent when the spawn-time probe
	// failed; the identity check degrades to PID-only for those.
	procIdent?: ProcessIdentity;
	/**
	 * Optional metadata for opt-in resource controls. Systemd-run
	 * tasks persist their transient unit name so stop/timeout/shutdown paths can
	 * stop the actual workload instead of only signaling the systemd-run wrapper.
	 */
	resourceControl?: ResourceControlMetadata;
	/**
	 * Why this task left the running state. Undefined means no cause was
	 * recorded. Set on every
	 * terminal transition through closeTaskLifecycle, the
	 * restoredTaskFromSnapshot coercion path, and the orphan watcher.
	 */
	terminationReason?: BackgroundTaskTerminationReason;
}

export interface ForegroundOutcome {
	exitCode: number | null;
	kind: "aborted" | "exited" | "yielded";
	status: BackgroundTaskStatus;
}

/**
 * Non-persisted single-owner latch between the bounded foreground wait and
 * the child's terminal finalize. Exactly one side settles it: the yield
 * timer (kind "yielded") or finalizeTask (kind "exited"). The winner owns
 * the exit notification; the loser must not deliver a duplicate.
 */
export interface ForegroundWaiter {
	outcome: ForegroundOutcome | null;
	resolve: ((outcome: ForegroundOutcome) => void) | null;
	settled: boolean;
	yieldTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Outcome of a bounded `bg_task action:"wait"` attachment. `settled` means
 * the task reached a terminal state while the wait owned the exit; the
 * other kinds detach the wait without touching the task.
 */
export type TaskWaitOutcome =
	| { kind: "aborted" }
	| { kind: "expired" }
	| { kind: "pending-message" }
	| { kind: "settled" };

/**
 * Non-persisted single-owner latch between a bounded `bg_task wait` and the
 * task's terminal finalize. `attached` is true only while the wait owns the
 * exit notification: while attached, finalize suppresses the async exit wake
 * and settles the waiter with `settled`; expiry, a queued message, or abort
 * detach the waiter and leave the normal completion wake enabled. Distinct
 * from ForegroundWaiter, whose abort stops the managed-Bash process.
 */
export interface TaskWaitWaiter {
	attached: boolean;
	settled: boolean;
	outcome: TaskWaitOutcome | null;
	resolve: ((outcome: TaskWaitOutcome) => void) | null;
	expiryTimer: ReturnType<typeof setTimeout> | null;
	pollTimer: ReturnType<typeof setInterval> | null;
}

export type ManagedTask = BackgroundTaskSnapshot & {
	child: ChildProcess | null;
	foregroundWaiter?: ForegroundWaiter | null;
	taskWaiter?: TaskWaitWaiter | null;
	closed: boolean;
	forceKillTimer: ReturnType<typeof setTimeout> | null;
	lastAnnouncedLength: number;
	matcher: ((text: string) => boolean) | null;
	output: string;
	outputTimer: ReturnType<typeof setTimeout> | null;
	voidedWakes: Set<number>;
	stopReason: "user" | "timeout" | "shutdown" | null;
	timeoutTimer: ReturnType<typeof setTimeout> | null;
	softTimeoutTimer?: ReturnType<typeof setTimeout> | null;
	restored?: boolean;
};

/**
 * Wake-event payload attached to the pi.sendMessage `details` field. Output
 * wakes carry the most recent unseen tail; exit wakes carry the trailing
 * portion of full output. Both inline tails are bounded by
 * `outputAlertMaxChars` (default 2KB) and `details.task.logFile` always
 * points to the full on-disk log for recovery. Total `details` payload is
 * targeted to stay under 4KB to keep transcript growth bounded.
 */
export interface BackgroundTaskEventDetails {
	deliveredAt: number;
	eventAt: number;
	eventType: TaskEventType;
	matchedPattern?: string;
	outputTail: string;
	/** Soft-timeout events include elapsed time and the configured deadline. */
	softTimeout?: { elapsedMs: number; softTimeoutMs: number };
	/**
	 * True iff `outputTail` had to be truncated to fit the cap. The caller can
	 * surface the full log via `task.logFile`.
	 */
	outputTailTruncated: boolean;
	sequence: number;
	task: BackgroundTaskSnapshot;
	taskStatusAtEmit: BackgroundTaskStatus;
}

export interface BackgroundLogTruncation {
	direction: "tail";
	/**
	 * Where a complete snapshot can be read, and only when that is an immutable
	 * artifact the caller can hand over. A mutable live log is never advertised
	 * here: it is not a complete result, and naming it invites a read of a file
	 * the producer may still be appending to. Absent means the complete result is
	 * available through the declared retrieval
	 * (`bg_task action:"get" output:"full"`).
	 */
	fullOutputPath?: string;
	shownChars: number;
	totalChars: number;
	truncated: true;
}

export interface SpawnTaskOptions {
	command: string;
	cwd?: string;
	/** Expanded per-command environment. Never persisted. */
	env?: NodeJS.ProcessEnv;
	/** When set, enables the bounded foreground waiter (soft wait, never a kill). */
	foregroundYieldMs?: number;
	notifyOnExit?: boolean;
	notifyOnOutput?: boolean;
	notifyPattern?: string;
	notifyMode?: NotifyMode;
	dedupeKey?: string;
	timeoutSeconds?: number;
	/** Soft progress reminder in milliseconds; 0 disables it. */
	softTimeoutMs?: number;
	title?: string;
	origin?: "bg_task" | "auto-background" | "managed-bash";
}

export interface BashBackgroundDecision {
	forced: boolean;
	notifyOnExit: boolean;
	notifyOnOutput: boolean;
	notifyPattern?: string;
	reason: string;
	title: string;
}
