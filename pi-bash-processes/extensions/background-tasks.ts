/*
 * kendex Pi background tasks.
 *
 * Locally owned package based on ideas and portions of the MIT-licensed
 * @ifi/pi-background-tasks package. See ../THIRD_PARTY_NOTICES.md.
 */

import {
	getShellConfig,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionToolContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { openLaneDir, pruneLanes } from "../scripts/lane-retention.js";

import { shouldAdoptActiveContext } from "./active-context.js";
import { createBridgeServer, taskGeneration, type BridgeFailure, type BridgeHandler, type BridgeHandlerResult, type BridgeServer, type BridgeTaskSummary } from "./bridge.js";
import {
	autoBackgroundDecision,
	bashBackgroundAckText,
	duplicateTaskNote,
	forcedBackgroundDecision,
} from "./auto-background.js";
import { publishBackgroundTaskActivity, publishBackgroundTaskStarted } from "./activity.js";
import { createCoalescedCall } from "./coalesce.js";
import {
	BG_COMMAND,
	BG_INSTALL_SYMBOL,
	BG_MESSAGE_TYPE,
	BG_STATE_TYPE,
	BG_WIDGET_KEY,
	DEFAULT_BACKGROUND_BASH_SHORTCUT,
	DEFAULT_BG_SHORTCUT,
	DEFAULT_FORCE_KILL_GRACE_MS,
	DEFAULT_FORCED_BACKGROUND_WINDOW_MS,
	DEFAULT_FOREGROUND_YIELD_MS,
	DEFAULT_LOG_TAIL_MAX_CHARS,
	DEFAULT_OUTPUT_ALERT_MAX_CHARS,
	DEFAULT_OUTPUT_BUFFER_MAX_CHARS,
	DEFAULT_OUTPUT_SETTLE_MS,
	DEFAULT_OUTPUT_WAKE_BUDGET_MAX_BYTES,
	DEFAULT_OUTPUT_WAKE_BUDGET_MAX_WAKES,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_SOFT_TIMEOUT_MS,
	DEFAULT_WIDGET_FINISHED_RETENTION_MS,
	DEFAULT_WIDGET_TOGGLE_SHORTCUT,
	MANAGED_BASH_PARTIAL_UPDATE_MS,
	MANAGED_BASH_SYMBOL,
	MAX_FINISHED_TASKS,
	WIDGET_COMPACT_TASKS,
} from "./constants.js";

/** A rerun of the same command inside this window is flagged in the spawn ack. */
const RECENT_RERUN_WINDOW_MS = 10 * 60 * 1000;

import {
	buildTaskSummaryLine,
	compactText,
	formatDuration,
	formatRelativeTime,
	formatShortcutHint,
	normalizedCommand,
	parseOutputMatcher,
	summarizeTaskStatus,
	tailText,
	taskDisplayName,
	trimOutputBuffer,
} from "./format.js";
import {
	bgStatusIcon,
	bgTree,
	frameWidget,
	makeToolResult,
	renderEmpty,
	renderTaskEventMessage,
} from "./render.js";
import { logBackgroundDiagnostic } from "./diagnostics.js";
import {
	BACKGROUND_WORK_MAX_OUTSTANDING,
	registerBackgroundWorkProvider,
	type BackgroundWorkOutstandingTask,
	type BackgroundWorkProvider,
	type BackgroundWorkReconciliation,
	type BackgroundWorkRegistration,
} from "./background-work.js";
// The surface type is the leaf module's; `registrations.ts` re-exports it for
// its own deps, and importing it from both places is a duplicate binding.
import { applyTaskToolSurface, bashPromptGuidelines, registerAll, type RegistrationDeps } from "./registrations.js";
import { closeTaskLifecycle, replayMissedExitsLifecycle, sendExitWakeLifecycle, type LifecycleHooks } from "./lifecycle.js";
import { taskLogs } from "./log-writer.js";
import { BASH_OUTPUT_SCHEMA, buildManagedBashEnv, createForegroundWaiter, formatManagedBashCompletionText, formatManagedBashRunningText, isCodemodeCall, normalizeManagedBashTimeoutSeconds, settleForegroundWaiter, STRUCTURED_OUTPUT_MAX_BYTES, structuredOutputFor, structuredOutputOmittedMarker } from "./managed-bash.js";
import type * as ManagedBashPresentation from "@vanillagreen/pi-tool-renderer/managed-bash";
import { getIntent, intentModeFor, intentParameters, intentPrepare, intentSuffix, stripIntent, withIntentParameter, installIntentGuard } from "@vanillagreen/pi-tool-renderer/intent";
let managedBashPresentation: typeof ManagedBashPresentation | undefined;
async function loadManagedBashPresentation(): Promise<void> {
	if (managedBashPresentation) return;
	try {
		managedBashPresentation = await import("@vanillagreen/pi-tool-renderer/managed-bash");
	} catch {
		managedBashPresentation = undefined;
	}
}
void loadManagedBashPresentation();
import { createOrphanWatcher, type OrphanWatcher } from "./orphan-watcher.js";
import { applyCustomEntryWithBarrier, createPersistence, sessionIdForContext, sidecarStatePath } from "./persistence.js";
import { mapWithConcurrency, PROBE_CONCURRENCY } from "./probes.js";
import { defaultSystemdUnitActive, planResourceControlledSpawn, stopResourceControlledTask } from "./resource-control.js";
import { installSettingsCacheRefresh, recordProjectTrust } from "./package-config.js";
import { bridgeSocketPath, logFilePath, pipefailShellArgs, settingBoolean, settingEnum, settingNumber, settingString, taskEnv, taskLaneDir, taskLanesRoot } from "./settings.js";
import { prepareSnapshot } from "./snapshot-artifact.js";
import { clampTaskWaitSeconds, createTaskWaitWaiter, DEFAULT_TASK_WAIT_SECONDS, formatTaskWaitRunningText, MAX_TASK_WAIT_SECONDS, settleTaskWaitWaiter, TASK_WAIT_PENDING_POLL_MS } from "./task-wait.js";
import {
	acknowledgeCompletion,
	beginResultFinalization,
	buildTaskResultObservation,
	completeResultFinalization,
	readRetainedOutput,
	reviewDeadlineFor,
	resultIsResolved,
	resultResolutionForDelivery,
	reviewReminderArmed,
	selectPrunableFinishedTasks,
	taskReadiness,
	type TaskReadiness,
	type TaskResultAck,
	type TaskResultHandoff,
	type TaskResultObservation,
} from "./task-result.js";
import { applyBgToolResultTasksWithBarrier } from "./tool-result-details.js";
import {
	defaultReadProcessIdentity,
	forgetSnapshot,
	rememberSnapshot,
	resolveTaskByToken,
	restoredTaskFromSnapshot,
	taskSnapshot,
} from "./snapshot.js";
import { MINI_DASHBOARD_RANK, setMiniDashboardWidget } from "./stacked-widget.js";
import {
	createBackgroundWidgetExpiryScheduler,
	createBackgroundWidgetVisibility,
	shouldRenderBackgroundWidget,
	toggleBackgroundWidgetVisibility,
	type BackgroundWidgetMode,
} from "./widget-visibility.js";
import type {
	BackgroundTaskSnapshot,
	BackgroundTaskStatus,
	ForegroundOutcome,
	ManagedTask,
	SpawnTaskOptions,
	TaskEventType,
	TaskWaitOutcome,
	WakeDiagnostic,
	WakeDropReason,
	WakeEventType,
} from "./types.js";
import {
	canEmitOutputWake,
	compactBackgroundTaskSnapshot,
	emptyOutputWakeBudget,
	ensureOutputWakeBudget,
	ensureWakeState,
	deliverWakeMessage,
	resolveNotifyMode,
	recordScheduledOutputDrop,
	scheduleTaskWake,
	sendOutputWakeBudgetExhaustedNotice,
	sendTaskWake,
	shouldEmitOutputWake,
	truncateForTranscript,
	voidPendingTaskWakes,
	WAKE_MANIFEST_FIELD_MAX_CHARS,
	type OutputWakeBudgetLimits,
} from "./wake-events.js";
import { taskSurfaceGuidance, type TaskToolSurface } from "./tool-surface.js";

/**
 * The surface the current session declared, resolved once at `session_start`.
 * Wake and acknowledgement text is generated long after registration, so it
 * reads this rather than a captured mode: a wake may only name operations the
 * model can actually call. The load-time value is the conservative compatibility
 * surface, which is also what a session that never reports a mode keeps.
 */
let taskToolSurface: TaskToolSurface = "compat";

/**
 * Clamp the rendered line count of an aboveEditor widget so it can never push
 * the chat / status / editor above the terminal viewport top, which is what
 * triggers pi-tui's full-screen redraw (firstChanged < prevViewportTop) and
 * the visible flash. Keeps at least 4 lines visible; reserves enough rows for
 * the editor + footer + a sliver of chat. Drops trailing lines and replaces
 * them with a muted "… N more" hint.
 */
function clampAboveEditorWidget(lines: string[], terminalRows: number, theme: Theme): string[] {
	const reserveForOtherUi = 10;
	const maxLines = Math.max(4, terminalRows - reserveForOtherUi);
	if (lines.length <= maxLines) return lines;
	const hidden = lines.length - (maxLines - 1);
	return [...lines.slice(0, maxLines - 1), theme.fg("muted", `… ${hidden} more (open dashboard for full view)`)];
}

// Task output arrives one chunk at a time. A chunk only marks the widget and
// the persisted state stale; these windows bound how often each is redone.
const OUTPUT_UI_REFRESH_MS = 200;
const OUTPUT_PERSIST_MS = 1_000;

export default function backgroundTasks(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[BG_INSTALL_SYMBOL]) return;
	guard[BG_INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;
	const interop = globalThis as unknown as Record<PropertyKey, unknown>;

	let activeCtx: ExtensionContext | null = null;
	// Call ids attributed to a codemode script: the `codemode` call itself and
	// every nested call its script made, so their own nested calls inherit the
	// attribution (see `isCodemodeCall`). An id is held from its `tool_call` to its
	// `tool_result`. A script only ever sees its own result, so a background task
	// it launched could never deliver a wake and a yielded bash would keep running
	// past the script's deadline.
	const codemodeCallIds = new Set<string>();
	// Exit wakes that arrived while a turn was in flight. The agent is usually
	// still working and will read the result itself; sending immediately is what
	// produced a visible "Background task finished" line for work that was
	// already reported. Deferred wakes flush at turn end unless something
	// observes the task first (see consumeObservedExitWake).
	let turnActive = false;
	const deferredExitWakes = new Map<string, { eventAt?: number; matchedPattern?: string; newOutputTail?: string; sequence?: number }>();
	let requestWidgetRender: (() => void) | null = null;
	let forceNextBashBackgroundAt: number | null = null;
	const backgroundBashShortcut = settingString("backgroundBashShortcut", DEFAULT_BACKGROUND_BASH_SHORTCUT);
	const dashboardShortcut = settingString("dashboardShortcut", DEFAULT_BG_SHORTCUT);
	const widgetToggleShortcut = settingString("widgetToggleShortcut", DEFAULT_WIDGET_TOGGLE_SHORTCUT);
	const widgetVisibility = createBackgroundWidgetVisibility(settingEnum("widgetDefaultMode", ["compact", "expanded", "hidden"] as const, "compact") as BackgroundWidgetMode);
	let taskCounter = 0;
	let shuttingDown = false;
	const tasks = new Map<string, ManagedTask>();
	const outputDedupeHashes = new Map<string, string>();

	const numericTaskId = (id: string): number => {
		const match = id.match(/^bg-(\d+)$/);
		return match ? Number(match[1]) : 0;
	};

	// Track the active session id so spawn/restore/replay can scope snapshots
	// to the current Pi session and reject cross-session leaks.
	let activeSessionId: string | null = null;

	// --- Background settlement provider (public seam) ---------------------
	//
	// Registers this lifecycle on the settlement seam in
	// `extensions/background-work.ts` (protocol `background-work/v1`) so a
	// consumer can tell an absent provider from this registered one. Group 2 of
	// openspec `herdsman-background-handoffs` (tasks 2.1-2.4); every answer is
	// fail-closed and nothing is inferred that the lifecycle did not record:
	// - `bind` adopts task→assignment association: spawned tasks inherit the
	//   bound request id (`task.assignmentRequestId`, written once at spawn),
	//   and binding refuses while unresolved work exists that is NOT
	//   attributable to the request — foreign-request tasks and unassociated
	//   tasks (restored pre-Group-2 work, or spawns from before the first bind)
	//   are quarantined for explicit reconciliation, never silently adopted.
	// - Result resolution (`task.resultResolution`) is the only thing that
	//   retires a task from `outstanding`: a durable observation that a
	//   certified result reached the worker (`delivered`, tasks 2.2) or that
	//   an unrecoverable capture error was actually handed over (`error`,
	//   tasks 2.3). `exitNotified` is notification state and never settles
	//   anything: a notified-but-unretrieved terminal task stays
	//   `awaiting-result-review` (design D2's terminal-ready condition).
	// - An empty unresolved map answers `ready` for ANY request — completed
	//   history is history and may be re-queried; while unresolved work exists,
	//   an unbound scope answers `error`, never inferred emptiness.
	// - `protect` marks the bound assignment settlement-waiting so its tasks'
	//   exit wakes are mandatory even under `notifyOnExit: false` (tasks 2.4).
	// `ready` still requires the exact active session (identity-mismatch at
	// the helper) and a completed successful restore. Registration is replaced
	// at every `session_start` and disposed first at `session_shutdown`, so a
	// stale registration never answers while the task map is being emptied.
	// Consumers arrive with the Herdsman settlement guard (Group 3); nothing
	// here wires waiting or settlement itself.
	const SETTLEMENT_PROVIDER_ID = "pi-bash-processes";
	const SETTLEMENT_PROVIDER_VERSION = 1;
	let settlementRestore: { state: "pending" } | { state: "done" } | { state: "failed"; reason: string } = { state: "pending" };
	let settlementRevision = 0;
	let settlementRegistration: BackgroundWorkRegistration | null = null;
	/** The accepted assignment request currently bound for spawn association; null before the first bind (or after a session restart). */
	let boundAssignment: string | null = null;
	/** The bound assignment marked settlement-waiting; only its tasks' exit wakes are mandatory. */
	let protectedAssignment: string | null = null;
	/** Monotonic snapshot revision: bumps on every transition that can change the answer. */
	const bumpSettlementRevision = (): void => {
		settlementRevision += 1;
		if (activeSessionId !== null && boundAssignment !== null) {
			settlementRegistration?.notifyChange({
				sessionId: activeSessionId,
				requestId: boundAssignment,
			});
		}
	};

	/**
	 * Record a result-resolution observation (openspec tasks 2.2-2.3).
	 * Eligibility is decided by the centralized `resultResolutionForDelivery`
	 * rule at each delivery site — a flushing (`finalizing`) handoff passes
	 * `null` and records nothing. Written once — the first actual handoff
	 * stands (`delivered` and `error` never overwrite each other) — and
	 * durable, so a restart cannot un-resolve a result that was already handed
	 * over. Deliberately separate from `acknowledgeCompletion`: a host wake is
	 * notification, not settlement. Never applies to a running task: running
	 * work is inspected, not resolved.
	 */
	const recordResultResolution = (task: ManagedTask, kind: "delivered" | "error" | null): boolean => {
		if (kind === null) return false;
		if (task.status === "running") return false;
		if (task.resultResolution !== undefined) return false;
		task.resultResolution = kind;
		rememberSnapshot(task);
		persistSnapshots();
		bumpSettlementRevision();
		return true;
	};

	/** Whether this task's exit wake is mandatory despite `notifyOnExit: false` (protected assignment, tasks 2.4). */
	const exitWakeIsMandatory = (task: ManagedTask): boolean =>
		protectedAssignment !== null && task.assignmentRequestId !== undefined && task.assignmentRequestId === protectedAssignment;

	/** Everything unresolved in the map, classified against one scope's request id. */
	type SettlementClassification = {
		/** Unresolved tasks associated with this request, in snapshot form. */
		outstanding: BackgroundWorkOutstandingTask[];
		/** Unresolved tasks with no association at all: quarantined, never adopted. */
		unassociated: string[];
		/** Unresolved tasks associated with a different request: unattributable to this scope. */
		unattributable: string[];
	};
	const classifySettlementTasks = (requestId: string): SettlementClassification => {
		const classification: SettlementClassification = { outstanding: [], unassociated: [], unattributable: [] };
		for (const task of tasks.values()) {
			if (resultIsResolved(task)) continue;
			if (task.assignmentRequestId === undefined) {
				classification.unassociated.push(task.id);
				continue;
			}
			if (task.assignmentRequestId !== requestId) {
				classification.unattributable.push(task.id);
				continue;
			}
			if (task.status === "running") {
				classification.outstanding.push({
					taskId: task.id,
					state: "running",
					reason: "managed task spawned under this assignment is running",
				});
				continue;
			}
			if (task.resultReady !== true) {
				classification.outstanding.push(
					taskReadiness(task) === "incomplete"
						? {
							taskId: task.id,
							state: "awaiting-result-review",
							reason: "terminal capture was never certified (readiness incomplete after restore); awaiting explicit result resolution (tasks 2.2-2.3)",
						}
						: {
							taskId: task.id,
							state: "flushing",
							reason: "process ended; output capture is still settling (resultReady not established)",
						},
				);
				continue;
			}
			classification.outstanding.push({
				taskId: task.id,
				state: "awaiting-result-review",
				reason: "terminal capture ready; awaiting an actual result handoff (tasks 2.2) — a host wake or an inspection does not resolve it",
			});
		}
		return classification;
	};
	/** A bounded, stable id list for a reconciliation reason. */
	const idList = (ids: string[]): string => {
		const shown = ids.slice(0, 8).join(", ");
		return ids.length > 8 ? `${shown} (+${ids.length - 8} more)` : shown;
	};

	const settlementProvider: BackgroundWorkProvider = {
		id: SETTLEMENT_PROVIDER_ID,
		version: SETTLEMENT_PROVIDER_VERSION,
		snapshot(scope) {
			if (activeSessionId == null) {
				throw new Error("background-work: no active session id; session_start has not established one");
			}
			const classified = classifySettlementTasks(scope.requestId);
			if (classified.outstanding.length > BACKGROUND_WORK_MAX_OUTSTANDING) {
				// Fail closed rather than truncate the bounded snapshot list.
				throw new Error(`background-work: ${classified.outstanding.length} outstanding tasks for this request exceed the ${BACKGROUND_WORK_MAX_OUTSTANDING}-task snapshot bound`);
			}
			let reconciliation: BackgroundWorkReconciliation;
			if (settlementRestore.state === "pending") {
				reconciliation = { state: "reconciling", reason: "task snapshot restore has not completed" };
			} else if (settlementRestore.state === "failed") {
				reconciliation = { state: "error", reason: settlementRestore.reason };
			} else {
				const quarantine = [...classified.unassociated, ...classified.unattributable];
				if (quarantine.length === 0) {
					// Nothing unresolved outside this request (and nothing
					// unassociated): either the bound view with its own
					// outstanding list, or a scope re-querying after every task
					// was resolved. Resolved history never blocks it.
					reconciliation = { state: "ready" };
				} else if (scope.requestId === boundAssignment) {
					// Bound, but unresolved work is not attributable to it:
					// quarantined for explicit reconciliation, never counted as
					// this request's outstanding and never silently cleared.
					reconciliation = {
						state: "reconciling",
						reason: `${quarantine.length} unresolved task(s) are not associated with the bound assignment and are quarantined for explicit reconciliation: ${idList(quarantine)}`,
					};
				} else if (boundAssignment !== null) {
					reconciliation = {
						state: "error",
						reason: `request "${scope.requestId}" is not the bound assignment ("${boundAssignment}") while ${quarantine.length} unresolved task(s) exist: ${idList(quarantine)}`,
					};
				} else {
					reconciliation = {
						state: "error",
						reason: `no assignment is bound; ${quarantine.length} unresolved task(s) require explicit reconciliation before any request can be answered: ${idList(quarantine)}`,
					};
				}
			}
			return {
				provider: { id: SETTLEMENT_PROVIDER_ID, version: SETTLEMENT_PROVIDER_VERSION },
				sessionId: activeSessionId,
				requestId: scope.requestId,
				revision: settlementRevision,
				reconciliation,
				outstanding: classified.outstanding,
			};
		},
		bind(scope) {
			if (activeSessionId == null) {
				return { ok: false, reason: "background-work: no active session id; session_start has not established one" };
			}
			if (scope.sessionId !== activeSessionId) {
				return { ok: false, reason: `background-work: query session "${scope.sessionId}" does not match the active session` };
			}
			const classified = classifySettlementTasks(scope.requestId);
			const blockers = [...classified.unassociated, ...classified.unattributable];
			if (blockers.length > 0) {
				return {
					ok: false,
					reason: `unresolved work not attributable to request "${scope.requestId}" blocks binding: ${idList(blockers)}; reconcile it explicitly (bg_task get/stop/clear) before binding`,
				};
			}
			if (boundAssignment !== scope.requestId) {
				boundAssignment = scope.requestId;
				// Protection belonged to the previous assignment; the new binding
				// must opt in again rather than inherit mandatory wakes.
				protectedAssignment = null;
				bumpSettlementRevision();
			}
			return { ok: true };
		},
		protect(scope, protect) {
			if (activeSessionId == null) {
				return { ok: false, reason: "background-work: no active session id; session_start has not established one" };
			}
			if (scope.sessionId !== activeSessionId) {
				return { ok: false, reason: `background-work: query session "${scope.sessionId}" does not match the active session` };
			}
			if (boundAssignment !== scope.requestId) {
				return { ok: false, reason: `background-work: request "${scope.requestId}" is not the bound assignment; bind it before protecting it` };
			}
			protectedAssignment = protect ? scope.requestId : null;
			if (protect) {
				// Protection must reconcile work that already ended BEFORE it was
				// set: a suppressed exit wake (notifyOnExit:false) or one that
				// was never sent leaves terminal, unresolved, associated tasks
				// with no wake queued, and settlement would wait on a wake that
				// is never coming. Re-enter them through the normal exit path —
				// mid-turn they hold, idle they batch — where the exitMandatory
				// gate now forces delivery. `exitNotified` covers both an
				// already-delivered wake and a held one still queued (both ack'd
				// when placed/sent), and re-entering an entry already in a
				// deferred/idle map only overwrites it, so this never duplicates
				// a wake; a resolved task is never resurrected.
				for (const task of tasks.values()) {
					if (task.assignmentRequestId !== scope.requestId) continue;
					if (task.status === "running" || task.resultResolution !== undefined) continue;
					if (task.exitNotified === true || task.supersededBy !== undefined) continue;
					sendTaskEvent("exit", task);
				}
			}
			return { ok: true };
		},
	};

	const persistenceLayer = createPersistence({
		pi,
		customType: BG_STATE_TYPE,
		getActiveCtx: () => activeCtx,
		listSnapshots: () => sortedTasks().map((task) => rememberSnapshot(task)),
		notify: (where) => activeCtx?.ui.notify?.(
			`Background task state persistence failed (${where}). Recent task transitions may not survive a restart.`,
			"warning",
		),
	});

	// Deferred persistence for per-chunk state; any immediate persist covers it.
	const persistSoon = createCoalescedCall(() => persistenceLayer.persistSnapshots(), OUTPUT_PERSIST_MS);
	const persistSnapshots = (): { appendEntry: boolean; sidecar: boolean } => {
		persistSoon.cancel();
		return persistenceLayer.persistSnapshots();
	};

	// ---------------------------------------------------------------------
	// Completion lifecycle: readiness, shared result preparation, review clock.
	//
	// Every rule below lives in `task-result.ts`; this section only supplies the
	// live host effects (snapshot persistence, the held-wake maps, the on-disk
	// log read) so `get`/`stop`/foreground delivery/host notification read the
	// same state instead of re-deriving it per adapter.
	// ---------------------------------------------------------------------

	/**
	 * Tasks whose result is being prepared right now. `boundFinishedTasks` never
	 * prunes one: a terminal retrieval racing the retention bound keeps its task
	 * map entry, snapshot, and log until the preparation releases the lease.
	 */
	const resultPreparationLeases = new Set<string>();
	const withResultPreparationLease = <T,>(task: Pick<ManagedTask, "id">, prepare: () => T): T => {
		resultPreparationLeases.add(task.id);
		try {
			return prepare();
		} finally {
			resultPreparationLeases.delete(task.id);
		}
	};

	/** Drops any completion wake this process still holds for a task. */
	const cancelHeldCompletionWake = (taskId: string): boolean => {
		const deferred = deferredExitWakes.delete(taskId);
		const idle = idleExitBatch.delete(taskId);
		return deferred || idle;
	};

	/**
	 * Single completion-acknowledgment entry point (see task-result.ts).
	 * Idempotent: a task already recorded is left without a second snapshot
	 * write. `cancelHeld: false` is for a caller that is itself placing a held
	 * wake — host notification after a deferral, or the deferral itself.
	 */
	const ackCompletion = (
		task: ManagedTask,
		reason: "foreground-delivery" | "wait-delivery" | "retrieval" | "stop" | "host-notification" | "held-wake",
		options: { cancelHeld?: boolean } = {},
	): boolean => {
		const result = acknowledgeCompletion(
			task,
			{
				cancelHeldWake: cancelHeldCompletionWake,
				persist: (target) => { rememberSnapshot(target); persistSnapshots(); },
			},
			options,
		);
		if (result.acknowledged || result.heldWakeCancelled) {
			logBackgroundDiagnostic("completion acknowledged", {
				heldWakeCancelled: result.heldWakeCancelled,
				id: task.id,
				reason,
			});
		}
		return result.acknowledged || result.heldWakeCancelled;
	};

	/**
	 * The one read a retrieval uses for retained output: live in-memory output
	 * while the task runs, the log tail once it is terminal, and an explicit
	 * error — never a fabricated success — when the retained log is gone.
	 */
	const retainedOutputFor = (task: ManagedTask): { ok: true; output: string } | { ok: false; error: string } => {
		if (task.output.length > 0) return { ok: true, output: task.output };
		return readRetainedOutput(task.logFile, { exists: existsSync, read: readLogTail });
	};

	/**
	 * Shared result preparation: the running/finalizing/incomplete/terminal
	 * observation every adapter reports. Held under a preparation lease so
	 * retention cannot prune the task mid-read.
	 */
	const observeTaskResult = (task: ManagedTask, now: number = Date.now()): TaskResultObservation =>
		withResultPreparationLease(task, () =>
			buildTaskResultObservation({
				logSettled: taskLogs.settled(task.logFile),
				now,
				output: retainedOutputFor(task),
				outputPreviewChars: settingNumber("logTailMaxChars", DEFAULT_LOG_TAIL_MAX_CHARS, activeCtx?.cwd),
				task,
			}));

	// --- Declared CLI bridge ------------------------------------------------
	//
	// The generated `pi-bg` is a shell process: it cannot read the live task map,
	// so it asks. This is the session's side of that conversation — one Unix
	// socket inside the session's own lane directory, serving the allowlisted
	// get/list/stop operations from the same shared observation the tools use.
	//
	// The bridge module owns framing, protocol version, and session identity; the
	// rules about what a task's state *means* stay here. No request path commits
	// an acknowledgment or a review: a prepared observation is not a successful
	// handoff, and only the caller's receipt can settle one. The legacy read
	// channels remain in place until that receipt path replaces them.
	const bridgeSocketPathFor = (): string => bridgeSocketPath(activeSessionId ?? `ephemeral-${process.pid}`);
	let bridgeServer: BridgeServer | null = null;

	// Prepared-result receipts. A get/stop response carries an opaque token bound
	// to the session, task incarnation, and the readiness the handoff was
	// prepared at; the CLI returns it only after its stdout write finished. Until
	// that token arrives nothing is committed, so a transport failure, an EPIPE,
	// or a snapshot the CLI could not open leaves the completion obligation
	// exactly where it was.
	type ReceiptCommit = TaskResultAck;
	interface PreparedReceipt {
		taskId: string;
		generation: string;
		readinessAtPrepare: TaskReadiness;
		outputWasFull: boolean;
		preparedAt: number;
		/** Set once a receipt settled it; a retry replays this instead of redoing it. */
		commit: ReceiptCommit | null;
		/**
		 * When the owning task was pruned. Set only on an accepted token, which keeps
		 * its record so a retry is told the *task* expired — never that the
		 * acknowledgment was never accepted, which would read as though it had been
		 * rolled back. Never aged out: the spec's answer for a pruned task is an
		 * explicit task expiry, and deleting the record would replace that with an
		 * unaccepted-preparation error for a token that was in fact accepted.
		 */
		prunedAt?: number;
	}
	const preparedReceipts = new Map<string, PreparedReceipt>();
	const RECEIPT_TTL_MS = 15 * 60_000;
	const RECEIPT_MAX_PENDING = 64;

	const prunePreparedReceipts = (now: number): void => {
		for (const [token, receipt] of preparedReceipts) {
			// Only an abandoned preparation ages out. It committed nothing, so its
			// record only has to outlive the caller's retry window; an accepted one is
			// the record a retry replays, and the spec keeps that answer due for the
			// task's retained lifetime and reports an explicit task expiry after it.
			if (!receipt.commit && now - receipt.preparedAt > RECEIPT_TTL_MS) preparedReceipts.delete(token);
		}
		// The bound is `RECEIPT_MAX_PENDING` records *including* the one about to be
		// minted, so this pass leaves a slot free. It only ever retires records
		// nothing can still depend on: the accepted handoff of a task that is already
		// out of the retained map. A live
		// preparation is never retired — its caller holds the token and is entitled
		// to have it settle — and neither is an accepted handoff of a retained task,
		// which is what makes a retry idempotent throughout that task's retained
		// lifetime. When nothing is retirable the cap is not enforced by eviction;
		// `mintReceipt` reports an explicit capacity failure instead.
		while (preparedReceipts.size >= RECEIPT_MAX_PENDING) {
			const retirable = [...preparedReceipts].find(([, receipt]) => receipt.commit && receipt.prunedAt !== undefined);
			if (!retirable) break;
			preparedReceipts.delete(retirable[0]);
		}
	};

	/**
	 * Retire a pruned task's receipts. An unaccepted preparation is dropped
	 * outright — it committed nothing, so there is nothing left to tell a retry.
	 * An accepted one keeps its record, marked pruned, so a retry is answered with
	 * the task's expiry rather than with an unaccepted-preparation error.
	 */
	const forgetTaskReceipts = (taskId: string, now: number = Date.now()): void => {
		for (const [token, receipt] of preparedReceipts) {
			if (receipt.taskId !== taskId) continue;
			if (!receipt.commit) {
				preparedReceipts.delete(token);
				continue;
			}
			receipt.prunedAt ??= now;
		}
	};

	// A token has to be recognizable as one this session issued even after the
	// record behind it is gone. Otherwise a retry of an accepted handoff that the
	// store's cap has since retired is indistinguishable from a token that was
	// never issued, and the only available answer — "nothing is recorded as
	// acknowledged" — would assert something false about a settled handoff. The
	// tag is a keyed digest over the token's own task identity, so verification
	// needs no stored per-token state and the cap stays a real memory bound.
	const receiptKey = randomBytes(32);
	/** The digest covers the *whole* token body, nonce included. */
	const receiptTag = (body: string): string =>
		createHmac("sha256", receiptKey).update(body).digest("base64url");

	/**
	 * Whether a token is one this session minted, read from the token itself.
	 *
	 * The digest authenticates the complete issued token — its nonce too — so any
	 * altered token fails verification and is refused as never issued, rather than
	 * being accepted as one of this session's own. That has to hold for every part
	 * of the token, because the answer for an authenticated-but-unheld token
	 * asserts it was issued here.
	 */
	const issuedTokenBody = (token: string): string | null => {
		const cut = token.lastIndexOf(":");
		if (cut <= 0) return null;
		const body = token.slice(0, cut);
		if (body.split(":").length !== 3) return null;
		const given = Buffer.from(token.slice(cut + 1));
		const want = Buffer.from(receiptTag(body));
		if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
		return body;
	};

	/**
	 * The store is full of handoffs that cannot be retired — every one of them an
	 * accepted handoff for a task this session still retains. A read can still be
	 * served, but it cannot be made settleable, so it is reported as a capacity
	 * failure instead of being handed a receipt that could never commit.
	 */
	const receiptCapacityFailure: BridgeFailure = {
		code: "capacity",
		message: `this session is holding the maximum of ${RECEIPT_MAX_PENDING} unsettled result handoffs; this read cannot be acknowledged, and no receipt was issued for it`,
	};

	/** Whether a new prepared handoff could be stored right now. */
	const receiptIsStorable = (): boolean => {
		prunePreparedReceipts(Date.now());
		return preparedReceipts.size < RECEIPT_MAX_PENDING;
	};

	/**
	 * Store a prepared handoff and return its token, or `null` when the store is
	 * saturated.
	 *
	 * The store is a memory bound, so a preparation that cannot be stored must fail
	 * explicitly: handing back a token whose record was not kept — or evicting the
	 * token just minted, or another caller's live preparation — would present a
	 * token as valid that can never settle what it promises.
	 */
	const mintReceipt = (task: ManagedTask, readiness: TaskReadiness, outputWasFull: boolean): string | null => {
		const now = Date.now();
		prunePreparedReceipts(now);
		if (preparedReceipts.size >= RECEIPT_MAX_PENDING) return null;
		const body = `${task.id}:${taskGeneration(task)}:${randomUUID()}`;
		const token = `${body}:${receiptTag(body)}`;
		preparedReceipts.set(token, {
			commit: null,
			generation: taskGeneration(task),
			outputWasFull,
			preparedAt: now,
			readinessAtPrepare: readiness,
			taskId: task.id,
		});
		return token;
	};

	const bridgeSummary = (task: ManagedTask): BridgeTaskSummary => {
		const observation = observeTaskResult(task);
		return {
			command: task.command,
			generation: taskGeneration(task),
			id: task.id,
			outputBytes: observation.outputBytes,
			outputComplete: observation.outputComplete,
			pid: task.pid,
			readiness: observation.readiness,
			startedAt: task.startedAt,
			status: task.status,
			updatedAt: task.updatedAt,
		};
	};

	/** Why a read is not a completed result, or undefined when it is one. */
	const captureErrorFor = (observation: TaskResultObservation): string | undefined => {
		if (observation.outputError) return observation.outputError;
		if (observation.readiness === "incomplete") {
			return "the capture was never certified complete and no process is left to finish it; the bytes shown are all that survive";
		}
		if (observation.readiness === "terminal" && !observation.outputComplete) {
			return "the retained capture is not certified complete; the log writer dropped bytes before the flush settled";
		}
		return undefined;
	};

	const bridgePrepared = async (task: ManagedTask) => {
		const handoff = await prepareTaskHandoff(task, "preview");
		return {
			captureError: handoff.captureError,
			observation: handoff.observation,
			task: bridgeSummary(task),
		};
	};

	/**
	 * Settle a prepared handoff. The receipt is the only thing that commits an
	 * acknowledgment or a review, and it is idempotent: a caller whose connection
	 * dropped after the request landed can retry the same token and get the same
	 * committed outcome rather than a second, or a refused, one.
	 *
	 * Only a token this session never accepted answers `receipt-unaccepted`. An
	 * accepted token always answers with its committed outcome while its task is
	 * retained, and with an explicit task expiry after the task is pruned — never
	 * with the unaccepted-preparation error, which would describe a committed
	 * acknowledgment as one that had never been recorded.
	 */
	const settleReceipt = (token: string, delivered?: "error"): BridgeHandlerResult => {
		const receipt = preparedReceipts.get(token);
		if (!receipt) {
			// No record. Two different situations reach here and they must not be
			// given the same answer:
			//
			// - the token is not one this session minted, so nothing was ever
			//   recorded for it and refusing it claims nothing false;
			// - the token *is* this session's, but the store's cap has since retired
			//   its record. Calling that an unaccepted preparation would describe a
			//   possibly-settled handoff as one that was never accepted, so this
			//   answer keeps the memory bound while saying only what is known: the
			//   handoff cannot be replayed, and nothing here is a claim about
			//   whether it was acknowledged.
			if (!issuedTokenBody(token)) {
				return {
					ok: false,
					error: {
						code: "receipt-unaccepted",
						message: "this token names no preparation this session holds; nothing is recorded as acknowledged or unacknowledged for it",
					},
				};
			}
			return {
				ok: false,
				error: {
					code: "expired",
					message: "this token was issued by this session, but the record that could replay it is no longer held; the handoff cannot be replayed, and this answer makes no claim about whether it was acknowledged",
				},
			};
		}
		if (receipt.prunedAt !== undefined) {
			// The task outlived its retention window. The commit that happened still
			// happened; what is gone is the task it belonged to. `prunedAt` is set only
			// for an accepted token, so this is an expiry of the task, not of a
			// preparation the session never accepted.
			return {
				ok: false,
				error: {
					code: "expired",
					message: `task ${receipt.taskId} is no longer retained; its accepted handoff cannot be replayed, and its acknowledgment stands`,
				},
			};
		}
		const task = resolveTask(receipt.taskId, undefined);
		if (receipt.commit) {
			// Already accepted: replay the committed outcome. The task may legitimately
			// be gone by now, so the record is served from the receipt itself.
			return {
				ok: true,
				result: {
					ack: {
						acknowledged: receipt.commit.acknowledged,
						committed: "replayed",
						reviewed: receipt.commit.reviewed,
						task: task ? bridgeSummary(task) : undefined,
					},
				},
			};
		}
		if (delivered === "error") {
			// The declared CLI confirms it handed over an unrecoverable capture
			// error (openspec tasks 2.3). This is an error delivery, NOT a
			// completion settlement: it records the durable `error` resolution
			// and commits no acknowledgment or review. The receipt's own
			// generation must still name this task, and the centralized rule
			// must say the delivery was an error — a certified capture would
			// make this confirmation meaningless, and a still-flushing one is
			// not a resolution at all.
			const resolution = task && taskGeneration(task) === receipt.generation
				? resultResolutionForDelivery(observeTaskResult(task))
				: null;
			if (task && resolution === "error") {
				const recorded = recordResultResolution(task, resolution);
				return {
					ok: true,
					result: {
						ack: {
							acknowledged: task.exitNotified === true,
							committed: recorded ? "error" : "replayed",
							reviewed: false,
							task: bridgeSummary(task),
						},
					},
				};
			}
			return {
				ok: true,
				result: {
					ack: {
						acknowledged: task?.exitNotified === true,
						committed: "none",
						reviewed: false,
						task: task ? bridgeSummary(task) : undefined,
					},
				},
			};
		}
		if (!task) {
			// An unaccepted preparation whose task is gone commits nothing and never
			// did: that is an expiry, not a rollback of an acknowledgment.
			preparedReceipts.delete(token);
			return { ok: false, error: { code: "expired", message: `task ${receipt.taskId} is no longer retained; its handoff was never acknowledged` } };
		}
		if (taskGeneration(task) !== receipt.generation) {
			preparedReceipts.delete(token);
			return { ok: false, error: { code: "stale-generation", message: `task ${receipt.taskId} was replaced; this receipt belongs to an earlier incarnation` } };
		}
		// Revalidate at commit time. A handoff prepared while the task ran streamed
		// a partial capture, so even if the task finished mid-stream it may only ever
		// reset the review clock — never acknowledge a completion whose bytes the
		// caller did not receive in full. The commit rule is shared with the tool
		// adapter, so both settle a handoff identically.
		const observation = observeTaskResult(task);
		const committed = commitTaskHandoff(task, receipt.readinessAtPrepare);
		receipt.commit = committed;
		logBackgroundDiagnostic("bridge receipt accepted", {
			acknowledged: committed.acknowledged,
			committed: committed.committed,
			id: task.id,
			readinessAtPrepare: receipt.readinessAtPrepare,
			readinessNow: observation.readiness,
		});
		return {
			ok: true,
			result: {
				ack: {
					acknowledged: committed.acknowledged,
					committed: committed.committed,
					reviewed: committed.reviewed,
					task: bridgeSummary(task),
				},
			},
		};
	};

	/**
	 * The one prepared-result operation: what a `get` hands over, shared by the
	 * `bg_task` tool and the declared CLI. Transport is the only thing that
	 * differs between them, so it is the only thing that lives outside this.
	 *
	 * Preparing commits nothing — not an acknowledgment, not a review. A full read
	 * is flushed to a boundary first, so the snapshot holds everything captured so
	 * far instead of whatever happened to have reached the file, and the boundary
	 * is then fixed at the flushed size so later output cannot change the artifact.
	 */
	const prepareTaskHandoff = async (task: ManagedTask, output: "preview" | "full"): Promise<TaskResultHandoff> => {
		if (output === "preview") {
			const observation = observeTaskResult(task);
			return { captureError: captureErrorFor(observation), observation };
		}
		if (task.status === "running") {
			// `flush` returns null when there is nothing pending, in which case the
			// file already holds every appended chunk.
			await taskLogs.flush(task.logFile);
		}
		const observation = observeTaskResult(task);
		const certified = observation.readiness === "terminal" && observation.outputComplete;
		const snapshot = await prepareSnapshot({
			generation: taskGeneration(task),
			laneDir: ownLaneDir(),
			logFile: task.logFile,
			partial: !certified,
			taskId: task.id,
		});
		if (!snapshot.ok) return { failure: { code: snapshot.code, message: snapshot.message }, observation };
		return { artifact: snapshot.artifact, captureError: certified ? undefined : captureErrorFor(observation), observation };
	};

	/**
	 * Commit a handoff whose output actually reached the caller. A terminal
	 * handoff settles the completion; a running one resets only the review clock
	 * and leaves the completion owed. The observation the handoff was *prepared*
	 * at decides which, never the task's state at commit time: a partial stream
	 * cannot become a completion acknowledgment because the task finished while it
	 * was being written.
	 */
	const commitTaskHandoff = (task: ManagedTask, readinessAtPrepare: TaskReadiness): TaskResultAck => {
		if (readinessAtPrepare !== "terminal") {
			recordReview(task);
			rememberSnapshot(task);
			persistSnapshots();
			return { acknowledged: false, committed: "review", reviewed: true };
		}
		ackCompletion(task, "retrieval");
		// A certified terminal result just reached the caller: record the
		// durable resolution through the centralized rule (openspec tasks
		// 2.2-2.3), distinct from the completion acknowledgment above it.
		recordResultResolution(task, resultResolutionForDelivery(observeTaskResult(task)));
		// The obligation is settled whether this handoff settled it or an earlier
		// delivery already had: the caller is told the result's completion is
		// accounted for, not that this call happened to flip the bit.
		return { acknowledged: task.exitNotified === true, committed: "terminal", reviewed: false };
	};

	const bridgeSnapshot = async (task: ManagedTask): Promise<BridgeHandlerResult> => {
		const handoff = await prepareTaskHandoff(task, "full");
		if (handoff.failure) {
			// A failed preparation is still an answer the worker actually receives
			// (openspec tasks 2.3): carry a receipt so the declared CLI can
			// confirm the error was delivered and the task resolves as `error`
			// instead of being trapped awaiting a retrieval that can never
			// certify. Minting can still decline at capacity; the client then
			// sends no receipt and the failure simply stays unresolved and
			// retryable.
			return { ok: false, error: { code: handoff.failure.code, message: handoff.failure.message }, receipt: mintReceipt(task, handoff.observation.readiness, true) ?? undefined };
		}
		if (!receiptIsStorable()) return { ok: false, error: receiptCapacityFailure };
		const artifact = handoff.artifact!;
		return {
			ok: true,
			result: {
				captureError: handoff.captureError,
				output: {
					bytes: artifact.bytes,
					complete: artifact.complete,
					kind: "snapshot",
					partial: artifact.partial,
					path: artifact.path,
				},
				receipt: mintReceipt(task, handoff.observation.readiness, true),
				task: bridgeSummary(task),
			},
		};
	};

	const bridgeHandler: BridgeHandler = async (request) => {
		if (request.op === "receipt") return settleReceipt(request.token ?? "", request.delivered);
		if (request.op === "list") {
			// Listing is inspection only: it never acknowledges, resets a review,
			// or advances any clock.
			return { ok: true, result: { tasks: [...tasks.values()].map(bridgeSummary) } };
		}
		const task = resolveTask(request.id, undefined);
		if (!task) {
			return { ok: false, error: { code: "unknown-task", message: `no task ${request.id} in this session` } };
		}
		if (request.generation !== undefined && request.generation !== taskGeneration(task)) {
			return {
				ok: false,
				error: { code: "stale-generation", message: `task ${task.id} was replaced; this handle names ${request.generation}` },
			};
		}
		if (request.op === "get") {
			// A full read hands over an artifact, never the live file: the caller must
			// not be reading a log the producer is still writing.
			if (request.output === "full") return bridgeSnapshot(task);
			const prepared = await bridgePrepared(task);
			const receipt = mintReceipt(task, prepared.observation.readiness, false);
			// A read with no storable receipt is reported as a capacity failure: it cannot
			// be acknowledged, so it must not look like a handoff that will commit.
			if (!receipt) return { ok: false, error: receiptCapacityFailure };
			return {
				ok: true,
				result: {
					captureError: prepared.captureError,
					output: { kind: "preview", partial: prepared.observation.readiness !== "terminal", text: prepared.observation.outputPreview, truncated: prepared.observation.outputPreviewTruncated },
					receipt,
					task: prepared.task,
				},
			};
		}
		// stop: the session's own bounded termination procedure, then the result
		// under the same id. A stop that cannot confirm termination is reported as
		// unconfirmed, never as a stopped task.
		const stopped = await stopTaskForBridge(task);
		if (!stopped.confirmed) {
			return { ok: false, error: { code: "unconfirmed-stop", message: stopped.message } };
		}
		// A confirmed stop returns a terminal task, so its capture is the same
		// immutable artifact a full get hands over.
		if (request.output === "full") return bridgeSnapshot(task);
		const prepared = await bridgePrepared(task);
		const receipt = mintReceipt(task, prepared.observation.readiness, false);
		// A read with no storable receipt is reported as a capacity failure: it cannot
		// be acknowledged, so it must not look like a handoff that will commit.
		if (!receipt) return { ok: false, error: receiptCapacityFailure };
		return {
			ok: true,
			result: {
				captureError: prepared.captureError,
				output: { kind: "preview", partial: prepared.observation.readiness !== "terminal", text: prepared.observation.outputPreview, truncated: prepared.observation.outputPreviewTruncated },
				receipt,
				task: prepared.task,
			},
		};
	};

	const ensureBridge = async (): Promise<void> => {
		const socketPath = bridgeSocketPathFor();
		const session = activeSessionId ?? `ephemeral-${process.pid}`;
		if (bridgeServer && bridgeServer.socketPath === socketPath && bridgeServer.session === session) return;
		await bridgeServer?.stop();
		bridgeServer = createBridgeServer({
			handle: bridgeHandler,
			onError: (error) => logBackgroundDiagnostic("bridge server error", { error: error instanceof Error ? error.message : String(error) }),
			session,
			socketPath,
		});
		const started = await bridgeServer.start();
		if (!started.listening) {
			logBackgroundDiagnostic("bridge endpoint unavailable", { reason: started.reason ?? "unknown", session, socketPath });
		}
	};

	const stopBridge = async (): Promise<void> => {
		const active = bridgeServer;
		bridgeServer = null;
		await active?.stop();
	};

	// Terminal confirmation for a declared stop. One promise per waiting request,
	// resolved where finalization actually completes, so the CLI never reports a
	// signal as a stopped task and never polls to find out.
	const terminalWaiters = new Map<string, Set<() => void>>();
	const notifyTerminal = (task: ManagedTask): void => {
		const waiters = terminalWaiters.get(task.id);
		if (!waiters) return;
		terminalWaiters.delete(task.id);
		for (const resolve of waiters) resolve();
	};
	/**
	 * A bounded wait for a task's terminal state, as a promise and the handle that
	 * cancels it. The cancel exists for a caller whose wait stops applying before
	 * it settles — a stop whose signal was refused has no termination left to wait
	 * for, and its timer must not outlive the refusal.
	 */
	const awaitTerminal = (task: ManagedTask, timeoutMs: number): { cancel: () => void; settled: Promise<boolean> } => {
		let cancel = (): void => {};
		const settled = new Promise<boolean>((resolve) => {
			if (taskReadiness(task) === "terminal" || task.status !== "running") {
				resolve(true);
				return;
			}
			const waiters = terminalWaiters.get(task.id) ?? new Set<() => void>();
			let done = false;
			const finish = (confirmed: boolean): void => {
				if (done) return;
				done = true;
				waiters.delete(onTerminal);
				if (waiters.size === 0) terminalWaiters.delete(task.id);
				clearTimeout(timer);
				resolve(confirmed);
			};
			const onTerminal = (): void => finish(true);
			cancel = () => finish(false);
			waiters.add(onTerminal);
			terminalWaiters.set(task.id, waiters);
			const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
		});
		return { cancel: () => cancel(), settled };
	};

	/**
	 * Stop bounded by the existing termination procedure: SIGTERM now, the
	 * existing force-kill escalation behind it, and confirmation from the same
	 * finalization that produces the terminal result. A stop that cannot confirm
	 * termination says so and leaves the outcome outstanding; it never reports a
	 * signal as a stopped task.
	 */
	const stopTaskForBridge = async (task: ManagedTask): Promise<{ confirmed: boolean; message: string }> => {
		if (taskReadiness(task) === "terminal" || task.status !== "running") {
			// The same wording the direct stop uses, so one stop outcome reads one
			// way however the caller reached it.
			return { confirmed: true, message: `${task.id} is already ${summarizeTaskStatus(task.status, task.exitCode, task.terminationReason)}.` };
		}
		const graceMs = settingNumber("forceKillGraceMs", DEFAULT_FORCE_KILL_GRACE_MS, activeCtx?.cwd);
		const boundMs = graceMs + 5_000;
		const pending = awaitTerminal(task, boundMs);
		const signalled = requestStop(task, "user", "agent");
		if (!signalled.ok) {
			// No signal was sent and nothing was confirmed: the task is exactly as
			// it was, and the caller must not treat this as a stopped task. Nothing
			// is pending termination, so the wait armed above is retired with it.
			pending.cancel();
			return { confirmed: false, message: signalled.message };
		}
		if (!(await pending.settled)) {
			return {
				confirmed: false,
				message: `${task.id} did not confirm termination within ${boundMs}ms; it is not reported stopped and its outcome stays outstanding`,
			};
		}
		return { confirmed: true, message: signalled.message };
	};

	// Restore replays the session's plain snapshot data first, newest per task
	// id, and only then rehydrates and probes the final task set, so startup
	// probes each surviving task once however long the history is.
	const restoreSnapshots = async (ctx: ExtensionContext) => {
		// Drop the previous in-memory tasks without leaking their armed timers:
		// the rehydrated task objects re-arm their own (including the soft
		// reminder), and a stale timer would fire a second wake for a task that no
		// longer exists in the map.
		for (const task of tasks.values()) releaseTaskTimers(task);
		tasks.clear();
		taskCounter = 0;
		activeSessionId = sessionIdForContext(ctx);
		const replayed = new Map<string, BackgroundTaskSnapshot>();
		const rememberRestoredSnapshot = (snapshot: BackgroundTaskSnapshot) => {
			if (!snapshot?.id || !snapshot.command) return;
			const existing = replayed.get(snapshot.id);
			if (existing && existing.updatedAt >= snapshot.updatedAt) return;
			replayed.set(snapshot.id, snapshot);
		};
		const clearRestoredTasks = () => { replayed.clear(); };
		let sidecarLoaded = false;
		let sidecarTasks: BackgroundTaskSnapshot[] | undefined;
		try {
			const file = sidecarStatePath(ctx);
			if (existsSync(file)) {
				const data = JSON.parse(readFileSync(file, "utf8")) as { tasks?: unknown };
				if (Array.isArray(data?.tasks)) {
					sidecarTasks = data.tasks as BackgroundTaskSnapshot[];
					for (const snapshot of sidecarTasks) rememberRestoredSnapshot(snapshot);
					sidecarLoaded = true;
				}
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logBackgroundDiagnostic("persistence failed (sidecar-read)", { error: msg });
			// Fall back to session entries below.
		}
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === BG_STATE_TYPE) {
				applyCustomEntryWithBarrier({
					data: entry.data,
					sidecarLoaded,
					sidecarTasks,
					clear: clearRestoredTasks,
					apply: (snapshot) => rememberRestoredSnapshot(snapshot),
				});
			}
			if (entry.type === "message" && entry.message.role === "toolResult" && (entry.message.toolName === "bg_task" || entry.message.toolName === "bg_status" || entry.message.toolName === "bash")) {
				const details = entry.message.details as { task?: unknown; tasks?: unknown } | undefined;
				if (details?.task) rememberRestoredSnapshot(details.task as BackgroundTaskSnapshot);
				applyBgToolResultTasksWithBarrier({
					apply: (snapshot) => rememberRestoredSnapshot(snapshot as BackgroundTaskSnapshot),
					clear: clearRestoredTasks,
					detailsTasks: details?.tasks,
					sidecarLoaded,
					sidecarTasks,
				});
			}
		}
		const sessionId = activeSessionId ?? undefined;
		const restored = await mapWithConcurrency([...replayed.values()], PROBE_CONCURRENCY, (snapshot) =>
			restoredTaskFromSnapshot(snapshot, { sessionId, unitActiveProbe: defaultSystemdUnitActive }));
		for (const task of restored) {
			tasks.set(task.id, task);
			taskCounter = Math.max(taskCounter, numericTaskId(task.id));
			rememberSnapshot(task);
		}
		// Reconcile markers with what we just restored: a session that died
		// mid-task leaves markers behind, and a restored running task needs one.
		for (const task of tasks.values()) {
			if (task.status === "running") {
				markTaskRunning(task);
				// Arming is idempotent per deadline, so a rehydrated running task
				// always ends up with exactly one timer — including one whose
				// previous reminder already fired and was re-armed from that review.
				scheduleSoftTimeout(task);
			} else clearRunningMarker(task);
		}
		if (tasks.size > 0) persistSnapshots();
	};

	const sortedTasks = (): ManagedTask[] => [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);

	// A finished task's output lives in its log only; read back as much of the
	// end as the in-memory buffer would have held. The dashboard asks on every
	// redraw, so the last tail read is reused while its log is unchanged.
	let lastLogTail: { logFile: string; size: number; mtimeMs: number; text: string } | undefined;
	const readLogTail = (logFile: string): string => {
		const maxChars = settingNumber("outputBufferMaxChars", DEFAULT_OUTPUT_BUFFER_MAX_CHARS);
		let fd: number | undefined;
		try {
			fd = openSync(logFile, "r");
			const { size, mtimeMs } = fstatSync(fd);
			if (lastLogTail?.logFile === logFile && lastLogTail.size === size && lastLogTail.mtimeMs === mtimeMs) return lastLogTail.text;
			const length = Math.min(size, maxChars);
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, size - length);
			// A cut through a multi-byte character decodes to U+FFFD at the start.
			const text = buffer.toString("utf8").replace(/^\uFFFD+/, "");
			lastLogTail = { logFile, size, mtimeMs, text };
			return text;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			logBackgroundDiagnostic("task log read failed", { logFile, error: reason });
			return `[log unreadable: ${reason}]`;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	};

	const getTaskOutput = (task: ManagedTask): string => {
		const read = retainedOutputFor(task);
		// A retained log that is gone or unreadable is reported as such: an
		// expired handle must not read as a successful empty result.
		return read.ok ? read.output : read.error;
	};

	/**
	 * `structuredContent.output` for a completed command: the task log is the
	 * full output (the in-memory buffer keeps only its end), read the way Pi's
	 * bash result reads its output file — everything up to the structured cap,
	 * else the first and last half around an omission marker. Returns null when
	 * the log cannot be read, so the caller falls back to the text it holds.
	 */
	const readStructuredOutput = (logFile: string): { output: string; truncated: boolean } | null => {
		let fd: number | undefined;
		try {
			fd = openSync(logFile, "r");
			const { size } = fstatSync(fd);
			if (size <= STRUCTURED_OUTPUT_MAX_BYTES) {
				const buffer = Buffer.alloc(size);
				readSync(fd, buffer, 0, size, 0);
				return { output: buffer.toString("utf8"), truncated: false };
			}
			const headBytes = Math.floor(STRUCTURED_OUTPUT_MAX_BYTES / 2);
			const tailBytes = STRUCTURED_OUTPUT_MAX_BYTES - headBytes;
			const head = Buffer.alloc(headBytes);
			const tail = Buffer.alloc(tailBytes);
			readSync(fd, head, 0, headBytes, 0);
			readSync(fd, tail, 0, tailBytes, size - tailBytes);
			const headText = new TextDecoder().decode(head, { stream: true });
			// The tail read can start inside a multi-byte character; skip its
			// continuation bytes so the kept tail does not open with U+FFFD.
			let tailStart = 0;
			while (tailStart < tail.length && (tail[tailStart]! & 0xc0) === 0x80) tailStart += 1;
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			const omitted = size - headBytes - tailBytes;
			return { output: `${headText}${structuredOutputOmittedMarker(omitted)}${tailText}`, truncated: true };
		} catch {
			return null;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	};

	/**
	 * Structured result of a completed managed command. `output` comes from the
	 * task log only while the log writer reports that file settled; a log whose
	 * last write failed or is still stalled is short by the bytes it dropped, so
	 * the bounded text the tool already holds is the honest record there (see
	 * `structuredOutputFor`). A yielded task gets no structured result at all: the
	 * schema describes a finished command (`exit_code`, `wall_time_seconds`), and
	 * a caller holding a Running result has a live task to ask instead.
	 */
	const managedBashStructuredContent = (task: ManagedTask, exitCode: number, elapsedMs: number, rawText: string) =>
		structuredOutputFor(
			{
				logFile: task.logFile,
				read: taskLogs.settled(task.logFile) ? readStructuredOutput(task.logFile) : null,
				outputBytes: task.outputBytes,
				text: rawText === "(no output)" ? "" : rawText,
			},
			exitCode,
			elapsedMs,
		);

	// A write the log writer still holds for the file would create it again,
	// so the removal waits for the file's writes to settle.
	const removeTaskLog = (task: ManagedTask) => {
		const remove = () => {
			try {
				rmSync(task.logFile, { force: true });
			} catch (error) {
				logBackgroundDiagnostic("task log removal failed", { id: task.id, logFile: task.logFile, error: error instanceof Error ? error.message : String(error) });
			}
		};
		const written = taskLogs.flush(task.logFile);
		if (written) void written.then(remove);
		else remove();
	};

	/** The lane directory this session's task logs are written to. */
	const ownLaneDir = (): string => taskLaneDir(activeSessionId ?? `ephemeral-${process.pid}`);

	// A task restored from another session's branch, as a forked session holds,
	// keeps its log: the session that wrote it still reads it, and the lane
	// prune removes it in time.
	const forgetFinishedTask = (task: ManagedTask) => {
		voidPendingTaskWakes(task, "clear", logWakeDiagnostic);
		clearTaskTimers(task);
		tasks.delete(task.id);
		bumpSettlementRevision();
		forgetSnapshot(task.id);
		// A pruned task cannot settle a handoff any more, so its unaccepted
		// preparations go with it rather than lingering as tokens for a task the
		// session no longer retains.
		forgetTaskReceipts(task.id);
		if (dirname(task.logFile) === ownLaneDir()) removeTaskLog(task);
	};

	// Tasks that exited and whose exit wake waits for their log's flush. They are
	// also non-prunable: their exit wake has not been delivered yet.
	const exitWakeDue = new WeakSet<ManagedTask>();

	// Keep at most MAX_FINISHED_TASKS finished tasks, dropping the oldest. Each
	// finished task the bound counts has had its exit reported or never asked
	// for it: an exit wake goes unsent only during session_shutdown, which
	// empties the map first, and session_start replays missed exits before it
	// bounds. A task whose exit wake waits for its log's flush, and a task whose
	// result a retrieval is preparing right now, are both protected.
	const boundFinishedTasks = (): number => {
		const protectedIds = new Set<string>(resultPreparationLeases);
		for (const task of tasks.values()) if (exitWakeDue.has(task)) protectedIds.add(task.id);
		const prunable = selectPrunableFinishedTasks(tasks.values(), { maxFinished: MAX_FINISHED_TASKS, protectedIds });
		for (const task of prunable) forgetFinishedTask(task);
		return prunable.length;
	};

	const releaseTaskTimers = (task: ManagedTask) => {
		if (task.outputTimer) clearTimeout(task.outputTimer);
		if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
		if (task.softTimeoutTimer) clearTimeout(task.softTimeoutTimer);
		if (task.forceKillTimer) clearTimeout(task.forceKillTimer);
		task.outputTimer = null;
		task.timeoutTimer = null;
		task.softTimeoutTimer = null;
		task.forceKillTimer = null;
	};

	const clearTaskTimers = (task: ManagedTask) => {
		if (task.outputTimer) {
			for (const pending of (task.pendingWakes ?? []).filter((wake) => wake.eventType === "output")) {
				persistScheduledOutputDrop(task, pending, "cleared-on-task-exit");
			}
		}
		releaseTaskTimers(task);
	};

	const widgetExpiry = createBackgroundWidgetExpiryScheduler(() => activeCtx ? syncWidget(activeCtx) : undefined);
	const clearWidget = () => {
		widgetExpiry.clear();
		if (activeCtx) setMiniDashboardWidget(activeCtx, BG_WIDGET_KEY, MINI_DASHBOARD_RANK.BACKGROUND_TASKS, undefined);
		requestWidgetRender = null;
	};

	const widgetFinishedRetentionMs = (cwd?: string): number =>
		Math.max(0, Math.floor(settingNumber("widgetFinishedRetentionSeconds", DEFAULT_WIDGET_FINISHED_RETENTION_MS / 1_000, cwd) * 1_000));

	const widgetTasks = (now: number = Date.now()): ManagedTask[] => {
		const retention = widgetFinishedRetentionMs(activeCtx?.cwd);
		return sortedTasks().filter((task) => {
			// A managed-bash call is an ordinary foreground tool row until it
			// actually yields. Only a yielded task has become a background task
			// the widget should claim; a task that exited inside its foreground
			// window was never backgrounded at all.
			if (task.origin === "managed-bash" && task.foregroundWaiter?.outcome?.kind !== "yielded") return false;
			return task.status === "running" || now - task.updatedAt <= retention;
		});
	};

	const renderWidgetLines = (theme: Theme): string[] => {
		const sorted = widgetTasks();
		const running = sorted.filter((task) => task.status === "running");
		const display = [...running, ...sorted.filter((task) => task.status !== "running")];
		const finished = sorted.length - running.length;
		const toggleHint = widgetToggleShortcut === "none" ? "" : ` · ${formatShortcutHint(widgetToggleShortcut)} toggle`;
		const dashboardHint = dashboardShortcut === "none" ? "" : ` · ${formatShortcutHint(dashboardShortcut)} dashboard`;
		const summary = `${theme.fg("customMessageLabel", theme.bold("Background tasks"))} ${theme.fg(
			"muted",
			`${running.length} running · ${finished} finished${toggleHint}${dashboardHint}`,
		)}`;
		if (display.length === 0) return [summary];
		const shown = display.slice(0, widgetVisibility.mode === "expanded" ? display.length : WIDGET_COMPACT_TASKS);
		const lines = [summary];
		shown.forEach((task, index) => {
			const isLast = index === shown.length - 1 && shown.length === display.length;
			const activityAt = task.lastOutputAt ?? task.updatedAt;
			lines.push(`${bgTree(theme, isLast ? "└" : "├", activeCtx?.cwd)}${bgStatusIcon(task.status, theme)} ${theme.fg("accent", task.id)} ${theme.fg(
				"dim",
				`${summarizeTaskStatus(task.status, task.exitCode, task.terminationReason)} · ${compactText(taskDisplayName(task), 72)} · ${formatRelativeTime(activityAt)}`,
			)}`);
		});
		const hidden = display.length - shown.length;
		if (hidden > 0) lines.push(`${bgTree(theme, "└", activeCtx?.cwd)}${theme.fg("muted", `… ${hidden} more`)}`);
		return lines;
	};

	function syncWidget(ctx: ExtensionContext): void {
		activeCtx = ctx;
		widgetExpiry.clear();
		const now = Date.now();
		const visibleTasks = widgetTasks(now);
		if (!shouldRenderBackgroundWidget({
			hasUi: ctx.hasUI,
			mode: widgetVisibility.mode,
			showWidget: settingBoolean("showWidget", true, ctx.cwd),
			trackedTaskCount: tasks.size,
			visibleTaskCount: visibleTasks.length,
		})) {
			clearWidget();
			return;
		}

		setMiniDashboardWidget(
			ctx,
			BG_WIDGET_KEY,
			MINI_DASHBOARD_RANK.BACKGROUND_TASKS,
			(tui, theme) => {
				requestWidgetRender = () => tui.requestRender();
				// No recurring redraw for relative-time labels: full-screen redraws cause
				// above-viewport flicker. Labels can stay stale between task events;
				// the one-shot expiry refresh only updates task visibility.
				return {
					dispose() {
						if (requestWidgetRender) requestWidgetRender = null;
					},
					invalidate() {},
					render(width: number) {
						return clampAboveEditorWidget(frameWidget(renderWidgetLines(theme), width, theme), tui.terminal.rows, theme);
					},
				};
			},
			{ placement: settingString("widgetPlacement", "aboveEditor", ctx.cwd) === "belowEditor" ? "belowEditor" : "aboveEditor" },
		);

		widgetExpiry.schedule(visibleTasks, widgetFinishedRetentionMs(ctx.cwd), now);
	}

	const refreshUi = () => {
		outputUiRefresh.cancel();
		for (const task of tasks.values()) rememberSnapshot(task);
		if (activeCtx) syncWidget(activeCtx);
		requestWidgetRender?.();
	};
	const outputUiRefresh = createCoalescedCall(refreshUi, OUTPUT_UI_REFRESH_MS);

	const logWakeDiagnostic = (diagnostic: WakeDiagnostic) => {
		logBackgroundDiagnostic("wake diagnostic", diagnostic);
	};

	const persistScheduledOutputDrop = (
		task: ManagedTask,
		pending: { eventAt: number; eventType: WakeEventType; sequence: number },
		reason: WakeDropReason,
		extra: Partial<WakeDiagnostic> = {},
	) => {
		recordScheduledOutputDrop({
			extra,
			logDiagnostic: logWakeDiagnostic,
			pending,
			reason,
			task,
		});
		// A dropped output wake is a diagnostic record, and a chatty task drops
		// one per chunk; it rides the next persist instead of forcing one.
		persistSoon.request();
	};

	const wakeBudgetLimits = (cwd?: string): OutputWakeBudgetLimits => ({
		maxBytes: Math.max(0, Math.floor(settingNumber("outputWakeBudgetMaxBytes", DEFAULT_OUTPUT_WAKE_BUDGET_MAX_BYTES, cwd))),
		maxWakes: Math.max(0, Math.floor(settingNumber("outputWakeBudgetMaxWakes", DEFAULT_OUTPUT_WAKE_BUDGET_MAX_WAKES, cwd))),
	});

	/**
	 * How a wake reads whether the session is idle and wakes it through the
	 * prompt lifecycle. Pi skips `before_agent_start` for a `triggerTurn` run
	 * (pi#5581, #10267), so an idle wake is started by a short user prompt.
	 */
	const wakeSend = {
		isIdle: (): boolean => {
			try {
				return activeCtx?.isIdle() === true;
			} catch {
				return false;
			}
		},
		sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>): void => pi.sendMessage(message as never, options as never),
		// Absent when the host has no `sendUserMessage`; the wake helper then keeps
		// the `triggerTurn` delivery rather than waking through a prompt it cannot.
		...(typeof pi.sendUserMessage === "function" ? { sendUserMessage: (content: string): void => pi.sendUserMessage(content) } : {}),
	};

	const announceWakeBudgetExhausted = (task: ManagedTask) => {
		const limits = wakeBudgetLimits(activeCtx?.cwd);
		const announced = sendOutputWakeBudgetExhaustedNotice({
			...wakeSend,
			logDiagnostic: logWakeDiagnostic,
			messageType: BG_MESSAGE_TYPE,
			surface: () => taskToolSurface,
			rememberSnapshot,
		}, task, limits);
		if (announced) {
			rememberSnapshot(task);
			persistSnapshots();
		}
		return announced;
	};

	const sendTaskEvent = (
		eventType: TaskEventType,
		task: ManagedTask,
		options: { eventAt?: number; matchedPattern?: string; newOutputTail?: string; sequence?: number; softTimeout?: { elapsedMs: number; softTimeoutMs: number } } = {},
	): boolean => {
		// Exit-vs-wait one-owner rule: while a model-facing bash call is inside
		// its bounded foreground wait, that tool result is the delivery channel
		// for this exit; while a bounded bg_task wait is attached, that tool
		// result is the delivery channel instead. Record the exit as delivered
		// so neither an async wake nor a post-restart replay duplicates it. A
		// session shutdown is excluded: the wake is dropped by the shutdown
		// gate and must stay replay-eligible.
		if (eventType === "exit" && !shuttingDown) {
			const foregroundOwnsExit = Boolean(task.foregroundWaiter && !task.foregroundWaiter.settled);
			const waitOwnsExit = task.taskWaiter?.attached === true && !task.taskWaiter.settled;
			if (foregroundOwnsExit || waitOwnsExit) {
				// The foreground/wait tool result IS this exit's delivery channel:
				// acknowledge through the shared entry point, which also drops any
				// completion wake this process still holds for the task. The result
				// resolution travels with it (openspec tasks 2.2-2.3) — but only as
				// far as the centralized delivery rule allows: a certified capture
				// delivers, an unrecoverable one delivers as `error`, and a flush
				// still settling records nothing (the task stays outstanding until
				// a certified handoff completes it).
				ackCompletion(task, "foreground-delivery");
				recordResultResolution(task, resultResolutionForDelivery(observeTaskResult(task)));
				publishBackgroundTaskActivity(eventType, task, { ...options, sequence: options.sequence ?? task.wakeSequence ?? 0 });
				return true;
			}
		}
		// Mid-turn exits are held until the turn ends: the agent can still read
		// the result in this same turn, in which case the wake is dropped.
		if (eventType === "exit" && turnActive && !shuttingDown) {
			// Held, not delivered: record the obligation, but do not cancel the
			// wake this branch is placing.
			ackCompletion(task, "held-wake", { cancelHeld: false });
			deferredExitWakes.set(task.id, options);
			publishBackgroundTaskActivity(eventType, task, { ...options, sequence: options.sequence ?? task.wakeSequence ?? 0 });
			return true;
		}
		// Idle-time exits: hold briefly so siblings finishing in the same window
		// arrive as one grouped wake (subagents-style completion batching).
		if (eventType === "exit" && !shuttingDown) {
			// Queued, not delivered: return false so callers do not mark the exit
			// notified. The flush claims delivery once the send actually succeeds,
			// which also keeps a crash inside the debounce window replay-eligible.
			idleExitBatch.set(task.id, options);
			publishBackgroundTaskActivity(eventType, task, { ...options, sequence: options.sequence ?? task.wakeSequence ?? 0 });
			rememberSnapshot(task);
			persistSnapshots();
			scheduleIdleExitFlush();
			return false;
		}
		const sent = sendTaskWake({
			...wakeSend,
			isShuttingDown: () => shuttingDown,
			logDiagnostic: logWakeDiagnostic,
			messageType: BG_MESSAGE_TYPE,
			surface: () => taskToolSurface,
			outputTail: (target) => tailText(getTaskOutput(target), settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS, activeCtx?.cwd)),
			rememberSnapshot,
			runningInventory,
			exitMandatory: exitWakeIsMandatory,
		}, eventType, task, options);
		publishBackgroundTaskActivity(eventType, task, { ...options, sequence: options.sequence ?? task.wakeSequence ?? 0 });
		rememberSnapshot(task);
		persistSnapshots();
		return sent;
	};

	const IDLE_EXIT_DEBOUNCE_MS = settingNumber("exitWakeBatchMs", 250, activeCtx?.cwd);
	const idleExitBatch = new Map<string, { eventAt?: number; matchedPattern?: string; newOutputTail?: string; sequence?: number }>();
	let idleExitTimer: ReturnType<typeof setTimeout> | null = null;

	// Merge-into-undelivered is Pi's job now: settings.followUpMode = "all"
	// drains queued follow-ups as one prompt, so every wake can go out as soon
	// as it is ready and Pi coalesces whatever is still queued.
	const scheduleIdleExitFlush = (): void => {
		if (IDLE_EXIT_DEBOUNCE_MS <= 0) {
			flushIdleExitBatch();
			return;
		}
		if (idleExitTimer) return;
		idleExitTimer = setTimeout(() => {
			idleExitTimer = null;
			flushIdleExitBatch();
		}, IDLE_EXIT_DEBOUNCE_MS);
		idleExitTimer.unref?.();
	};
	const flushIdleExitBatch = (): void => {
		if (idleExitBatch.size === 0) return;
		for (const [id, options] of idleExitBatch) deferredExitWakes.set(id, options);
		idleExitBatch.clear();
		flushDeferredExitWakes();
	};

	const scheduleOutputReaction = (task: ManagedTask) => {
		ensureWakeState(task);
		if (!task.notifyOnOutput) return;
		if (!canEmitOutputWake(task)) {
			logWakeDiagnostic({
				eventAt: task.lastOutputAt ?? Date.now(),
				eventType: "output",
				reason: "output-after-stop-suppressed",
				stopReason: task.stopReason ?? undefined,
				taskId: task.id,
				taskStatus: task.status,
				timestamp: Date.now(),
			});
			return;
		}
		if (task.outputTimer) {
			for (const pendingWake of (task.pendingWakes ?? []).filter((wake) => wake.eventType === "output")) {
				persistScheduledOutputDrop(task, pendingWake, "output-wake-rescheduled");
			}
			clearTimeout(task.outputTimer);
		}
		const pending = scheduleTaskWake(task, "output", task.lastOutputAt ?? Date.now());
		task.outputTimer = setTimeout(() => {
			task.outputTimer = null;
			if (!canEmitOutputWake(task)) {
				sendTaskEvent("output", task, { eventAt: pending.eventAt, sequence: pending.sequence });
				refreshUi();
				return;
			}
			const output = getTaskOutput(task);
			const unseenOutput = output.slice(task.lastAnnouncedLength);
			if (!unseenOutput.trim()) {
				task.lastAnnouncedLength = output.length;
				persistScheduledOutputDrop(task, pending, "empty-output");
				return;
			}
			if (task.matcher && !canEmitOutputWake(task)) {
				sendTaskEvent("output", task, { eventAt: pending.eventAt, sequence: pending.sequence });
				refreshUi();
				return;
			}
			const patternMatched = task.matcher ? (task.matcher(unseenOutput) || task.matcher(output)) : true;
			if (!patternMatched) {
				persistScheduledOutputDrop(task, pending, "notify-pattern-no-match", { matchedPattern: task.notifyPattern });
				return;
			}
			const newOutputTail = tailText(unseenOutput, settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS, activeCtx?.cwd));
			const decisionDiagnostics: WakeDiagnostic[] = [];
			const limits = wakeBudgetLimits(activeCtx?.cwd);
			const shouldEmit = shouldEmitOutputWake(task, {
				dedupeHashes: outputDedupeHashes,
				eventAt: pending.eventAt,
				logDiagnostic: (diagnostic) => decisionDiagnostics.push(diagnostic),
				newOutput: unseenOutput,
				newOutputTail,
				patternMatched,
				sequence: pending.sequence,
				wakeBudgetLimits: limits,
			});
			if (!shouldEmit) {
				const diagnostic = decisionDiagnostics[decisionDiagnostics.length - 1];
				const reason = (diagnostic?.reason ?? "output-after-stop-suppressed") as WakeDropReason;
				task.lastAnnouncedLength = output.length;
				persistScheduledOutputDrop(task, pending, reason, diagnostic ?? {});
				if (reason === "wake-budget-exhausted") announceWakeBudgetExhausted(task);
				refreshUi();
				return;
			}
			task.lastAnnouncedLength = output.length;
			sendTaskEvent("output", task, {
				eventAt: pending.eventAt,
				matchedPattern: task.notifyPattern,
				newOutputTail,
				sequence: pending.sequence,
			});
			refreshUi();
		}, settingNumber("outputSettleMs", DEFAULT_OUTPUT_SETTLE_MS, activeCtx?.cwd));
		task.outputTimer.unref?.();
	};

	/**
	 * Arm the one review reminder for a running task. The deadline is measured
	 * from the last successful review (`reviewDeadlineFor`), never from output
	 * activity and never from the hard `expiresAt` ceiling. A deadline that has
	 * already passed (a restored live task, or a review that happened just
	 * before a restart) fires on the next tick rather than being skipped.
	 *
	 * `reviewRevision` is the staleness token: a review that lands while the
	 * timer is armed bumps it, and the timer that fires under the old revision
	 * is discarded instead of delivering a reminder for a review that already
	 * happened.
	 */
	const scheduleSoftTimeout = (task: ManagedTask): void => {
		if (task.softTimeoutTimer) clearTimeout(task.softTimeoutTimer);
		task.softTimeoutTimer = null;
		const deadline = reviewDeadlineFor(task);
		if (deadline == null) {
			task.softExpiresAt = null;
			return;
		}
		task.softExpiresAt = deadline;
		if (!reviewReminderArmed(task)) return;
		const revision = task.reviewRevision ?? 0;
		task.softTimeoutTimer = setTimeout(() => {
			task.softTimeoutTimer = null;
			// Revalidate at dispatch: a successful review, or a terminal
			// transition, makes this reminder stale.
			if ((task.reviewRevision ?? 0) !== revision) return;
			if (task.status !== "running" || task.stopReason != null) return;
			deliverReviewReminder(task, deadline, revision);
		}, Math.max(1, deadline - Date.now()));
		task.softTimeoutTimer.unref?.();
	};

	/**
	 * Hand one progress review to the host and rearm the next interval from it.
	 * A delivered review counts as the task's review, so the next reminder is
	 * measured from delivery. A wake the host would not take (shutdown) is left
	 * re-armable.
	 */
	const deliverReviewReminder = (task: ManagedTask, deadline: number, revision: number): void => {
		task.softTimeoutNotified = true;
		const deliveredAt = Date.now();
		const sent = sendTaskEvent("soft-timeout", task, {
			eventAt: deadline,
			softTimeout: {
				elapsedMs: Math.max(0, deliveredAt - task.startedAt),
				softTimeoutMs: task.softTimeoutMs ?? 0,
			},
		});
		if (!sent) {
			task.softTimeoutNotified = false;
			return;
		}
		task.lastReviewedAt = deliveredAt;
		task.reviewedOutputBytes = task.outputBytes;
		task.reviewRevision = revision + 1;
		scheduleSoftTimeout(task);
		rememberSnapshot(task);
		persistSnapshots();
		refreshUi();
	};

	/**
	 * Record a successful deliberate review of a running task: the next reminder
	 * interval starts now and any armed reminder for the previous deadline is
	 * discarded. Never touches the hard `expiresAt` ceiling. A running `get`
	 * calls this; so does the legacy `extend` soft-window reset.
	 */
	const recordReview = (task: ManagedTask, reviewedAt: number = Date.now()): void => {
		task.lastReviewedAt = reviewedAt;
		task.reviewedOutputBytes = task.outputBytes;
		task.reviewRevision = (task.reviewRevision ?? 0) + 1;
		task.softTimeoutNotified = false;
		scheduleSoftTimeout(task);
	};

	/**
	 * `bg_task action:"extend"`: clear the one-shot latch and start a fresh soft
	 * window from now. Optional `softTimeoutMs` sets that window; omitted keeps the
	 * task's configured value. The hard `timeoutSeconds` budget is never touched.
	 */
	const extendSoftTimeout = (task: ManagedTask | null, softTimeoutMs?: number): { ok: boolean; message: string } => {
		if (!task) return { ok: false, message: "No background task matched that id or pid." };
		if (task.status !== "running") {
			return { ok: false, message: `${task.id} is already ${summarizeTaskStatus(task.status, task.exitCode, task.terminationReason)}.` };
		}
		const nextMs = softTimeoutMs === undefined
			? task.softTimeoutMs ?? 0
			: Number.isFinite(softTimeoutMs) ? Math.max(0, Math.floor(softTimeoutMs)) : 0;
		task.softTimeoutMs = nextMs;
		task.updatedAt = Date.now();
		// The legacy soft-window reset is a review: the next interval is measured
		// from now and the absolute hard timeout is untouched.
		recordReview(task);
		rememberSnapshot(task);
		persistSnapshots();
		refreshUi();
		return {
			ok: true,
			message: nextMs > 0
				? `Soft reminder for ${task.id} extended: it will ask again in ${formatDuration(nextMs)}. Hard timeout is unchanged.`
				: `Soft reminder for ${task.id} disabled. Hard timeout is unchanged.`,
		};
	};

	const lifecycleHooks: LifecycleHooks = {
		// Host notification is the completion acknowledgment, but it must not drop
		// a wake this same path just deferred: cancelHeld stays off here, and the
		// explicit retrieval/stop paths are what cancel a held wake.
		acknowledgeCompletion: (task) => ackCompletion(task, "host-notification", { cancelHeld: false }),
		rememberSnapshot,
		persistSnapshots,
		sendTaskEvent,
		refreshUi,
		clearTaskTimers,
	};

	/**
	 * Sidecar marker the read shims check: present while a task is running, so a
	 * read of a running task's log can tell the agent it is polling rather than
	 * consuming. Removed on every terminal transition.
	 */
	const runningMarkerPath = (task: Pick<ManagedTask, "logFile">): string => `${task.logFile}.running`;
	const markTaskRunning = (task: Pick<ManagedTask, "logFile">): void => {
		try {
			writeFileSync(runningMarkerPath(task), "");
		} catch {
			// A missing marker only costs the polling hint.
		}
	};
	const clearRunningMarker = (task: Pick<ManagedTask, "logFile">): void => {
		try {
			rmSync(runningMarkerPath(task), { force: true });
		} catch {
			// Best effort.
		}
	};

	// The task's final status and its timers settle at once, so a stop,
	// timeout or shutdown after the child exits signals nothing. The exit wake
	// names the log file as the task's full output, so it waits for the log's
	// flush to release. A task cleared or replaced meanwhile gets no wake.
	// Once the log holds the output, the process handle and the in-memory
	// output are released: an exited process has nothing left to report. A log
	// whose last write failed or is still stalled keeps the in-memory output as
	// the record.
	//
	// The two halves of the terminal transition are recorded explicitly so a
	// retrieval that races this flush reports `finalizing` (process ended,
	// output not durable yet) instead of a complete result whose last bytes are
	// still in the writer's queue. See task-result.ts `taskReadiness`.
	const finalizeTask = (task: ManagedTask, exitCode: number | null, statusOverride?: BackgroundTaskStatus): void => {
		beginResultFinalization(task);
		if (!closeTaskLifecycle(task, exitCode, lifecycleHooks, statusOverride)) return;
		// The terminal transition changes which snapshot states are decidable
		// (running → settling/terminal), so the settlement revision follows it.
		bumpSettlementRevision();
		clearRunningMarker(task);
		task.child = null;
		refreshUi();
		exitWakeDue.add(task);
		const settle = () => {
			exitWakeDue.delete(task);
			if (tasks.get(task.id) === task) {
				// The writer's own answer for this file is the capture's integrity
				// record; it is persisted with the snapshot, so a restore cannot
				// re-derive a complete capture from a fresh, empty queue.
				const logSettled = taskLogs.settled(task.logFile);
				completeResultFinalization(task, logSettled);
				notifyTerminal(task);
				// The exit-wake decision runs while an attached waiter is still
				// unsettled: that is how a foreground bash wait or a bounded task
				// wait is recognised as the delivery channel for this exit.
				sendExitWakeLifecycle(task, lifecycleHooks);
				if (logSettled && existsSync(task.logFile)) {
					task.output = "";
					task.lastAnnouncedLength = 0;
				}
				if (boundFinishedTasks() > 0) persistSnapshots();
			}
			// Release the waiters after that decision, and even for a task a newer
			// run replaced: an attached wait must always end.
			settleForeground(task, { exitCode: task.exitCode, kind: "exited", status: task.status });
			settleTaskWait(task, { kind: "settled" });
		};
		const written = taskLogs.flush(task.logFile);
		if (written) void written.then(settle);
		else settle();
	};

	// Orphan-running tasks (status=
	// running, child=null, restored=true) need a liveness watcher.
	// When the recorded pid eventually disappears, finalize and emit
	// the canonical exit wake so the silent stall does not survive Pi
	// dying mid-bg_task.
	let orphanWatcher: OrphanWatcher | null = null;
	const ensureOrphanWatcher = () => {
		if (orphanWatcher) return;
		orphanWatcher = createOrphanWatcher({
			getTasks: () => tasks.values(),
			hooks: lifecycleHooks,
			unitActiveProbe: defaultSystemdUnitActive,
			onFinalize: (task, reason) => {
				clearRunningMarker(task);
				// A rehydrated orphan has no process left to flush and no writer queue
				// of its own, so the retained log already is the terminal output and no
				// bytes were dropped in this process. The canonical lifecycle already
				// persisted the close; record readiness and persist once more so a
				// restored snapshot cannot read as finalizing forever.
				completeResultFinalization(task, true);
				notifyTerminal(task);
				rememberSnapshot(task);
				persistSnapshots();
				// Orphan finalizes bypass finalizeTask, so resolve an attached
				// bounded wait here; the exit-wake suppression itself already
				// happened inside finalizeTaskLifecycle while the waiter was
				// still attached.
				settleTaskWait(task, { kind: "settled" });
				logBackgroundDiagnostic("orphan task finalized", { id: task.id, pid: task.pid, reason, status: task.status });
			},
		});
		orphanWatcher.start();
	};

	// Replay 'exit' wakeups for any task we restored in a terminal state
	// without ever notifying the agent. The canonical failure path: a long-
	// running session_shutdown or a mid-session restore coerced status
	// running->stopped (restoredTaskFromSnapshot) and the agent never saw
	// the exit. Without this replay the bg_task silently stalls.
	//
	// Restored tasks whose process is still alive remain status='running'
	// (handled by restoredTaskFromSnapshot) and are skipped by
	// selectMissedExits, so kill -9 / OOM with an orphaned-but-alive child
	// does not get a fake exit.
	const replayMissedExits = () => {
		const replayed = replayMissedExitsLifecycle(tasks.values(), lifecycleHooks);
		if (replayed > 0) {
			logBackgroundDiagnostic("replayed missed exit wakes", { replayed, session: activeSessionId ?? "unknown" });
		}
	};

	// A non-null result is the log writer's hold: the task's output should
	// pause until it resolves.
	const appendLogLine = (task: ManagedTask, text: string): Promise<void> | null =>
		taskLogs.append(task.logFile, text);

	const resourceControlFallbackWarned = new Set<string>();
	const warnResourceControlFallback = (message: string, cwd?: string) => {
		if (!settingBoolean("resourceControlWarnOnFallback", true, cwd)) return;
		if (resourceControlFallbackWarned.has(message)) return;
		resourceControlFallbackWarned.add(message);
		logBackgroundDiagnostic(message);
		activeCtx?.ui.notify?.(message, "warning");
	};

	type KillTaskResult = { error?: string; sent: boolean };

	const killTaskProcess = (task: ManagedTask, signal: NodeJS.Signals): KillTaskResult => {
		const resourceStop = stopResourceControlledTask(task.resourceControl, signal);
		if (resourceStop.attempted && resourceStop.ok) return { sent: true };
		if (resourceStop.attempted && !resourceStop.ok) {
			const error = resourceStop.error ?? "resource-control stop failed";
			appendLogLine(task, `\n[resource-control stop error] ${error}\n`);
			return { error, sent: false };
		}
		if (task.pid <= 0) {
			return { sent: false };
		}
		try {
			if (process.platform === "win32") {
				process.kill(task.pid, signal);
			} else {
				// We spawn detached on Unix, so -pid targets the task process group.
				process.kill(-task.pid, signal);
			}
			return { sent: true };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ESRCH") appendLogLine(task, `\n[kill error] ${String(error)}\n`);
			return resourceStop.attempted
				? { error: resourceStop.error ?? String(error), sent: false }
				: { sent: false };
		}
	};

	const requestStop = (
		task: ManagedTask | null,
		reason: "user" | "timeout" | "shutdown" = "user",
		author: "agent" | "operator" = "agent",
	): { ok: boolean; message: string } => {
		if (!task) return { ok: false, message: "No background task matched that id or pid." };
		if (task.status !== "running") {
			return { ok: true, message: `${task.id} is already ${summarizeTaskStatus(task.status, task.exitCode, task.terminationReason)}.` };
		}

		task.stopReason = reason;
		// stamp terminationReason eagerly so when the child's
		// close handler later calls closeTaskLifecycle the annotation
		// is already in place. session_shutdown calls requestStop with
		// reason="shutdown" so the two paths land on distinct values.
		// The author decides the wake, not the reason: an agent-authored stop is
		// already reported by the stop tool result, while a stop the agent did not
		// author (dashboard key, /bg:stop) voids a task the agent may still be
		// waiting on — that one must reach it.
		if (reason === "user") task.terminationReason = author === "operator" ? "cancelled-by-user" : "extension-stop";
		else if (reason === "shutdown") task.terminationReason = "session-shutdown";
		else if (reason === "timeout") task.terminationReason = "timeout";
		task.updatedAt = Date.now();
		voidPendingTaskWakes(task, reason === "shutdown" ? "shutdown" : "stop", logWakeDiagnostic);
		rememberSnapshot(task);
		if (task.outputTimer) clearTimeout(task.outputTimer);
		task.outputTimer = null;
		persistSnapshots();

		// Bound the command preview embedded in the stop message so a 100KB
		// heredoc command cannot leak into the bg_task/bg_status stop tool
		// result content.
		const safeCommand = truncateForTranscript(task.command, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "";

		const stopResult = killTaskProcess(task, "SIGTERM");
		if (!stopResult.sent) {
			if (stopResult.error) {
				task.stopReason = null;
				task.terminationReason = undefined;
				task.updatedAt = Date.now();
				rememberSnapshot(task);
				persistSnapshots();
				refreshUi();
				return { ok: false, message: `Failed to stop ${task.id}: ${stopResult.error}` };
			}
			finalizeTask(task, task.exitCode, reason === "timeout" ? "timed_out" : "stopped");
			return { ok: true, message: `Stopped ${task.id} (${safeCommand}).` };
		}

		const forceKillGraceMs = settingNumber("forceKillGraceMs", DEFAULT_FORCE_KILL_GRACE_MS, activeCtx?.cwd);
		task.forceKillTimer = setTimeout(() => {
			if (task.status === "running" && !task.closed) {
				appendLogLine(task, `\n[stop] Escalating to SIGKILL after ${formatDuration(forceKillGraceMs)}.\n`);
				killTaskProcess(task, "SIGKILL");
			}
		}, forceKillGraceMs);
		task.forceKillTimer.unref?.();
		refreshUi();
		return { ok: true, message: `Stopping ${task.id} (${safeCommand}).` };
	};

	const managedBashYieldMs = (cwd?: string): number =>
		Math.max(0, Math.floor(settingNumber("foregroundYieldMs", DEFAULT_FOREGROUND_YIELD_MS, cwd)));

	// Mirror Pi's built-in bash env contract: inherited env plus the
	// per-command session/model variables from the executing context. The five
	// PI_* session keys are deleted first so an inherited shell value cannot
	// shadow the live session. Never persisted (no snapshot field).
	const managedBashEnv = (ctx: ExtensionContext): NodeJS.ProcessEnv => {
		let sessionId: string | undefined;
		let sessionFile: string | undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
			sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined;
		} catch {
			// Session metadata is best-effort; the command still runs.
		}
		const model = ctx.model as { id?: string; provider?: string } | undefined;
		return buildManagedBashEnv(taskEnv(ownLaneDir(), { sessionId: activeSessionId ?? `ephemeral-${process.pid}`, socketPath: bridgeSocketPathFor() }), {
			sessionId,
			sessionFile,
			provider: model?.provider,
			model: model?.id,
			reasoningLevel: ctx.thinkingLevel,
		});
	};

	// Single-owner settle: the first caller wins and clears the pending yield
	// timer, so a later close or yield can never deliver a second outcome.
	const settleForeground = (task: ManagedTask, outcome: ForegroundOutcome): boolean =>
		settleForegroundWaiter(task.foregroundWaiter, outcome);

	// Single-owner settle for a bounded bg_task wait. Unlike the managed-Bash
	// foreground waiter, ending the wait never signals the task's process.
	const settleTaskWait = (task: ManagedTask, outcome: TaskWaitOutcome): boolean =>
		settleTaskWaitWaiter(task.taskWaiter, outcome);

	// Bounded soft wait. Resolves "yielded" after yieldMs without signalling
	// the child; a finalize before the timer wins resolves "exited". A task
	// that finalized before the wait attached resolves immediately with its
	// terminal state so no wake is ever retried for it.
	const waitForForeground = (task: ManagedTask, yieldMs: number): Promise<ForegroundOutcome> => {
		const waiter = task.foregroundWaiter;
		if (!waiter) {
			return Promise.resolve({ exitCode: task.exitCode, kind: "exited", status: task.status });
		}
		if (waiter.settled) {
			return Promise.resolve(waiter.outcome ?? { exitCode: task.exitCode, kind: "exited", status: task.status });
		}
		return new Promise((resolve) => {
			waiter.resolve = resolve;
			const timer = setTimeout(() => {
				settleForeground(task, { exitCode: null, kind: "yielded", status: "running" });
			}, Math.max(0, yieldMs));
			timer.unref?.();
			waiter.yieldTimer = timer;
		});
	};

	const managedBashOutputTail = (task: ManagedTask, cwd?: string): string =>
		tailText(getTaskOutput(task).trim(), settingNumber("logTailMaxChars", DEFAULT_LOG_TAIL_MAX_CHARS, cwd));

	// Render-ready view of the task's *current* state. The transcript row keeps
	// its place, but status, exit code and tail always come from the live task,
	// so a row that yielded as "running" later expands to the finished output.
	const managedBashRowFor = (task: ManagedTask, cwd?: string): ManagedBashPresentation.ManagedBashRowTask => {
		const output = getTaskOutput(task);
		return {
			elapsedMs: (task.status === "running" ? Date.now() : task.updatedAt) - task.startedAt,
			exitCode: task.exitCode,
			id: task.id,
			lineCount: output.trim() ? output.replace(/\r?\n+$/, "").split(/\r?\n/).length : 0,
			logFile: task.logFile,
			status: task.status,
			tail: managedBashDisplayTail(task, cwd),
		};
	};

	const managedBashDisplayTail = (task: ManagedTask, cwd?: string): string =>
		tailText(getTaskOutput(task).trim(), settingNumber("logTailMaxChars", DEFAULT_LOG_TAIL_MAX_CHARS, cwd));

	const formatManagedBashCompletion = (task: ManagedTask, elapsedMs: number, cwd?: string): string =>
		formatManagedBashCompletionText({
			elapsedText: formatDuration(elapsedMs),
			id: task.id,
			outputTail: managedBashOutputTail(task, cwd),
			statusText: summarizeTaskStatus(task.status, task.exitCode, task.terminationReason),
		});

	const formatManagedBashRunning = (task: ManagedTask, elapsedMs: number, cwd?: string): string =>
		formatManagedBashRunningText({
			elapsedText: formatDuration(elapsedMs),
			id: task.id,
			outputTail: managedBashOutputTail(task, cwd),
			pid: task.pid,
		}, taskToolSurface);

	/**
	 * Pi's own bash tool definition, typed from the module's export without
	 * importing it. Resolved when a script first calls bash, so a Pi whose module
	 * graph differs reaches this path only when it is actually used.
	 */
	type PiBashDefinition = ReturnType<(typeof import("@earendil-works/pi-coding-agent"))["createBashToolDefinition"]>;
	let piBashDefinition: PiBashDefinition | undefined;

	/**
	 * Bash a codemode script launched: `await tools.bash({ command })`. A script
	 * only ever sees its own result, so a yielded task would keep running with a
	 * wake nobody can receive, and the script's deadline would cancel it midway.
	 * The call runs to completion through Pi's own bash tool instead — the same
	 * command, foreground timeout, abort, output truncation, and structured
	 * result this tool declares (`BASH_OUTPUT_SCHEMA`). Nothing spawns a managed
	 * task, so there is no task log, snapshot, or wake.
	 *
	 * Pi's definition is resolved on first use rather than imported at load time,
	 * so a Pi without this export fails the call a script made, not the extension.
	 */
	const runScriptBash = async (
		toolCallId: string,
		params: { command?: unknown; timeout?: unknown },
		signal: AbortSignal | undefined,
		onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<unknown>> => {
		const command = typeof params?.command === "string" ? params.command : "";
		if (!command.trim()) throw new Error("command is required");
		recordProjectTrust(ctx);
		if (shouldAdoptActiveContext(activeCtx, ctx)) activeCtx = ctx;
		const definition = (piBashDefinition ??= (await import("@earendil-works/pi-coding-agent")).createBashToolDefinition(ctx.cwd ?? process.cwd()));
		// `timeout` is Pi's own: seconds, absent means no hard kill, and Pi rejects
		// a non-positive value itself.
		return definition.execute(
			toolCallId,
			{ command, ...(params.timeout === undefined ? {} : { timeout: params.timeout as number }) },
			signal,
			onUpdate,
			ctx,
		) as Promise<AgentToolResult<unknown>>;
	};

	const runManagedBash = async (
		params: { command?: unknown; timeout?: unknown },
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		onUpdate?: (partial: AgentToolResult<unknown>) => void,
	): Promise<AgentToolResult<unknown>> => {
		const command = typeof params?.command === "string" ? params.command : "";
		if (!command.trim()) throw new Error("command is required");
		recordProjectTrust(ctx);
		if (shouldAdoptActiveContext(activeCtx, ctx)) activeCtx = ctx;

		const timeoutSeconds = normalizeManagedBashTimeoutSeconds(params.timeout);
		const yieldMs = managedBashYieldMs(ctx.cwd);
		const task = spawnTask({
			command,
			cwd: ctx.cwd,
			env: managedBashEnv(ctx),
			foregroundYieldMs: yieldMs,
			notifyOnExit: true,
			origin: "managed-bash",
			timeoutSeconds,
		});
		const onAbort = () => {
			settleForeground(task, { exitCode: null, kind: "aborted", status: "running" });
			requestStop(task, "user");
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// Stream the bounded tail while the command is still inside its
			// foreground window so the row behaves like a normal bash call.
			// Updates fire only when the tail actually grows.
			let lastPartialTail = "";
			const partialTimer = onUpdate
				? setInterval(() => {
					try {
						if (task.status !== "running") return;
						const tail = managedBashDisplayTail(task, ctx.cwd);
						if (tail === lastPartialTail) return;
						lastPartialTail = tail;
						onUpdate({
							content: [{ type: "text", text: tail }],
							details: { action: "bash", task: compactBackgroundTaskSnapshot(rememberSnapshot(task)) },
						});
					} catch {
						// Partial rendering is best-effort; the final result still lands.
					}
				}, MANAGED_BASH_PARTIAL_UPDATE_MS)
				: null;
			partialTimer?.unref?.();
			const outcome = await (async () => {
				try {
					return await waitForForeground(task, yieldMs);
				} finally {
					if (partialTimer) clearInterval(partialTimer);
				}
			})();
			if (outcome.kind === "aborted") throw new Error("Operation aborted");
			const elapsedMs = Date.now() - task.startedAt;
			const details = { action: "bash", task: compactBackgroundTaskSnapshot(rememberSnapshot(task)) };
			if (outcome.kind === "exited") {
				// A command that finished inside its foreground window was never a
				// background task: the model gets its stdout, and any non-clean end
				// throws, exactly like the built-in bash tool.
				const rawText = getTaskOutput(task) || "(no output)";
				if (task.status === "timed_out") {
					throw new Error(`${rawText}\n\nCommand timed out after ${timeoutSeconds} seconds`);
				}
				if (task.status === "cancelled") throw new Error(`${rawText}\n\nCommand aborted`);
				// A signal-killed command ends without an exit code, and Pi's own bash
				// reports exactly that: "Command terminated without an exit code".
				// Returning it as success would tell a programmatic caller that a failed
				// command exited 0.
				const exitCode = task.exitCode;
				if (typeof exitCode !== "number") {
					throw new Error(`${rawText}\n\nCommand terminated without an exit code`);
				}
				if (exitCode !== 0) {
					throw new Error(`${rawText}\n\nCommand exited with code ${exitCode}`);
				}
				return makeToolResult(rawText, details, managedBashStructuredContent(task, exitCode, elapsedMs, rawText));
			}
			return makeToolResult(formatManagedBashRunning(task, elapsedMs, ctx.cwd), details);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};

	/**
	 * Bounded `bg_task action:"wait"` attachment. A terminal task returns its
	 * terminal status and bounded output immediately; a running task attaches
	 * one waiter that resolves on task settlement, window expiry, a queued
	 * user message, or tool abort. Only a settlement is consumed by the wait
	 * (the async exit wake is suppressed to keep one owner); expiry, steer,
	 * and abort return Running/abort and leave the completion wake armed. A
	 * second concurrent wait for the same task is rejected. Nothing here
	 * starts, stops, or re-waits for the task.
	 */
	/** Oldest running task, for id-less waits: `bg_task wait` with no target. */
	const oldestRunningTask = (): ManagedTask | null => {
		let oldest: ManagedTask | null = null;
		for (const task of tasks.values()) {
			if (task.status !== "running") continue;
			if (!oldest || task.startedAt < oldest.startedAt) oldest = task;
		}
		return oldest;
	};

	const waitForTask = async (
		task: ManagedTask,
		waitSecondsInput: unknown,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> => {		const waitSeconds = clampTaskWaitSeconds(
			waitSecondsInput,
			settingNumber("taskWaitDefaultSeconds", DEFAULT_TASK_WAIT_SECONDS, ctx.cwd),
			settingNumber("taskWaitMaxSeconds", MAX_TASK_WAIT_SECONDS, ctx.cwd),
		);
		const details = () => ({ action: "wait", task: compactBackgroundTaskSnapshot(rememberSnapshot(task)) });
		if (task.status !== "running") {
			// The terminal result IS the delivery: drop any exit wake that was
			// deferred while this turn was in flight, otherwise the agent gets
			// pinged at turn end for a result this call already handed it. The
			// preparation lease keeps retention from pruning the task mid-read.
			consumeObservedExitWake(task.id);
			// This wait's result is an actual handoff of the terminal result —
			// eligibility decided by the centralized rule: certified delivers,
			// unrecoverable delivers as `error`, a still-flushing capture
			// records nothing (openspec tasks 2.2-2.3). A wait that returns a
			// still-running task below resolves nothing either.
			recordResultResolution(task, resultResolutionForDelivery(observeTaskResult(task)));
			const text = withResultPreparationLease(task, () => formatManagedBashCompletion(task, Date.now() - task.startedAt, ctx.cwd));
			return makeToolResult(text, details());
		}
		const active = task.taskWaiter;
		if (active && active.attached && !active.settled) {
			throw new Error(`A bounded wait is already active for ${task.id}; await its result or the automatic completion wake instead of starting another wait.`);
		}
		// A Running result reports how long this wait was attached, not how
		// old the task is: waiting once on a long-running task must not
		// present the task's whole lifetime as the wait duration.
		const waitStartedAt = Date.now();
		const waiter = createTaskWaitWaiter();
		task.taskWaiter = waiter;
		const waitPromise = new Promise<TaskWaitOutcome>((resolve) => {
			waiter.resolve = resolve;
			const expiryTimer = setTimeout(() => {
				settleTaskWaitWaiter(waiter, { kind: "expired" });
			}, Math.max(0, waitSeconds) * 1_000);
			expiryTimer.unref?.();
			waiter.expiryTimer = expiryTimer;
			const pollTimer = setInterval(() => {
				if (!waiter.attached) return;
				let pending = false;
				try {
					pending = ctx.hasPendingMessages();
				} catch {
					pending = false;
				}
				if (pending) settleTaskWaitWaiter(waiter, { kind: "pending-message" });
			}, TASK_WAIT_PENDING_POLL_MS);
			pollTimer.unref?.();
			waiter.pollTimer = pollTimer;
		});
		const onAbort = () => { settleTaskWaitWaiter(waiter, { kind: "aborted" }); };
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const outcome = await waitPromise;
			if (outcome.kind === "aborted") throw new Error("Operation aborted");
			if (task.status !== "running") {
				// Terminal delivery keeps total task age; only the Running
				// text below is scoped to the wait attachment. Eligibility for
				// the durable resolution follows the centralized rule (tasks
				// 2.2-2.3): certified → delivered, unrecoverable → error,
				// still-flushing → nothing recorded.
				recordResultResolution(task, resultResolutionForDelivery(observeTaskResult(task)));
				return makeToolResult(formatManagedBashCompletion(task, Date.now() - task.startedAt, ctx.cwd), details());
			}
			return makeToolResult(
				formatTaskWaitRunningText({
					elapsedText: formatDuration(Date.now() - waitStartedAt),
					id: task.id,
					outputTail: managedBashOutputTail(task, ctx.cwd),
					pid: task.pid,
					waitSeconds,
				}),
				details(),
			);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};

	/** One-line inventory of other running tasks for wake payloads. */
	const runningInventory = (): string => {
		const running = [...tasks.values()].filter((t) => t.status === "running" && t.stopReason == null).map((t) => t.id);
		return running.length === 0
			? "No other background tasks are running."
			: `Tasks still running: ${running.join(", ")}. You will be woken once each; no polling needed.`;
	};

	/**
	 * Sends every pending exit wake as one message. Deliverability is Pi's
	 * concern now: with followUpMode "all" Pi drains queued follow-ups as a
	 * single prompt, so a wake sent while another is queued still reaches the
	 * agent merged, not stacked.
	 */
	const flushDeferredExitWakes = (): void => {
		if (deferredExitWakes.size === 0) return;
		const pending = [...deferredExitWakes.entries()];
		deferredExitWakes.clear();
		const finished = pending
			.map(([id]) => tasks.get(id))
			.filter((task): task is ManagedTask => Boolean(task && task.status !== "running"));
		if (finished.length === 0) return;
		if (finished.length === 1) {
			const task = finished[0]!;
			// Options come from the pending entry: the map was cleared above, so
			// reading it back here would silently drop the event timestamp and
			// sequence the wake payload carries.
			const options = pending.find(([id]) => id === task.id)?.[1] ?? {};
			const sent = sendTaskWake({
				...wakeSend,
				isShuttingDown: () => shuttingDown,
				logDiagnostic: logWakeDiagnostic,
				messageType: BG_MESSAGE_TYPE,
				surface: () => taskToolSurface,
				outputTail: (target) => tailText(getTaskOutput(target), settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS, activeCtx?.cwd)),
				rememberSnapshot,
				runningInventory,
				exitMandatory: exitWakeIsMandatory,
			}, "exit", task, options);
			// The send is the delivery: acknowledge through the shared entry point so
			// a restart cannot replay a wake the agent already received.
			if (sent) ackCompletion(task, "host-notification");
			return;
		}
		// Grouped wake: several mid-turn completions become one message.
		const summaries = finished.map((task) => {
			const exit = task.exitCode ?? 0;
			const status = exit === 0 ? "exit 0" : `exit ${exit}`;
			return `${task.id} · ${status} · ${compactText(task.command, 60)}`;
		});
		const failures = finished.filter((task) => (task.exitCode ?? 0) !== 0);
		const content = [
			`${finished.length} background tasks finished.`,
			...summaries.map((line) => `• ${line}`),
			failures.length > 0
				? `${failures.length} failed: ${taskSurfaceGuidance(taskToolSurface).reviewFailures}.`
				: "If these results are already consumed, nothing more to do; stop lingering tasks with bg_task stop.",
			runningInventory(),
		].join("\n");
		deliverWakeMessage(
			wakeSend,
			{ customType: BG_MESSAGE_TYPE, content, display: true, details: { grouped: true, tasks: finished.map((t) => compactBackgroundTaskSnapshot(t)) } },
			{ deliverAs: "followUp", triggerTurn: true },
		);
		// One message named every task in the batch, so every obligation it
		// fulfilled is recorded. An idle-batched completion never carried this
		// record before, which left it replay-eligible after a restart.
		for (const task of finished) ackCompletion(task, "host-notification");
	};

	/**
	 * End-of-run inventory: the agent is about to hand control back, so if tasks
	 * are still running say so once. No task is killed automatically — stopping
	 * is the agent's call via bg_task stop.
	 */
	const announceRunningTasks = (): void => {
		const running = [...tasks.values()].filter((t) => t.status === "running" && t.stopReason == null);
		if (running.length === 0 || shuttingDown) return;
		const list = running.map((t) => `${t.id} (${compactText(t.command, 48)})`).join(", ");
		pi.sendMessage(
			{
				customType: BG_MESSAGE_TYPE,
				content: `${running.length} background task${running.length === 1 ? "" : "s"} still running: ${list}. Completions will wake you; nothing needs polling.`,
				display: false,
			},
			{ triggerTurn: false },
		);
	};

	/**
	 * Drops a deferred/idle exit wake because the agent already observed the
	 * task's result through a declared operation (bg_task get/log/wait/stop).
	 * Returns true when this process was actually holding one, which is also when
	 * the shared acknowledgment is recorded: observing an already-acknowledged
	 * task changes nothing.
	 */
	const consumeObservedExitWake = (taskId: string): boolean => {
		const task = tasks.get(taskId);
		const held = cancelHeldCompletionWake(taskId);
		if (!held || !task) return false;
		ackCompletion(task, "retrieval", { cancelHeld: false });
		return true;
	};

	/**
	 * Tasks whose normalized command matches the candidate's. Exact matches come
	 * first so the ack can say "identical" when it is; "similar" covers prefix/
	 * substring overlap (e.g. the same suite with a different tail command).
	 */
	const similarRunningTasks = (command: string): { identical: ManagedTask[]; similar: ManagedTask[] } => {
		const normalized = normalizedCommand(command).toLowerCase();
		if (!normalized) return { identical: [], similar: [] };
		const identical: ManagedTask[] = [];
		const similar: ManagedTask[] = [];
		for (const task of tasks.values()) {
			if (task.status !== "running") continue;
			const other = normalizedCommand(task.command).toLowerCase();
			if (other === normalized) identical.push(task);
			else if (other.includes(normalized) || normalized.includes(other)) similar.push(task);
		}
		return { identical, similar };
	};

	/**
	 * Same command in the same cwd that finished recently. Sequential reruns do
	 * not trip the running-task check, yet re-running a whole suite after one
	 * edit is the usual waste; the ack mentions the previous run so the agent can
	 * read that log or rerun only the failing file.
	 */
	const recentlyFinishedTasks = (command: string, cwd: string): ManagedTask[] => {
		const normalized = normalizedCommand(command).toLowerCase();
		if (!normalized) return [];
		const cutoff = Date.now() - RECENT_RERUN_WINDOW_MS;
		const recent: ManagedTask[] = [];
		for (const task of tasks.values()) {
			if (task.status === "running" || task.updatedAt < cutoff) continue;
			if (task.cwd !== cwd) continue;
			const other = normalizedCommand(task.command).toLowerCase();
			if (other === normalized) recent.push(task);
		}
		return recent;
	};

	const spawnTask = (options: SpawnTaskOptions): ManagedTask => {
		const command = options.command.trim();
		if (!command) throw new Error("command is required for background task spawn");

		const cwd = options.cwd?.trim() || activeCtx?.cwd || process.cwd();
		const id = `bg-${++taskCounter}`;
		const now = Date.now();
		const timeoutSeconds = typeof options.timeoutSeconds === "number" ? options.timeoutSeconds : settingNumber("defaultTimeoutSeconds", DEFAULT_TIMEOUT_MS / 1_000, cwd);
		// Hard `timeoutSeconds` and soft `softTimeoutMs` are separate budgets: the
		// hard one kills, the soft one only reminds.
		const softTimeoutMs = typeof options.softTimeoutMs === "number"
			? Math.max(0, Math.floor(options.softTimeoutMs))
			: Math.max(0, Math.floor(settingNumber("defaultSoftTimeoutMs", DEFAULT_SOFT_TIMEOUT_MS, cwd)));
		const expiresAt = timeoutSeconds > 0 ? now + timeoutSeconds * 1_000 : null;
		// The first review is due one interval after the start; every later one is
		// measured from the last review (see task-result.ts reviewDeadlineFor).
		const softExpiresAt = reviewDeadlineFor({ softTimeoutMs, startedAt: now });
		const laneDir = openLaneDir(ownLaneDir(), activeCtx?.cwd ?? cwd);
		const logFile = logFilePath(laneDir, id, now);
		writeFileSync(logFile, "");

		const { shell, args } = getShellConfig();
		const spawnPlan = planResourceControlledSpawn({
			command,
			cwd,
			shell,
			shellArgs: pipefailShellArgs(shell, args, cwd),
			taskId: id,
			now,
			origin: options.origin ?? "bg_task",
		});
		for (const warning of spawnPlan.warnings) warnResourceControlFallback(warning, cwd);
		// kendex#97 hardening: spawn the child in its own session / process
		// group via `detached: true` (Node calls setsid() on POSIX before
		// exec). This protects against two signal paths:
		//
		//   H1 (process-group / parent-death cascade): when Pi exits or is
		//   restarted, the kernel does NOT propagate SIGHUP / SIGTERM to
		//   the child because it lives in a separate pgid that is not tied
		//   to Pi's controlling terminal or session. PR_SET_PDEATHSIG is 0
		//   by default on Linux for non-prctl'd children, so the child is
		//   not signaled on parent death even without setsid — setsid is
		//   the belt-and-braces protection that also covers macOS / BSD.
		//
		//   H3 (session-leader cascade): if Pi was attached to a tmux pane
		//   that subsequently died, SIGHUP would propagate through Pi's
		//   session leader to every process group in the same session.
		//   detached: true makes the child its own session leader so the
		//   cascade stops at Pi's pgid.
		//
		// We do NOT call child.unref() here because we still rely on the
		// child handle for stdout/stderr piping and close-event delivery;
		// the detached flag only affects session/pgid membership, not
		// whether the parent waits for the child during normal operation.
		const child = spawn(spawnPlan.file, spawnPlan.args, {
			cwd,
			detached: process.platform !== "win32",
			env: options.env ?? taskEnv(laneDir, { sessionId: activeSessionId ?? `ephemeral-${process.pid}`, socketPath: bridgeSocketPathFor() }),
			stdio: ["ignore", "pipe", "pipe"],
		});

		const spawnedPid = child.pid ?? 0;
		const task: ManagedTask = {
			child,
			closed: false,
			command,
			cwd,
			exitCode: null,
			exitNotified: false,
			resourceControl: spawnPlan.metadata,
			sessionId: activeSessionId ?? undefined,
			expiresAt,
			softExpiresAt,
			softTimeoutNotified: false,
			softTimeoutMs,
			lastReviewedAt: undefined,
			reviewedOutputBytes: undefined,
			reviewRevision: 0,
			resultReady: false,
			forceKillTimer: null,
			foregroundWaiter: options.foregroundYieldMs != null ? createForegroundWaiter() : null,
			taskWaiter: null,
			id,
			lastAnnouncedLength: 0,
			lastOutputAt: null,
			logFile,
			matcher: parseOutputMatcher(options.notifyPattern),
			notifyOnExit: options.notifyOnExit ?? true,
			notifyOnOutput: options.notifyOnOutput ?? false,
			notifyPattern: options.notifyPattern?.trim() || undefined,
			notifyMode: resolveNotifyMode(options.notifyMode, options.notifyPattern),
			origin: options.origin ?? "bg_task",
			// Task → assignment association (openspec tasks 2.1): every spawn
			// inherits the currently bound accepted assignment, or none when
			// nothing is bound yet. Written once; never rewritten.
			assignmentRequestId: boundAssignment ?? undefined,
			dedupeKey: options.dedupeKey?.trim() || undefined,
			output: "",
			outputBytes: 0,
			wakeSequence: 0,
			wakeEvents: [],
			voidedWakeSequences: [],
			voidedWakes: new Set<number>(),
			pendingWakes: [],
			lastOutputDedupeHash: undefined,
			lastOutputDedupeByKey: {},
			outputPatternMatched: false,
			outputWakeBudget: emptyOutputWakeBudget(),
			outputTimer: null,
			pid: spawnedPid,
			startedAt: now,
			status: "running",
			stopReason: null,
			terminationReason: undefined,
			timeoutTimer: null,
			softTimeoutTimer: null,
			title: options.title?.trim() || command,
			updatedAt: now,
		};
		tasks.set(task.id, task);
		bumpSettlementRevision();
		markTaskRunning(task);
		// Supersede older runs of the identical command in the same cwd. Two
		// identical commands cannot both inform a decision: the older result
		// arrives after the agent has already moved to the newer one, which is
		// exactly the shape that produced a wake turn per dead build (bg-108/
		// 158/160/167). The older task keeps running and stays listed — only its
		// exit wake is dropped.
		const normalizedNew = normalizedCommand(task.command).toLowerCase();
		if (normalizedNew) {
			for (const other of tasks.values()) {
				if (other.id === task.id || other.status !== "running" || other.stopReason != null) continue;
				if (other.cwd !== task.cwd) continue;
				if (normalizedCommand(other.command).toLowerCase() !== normalizedNew) continue;
				other.supersededBy = task.id;
				rememberSnapshot(other);
			}
		}
		rememberSnapshot(task);
		persistSnapshots();
		publishBackgroundTaskStarted(task);
		// The identity lets a later restore tell this process from a reused
		// pid; it rides the next windowed persist, and every lifecycle persist
		// and session_shutdown flush it. A task cleared or replaced before the
		// read resolves stays forgotten. An identity the read could not answer
		// stays unset, so restore falls back to pid-only liveness.
		if (spawnedPid > 0) {
			void defaultReadProcessIdentity(spawnedPid).then((reading) => {
				if (tasks.get(task.id) !== task) return;
				switch (reading.kind) {
					case "identity":
						task.procIdent = reading.identity;
						rememberSnapshot(task);
						persistSoon.request();
						return;
					case "alive":
					case "gone":
						return;
					case "unknown":
						logBackgroundDiagnostic("spawn identity unknown", { id: task.id, pid: spawnedPid, reason: reading.reason });
						return;
					default: {
						const unreachable: never = reading;
						throw new Error(`unknown identity reading: ${JSON.stringify(unreachable)}`);
					}
				}
			});
		}

		const handleChunk = (chunk: Buffer) => {
			const text = chunk.toString();
			task.updatedAt = Date.now();
			task.lastOutputAt = task.updatedAt;
			task.outputBytes += chunk.byteLength;
			task.output += text;
			const trimmed = trimOutputBuffer(task.output, task.lastAnnouncedLength);
			task.output = trimmed.output;
			task.lastAnnouncedLength = trimmed.lastAnnouncedLength;
			const hold = appendLogLine(task, text);
			if (hold) {
				// The log's writes fell behind: stop reading until they settle
				// or one stalls, so the child blocks on its pipe meanwhile.
				child.stdout?.pause();
				child.stderr?.pause();
				void hold.then(() => {
					child.stdout?.resume();
					child.stderr?.resume();
				});
			}
			scheduleOutputReaction(task);
			outputUiRefresh.request();
		};

		child.stdout?.on("data", handleChunk);
		child.stderr?.on("data", handleChunk);
		child.on("close", (code) => finalizeTask(task, typeof code === "number" ? code : null));
		child.on("error", (error) => {
			handleChunk(Buffer.from(`\n[spawn error] ${error.message}\n`));
			finalizeTask(task, 1, "failed");
		});

		scheduleSoftTimeout(task);

		if (expiresAt != null) {
			task.timeoutTimer = setTimeout(() => {
				appendLogLine(task, `\n[timeout] Background task exceeded ${formatDuration(timeoutSeconds * 1_000)}.\n`);
				requestStop(task, "timeout");
			}, Math.max(1, timeoutSeconds * 1_000));
			task.timeoutTimer.unref?.();
		}

		refreshUi();
		return task;
	};

	const clearFinishedTasks = (): { removed: number; kept: number } => {
		let removed = 0;
		let kept = 0;
		for (const task of [...tasks.values()]) {
			if (task.status === "running") continue;
			// An assignment-owned terminal result that was never delivered is
			// outstanding evidence, not finished clutter (openspec tasks 2.1-2.2):
			// `clear` skips it so an explicit clear can never turn owned outstanding
			// work into apparent completion. Resolved history and unassociated tasks
			// clear as before; retrieve the kept task (get/stop) to clear it after.
			if (task.assignmentRequestId !== undefined && !resultIsResolved(task)) {
				kept += 1;
				continue;
			}
			forgetFinishedTask(task);
			removed += 1;
		}
		persistSnapshots();
		refreshUi();
		return { removed, kept };
	};

	const formatTaskListText = (): string => {
		const sorted = sortedTasks();
		if (sorted.length === 0) return "No background tasks.";
		return sorted.map((task) => buildTaskSummaryLine(taskSnapshot(task))).join("\n\n");
	};

	const resolveTask = (id?: string, pid?: number): ManagedTask | null =>
		resolveTaskByToken<ManagedTask>(tasks.values(), id ?? pid);

	const forcedBackgroundWindowMs = (cwd?: string): number =>
		Math.max(1_000, settingNumber("forcedBackgroundWindowSeconds", DEFAULT_FORCED_BACKGROUND_WINDOW_MS / 1_000, cwd) * 1_000);

	const consumeForcedBackground = (cwd?: string): boolean => {
		if (forceNextBashBackgroundAt == null) return false;
		if (Date.now() - forceNextBashBackgroundAt > forcedBackgroundWindowMs(cwd)) {
			forceNextBashBackgroundAt = null;
			return false;
		}
		forceNextBashBackgroundAt = null;
		return true;
	};

	const armForcedBackground = (ctx: ExtensionContext | ExtensionCommandContext, source: "shortcut" | "command") => {
		forceNextBashBackgroundAt = Date.now();
		const seconds = Math.max(1, Math.round(forcedBackgroundWindowMs(ctx.cwd) / 1_000));
		const sourceText = source === "shortcut" ? formatShortcutHint(backgroundBashShortcut) : `/${BG_COMMAND} next`;
		const note = ctx.isIdle?.()
			? `${sourceText} armed. Next bash command in the next ${seconds}s will start as a background task.`
			: `${sourceText} armed. Next not-yet-started bash command in this turn will start as a background task. Already-running bash cannot be detached safely.`;
		ctx.ui.notify(note, "info");
	};

	const decisionForBashCommand = (command: string, cwd?: string) => {
		if (!command.trim()) return null;
		if (consumeForcedBackground(cwd)) return forcedBackgroundDecision(command, cwd);
		if (!settingBoolean("autoBackgroundBash", true, cwd)) return null;
		return autoBackgroundDecision(command, cwd, taskToolSurface);
	};

	const dashboardDeps = {
		clearFinishedTasks,
		formatTaskListText,
		getTask: (id: string) => tasks.get(id) ?? null,
		getTaskOutput,
		requestStop: (task: ManagedTask | null, reason: "user", author?: "agent" | "operator") => requestStop(task, reason, author ?? "agent"),
		sortedTasks,
	};
	// The registration surface is built once and shared: `registerAll` uses it at
	// load and `session_start` uses it again to declare the mode's tool surface.
	const registrationDeps: RegistrationDeps = {
		getActiveCtx: () => activeCtx,
		setActiveCtx: (ctx) => { activeCtx = ctx; },
		rememberSnapshot,
		sortedTasks,
		formatTaskListText,
		getTaskOutput,
		resolveTask,
		requestStop: (task, _reason, author) => requestStop(task, "user", author ?? "agent"),
		readTaskResult: async (task, output) => {
			const handoff = await prepareTaskHandoff(task, output);
			// A handoff the caller cannot certify is still handed over — the surviving
			// bytes and the loss metadata are the truth — but it commits nothing, so a
			// short capture is never reported as a settled result.
			//
			// Handing that failure over IS a delivery of the result's final
			// state (openspec tasks 2.3): the centralized rule records `error`
			// for a terminal or restored-incomplete capture that will never
			// certify, so an assignment cannot be trapped awaiting a retrieval
			// that can never succeed. A running or still-flushing task's read
			// error is inspection, not a resolution, and records nothing.
			if (handoff.failure || handoff.captureError) {
				recordResultResolution(task, resultResolutionForDelivery(handoff.observation));
				return { handoff };
			}
			const ack = commitTaskHandoff(task, handoff.observation.readiness);
			// The observation describes the result *as handed over*, which is what
			// makes its changed-output indicator meaningful — a post-commit re-read is
			// always unchanged and would say nothing. The one field this handoff did
			// change is reported as it now stands, so the result cannot claim both that
			// the completion is settled and that it is still owed.
			return {
				ack,
				handoff: ack.committed === "terminal" ? { ...handoff, observation: { ...handoff.observation, completionOwed: false } } : handoff,
			};
		},
		stopTaskConfirmed: stopTaskForBridge,
		extendSoftTimeout,
		similarRunningTasks,
		recentlyFinishedTasks,
		spawnTask,
		oldestRunningTask,
		waitForTask,
		consumeObservedExitWake,
		clearFinishedTasks,
		armForcedBackground,
		toggleWidget: () => {
			toggleBackgroundWidgetVisibility(widgetVisibility);
			if (activeCtx) syncWidget(activeCtx);
		},
		dashboardDeps,
		dashboardShortcut,
		backgroundBashShortcut,
		widgetToggleShortcut,
	};


	pi.registerMessageRenderer(BG_MESSAGE_TYPE, (message, { expanded }, theme) => renderTaskEventMessage(message, expanded, theme));

	installSettingsCacheRefresh(pi);

	// A wake is a follow-up message: it cannot steer the run that is already in
	// flight, so holding it until the agent truly stops costs nothing and is the
	// only way several completions can arrive as ONE grouped wake.
	//
	// The flush boundary is agent_settled, NOT agent_end: agent_end closes one
	// low-level run, but retries, overflow recovery, compaction retry and
	// follow-up work continue after it (docs/json.md: "agent_settled means Pi
	// has no remaining automatic work"). A mid-run agent_end that folds
	// turnActive=false would push every later exit down the idle path, where the
	// wake is sent (after the 250ms debounce) before any later read can consume
	// it — the "wake arrived already consumed" failure.
	pi.on("agent_settled", () => {
		turnActive = false;
		flushDeferredExitWakes();
		announceRunningTasks();
	});
	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		recordProjectTrust(ctx);
		activeCtx = ctx;
		// The settlement provider is session-scoped: reset its restore state and
		// replace any live registration before restore, so a query during the
		// async restore window is answered by a current registration as
		// explicitly reconciling — never as absence or a stale answer. The
		// assignment binding and its protection are session-scoped state too:
		// after a restart nothing has been accepted yet, so a consumer must bind
		// (and re-protect) again while restore settles the map.
		boundAssignment = null;
		protectedAssignment = null;
		settlementRestore = { state: "pending" };
		settlementRegistration?.dispose();
		settlementRegistration = null;
		try {
			settlementRegistration = registerBackgroundWorkProvider(pi.events, settlementProvider);
		} catch (error) {
			// No registration beats a broken one: a consumer that expects this
			// provider then reads `missing` (fail closed), an ordinary session
			// keeps its normal lifecycle, and the failure stays on record.
			logBackgroundDiagnostic("background settlement provider registration failed", { error: error instanceof Error ? error.message : String(error) });
		}
		// The session mode is known only here, and it decides the declared tool
		// surface: the TUI gets `bg_task` with exactly spawn/get/stop/list and no
		// `bg_status`, while print/json/rpc/unknown keep the compatibility surface
		// with `bg_status` and the bounded wait. This runs before the first agent
		// turn, so no request is ever assembled against the wrong declaration.
		registerBashTool(taskToolSurface = applyTaskToolSurface(pi, registrationDeps, ctx.mode));
		const pruned = pruneLanes(taskLanesRoot());
		for (const failure of pruned.failed) logBackgroundDiagnostic("task log prune failed", { path: failure.path, error: failure.error });
		try {
			await restoreSnapshots(ctx);
			settlementRestore = { state: "done" };
		} catch (error) {
			// A failed restore must never read as an empty successful snapshot:
			// record the actionable failure, keep the registration (queries then
			// fail closed as provider error), and preserve the existing control
			// flow by rethrowing exactly as before.
			settlementRestore = { state: "failed", reason: `task snapshot restore failed: ${error instanceof Error ? error.message : String(error)}` };
			bumpSettlementRevision();
			throw error;
		}
		bumpSettlementRevision();
		replayMissedExits();
		if (boundFinishedTasks() > 0) persistSnapshots();
		// The declared CLI's endpoint comes up with the session, after restore, so
		// a `pi-bg` call can never observe a half-restored task map. A failure to
		// listen is reported rather than hidden: the CLI must say the endpoint is
		// unavailable instead of guessing at live state.
		await ensureBridge();
		// Restore just probed every task the watcher would check, so the first
		// pass waits one poll interval.
		ensureOrphanWatcher();
		syncWidget(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		turnActive = true;
		recordProjectTrust(ctx);
		activeCtx = ctx;
		syncWidget(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		activeCtx = ctx;
		syncWidget(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		activeCtx = ctx;
		syncWidget(ctx);
	});
	pi.on("session_shutdown", async () => {
		// Dispose the settlement registration first: a query arriving while the
		// task map is emptied must read absence (ordinary lifecycle), never a
		// half-torn-down snapshot from a stale registration.
		settlementRegistration?.dispose();
		settlementRegistration = null;
		// A script cannot outlive its session, so neither can its provenance.
		codemodeCallIds.clear();
		deferredExitWakes.clear();
		idleExitBatch.clear();
		delete interop[MANAGED_BASH_SYMBOL];
		flushIdleExitBatch();
		shuttingDown = true;
		// The endpoint answers from the live task map, so it closes before the map
		// is emptied; a client that arrives during shutdown gets an unavailable
		// endpoint rather than a stale answer.
		await stopBridge();
		orphanWatcher?.stop();
		orphanWatcher = null;
		outputUiRefresh.cancel();
		// Abort in-flight bounded waits before the stop path runs. The wait
		// detaches and rejects through its normal `Operation aborted`
		// channel, and because the shutdown exit-wake gate owns delivery,
		// exitNotified stays false so the exit remains replay-eligible.
		for (const task of tasks.values()) settleTaskWait(task, { kind: "aborted" });
		for (const task of tasks.values()) {
			if (task.status === "running") {
				task.stopReason = "shutdown";
				// explicit annotation for the session_shutdown
				// kill path so a later restore can tell shutdown-kills from
				// reconcile-on-restart coercion.
				task.terminationReason = "session-shutdown";
				voidPendingTaskWakes(task, "shutdown", logWakeDiagnostic);
				const termResult = killTaskProcess(task, "SIGTERM");
				const killResult: KillTaskResult = killTaskProcess(task, "SIGKILL");
				if (termResult.sent || killResult.sent) {
					task.status = "stopped";
				} else {
					task.stopReason = null;
					task.terminationReason = undefined;
					appendLogLine(task, `\n[shutdown stop skipped] ${termResult.error ?? killResult.error ?? "no stop signal sent"}\n`);
				}
				task.updatedAt = Date.now();
				rememberSnapshot(task);
			}
			clearTaskTimers(task);
		}
		persistSnapshots();
		// The persisted snapshots carry the tasks to the next session_start.
		tasks.clear();
		clearWidget();
		lastLogTail = undefined;
		activeCtx = null;
		await taskLogs.drain();
	});

	// Model-facing bash is spawned exactly once by the managed bash tool
	// registered below. The legacy pre-execution command rewrite is disabled
	// so Pi's tool_call authorization and the spawn both see the original
	// command. Explicit bg_task and user `!` bash handlers are unchanged.
	pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
		recordProjectTrust(ctx);
		activeCtx = ctx;
		if (!isCodemodeCall(codemodeCallIds, event)) return undefined;
		// A codemode script has no delivery channel for a managed background task:
		// its result is the only thing that reaches the model, the script's own
		// deadline cancels whatever it awaited, and nothing in the script could use
		// the task's stop handle. Refuse the launch here, before the spawn, and say
		// what to do instead. This refuses that one managed task, not shell syntax
		// and not a promise of sandboxing: a script's bash may still put its own
		// work in the background. Reads and bounded waits stay available.
		if (event.toolName === "bg_task" && (event.input as { action?: unknown } | undefined)?.action === "spawn") {
			return {
				block: true,
				reason: "bg_task spawn is not available inside codemode: a managed task is detached work whose only delivery is an exit wake, and the script holds the turn, so nothing could receive that wake or reach the task's stop handle. Ordinary shell work is unaffected — this refuses one managed task, not shell syntax — so a script may still put its own work in the background. Run the command with `await tools.bash({ command })` instead (with `intent` when the bash schema requires one): it stays foreground and returns its output, or start the task from a normal tool call outside the script.",
			};
		}
		// Attribute the call so a nested call of its own (through tool_batch, for
		// example) inherits the provenance. A refused call is never recorded: it
		// produces no tool_result that would release the id.
		codemodeCallIds.add(event.toolCallId);
		return undefined;
	});

	pi.on("tool_result", (event: any) => {
		codemodeCallIds.delete(event.toolCallId);
	});

	pi.on("user_bash", (event: any, ctx: ExtensionContext) => {
		recordProjectTrust(ctx);
		// Pi 0.83.0 also routes direct RPC bash through this handler, so ctx is no
		// longer guaranteed to be the interactive session's UI context.
		if (shouldAdoptActiveContext(activeCtx, ctx)) activeCtx = ctx;
		const command = typeof event?.command === "string" ? event.command : "";
		const decision = decisionForBashCommand(command, event?.cwd ?? ctx.cwd);
		if (!decision) return undefined;

		const task = spawnTask({
			command,
			cwd: event?.cwd ?? ctx.cwd,
			origin: "auto-background",
			notifyOnExit: decision.notifyOnExit,
			notifyOnOutput: decision.notifyOnOutput,
			notifyPattern: decision.notifyPattern,
			title: decision.title,
		});
		const otherRunning = [...tasks.values()].filter((t) => t.status === "running" && t.stopReason == null).map((t) => t.id);
		// The same duplicate/rerun guidance bg_task spawn gives: a bash command
		// that duplicates a task already running is the pattern that produced a
		// chain of superseded builds and their wakes.
		const similar = similarRunningTasks(command);
		const identical = similar.identical.filter((t) => t.id !== task.id).map((t) => t.id);
		const related = similar.similar.filter((t) => t.id !== task.id).map((t) => t.id);
		const reran = recentlyFinishedTasks(command, task.cwd).filter((t) => t.id !== task.id);
		const duplicateNote = duplicateTaskNote(identical, related, reran, taskToolSurface);
		const output = bashBackgroundAckText(rememberSnapshot(task), decision, otherRunning, duplicateNote, taskToolSurface);
		if (ctx.hasUI) {
			const label = decision.forced ? "Shortcut moved user bash to background" : "Auto-backgrounded user bash";
			ctx.ui.notify(`${label}: ${task.id} (pid ${task.pid})`, "info");
		}
		return { result: { output, exitCode: 0, cancelled: false, truncated: false } };
	});

	// `bash` is declared in every mode, so it is re-declared with the mode's own
	// guidance: its "what to do with a Running result" bullet is where a TUI could
	// otherwise be told about the compatibility wait it does not have.
	const registerBashTool = (surface: TaskToolSurface): void => pi.registerTool({
		name: "bash",
		label: "bash",
		renderShell: "self",
		description: "Run builds, tests, programs, diagnostics, and system commands. Do not use shell grep/find/cat/ls as substitutes for dedicated retrieval or code-intelligence tools. Commands run under the background-task manager: a command that finishes within the foreground wait returns its stdout/stderr and exit status directly, while a command still running after that returns a Running result with a task id, keeps running under the manager, and wakes the agent automatically on completion. Optionally provide a timeout in seconds as a hard runtime limit.",
		promptSnippet: "Run builds, tests, programs, diagnostics, and system commands. Do not use shell grep/find/cat/ls as substitutes for dedicated retrieval or code-intelligence tools.",
		promptGuidelines: bashPromptGuidelines(surface),
		parameters: intentParameters("bash", Type.Object({
			command: Type.String({ description: "Shell command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout); enforced as hard process runtime" })),
		})),
		outputSchema: BASH_OUTPUT_SCHEMA,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			params = intentPrepare("bash", "Running the command", activeCtx?.cwd)(params as Record<string, unknown>) as typeof params;
			const args = params as { command?: unknown; timeout?: unknown };
			if (codemodeCallIds.has(toolCallId)) return runScriptBash(toolCallId, args, signal, onUpdate as never, ctx);
			return runManagedBash(
				args,
				signal,
				ctx,
				onUpdate as ((partial: AgentToolResult<unknown>) => void) | undefined,
			);
		},
		renderCall(args: any, theme: any, context: any) {
			if (managedBashPresentation) return managedBashPresentation.renderManagedBashCall({ args, context, theme, cwd: activeCtx?.cwd ?? process.cwd() });
			return renderEmpty();
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (managedBashPresentation) {
				// Only a task that actually yielded is a background task. One that
				// exited inside its foreground window renders as a plain bash row.
				const id = (result?.details?.task as { id?: string } | undefined)?.id;
				const live = id ? tasks.get(id) : undefined;
				const isPartial = Boolean(options?.isPartial);
				const asBackground = isPartial || live?.foregroundWaiter?.outcome?.kind === "yielded";
				return managedBashPresentation.renderManagedBashResult({
					context,
					expanded: Boolean(options?.expanded),
					isPartial,
					result,
					task: live && asBackground ? managedBashRowFor(live, activeCtx?.cwd) : undefined,
					theme,
					cwd: activeCtx?.cwd ?? process.cwd(),
				});
			}
			return renderEmpty();
		},
	});
	interop[MANAGED_BASH_SYMBOL] = true;
	// The load-time declaration is the conservative one; `session_start` replaces
	// it with the mode's own surface through `applyTaskToolSurface`.
	registerBashTool("compat");

	registerAll(pi, registrationDeps);
	// `bash` and `bg_task` carry the intent argument (the declaration above and
	// `registerBgTaskTool`). A model-issued call that omits a required intent is
	// refused here, before the spawn or the foreground run; a script's own bash
	// call is left alone by provenance (see `installIntentGuard`).
	installIntentGuard(pi, { tools: ["bash", "bg_task"] });
}
