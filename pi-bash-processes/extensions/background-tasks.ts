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
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { openLaneDir, pruneLanes } from "../scripts/lane-retention.js";

import { shouldAdoptActiveContext } from "./active-context.js";
import {
	autoBackgroundDecision,
	bashBackgroundAckText,
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
import { registerAll } from "./registrations.js";
import { closeTaskLifecycle, replayMissedExitsLifecycle, sendExitWakeLifecycle, type LifecycleHooks } from "./lifecycle.js";
import { taskLogs } from "./log-writer.js";
import { buildManagedBashEnv, createForegroundWaiter, formatManagedBashCompletionText, formatManagedBashRunningText, normalizeManagedBashTimeoutSeconds, settleForegroundWaiter } from "./managed-bash.js";
import { emulateTruncation, stripTerminalTruncation } from "./pipe-strip.js";
import { matchSleepIntercept } from "./sleep-intercept.js";
import type * as ManagedBashPresentation from "@vanillagreen/pi-tool-renderer/managed-bash";
import { getIntent, intentModeFor, intentParameters, intentPrepare, intentSuffix, stripIntent, withIntentParameter } from "@vanillagreen/pi-tool-renderer/intent";
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
import { consumeLogPath, logFilePath, settingBoolean, settingEnum, settingNumber, settingString, taskEnv, taskLaneDir, taskLanesRoot } from "./settings.js";
import { drainConsumedLogPaths } from "./read-shim.js";
import { clampTaskWaitSeconds, createTaskWaitWaiter, DEFAULT_TASK_WAIT_SECONDS, formatTaskWaitRunningText, MAX_TASK_WAIT_SECONDS, settleTaskWaitWaiter, TASK_WAIT_PENDING_POLL_MS } from "./task-wait.js";
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
				if (!task.softTimeoutNotified) scheduleSoftTimeout(task);
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
		if (task.output.length > 0) return task.output;
		if (!existsSync(task.logFile)) return "";
		return readLogTail(task.logFile);
	};

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
		forgetSnapshot(task.id);
		if (dirname(task.logFile) === ownLaneDir()) removeTaskLog(task);
	};

	// Tasks that exited and whose exit wake waits for their log's flush.
	const exitWakeDue = new WeakSet<ManagedTask>();

	// Keep at most MAX_FINISHED_TASKS finished tasks, dropping the oldest. Each
	// finished task the bound counts has had its exit reported or never asked
	// for it: an exit wake goes unsent only during session_shutdown, which
	// empties the map first, and session_start replays missed exits before it
	// bounds. A task whose exit wake waits for its log's flush is not counted.
	const boundFinishedTasks = (): number => {
		const finished = [...tasks.values()].filter((task) => task.status !== "running" && !exitWakeDue.has(task));
		const excess = finished.length - MAX_FINISHED_TASKS;
		let removed = 0;
		for (const task of finished.sort((a, b) => a.updatedAt - b.updatedAt)) {
			if (removed >= excess) break;
			forgetFinishedTask(task);
			removed += 1;
		}
		return removed;
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

	const announceWakeBudgetExhausted = (task: ManagedTask) => {
		const limits = wakeBudgetLimits(activeCtx?.cwd);
		const announced = sendOutputWakeBudgetExhaustedNotice({
			logDiagnostic: logWakeDiagnostic,
			messageType: BG_MESSAGE_TYPE,
			rememberSnapshot,
			sendMessage: (message, messageOptions) => pi.sendMessage(message as any, messageOptions as any),
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
				task.exitNotified = true;
				publishBackgroundTaskActivity(eventType, task, { ...options, sequence: options.sequence ?? task.wakeSequence ?? 0 });
				rememberSnapshot(task);
				persistSnapshots();
				return true;
			}
		}
		// Mid-turn exits are held until the turn ends: the agent can still read
		// the result in this same turn, in which case the wake is dropped.
		if (eventType === "exit" && turnActive && !shuttingDown) {			task.exitNotified = true;
			deferredExitWakes.set(task.id, options);
			publishBackgroundTaskActivity(eventType, task, { ...options, sequence: options.sequence ?? task.wakeSequence ?? 0 });
			rememberSnapshot(task);
			persistSnapshots();
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
			isShuttingDown: () => shuttingDown,
			logDiagnostic: logWakeDiagnostic,
			messageType: BG_MESSAGE_TYPE,
			outputTail: (target) => tailText(getTaskOutput(target), settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS, activeCtx?.cwd)),
			rememberSnapshot,
			sendMessage: (message, messageOptions) => pi.sendMessage(message as any, messageOptions as any),
			runningInventory,
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
	 * Arm the one-shot soft progress reminder for a running task. A soft expiry
	 * never signals the process: it emits exactly one steer wake asking the agent
	 * to continue (extend), inspect, or stop. `softTimeoutNotified` is the
	 * one-shot latch; it is persisted so a session restore cannot re-wake for a
	 * deadline the agent already saw.
	 */
	const scheduleSoftTimeout = (task: ManagedTask): void => {
		if (task.softTimeoutTimer) clearTimeout(task.softTimeoutTimer);
		task.softTimeoutTimer = null;
		const softTimeoutMs = task.softTimeoutMs ?? 0;
		if (task.status !== "running" || task.stopReason != null || softTimeoutMs <= 0 || task.softTimeoutNotified) return;
		const deadline = task.softExpiresAt ?? (task.startedAt + softTimeoutMs);
		task.softExpiresAt = deadline;
		// A deadline that already passed (restored live task) fires on the next
		// tick instead of being skipped.
		const delay = Math.max(1, deadline - Date.now());
		task.softTimeoutTimer = setTimeout(() => {
			task.softTimeoutTimer = null;
			if (task.status !== "running" || task.stopReason != null || task.softTimeoutNotified) return;
			task.softTimeoutNotified = true;
			const sent = sendTaskEvent("soft-timeout", task, {
				eventAt: deadline,
				softTimeout: {
					elapsedMs: Math.max(0, Date.now() - task.startedAt),
					softTimeoutMs,
				},
			});
			// A wake that could not be delivered (shutdown) stays re-armable.
			if (!sent) task.softTimeoutNotified = false;
			rememberSnapshot(task);
			persistSnapshots();
			refreshUi();
		}, delay);
		task.softTimeoutTimer.unref?.();
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
		task.softTimeoutNotified = false;
		task.softExpiresAt = nextMs > 0 ? Date.now() + nextMs : null;
		task.updatedAt = Date.now();
		scheduleSoftTimeout(task);
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
	const finalizeTask = (task: ManagedTask, exitCode: number | null, statusOverride?: BackgroundTaskStatus): void => {
		if (!closeTaskLifecycle(task, exitCode, lifecycleHooks, statusOverride)) return;
		clearRunningMarker(task);
		task.child = null;
		refreshUi();
		exitWakeDue.add(task);
		const settle = () => {
			exitWakeDue.delete(task);
			if (tasks.get(task.id) === task) {
				// The exit-wake decision runs while an attached waiter is still
				// unsettled: that is how a foreground bash wait or a bounded task
				// wait is recognised as the delivery channel for this exit.
				sendExitWakeLifecycle(task, lifecycleHooks);
				if (taskLogs.settled(task.logFile) && existsSync(task.logFile)) {
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
		return buildManagedBashEnv(taskEnv(ownLaneDir()), {
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
	const managedBashRowFor = (task: ManagedTask, cwd?: string): ManagedBashRowTask => {
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
			logFile: task.logFile,
			outputTail: managedBashOutputTail(task, cwd),
			statusText: summarizeTaskStatus(task.status, task.exitCode, task.terminationReason),
		});

	const formatManagedBashRunning = (task: ManagedTask, elapsedMs: number, cwd?: string): string =>
		formatManagedBashRunningText({
			elapsedText: formatDuration(elapsedMs),
			id: task.id,
			logFile: task.logFile,
			outputTail: managedBashOutputTail(task, cwd),
			pid: task.pid,
		});

	const basenameTaskLog = (logFile: string): string => logFile.split("/").pop() ?? logFile;

	/**
	 * Runs the read remainder of an intercepted sleep command through /bin/sh
	 * and returns bounded stdout. The gate has already proven every segment is
	 * a pure read, so this cannot mutate anything.
	 */
	const executeReadRemainder = async (remainder: string, cwd: string): Promise<string> => {
		try {
			const child = spawn("/bin/sh", ["-c", remainder], { cwd, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			const collect = (chunk: Buffer) => {
				out += chunk.toString();
				if (out.length > 8_000) out = out.slice(0, 8_000);
			};
			child.stdout?.on("data", collect);
			child.stderr?.on("data", collect);
			const done = new Promise<void>((resolve) => child.on("close", () => resolve()));
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref?.());
			await Promise.race([done, timeout]);
			child.kill("SIGKILL");
			return out.trim();
		} catch (error) {
			return `[intercepted read failed: ${error instanceof Error ? error.message : String(error)}]`;
		}
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

		// Intercept-substitute-label: `sleep N && <reads of managed logs>` is a
		// hand-written poll. Run the reads against the task now (bounded wait if
		// it is still running) and tell the agent what happened, instead of
		// burning N seconds in a foreground window. Anything the gate cannot
		// parse with certainty runs exactly as written (fail open).
		const intercept = matchSleepIntercept(command);
		if (intercept) {
			const referenced = [...tasks.values()].filter((task) =>
				intercept.logPaths.some((path) => path.includes(basenameTaskLog(task.logFile)) || task.logFile.includes(path.trim()))
			);
			const target = referenced.at(-1);
			if (target && target.status === "running") {
				const result = await waitForTask(target, Math.min(intercept.sleepSeconds, 30), signal, ctx);
				const label = `kendex: intercepted sleep ${intercept.sleepSeconds}; bg_task action:"wait" ran against ${target.id} instead. Next time call bg_task action:\"wait\" directly.`;
				return {
					content: [{ type: "text", text: `${label}\n\n${result.content[0]?.text ?? ""}` }],
					details: result.details,
				} as AgentToolResult<unknown>;
			}
			if (target) {
				const label = `kendex: intercepted sleep ${intercept.sleepSeconds}; ${target.id} already finished, so the reads ran now. Next time read the log directly — no sleep needed.`;
				const readResult = await executeReadRemainder(intercept.remainder, ctx.cwd);
				// The reads just ran are the delivery for this exit: drop the pending
				// wake and record it, exactly like a shimmed read of the log.
				consumeObservedExitWake(target.id);
				target.exitNotified = true;
				rememberSnapshot(target);
				persistSnapshots();
				return {
					content: [{ type: "text", text: `${label}\n\n${readResult}` }],
					details: { action: "bash", intercepted: true, task: compactBackgroundTaskSnapshot(rememberSnapshot(target)) },
				} as AgentToolResult<unknown>;
			}
			// Read targets matched no managed task: fail open — run as written.
		}

		const timeoutSeconds = normalizeManagedBashTimeoutSeconds(params.timeout);
		const yieldMs = managedBashYieldMs(ctx.cwd);
		// A terminal `| head/tail [-n] N` becomes run-to-completion + post-hoc
		// emulation: the filter used to eat the exit code (pipefail off) and keep
		// the log empty until exit. The truncation itself still applies below.
		const stripped = stripTerminalTruncation(command);
		const effectiveCommand = stripped?.command ?? command;
		const task = spawnTask({
			command: effectiveCommand,
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
				if (typeof task.exitCode === "number" && task.exitCode !== 0) {
					throw new Error(`${rawText}\n\nCommand exited with code ${task.exitCode}`);
				}
				// Emulate the stripped filter on the completed output and disclose
				// the substitution; the command ran to completion, so this exit code
				// is the real one.
				let text = rawText;
				if (stripped) {
					const emulated = emulateTruncation(rawText, stripped.tool, stripped.lines);
					text = emulated.text
						+ `\n(kendex: \`${stripped.tool} -n ${stripped.lines}\` was applied to the completed output; the command ran without the filter)`;
				}
				return makeToolResult(text, details);
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
			// pinged at turn end for a result this call already handed it.
			consumeObservedExitWake(task.id);
			return makeToolResult(formatManagedBashCompletion(task, Date.now() - task.startedAt, ctx.cwd), details());
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
				// text below is scoped to the wait attachment.
				return makeToolResult(formatManagedBashCompletion(task, Date.now() - task.startedAt, ctx.cwd), details());
			}
			return makeToolResult(
				formatTaskWaitRunningText({
					elapsedText: formatDuration(Date.now() - waitStartedAt),
					id: task.id,
					logFile: task.logFile,
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
	const flushDeferredExitWakes = (): void => {		drainShimConsumedReads();
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
				isShuttingDown: () => shuttingDown,
				logDiagnostic: logWakeDiagnostic,
				messageType: BG_MESSAGE_TYPE,
				outputTail: (target) => tailText(getTaskOutput(target), settingNumber("outputAlertMaxChars", DEFAULT_OUTPUT_ALERT_MAX_CHARS, activeCtx?.cwd)),
				rememberSnapshot,
				sendMessage: (message, messageOptions) => pi.sendMessage(message as any, messageOptions as any),
				runningInventory,
			}, "exit", task, options);
			// The send is the delivery: claim it so a restart cannot replay a wake
			// the agent already received.
			if (sent) {
				task.exitNotified = true;
				rememberSnapshot(task);
				persistSnapshots();
			}
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
				? `${failures.length} failed: review with bg_task log.`
				: "If these results are already consumed, nothing more to do; stop lingering tasks with bg_task stop.",
			runningInventory(),
		].join("\n");
		pi.sendMessage(
			{ customType: BG_MESSAGE_TYPE, content, display: true, details: { grouped: true, tasks: finished.map((t) => compactBackgroundTaskSnapshot(t)) } },
			{ deliverAs: "followUp", triggerTurn: true },
		);
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
	 * Drops a deferred exit wake because the agent already read the task's
	 * result in this turn (bg_task log/wait). Returns true when a wake was held.
	 */
	const consumeObservedExitWake = (taskId: string): boolean => {		const dropped = deferredExitWakes.delete(taskId);
		const droppedIdle = idleExitBatch.delete(taskId);
		return dropped || droppedIdle;
	};

	/**
	 * Drops pending wakes for tasks whose log the agent has already read through
	 * the managed-bash read shims (cat/tail/head/grep/less, pi-bg read). The shims
	 * report the exact path they opened, so this is the real read — not a guess
	 * about command text.
	 */
	const drainShimConsumedReads = (): void => {
		let paths: Set<string>;
		try {
			paths = drainConsumedLogPaths(consumeLogPath());
		} catch {
			return;
		}
		if (paths.size === 0) return;
		for (const task of tasks.values()) {
			if (task.status === "running" || !task.logFile) continue;
			if (!paths.has(task.logFile)) continue;
			if (!consumeObservedExitWake(task.id)) continue;
			// The read is the delivery: record it so a restart cannot replay the
			// wake for a result the agent already saw.
			task.exitNotified = true;
			rememberSnapshot(task);
			persistSnapshots();
		}
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
		const softExpiresAt = softTimeoutMs > 0 ? now + softTimeoutMs : null;
		const laneDir = openLaneDir(ownLaneDir(), activeCtx?.cwd ?? cwd);
		const logFile = logFilePath(laneDir, id, now);
		writeFileSync(logFile, "");

		const { shell, args } = getShellConfig();
		const spawnPlan = planResourceControlledSpawn({
			command,
			cwd,
			shell,
			shellArgs: args,
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
		env: options.env ?? taskEnv(laneDir),
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

	const clearFinishedTasks = (): number => {
		let removed = 0;
		for (const task of [...tasks.values()]) {
			if (task.status === "running") continue;
			forgetFinishedTask(task);
			removed += 1;
		}
		persistSnapshots();
		refreshUi();
		return removed;
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
		return autoBackgroundDecision(command, cwd);
	};

	const dashboardDeps = {
		clearFinishedTasks,
		formatTaskListText,
		getTask: (id: string) => tasks.get(id) ?? null,
		getTaskOutput,
		requestStop: (task: ManagedTask | null, reason: "user", author?: "agent" | "operator") => requestStop(task, reason, author ?? "agent"),
		sortedTasks,
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
		const pruned = pruneLanes(taskLanesRoot());
		for (const failure of pruned.failed) logBackgroundDiagnostic("task log prune failed", { path: failure.path, error: failure.error });
		await restoreSnapshots(ctx);
		replayMissedExits();
		if (boundFinishedTasks() > 0) persistSnapshots();
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
		deferredExitWakes.clear();
		idleExitBatch.clear();
		delete interop[MANAGED_BASH_SYMBOL];
		flushIdleExitBatch();
		shuttingDown = true;
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
	pi.on("tool_call", async (_event: any, ctx: ExtensionContext) => {
		recordProjectTrust(ctx);
		activeCtx = ctx;
		return undefined;
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
		const duplicateNote = duplicateTaskNote(identical, related, reran);
		const output = bashBackgroundAckText(rememberSnapshot(task), decision, otherRunning, duplicateNote);
		if (ctx.hasUI) {
			const label = decision.forced ? "Shortcut moved user bash to background" : "Auto-backgrounded user bash";
			ctx.ui.notify(`${label}: ${task.id} (pid ${task.pid})`, "info");
		}
		return { result: { output, exitCode: 0, cancelled: false, truncated: false } };
	});

	pi.registerTool({
		name: "bash",
		label: "bash",
		renderShell: "self",
		description: "Run builds, tests, programs, diagnostics, and system commands. Do not use shell grep/find/cat/ls as substitutes for dedicated retrieval or code-intelligence tools. Commands run under the background-task manager: a command that finishes within the foreground wait returns its stdout/stderr and exit status directly, while a command still running after that returns a Running result with a task id, keeps running under the manager, and wakes the agent automatically on completion. Optionally provide a timeout in seconds as a hard runtime limit.",
		promptSnippet: "Run builds, tests, programs, diagnostics, and system commands. Do not use shell grep/find/cat/ls as substitutes for dedicated retrieval or code-intelligence tools.",
		promptGuidelines: [
			"You can inspect PI_* environment variables for current model and session details.",
			"If a bash result says Running, it is not success. If the result is a dependency barrier, call bg_task action:\"wait\" once with a bounded waitSeconds; otherwise continue only independent work. If nothing independent remains, finish the turn with a brief waiting status and go idle; completion will wake the agent in a new turn. Do not repeatedly call list/log/wait in a polling loop.",
		],
		parameters: intentParameters("bash", Type.Object({
			command: Type.String({ description: "Shell command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout); enforced as hard process runtime" })),
		})),		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			params = intentPrepare("bash", "Running the command", activeCtx?.cwd)(params as Record<string, unknown>) as typeof params;
			return runManagedBash(
				params as { command?: unknown; timeout?: unknown },
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

	registerAll(pi, {
		getActiveCtx: () => activeCtx,
		setActiveCtx: (ctx) => { activeCtx = ctx; },
		rememberSnapshot,
		sortedTasks,
		formatTaskListText,
		getTaskOutput,
		resolveTask,
		requestStop: (task, _reason, author) => requestStop(task, "user", author ?? "agent"),
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
	});
}
