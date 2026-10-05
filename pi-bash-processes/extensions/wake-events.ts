import { createHash } from "node:crypto";

import type {
	BackgroundTaskEventDetails,
	BackgroundTaskSnapshot,
	ManagedTask,
	NotifyMode,
	OutputWakeBudgetState,
	TaskEventType,
	WakeDiagnostic,
	WakeEventType,
	WakeDropReason,
	WakeEventRecord,
	WakePendingRecord,
} from "./types.js";
import { taskSurfaceGuidance, type TaskToolSurface } from "./tool-surface.js";

export const NOTIFY_MODES = ["always", "transition", "first-match-only"] as const;
const MAX_WAKE_EVENTS = 50;

export function emptyOutputWakeBudget(): OutputWakeBudgetState {
	return { wakes: 0, bytes: 0, exhausted: false, announcedAt: null };
}

/**
 * Pure normalization for an `OutputWakeBudgetState` shape pulled from
 * persistence, a snapshot field, or live state. Returns a fresh object so
 * snapshot serialization and the live-task helpers cannot share mutable
 * structure or drift apart on field additions.
 */
export function normalizeOutputWakeBudget(value: unknown): OutputWakeBudgetState {
	const source = value && typeof value === "object" ? value as Partial<OutputWakeBudgetState> : undefined;
	return {
		announcedAt: typeof source?.announcedAt === "number" ? source.announcedAt : null,
		bytes: Number.isFinite(source?.bytes) ? Math.max(0, Math.floor((source?.bytes as number) ?? 0)) : 0,
		exhausted: source?.exhausted === true,
		wakes: Number.isFinite(source?.wakes) ? Math.max(0, Math.floor((source?.wakes as number) ?? 0)) : 0,
	};
}

export function ensureOutputWakeBudget(task: Pick<ManagedTask, "outputWakeBudget">): OutputWakeBudgetState {
	task.outputWakeBudget = normalizeOutputWakeBudget(task.outputWakeBudget);
	return task.outputWakeBudget;
}

export interface OutputWakeBudgetLimits {
	maxWakes: number;
	maxBytes: number;
}

/**
 * Returns true iff delivering one more output wake of `nextWakeBytes` would
 * exceed either arm of the budget. Caller treats `true` as "suppress this
 * wake and mark exhausted". A limit of 0 disables that arm.
 */
export function wouldExhaustOutputWakeBudget(
	budget: OutputWakeBudgetState,
	limits: OutputWakeBudgetLimits,
	nextWakeBytes: number,
): boolean {
	if (budget.exhausted) return true;
	const wakeCap = Math.max(0, Math.floor(limits.maxWakes));
	const byteCap = Math.max(0, Math.floor(limits.maxBytes));
	if (wakeCap > 0 && budget.wakes + 1 > wakeCap) return true;
	if (byteCap > 0 && budget.bytes + Math.max(0, nextWakeBytes) > byteCap) return true;
	return false;
}

export function normalizeNotifyMode(value: unknown): NotifyMode {
	if (value === "transition" || value === "first-match-only" || value === "always") return value;
	return "always";
}

/**
 * Pick a default `notifyMode` for tasks where the caller didn't set one
 * When a pattern is supplied, default to "first-match-only" so
 * a single pattern hit wakes the agent and subsequent matches stay quiet.
 * Otherwise default to "transition" so chatty pollers that print the same
 * state line repeatedly only wake the agent on state changes. Callers that
 * really want every-output wakes should pass `"always"` explicitly.
 */
export function defaultNotifyMode(notifyPattern: string | undefined): NotifyMode {
	return notifyPattern?.trim() ? "first-match-only" : "transition";
}

export function resolveNotifyMode(value: unknown, notifyPattern: string | undefined): NotifyMode {
	if (value === "always" || value === "transition" || value === "first-match-only") return value;
	return defaultNotifyMode(notifyPattern);
}

export function ensureWakeState(task: ManagedTask): void {
	task.notifyMode = normalizeNotifyMode(task.notifyMode);
	task.wakeSequence = Number.isFinite(task.wakeSequence) ? Math.max(0, Math.floor(task.wakeSequence ?? 0)) : 0;
	task.wakeEvents = Array.isArray(task.wakeEvents) ? task.wakeEvents : [];
	task.pendingWakes = Array.isArray(task.pendingWakes) ? task.pendingWakes : [];
	task.voidedWakeSequences = Array.isArray(task.voidedWakeSequences) ? [...new Set(task.voidedWakeSequences)] : [];
	task.lastOutputDedupeByKey = task.lastOutputDedupeByKey && typeof task.lastOutputDedupeByKey === "object" ? task.lastOutputDedupeByKey : {};
	if (!(task.voidedWakes instanceof Set)) task.voidedWakes = new Set<number>();
	for (const sequence of task.voidedWakeSequences) task.voidedWakes.add(sequence);
	task.voidedWakeSequences = [...task.voidedWakes].sort((a, b) => a - b);
	task.outputPatternMatched = task.outputPatternMatched === true;
	ensureOutputWakeBudget(task);
}

export function canEmitOutputWake(task: Pick<ManagedTask, "status" | "stopReason">): boolean {
	return task.status === "running" && task.stopReason == null;
}

export function nextWakeSequence(task: ManagedTask): number {
	ensureWakeState(task);
	task.wakeSequence = (task.wakeSequence ?? 0) + 1;
	return task.wakeSequence;
}

export function scheduleTaskWake(
	task: ManagedTask,
	eventType: WakeEventType,
	eventAt: number,
): WakePendingRecord {
	ensureWakeState(task);
	const pending: WakePendingRecord = { eventAt, eventType, sequence: nextWakeSequence(task) };
	task.pendingWakes = [...(task.pendingWakes ?? []), pending];
	return pending;
}

export function forgetPendingWake(task: ManagedTask, sequence: number): void {
	ensureWakeState(task);
	task.pendingWakes = (task.pendingWakes ?? []).filter((wake) => wake.sequence !== sequence);
}

export function isWakeVoided(task: ManagedTask, sequence: number): boolean {
	ensureWakeState(task);
	return task.voidedWakes.has(sequence) || (task.voidedWakeSequences ?? []).includes(sequence);
}

export function voidPendingTaskWakes(
	task: ManagedTask,
	action: "stop" | "clear" | "shutdown",
	logDiagnostic?: (diagnostic: WakeDiagnostic) => void,
	now: () => number = Date.now,
): number {
	ensureWakeState(task);
	const pending = task.pendingWakes ?? [];
	if (pending.length === 0) return 0;
	for (const wake of pending) {
		task.voidedWakes.add(wake.sequence);
		logDiagnostic?.({
			action,
			eventAt: wake.eventAt,
			eventType: wake.eventType,
			reason: "wake-voided",
			sequence: wake.sequence,
			taskId: task.id,
			taskStatus: task.status,
			timestamp: now(),
		});
	}
	task.voidedWakeSequences = [...task.voidedWakes].sort((a, b) => a - b);
	task.pendingWakes = [];
	return pending.length;
}

export function recordWakeEvent(task: ManagedTask, record: WakeEventRecord): void {
	ensureWakeState(task);
	task.wakeEvents = [...(task.wakeEvents ?? []), record].slice(-MAX_WAKE_EVENTS);
	if (record.droppedReason === "voided") {
		task.voidedWakes.add(record.sequence);
		task.voidedWakeSequences = [...task.voidedWakes].sort((a, b) => a - b);
	}
}

export interface RecordScheduledOutputDropInput {
	extra?: Partial<WakeDiagnostic>;
	logDiagnostic: (diagnostic: WakeDiagnostic) => void;
	now?: () => number;
	pending: WakePendingRecord;
	reason: WakeDropReason;
	task: ManagedTask;
}

export function recordScheduledOutputDrop(input: RecordScheduledOutputDropInput): void {
	const now = input.now ?? Date.now;
	const timestamp = now();
	forgetPendingWake(input.task, input.pending.sequence);
	recordWakeEvent(input.task, {
		deliveredAt: null,
		droppedReason: input.reason,
		eventAt: input.pending.eventAt,
		eventType: "output",
		sequence: input.pending.sequence,
		taskStatusAtEmit: input.task.status,
	});
	input.logDiagnostic({
		eventAt: input.pending.eventAt,
		eventType: "output",
		reason: input.reason,
		sequence: input.pending.sequence,
		taskId: input.task.id,
		taskStatus: input.task.status,
		timestamp,
		...input.extra,
	});
}

function recordWakeDrop(
	task: ManagedTask,
	pending: WakePendingRecord,
	reason: WakeDropReason,
	logDiagnostic: (diagnostic: WakeDiagnostic) => void,
	now: () => number,
	extra: Partial<WakeDiagnostic> = {},
): void {
	const timestamp = now();
	forgetPendingWake(task, pending.sequence);
	recordWakeEvent(task, {
		deliveredAt: null,
		droppedReason: reason,
		eventAt: pending.eventAt,
		eventType: pending.eventType,
		sequence: pending.sequence,
		taskStatusAtEmit: task.status,
	});
	logDiagnostic({
		eventAt: pending.eventAt,
		eventType: pending.eventType,
		reason: reason === "voided" ? "voided-wake-fired" : reason,
		sequence: pending.sequence,
		taskId: task.id,
		taskStatus: task.status,
		timestamp,
		...extra,
	});
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export interface OutputWakeDecisionInput {
	/**
	 * Optional caps for the per-task output-wake budget. Omit on the historical
	 * code paths (tests, internal helpers) — budget is enforced only when
	 * `wakeBudgetLimits` is set, so old callers preserve their existing
	 * behavior. Either arm may be 0 to disable that arm.
	 */
	wakeBudgetLimits?: OutputWakeBudgetLimits;
	dedupeHashes?: Map<string, string>;
	eventAt: number;
	logDiagnostic?: (diagnostic: WakeDiagnostic) => void;
	newOutput: string;
	newOutputTail: string;
	now?: () => number;
	patternMatched: boolean;
	sequence?: number;
}

export function outputDedupeKey(task: ManagedTask): string {
	ensureWakeState(task);
	return task.dedupeKey?.trim() || task.id;
}

export function shouldEmitOutputWake(task: ManagedTask, input: OutputWakeDecisionInput): boolean {
	ensureWakeState(task);
	const log = input.logDiagnostic;
	const now = input.now ?? Date.now;
	const baseDiagnostic = {
		eventAt: input.eventAt,
		eventType: "output" as const,
		sequence: input.sequence,
		taskId: task.id,
		taskStatus: task.status,
		timestamp: now(),
	};
	if (!task.notifyOnOutput) {
		log?.({ ...baseDiagnostic, reason: "notify-output-disabled" });
		return false;
	}
	if (!canEmitOutputWake(task)) {
		log?.({ ...baseDiagnostic, reason: "output-after-stop-suppressed", stopReason: task.stopReason ?? undefined });
		return false;
	}
	if (!input.newOutput.trim()) {
		log?.({ ...baseDiagnostic, reason: "empty-output" });
		return false;
	}
	if (!input.patternMatched) {
		log?.({ ...baseDiagnostic, matchedPattern: task.notifyPattern, reason: "notify-pattern-no-match" });
		return false;
	}

	const notifyMode = normalizeNotifyMode(task.notifyMode);
	if (notifyMode === "first-match-only" && task.notifyPattern && task.outputPatternMatched) {
		log?.({ ...baseDiagnostic, matchedPattern: task.notifyPattern, reason: "first-match-only-suppressed" });
		return false;
	}

	if (notifyMode === "transition") {
		const dedupeKey = outputDedupeKey(task);
		const hash = sha256(input.newOutputTail);
		const previous = input.dedupeHashes?.get(dedupeKey) ?? task.lastOutputDedupeByKey?.[dedupeKey];
		task.lastOutputDedupeHash = hash;
		task.lastOutputDedupeByKey = { ...(task.lastOutputDedupeByKey ?? {}), [dedupeKey]: hash };
		input.dedupeHashes?.set(dedupeKey, hash);
		if (previous === hash) {
			log?.({ ...baseDiagnostic, dedupeKey, reason: "output-transition-dedupe" });
			return false;
		}
	}

	if (input.wakeBudgetLimits) {
		const budget = ensureOutputWakeBudget(task);
		const nextBytes = byteLength(input.newOutputTail);
		if (wouldExhaustOutputWakeBudget(budget, input.wakeBudgetLimits, nextBytes)) {
			log?.({ ...baseDiagnostic, reason: "wake-budget-exhausted" });
			return false;
		}
	}

	return true;
}

export function noteOutputWakeSent(task: ManagedTask): void {
	ensureWakeState(task);
	if (normalizeNotifyMode(task.notifyMode) === "first-match-only" && task.notifyPattern) {
		task.outputPatternMatched = true;
	}
}

/**
 * The delivery a wake uses, so one place decides how an idle run starts.
 *
 * A run started by `triggerTurn` skips `before_agent_start` (pi#5581, #10267):
 * the run is never prepared with the system-prompt options every extension
 * contributed, so its second request rebuilds the prompt from base options,
 * drops those sections mid-run and re-bills the whole prompt. An idle session is
 * therefore woken by a short user prompt, which runs the normal prompt
 * lifecycle; a busy session keeps its steer, and that run already carries
 * prepared options.
 */
export interface WakeSend {
	sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => void;
	/** Whether the session is idle right now. Absent means unknown. */
	isIdle?: () => boolean;
	/** Starts an idle run through the prompt lifecycle. Absent keeps `triggerTurn`. */
	sendUserMessage?: (content: string) => void;
}

/**
 * The short prompt that starts an idle session's run. It carries no content —
 * the wake is the custom message above it — it only routes the wake through
 * `prompt()` so the run is prepared like a user turn.
 */
const IDLE_WAKE_PROMPT = "New background task notification above.";

/** Send one wake, through the prompt lifecycle when the session is idle. */
export function deliverWakeMessage(
	deps: WakeSend,
	message: Record<string, unknown>,
	busyOptions: Record<string, unknown>,
): void {
	if (deps.isIdle?.() === true && typeof deps.sendUserMessage === "function") {
		// Append without a trigger; the user prompt below starts the run.
		deps.sendMessage(message, {});
		deps.sendUserMessage(IDLE_WAKE_PROMPT);
		return;
	}
	deps.sendMessage(message, busyOptions);
}

export interface SendTaskWakeDeps {
	isShuttingDown: () => boolean;
	logDiagnostic: (diagnostic: WakeDiagnostic) => void;
	messageType: string;
	/**
	 * The session's declared surface, so the wake names only callable
	 * operations. Omitted means the conservative compatibility surface, which is
	 * what a caller with no session mode has.
	 */
	surface?: () => TaskToolSurface;
	now?: () => number;
	/**
	 * Bounded full-output tail used as the fallback `outputTail` payload.
	 * Callers must clamp this to `outputAlertMaxChars` before returning it.
	 */
	outputTail: (task: ManagedTask) => string;
	rememberSnapshot: (task: ManagedTask) => BackgroundTaskSnapshot;
	sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => void;
	/** Whether the session is idle right now. Absent means unknown. */
	isIdle?: () => boolean;
	/** Starts an idle run through the prompt lifecycle. Absent keeps `triggerTurn`. */
	sendUserMessage?: (content: string) => void;
	/** Optional one-line inventory of other still-running tasks, appended to the wake text. */
	runningInventory?: () => string;
	/**
	 * Whether an exit wake for this task is mandatory despite
	 * `notifyOnExit: false` — the protected-assignment bypass (openspec
	 * `herdsman-background-handoffs` tasks 2.4): a settlement-waiting
	 * assignment's tasks must wake the model exactly once at terminal-ready so
	 * the terminal result can be retrieved and resolved, and a suppressed wake
	 * would leave that assignment waiting forever. Only the `exit` gate below
	 * consults it; output and soft-timeout events are unaffected.
	 */
	exitMandatory?: (task: ManagedTask) => boolean;
}

export interface SendTaskWakeOptions {
	eventAt?: number;
	matchedPattern?: string;
	/**
	 * Newly observed (already-bounded) output tail. For output wakes this is
	 * preferred over the full-output tail: it carries just the unseen excerpt
	 * the agent needs to react. The interface intentionally exposes one inline
	 * tail in `details`, so providing this displaces the
	 * full-output tail in the emitted payload.
	 */
	newOutputTail?: string;
	sequence?: number;
	softTimeout?: { elapsedMs: number; softTimeoutMs: number };
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function pickOutputTail(deps: SendTaskWakeDeps, task: ManagedTask, options: SendTaskWakeOptions): {
	tail: string;
	truncated: boolean;
} {
	if (typeof options.newOutputTail === "string" && options.newOutputTail.length > 0) {
		return { tail: options.newOutputTail, truncated: options.newOutputTail.startsWith("[...truncated]") };
	}
	const tail = deps.outputTail(task);
	return { tail, truncated: tail.startsWith("[...truncated]") };
}

// Maximum per-field characters retained in a wake / log-action tool-result
// manifest. An agent could spawn
// a task with a 100KB heredoc command and grow the transcript through every
// subsequent wake or log inspection because each one carried the full
// snapshot. Bounding text fields means a malicious / verbose command is
// truncated in custom messages and tool-result entries; the live in-memory
// snapshot still holds the full text for the active dashboard / renderer.
// Sized so that with the default ~2KB inline output tail plus a content
// headline the worst-case wake payload (every long field at max) still fits
// comfortably under the 4 KB target.
export const WAKE_MANIFEST_FIELD_MAX_CHARS = 192;
// Headline command preview included in wake `content` (the textual surface
// the agent reads directly). Smaller than the manifest cap so the leading
// summary line stays terse.
export const WAKE_CONTENT_COMMAND_MAX_CHARS = 160;

/**
 * Shared transcript-bounded text helper. Returns `value` when it
 * is `undefined` or already within `maxChars`, otherwise the head sliced and
 * suffixed with an ellipsis. Used by the compact wake manifest and by every
 * transcript-facing content string (spawn/log/stop tool results, auto-
 * background ack text, task summary lines) so a pathological
 * agent-controlled field cannot leak past pi-output-policy.
 */
export function truncateForTranscript(value: string | undefined, maxChars: number): string | undefined {
	if (value === undefined) return undefined;
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function truncateField(value: string | undefined, maxChars: number): string | undefined {
	return truncateForTranscript(value, maxChars);
}

function compactResourceControl(snapshot: BackgroundTaskSnapshot): BackgroundTaskSnapshot["resourceControl"] {
	if (!snapshot.resourceControl) return undefined;
	return {
		mode: snapshot.resourceControl.mode,
		requestedMode: snapshot.resourceControl.requestedMode,
		unitName: truncateField(snapshot.resourceControl.unitName, WAKE_MANIFEST_FIELD_MAX_CHARS),
		warning: truncateField(snapshot.resourceControl.warning, WAKE_MANIFEST_FIELD_MAX_CHARS),
	};
}

/**
 * Compact transcript-safe view of a `BackgroundTaskSnapshot` for inclusion in
 * wake messages and log/spawn/stop tool-result details. Keeps the lifecycle-
 * critical fields (id, pid, status, exitCode, logFile, outputBytes,
 * startedAt, updatedAt, notifyOn*, notifyMode, dedupeKey, expiresAt) but
 * truncates text fields and drops internal-only state arrays (wakeEvents,
 * pendingWakes, voidedWakeSequences, lastOutputDedupeByKey, etc.) that bloat
 * the transcript without helping the agent.
 *
 * Restore paths only need `id` + `command` to keep the task addressable; the
 * truncated command is acceptable as a sidecar-less fallback because sidecar
 * state is the canonical source and is loaded first by `restoreSnapshots`.
 */
export function compactBackgroundTaskSnapshot(snapshot: BackgroundTaskSnapshot): BackgroundTaskSnapshot {
	return {
		command: truncateField(snapshot.command, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "",
		cwd: truncateField(snapshot.cwd, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "",
		dedupeKey: truncateField(snapshot.dedupeKey, WAKE_MANIFEST_FIELD_MAX_CHARS),
		exitCode: snapshot.exitCode,
		exitNotified: snapshot.exitNotified,
		expiresAt: snapshot.expiresAt,
		id: snapshot.id,
		lastOutputAt: snapshot.lastOutputAt,
		logFile: truncateField(snapshot.logFile, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "",
		notifyMode: snapshot.notifyMode,
		notifyOnExit: snapshot.notifyOnExit,
		notifyOnOutput: snapshot.notifyOnOutput,
		notifyPattern: truncateField(snapshot.notifyPattern, WAKE_MANIFEST_FIELD_MAX_CHARS),
		outputBytes: snapshot.outputBytes,
		softExpiresAt: snapshot.softExpiresAt,
		softTimeoutNotified: snapshot.softTimeoutNotified,
		softTimeoutMs: snapshot.softTimeoutMs,
		pid: snapshot.pid,
		resourceControl: compactResourceControl(snapshot),
		sessionId: snapshot.sessionId,
		startedAt: snapshot.startedAt,
		status: snapshot.status,
		terminationReason: snapshot.terminationReason,
		title: truncateField(snapshot.title, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "",
		updatedAt: snapshot.updatedAt,
	};
}

export function sendTaskWake(
	deps: SendTaskWakeDeps,
	eventType: TaskEventType,
	task: ManagedTask,
	options: SendTaskWakeOptions = {},
): boolean {
	ensureWakeState(task);
	const now = deps.now ?? Date.now;
	const guidance = taskSurfaceGuidance(deps.surface?.() ?? "compat");
	if (eventType === "soft-timeout") {
		if (deps.isShuttingDown() || task.status !== "running" || task.stopReason != null) return false;
		const deliveredAt = now();
		const { tail, truncated } = pickOutputTail(deps, task, options);
		const compactTask = compactBackgroundTaskSnapshot(deps.rememberSnapshot(task));
		const softTimeout = options.softTimeout ?? {
			elapsedMs: Math.max(0, deliveredAt - task.startedAt),
			softTimeoutMs: task.softTimeoutMs ?? 0,
		};
		const details: BackgroundTaskEventDetails = {
			deliveredAt,
			eventAt: options.eventAt ?? task.softExpiresAt ?? task.updatedAt ?? deliveredAt,
			eventType,
			outputTail: tail,
			outputTailTruncated: truncated,
			sequence: task.wakeSequence ?? 0,
			softTimeout,
			task: compactTask,
			taskStatusAtEmit: task.status,
		};
		const commandPreview = truncateField(task.command, WAKE_CONTENT_COMMAND_MAX_CHARS) ?? "";
		// The soft timeout is the primary decision mechanism; a configured hard
		// timeout is only a backstop. When a hard deadline exists, surface the
		// remaining hard time so the agent treats this wake as the decision point
		// long before any hard kill.
		const hardRemaining = task.expiresAt != null ? Math.max(0, task.expiresAt - deliveredAt) : null;
		const content = [
			`Background task ${task.id} is still running after ${formatElapsed(softTimeout.elapsedMs)} (soft reminder at ${formatElapsed(softTimeout.softTimeoutMs)}).`,
			`Command: ${commandPreview}`,
			`Output so far:\n${tail || "(no output yet)"}`,
			`Inspect it with ${guidance.inspect} id: ${task.id} — Running is not success, so do not read a partial result as one.`,
			...(hardRemaining != null ? [`Hard timeout backstop: about ${formatElapsed(hardRemaining)} remaining; it will kill the task if you let it lapse.`] : []),
			guidance.softReminderChoices,
		].join("\n");
		deliverWakeMessage(deps, {
			content,
			customType: deps.messageType,
			details,
			display: true,
		}, { deliverAs: "steer", triggerTurn: true });
		return true;
	}
	const pending: WakePendingRecord = {
		eventAt: options.eventAt ?? (eventType === "output" ? (task.lastOutputAt ?? now()) : (task.updatedAt ?? now())),
		eventType,
		sequence: options.sequence ?? nextWakeSequence(task),
	};
	if (isWakeVoided(task, pending.sequence)) {
		recordWakeDrop(task, pending, "voided", deps.logDiagnostic, now);
		return false;
	}
	if (deps.isShuttingDown()) {
		recordWakeDrop(task, pending, "shutting-down", deps.logDiagnostic, now);
		return false;
	}
	if (eventType === "output" && !task.notifyOnOutput) {
		recordWakeDrop(task, pending, "notify-output-disabled", deps.logDiagnostic, now);
		return false;
	}
	if (eventType === "output" && !canEmitOutputWake(task)) {
		recordWakeDrop(task, pending, "output-after-stop-suppressed", deps.logDiagnostic, now, { stopReason: task.stopReason ?? undefined });
		return false;
	}
	if (eventType === "exit" && !task.notifyOnExit && !(deps.exitMandatory?.(task) ?? false)) {
		recordWakeDrop(task, pending, "notify-exit-disabled", deps.logDiagnostic, now);
		return false;
	}

	if (eventType === "output") noteOutputWakeSent(task);
	const deliveredAt = now();
	const record: WakeEventRecord = {
		deliveredAt,
		eventAt: pending.eventAt,
		eventType,
		sequence: pending.sequence,
		taskStatusAtEmit: task.status,
	};
	recordWakeEvent(task, record);
	forgetPendingWake(task, pending.sequence);

	const { tail, truncated } = pickOutputTail(deps, task, options);
	if (eventType === "output") {
		const budget = ensureOutputWakeBudget(task);
		budget.wakes += 1;
		budget.bytes += byteLength(tail);
	}
	const compactTask = compactBackgroundTaskSnapshot(deps.rememberSnapshot(task));
	const details: BackgroundTaskEventDetails = {
		deliveredAt,
		eventAt: pending.eventAt,
		eventType,
		// matchedPattern flows from task.notifyPattern and could be a multi-KB
		// regex bomb. Bound it with the same
		// manifest cap as the compact task fields.
		matchedPattern: truncateForTranscript(options.matchedPattern, WAKE_MANIFEST_FIELD_MAX_CHARS),
		outputTail: tail,
		outputTailTruncated: truncated,
		sequence: pending.sequence,
		task: compactTask,
		taskStatusAtEmit: task.status,
	};
	const cancelled = eventType === "exit" && task.terminationReason === "cancelled-by-user";
	const headline = eventType === "exit"
		? cancelled
			? `Background task ${task.id} was cancelled by the user; no result is coming.`
			: `Background task ${task.id} finished.`
		: `Background task ${task.id} emitted new output.`;
	const exitGuidance = eventType !== "exit"
		? ""
		: cancelled
			? "\nNo result will arrive; rerun the work if it is still needed."
			: (task.exitCode ?? 0) === 0
				? "\nIf you already consumed this result, nothing more to do."
				: `\n${guidance.reviewFailures} (the failed task is ${task.id}).`;
	const inventory = deps.runningInventory?.();
	const commandPreview = truncateField(task.command, WAKE_CONTENT_COMMAND_MAX_CHARS) ?? "";

	deliverWakeMessage(
		deps,
		{
			content: `${headline}\nCommand: ${commandPreview}${exitGuidance}${inventory ? `\n${inventory}` : ""}`,
			customType: deps.messageType,
			details,
			display: true,
		},
		eventType === "exit" ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer", triggerTurn: true },
	);
	return true;
}

/**
 * Build the concise "wake budget exhausted" notice. Emitted once per task when
 * the budget guard trips, instead of further inline-tail wakes. The notice
 * points at the declared result operation — never at the live log path, which is
 * a file the manager keeps appending to, not a retrieval route.
 */
export interface SendBudgetExhaustedNoticeDeps {
	logDiagnostic: (diagnostic: WakeDiagnostic) => void;
	messageType: string;
	now?: () => number;
	rememberSnapshot: (task: ManagedTask) => BackgroundTaskSnapshot;
	sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => void;
	/** Whether the session is idle right now. Absent means unknown. */
	isIdle?: () => boolean;
	/** Starts an idle run through the prompt lifecycle. Absent keeps `triggerTurn`. */
	sendUserMessage?: (content: string) => void;
	/**
	 * The mode's declared surface, read lazily so the notice names the operation
	 * the session actually has. Absent means the conservative compatibility
	 * surface, which is what a caller that does not know its mode must get.
	 */
	surface?: () => TaskToolSurface;
}

export function sendOutputWakeBudgetExhaustedNotice(
	deps: SendBudgetExhaustedNoticeDeps,
	task: ManagedTask,
	limits: OutputWakeBudgetLimits,
): boolean {
	const budget = ensureOutputWakeBudget(task);
	if (budget.announcedAt != null) return false;
	const now = deps.now ?? Date.now;
	const timestamp = now();
	budget.exhausted = true;
	budget.announcedAt = timestamp;
	const content = [
		`Background task ${task.id} output wake budget exhausted; further output wakes suppressed.`,
		`Inspect it with ${taskSurfaceGuidance(deps.surface?.() ?? "compat").inspect} id: ${task.id} (or pid: ${task.pid}).`,
		`Budget caps: ${Math.max(0, Math.floor(limits.maxWakes))} wakes / ${Math.max(0, Math.floor(limits.maxBytes))} inline bytes.`,
	].join("\n");
	const compactTask = compactBackgroundTaskSnapshot(deps.rememberSnapshot(task));
	deliverWakeMessage(
		deps,
		{
			content,
			customType: deps.messageType,
			details: {
				deliveredAt: timestamp,
				eventType: "output-budget-exhausted",
				outputBytes: task.outputBytes,
				task: compactTask,
				wakeBudget: {
					announcedAt: budget.announcedAt,
					bytes: budget.bytes,
					maxBytes: Math.max(0, Math.floor(limits.maxBytes)),
					maxWakes: Math.max(0, Math.floor(limits.maxWakes)),
					wakes: budget.wakes,
				},
			},
			display: true,
		},
		{ deliverAs: "steer", triggerTurn: true },
	);
	deps.logDiagnostic({
		eventType: "output",
		reason: "wake-budget-exhausted",
		taskId: task.id,
		taskStatus: task.status,
		timestamp,
	});
	return true;
}
