// Pi tool / command / shortcut registrations for pi-background-tasks.
//
// The host closure builds a RegistrationDeps
// object from its private state and calls registerAll(pi, deps). Each
// registration handler captures `deps` via closure, so the extracted
// module stays free of cross-module mutable state.

import { StringEnum } from "@earendil-works/pi-ai";
import { getIntent, intentHardRequired, intentModeFor, intentParameters, intentPrepare, intentSuffix, stripIntent, withIntentParameter } from "@vanillagreen/pi-tool-renderer/intent";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { BG_COMMAND } from "./constants.js";
import { duplicateTaskNote } from "./auto-background.js";
export {
	COMPAT_BG_TASK_ACTIONS,
	TUI_BG_TASK_ACTIONS,
	taskToolSurfaceFor,
	type TaskToolSurface,
} from "./tool-surface.js";
import { COMPAT_BG_TASK_ACTIONS, TUI_BG_TASK_ACTIONS, taskSurfaceActions, taskToolSurfaceFor, type TaskToolSurface } from "./tool-surface.js";
import { openDashboard, type DashboardDeps } from "./dashboard.js";
import { formatRelativeTime, formatTaskLog, formatTaskResultText, summarizeTaskStatus, taskLogTruncation } from "./format.js";
import { makeToolResult, renderBgToolResult, renderEmpty } from "./render.js";
import { bgToolResultTasks } from "./tool-result-details.js";
import type { TaskResultAck, TaskResultHandoff } from "./task-result.js";
import type { BackgroundTaskSnapshot, ManagedTask, SpawnTaskOptions } from "./types.js";
import { compactBackgroundTaskSnapshot, NOTIFY_MODES, WAKE_MANIFEST_FIELD_MAX_CHARS, truncateForTranscript } from "./wake-events.js";

export interface RegistrationDeps {
	getActiveCtx: () => ExtensionContext | null;
	setActiveCtx: (ctx: ExtensionContext) => void;
	rememberSnapshot: (task: ManagedTask) => BackgroundTaskSnapshot;
	sortedTasks: () => ManagedTask[];
	formatTaskListText: () => string;
	getTaskOutput: (task: ManagedTask) => string;
	resolveTask: (id?: string, pid?: number) => ManagedTask | null;
	/**
	 * The shared get operation. Identical to what the declared `pi-bg` CLI
	 * requests through the session endpoint, including the commit rule: a handoff
	 * that could not be certified is returned with its loss metadata and no `ack`,
	 * so a short capture can never be presented as a settled result.
	 */
	readTaskResult: (task: ManagedTask, output: "preview" | "full") => Promise<{ ack?: TaskResultAck; handoff: TaskResultHandoff }>;
	/**
	 * Confirmed stop: the same bounded termination/finalization procedure
	 * `pi-bg stop` uses. A stop that cannot confirm termination is unconfirmed,
	 * never reported as a stopped task.
	 */
	stopTaskConfirmed: (task: ManagedTask) => Promise<{ confirmed: boolean; message: string }>;
	requestStop: (task: ManagedTask | null, reason: "user", author?: "agent" | "operator") => { ok: boolean; message: string };
	extendSoftTimeout: (task: ManagedTask | null, seconds?: number) => { ok: boolean; message: string };
	spawnTask: (options: SpawnTaskOptions) => ManagedTask;
	similarRunningTasks: (command: string) => { identical: ManagedTask[]; similar: ManagedTask[] };
	oldestRunningTask: () => ManagedTask | null;
	waitForTask: (
		task: ManagedTask,
		waitSeconds: unknown,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<unknown>>;
	clearFinishedTasks: () => number;
	/** True when a deferred exit wake for this task was dropped. */
	consumeObservedExitWake: (taskId: string) => boolean;
	armForcedBackground: (ctx: ExtensionContext, source: "shortcut" | "command") => void;
	toggleWidget: () => void;
	dashboardDeps: DashboardDeps;
	dashboardShortcut: string;
	backgroundBashShortcut: string;
	widgetToggleShortcut: string;
}

/** Action enum named by the surface, so the declared schema is the narrow one in TUI. */
function bgTaskActions(surface: TaskToolSurface): readonly string[] {
	return taskSurfaceActions(surface);
}

/**
 * Per-surface `bg_task` guidance. This is the supported per-session prompt
 * contribution: Pi appends a tool's `promptGuidelines` to the system prompt only
 * while that tool is active, so the TUI never receives the compatibility wait
 * advice and a noninteractive child never receives push-only end-response advice.
 */
function bgTaskGuidelines(surface: TaskToolSurface): string[] {
	const shared = [
		"Use bg_task instead of bash backgrounding/nohup when the user wants a long-running command to continue while the conversation remains usable.",
		"Use bg_task action:\"get\" output:\"full\" to hand over a finished task's complete output; pass output:\"full\" with action:\"stop\" to stop and read the final result in one call.",
	];
	if (surface === "tui") {
		return [
			shared[0]!,
			"Use bg_task list/get/stop/extend to inspect, re-arm, or terminate tasks started by bg_task or /bg. get is the task's result, including its readiness and outcome; there is no separate status tool in this mode.",
			"For a long-running watcher or monitor, set softTimeoutMs generously at spawn (or 0 to disable it); the periodic soft reminder can be re-armed later with bg_task action:\"extend\" id:... softTimeoutMs:....",
			shared[1]!,
			"Running is not success. Do not poll: no sleep/tail loops and no repeated list/get calls. Do independent work; if nothing independent remains, finish the turn with a brief waiting status and go idle, and the task's completion wakes the agent in a new turn.",
			"Use bg_task for pi-bridge, session, tmux, agent/delegate, or log monitoring instead of raw foreground bash polling loops.",
			"If a bash monitor is auto-backgrounded, continue the turn and inspect it later with bg_task get/list/stop rather than waiting on foreground bash.",
		];
	}
	return [
		shared[0]!,
		"Use bg_task list/log/get/stop to inspect or terminate tasks started by bg_task or /bg. log is the raw captured tail; get is the task's result, including its readiness and outcome.",
		shared[1]!,
		"Running is not success. In an interactive session, do independent work and end the turn to await the completion wake instead of polling. A noninteractive or child caller that must have a shell result before its session closes can call bg_task action:\"wait\" once with a bounded waitSeconds: that yields only its own turn, never stops the task, and is the retained compatibility wait. Do not repeatedly call list/log/get/wait in a polling loop.",
		"Use bg_task for pi-bridge, session, tmux, agent/delegate, or log monitoring instead of raw foreground bash polling loops.",
		"If a bash monitor is auto-backgrounded, continue the turn and inspect it later with bg_task log/list/stop rather than waiting on foreground bash.",
	];
}

function bgTaskDescription(surface: TaskToolSurface): string {
	const behaviours =
		"Tasks write persistent logs, do not time out by default, stop as a process group on Unix, and can wake the agent on exit or matching output.";
	if (surface === "tui") {
		return `Spawn, inspect, and stop explicit background shell tasks. ${behaviours} Never poll a running task with sleep/tail loops or repeated list/get calls: the exit wake arrives as a new turn. The background-tasks extension also auto-diverts recognized bash monitoring loops before they block.`;
	}
	return `Spawn, inspect, wait for, and stop explicit background shell tasks. \`wait\` blocks the turn for a bounded window and returns the terminal result or a truthful Running status; it never stops the task. ${behaviours} Never poll a running task with sleep/tail loops or repeated list/log calls: the exit wake arrives as a new turn. The background-tasks extension also auto-diverts recognized bash monitoring loops before they block.`;
}

function bgTaskPromptSnippet(surface: TaskToolSurface): string {
	return surface === "tui"
		? "Spawn, inspect, and stop explicit non-blocking background shell tasks."
		: "Spawn, inspect, wait for, and stop explicit non-blocking background shell tasks.";
}

function bgTaskActionDescription(surface: TaskToolSurface): string {
	return surface === "tui"
		? "spawn=start a task, get=the task's result (state, outcome, output preview or full immutable output), stop=terminate and return the result, list=show tasks, extend=reset the soft reminder, optionally at a new interval"
		: "spawn=start a task, list=show tasks, log=raw tail of the captured log, get=the task's result (state, outcome, output preview or full immutable output), stop=terminate and return the result, clear=remove finished tasks, wait=block up to waitSeconds for a task to finish, extend=reset the soft reminder, optionally at a new interval";
}

/**
 * `bash`'s guidelines about what to do with a Running result. `bash` is active
 * in every mode, so its guidance is the other place the TUI could be told about
 * an action it does not have: the bounded compatibility wait is only recommended
 * where it exists, and the TUI is pointed at ending the turn instead.
 */
export function bashPromptGuidelines(surface: TaskToolSurface): string[] {
	return [
		"You can inspect PI_* environment variables for current model and session details.",
		surface === "tui"
			? 'If a bash result says Running, it is not success: do not use its output or artifacts yet. Do independent work; if nothing independent remains, finish the turn with a brief waiting status and go idle, and completion will wake the agent in a new turn. There is no bounded wait in this mode, and repeatedly calling list/get is not a substitute for it.'
			: 'If a bash result says Running, it is not success: do not use its output or artifacts yet. If the result is a dependency barrier, call bg_task action:"wait" once with a bounded waitSeconds; otherwise continue only independent work. If nothing independent remains, finish the turn with a brief waiting status and go idle; completion will wake the agent in a new turn. Do not repeatedly call list/log/wait in a polling loop.',
	];
}

/**
 * The `bg_task` parameter schema for one surface. The declared properties narrow
 * with the action enum and so do their descriptions: a field that exists only to
 * serve an action this surface does not declare is not declared either, and no
 * description names an action the caller cannot use. A compatibility caller's
 * schema is therefore unchanged, and the TUI never reads prose about a bounded
 * wait or a raw log action.
 */
function bgTaskSchema(surface: TaskToolSurface) {
	const tui = surface === "tui";
	return Type.Object({
		action: StringEnum(bgTaskActions(surface), {
			description: bgTaskActionDescription(surface),
		}),
		command: Type.Optional(Type.String({ description: "Shell command for action=spawn" })),
		cwd: Type.Optional(Type.String({ description: "Working directory for action=spawn" })),
		id: Type.Optional(Type.String({
			description: tui
				? "Task id for action=get, action=stop, or action=extend."
				: "Task id for action=log, action=get, action=stop, action=wait, or action=extend. action=wait without an id waits on the oldest running task.",
		})),
		notifyOnExit: Type.Optional(Type.Boolean({ description: "Wake the agent when the task exits. Defaults to true." })),
		notifyOnOutput: Type.Optional(Type.Boolean({ description: "Wake the agent when new output arrives. Defaults to false." })),
		notifyPattern: Type.Optional(Type.String({ description: "Substring or /regex/flags gate for output wakeups." })),
		notifyMode: Type.Optional(StringEnum(NOTIFY_MODES, {
			description: "Output wake mode: always=every output update, transition=only changed output tail hash, first-match-only=one notifyPattern match then suppress output wakes. Default: first-match-only when notifyPattern is set, transition otherwise (set 'always' explicitly to opt into every-output wakes).",
		})),
		dedupeKey: Type.Optional(Type.String({ description: "Optional key used by notifyMode=transition to coalesce matching output wakes across tasks." })),
		pid: Type.Optional(Type.Number({
			description: tui ? "PID for action=get or action=stop" : "PID for action=log, action=get, or action=stop",
		})),
		output: Type.Optional(StringEnum(["preview", "full"] as const, {
			description: "For action=get or action=stop: preview=an inline preview of captured output (default), full=flush the capture and hand over the complete immutable output for this task.",
		})),
		timeoutSeconds: Type.Optional(Type.Number({ description: "Hard timeout for spawned tasks. Defaults to 0 (disabled)." })),
		softTimeoutMs: Type.Optional(Type.Number({
			description: "Soft progress reminder in milliseconds for action=spawn, or for action=extend to re-arm it later. Set it generously for a long-running task such as a watcher or log monitor, or 0 to disable it. Defaults to 600000 (10 minutes). Soft expiry never stops the process: it asks the agent to continue, inspect, or stop.",
		})),
		...(tui
			? {}
			: {
				waitSeconds: Type.Optional(Type.Number({ description: "Bounded wait window in seconds for action=wait. Omitted values use taskWaitDefaultSeconds and values are capped by taskWaitMaxSeconds. This is a wait budget, not a task timeout: it never stops the task." })),
			}),
		title: Type.Optional(Type.String({ description: "Optional display label for action=spawn" })),
	});
}

/**
 * The compatibility-only status tool. It is registered late, in non-TUI modes
 * only, and routes `list`/`stop`/`log` through the same shared operations
 * `bg_task` uses, so a result read here is acknowledged exactly once by the same
 * path rather than by a second acknowledgment channel.
 */
function registerBgStatusTool(pi: ExtensionAPI, deps: RegistrationDeps): void {
	pi.registerTool({
		renderShell: "self",
		name: "bg_status",
		label: "Background Process Status",
		description: "List, view the result of, or stop background tasks spawned by bg_task or /bg. Use pid for log/stop.",
		promptGuidelines: [
			"bg_status is the compatibility status surface for noninteractive and child sessions: list shows tracked tasks, log hands over a task's result through the same shared get operation as bg_task, and stop ends the task through the same shared confirmed stop. A result read here acknowledges completion on the same single path.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "log", "stop"] as const, {
				description: "list=show tracked tasks, log=hand over the task's result by pid, stop=terminate by pid",
			}),
			pid: Type.Optional(Type.Number({ description: "Task pid for action=log or action=stop" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			if (params.action === "list") {
				const tasks = deps.sortedTasks().map(deps.rememberSnapshot);
				return makeToolResult(deps.formatTaskListText(), { action: "list", tasks: bgToolResultTasks(tasks) });
			}
			const task = deps.resolveTask(undefined, params.pid);
			if (!task) throw new Error("No background task matched that pid.");
			if (params.action === "log") {
				// The compatibility read is the shared get operation, not a raw live-log
				// tail: it hands over the same prepared snapshot and commits the same
				// single acknowledgment, so there is no second channel to reconcile.
				return makeToolResult(...(await getResultResult(deps, task, "preview", "log")));
			}
			// A stop that cannot confirm termination is reported as unconfirmed, never
			// as a stopped task.
			const stopped = await deps.stopTaskConfirmed(task);
			if (!stopped.confirmed) throw new Error(stopped.message);
			return makeToolResult(stopped.message, { action: "stop", task: compactBackgroundTaskSnapshot(deps.rememberSnapshot(task)) });
		},
		renderCall() { return renderEmpty(); },
		renderResult(result: any, options: any, theme: Theme, context: any) {
			return renderBgToolResult(result, options, theme, context);
		},
	});
}

/**
 * Registers `bg_task` for one surface. Re-registering the same name replaces the
 * declaration, which is how the TUI gets its four-action schema instead of the
 * compatibility one; Pi activates the replacement through the ordinary
 * registration path, so a user or child selection that already excluded the name
 * is never overridden.
 */
function registerBgTaskTool(pi: ExtensionAPI, deps: RegistrationDeps, surface: TaskToolSurface): void {
	pi.registerTool({
		renderShell: "self",
		name: "bg_task",
		intent: "start, inspect, wait for, or stop a managed background process",
		label: "Background Task",
		description: bgTaskDescription(surface),
		promptSnippet: bgTaskPromptSnippet(surface),
		promptGuidelines: bgTaskGuidelines(surface),
		parameters: intentParameters("bg_task", bgTaskSchema(surface)), async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const intent = getIntent(params);
			if (params.action === "spawn" && intent) {
				params.title = typeof params.title === "string" && params.title.trim() ? params.title : intent;
			}
			if (params.action === "list") {
				const tasks = deps.sortedTasks().map(deps.rememberSnapshot);
				return makeToolResult(deps.formatTaskListText(), { action: "list", tasks: bgToolResultTasks(tasks) });
			}
			if (params.action === "clear") {
				const removed = deps.clearFinishedTasks();
				// Clearing only drops finished rows. When running tasks remain, say so
				// and name the action that actually silences them: the reported failure
				// (a clear that looked like it had dealt with the tasks, followed by a
				// wake per remaining task) came from that gap.
				const running = deps.sortedTasks().filter((candidate) => candidate.status === "running" && candidate.stopReason == null);
				const stillRunning = running.length > 0
					? `\nStill running: ${running.map((candidate) => candidate.id).join(", ")} — clear does not touch running tasks. Each will send an exit wake; use bg_task stop id:"all" to end them without a wake.`
					: "";
				return makeToolResult(`Removed ${removed} finished background task(s).${stillRunning}`, { action: "clear", removed });
			}
			if (params.action === "spawn") {
				const task = deps.spawnTask({
					command: params.command ?? "",
					cwd: params.cwd,
					notifyOnExit: params.notifyOnExit,
					notifyOnOutput: params.notifyOnOutput,
					notifyPattern: params.notifyPattern,
					notifyMode: params.notifyMode,
					dedupeKey: params.dedupeKey,
					timeoutSeconds: params.timeoutSeconds,
					softTimeoutMs: params.softTimeoutMs,
					title: params.title,
				});
				const safeCommand = truncateForTranscript(task.command, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "";
				const safeCwd = truncateForTranscript(task.cwd, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "";
				const safePattern = truncateForTranscript(task.notifyPattern, WAKE_MANIFEST_FIELD_MAX_CHARS);
				const safeDedupe = truncateForTranscript(task.dedupeKey, WAKE_MANIFEST_FIELD_MAX_CHARS);
				// Exclude the task just spawned: it is already in the map when the
				// note is rendered, so it would otherwise warn about itself.
				const similar = deps.similarRunningTasks(task.command);
				const identical = similar.identical.filter((t) => t.id !== task.id);
				const related = similar.similar.filter((t) => t.id !== task.id);
				const reran = deps.recentlyFinishedTasks(task.command, task.cwd).filter((t) => t.id !== task.id);
				const duplicateNote = duplicateTaskNote(
					identical.map((t) => t.id),
					related.map((t) => t.id),
					reran,
					surface,
				);
				const resourceControl = task.resourceControl
					? `\nResource controls: ${task.resourceControl.mode}${task.resourceControl.unitName ? ` (${task.resourceControl.unitName})` : ""}`
					: "";
				return makeToolResult(
					`Started ${task.id} (pid ${task.pid}) in the background.\nCommand: ${safeCommand}\nCwd: ${safeCwd}\nExpiry: ${
						task.expiresAt != null ? formatRelativeTime(task.expiresAt) : "none"
					}\nWakeups: exit=${task.notifyOnExit ? "yes" : "no"}, output=${
						task.notifyOnOutput ? (safePattern ?? "yes") : "no"
					}, mode=${task.notifyMode ?? "always"}${safeDedupe ? `, dedupeKey=${safeDedupe}` : ""}${resourceControl}${duplicateNote}${buildRunningInventory(deps, task.id, undefined)}`,
					{ action: "spawn", task: compactBackgroundTaskSnapshot(deps.rememberSnapshot(task)) },
				);
			}
			if (params.action === "stop" && (params.id === "all" || params.pid === "all")) {
				const running = deps.sortedTasks().filter((candidate) => candidate.status === "running" && candidate.stopReason == null);
				if (running.length === 0) {
					return makeToolResult("No background tasks are running.", { action: "stop", tasks: [] });
				}
				const results = running.map((candidate) => ({ candidate, stopped: deps.requestStop(candidate, "user") }));
				const summary = results.map(({ candidate, stopped }) => stopped.ok ? `Stopped ${candidate.id}.` : `Failed to stop ${candidate.id}: ${stopped.message}`);
				return makeToolResult(summary.join("\n"), {
					action: "stop",
					tasks: results.map(({ candidate }) => compactBackgroundTaskSnapshot(deps.rememberSnapshot(candidate))),
				});
			}
			const task = deps.resolveTask(params.id, params.pid)
				?? (params.action === "wait" && params.id === undefined && params.pid === undefined ? deps.oldestRunningTask() : null);
			if (!task) {
				throw new Error(
					params.action === "wait"
						? 'No background task matched that id or pid, and no task is running. Start one with action:"spawn" or list tasks with action:"list".'
						: "No background task matched that id or pid.",
				);
			}
			
			if (params.action === "wait") return deps.waitForTask(task, params.waitSeconds, signal, ctx);
			if (params.action === "extend") {
				const extended = deps.extendSoftTimeout(task, params.softTimeoutMs);
				if (!extended.ok) throw new Error(extended.message);
				return makeToolResult(extended.message, { action: "extend", task: compactBackgroundTaskSnapshot(deps.rememberSnapshot(task)) });
			}
			if (params.action === "log") {
				// Reading a finished task's log in the same turn the exit wake was
				// deferred means the agent already has the result: drop the wake
				// instead of announcing work that has been reported.
				if (task.status !== "running") deps.consumeObservedExitWake(task.id);
				const output = deps.getTaskOutput(task);
				const cwd = deps.getActiveCtx()?.cwd;
				const truncation = taskLogTruncation(output, task.logFile, cwd);
				return makeToolResult(formatTaskLog(output, task.logFile, cwd), {
					action: "log",
					task: compactBackgroundTaskSnapshot(deps.rememberSnapshot(task)),
					...(truncation ? { truncation } : {}),
				});
			}
			if (params.action === "get") {
				return makeToolResult(...(await getResultResult(deps, task, params.output, "get")));
			}
			// stop: the session's own bounded termination/finalization procedure, then
			// the result under the same id, so a stop answers with the outcome rather
			// than only a signal receipt. A stop that cannot confirm termination is
			// unconfirmed, never reported as a stopped task.
			const stopped = await deps.stopTaskConfirmed(task);
			if (!stopped.confirmed) throw new Error(stopped.message);
			const stoppedResult = await getResultResult(deps, task, params.output, "stop");
			// The result text already names the task and its command, so the stop's
			// own wording is carried in the details rather than printed a second time:
			// the transcript budget belongs to the result, not to a duplicate of it.
			stoppedResult[1].stopMessage = truncateForTranscript(stopped.message, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "";
			return makeToolResult(...stoppedResult);
		},
		renderCall() { return renderEmpty(); },
		renderResult(result: any, options: any, theme: Theme, context: any) {
			return renderBgToolResult(result, options, theme, context);
		},
	});
}

/**
 * The `bg_task` transport for the shared get operation. The tool delivers its
 * output synchronously in the result, so a handoff it produced successfully is
 * committed by the operation itself; an uncertified capture comes back with its
 * loss metadata and no acknowledgment, and is described as such. The
 * compatibility `bg_status log` action uses the same transport, so its read is
 * acknowledged by the same path rather than by a second channel.
 */
async function getResultResult(
	deps: RegistrationDeps,
	task: ManagedTask,
	output: "preview" | "full" | undefined,
	action: "get" | "stop" | "log",
): Promise<[string, Record<string, unknown>]> {
	const { ack, handoff } = await deps.readTaskResult(task, output ?? "preview");
	if (handoff.failure) throw new Error(handoff.failure.message);
	const observation = handoff.observation;
	// A finished task's result has been reported: drop the deferred exit wake
	// instead of announcing work the caller already has.
	if (observation.status !== "running") deps.consumeObservedExitWake(task.id);
	return [
		formatTaskResultText(handoff, ack),
		{
			action,
			ack,
			captureError: handoff.captureError,
			...(handoff.artifact ? { artifact: handoff.artifact, fullOutputPath: truncateForTranscript(handoff.artifact.path, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "" } : {}),
			observation: {
				completionOwed: observation.completionOwed,
				exitCode: observation.exitCode,
				hardDeadlineAt: observation.hardDeadlineAt,
				outputBytes: observation.outputBytes,
				outputChanged: observation.outputChanged,
				outputComplete: observation.outputComplete,
				outputError: observation.outputError,
				outputPreview: observation.outputPreview,
				outputPreviewTruncated: observation.outputPreviewTruncated,
				outputRevision: observation.outputRevision,
				readiness: observation.readiness,
				reviewDeadlineAt: observation.reviewDeadlineAt,
				status: observation.status,
				terminationReason: observation.terminationReason,
			},
			task: compactBackgroundTaskSnapshot(deps.rememberSnapshot(task)),
		},
	];
}

/** One-line inventory of other tasks still running, for spawn acks and wakes. */
function buildRunningInventory(deps: RegistrationDeps, excludeId: string | undefined, keep: string | undefined): string {
	const running = deps.sortedTasks()
		.filter((task) => task.status === "running" && task.stopReason == null && task.id !== excludeId)
		.map((task) => task.id);
	if (running.length === 0) return keep ?? "";
	const list = running.join(", ");
	const note = `Tasks still running: ${list}. You will be woken once each; no polling needed.`;
	return keep ? `${keep}\n${note}` : `\n${note}`;
}

function registerCommands(pi: ExtensionAPI, deps: RegistrationDeps): void {
	const taskIdCompletions = (prefix: string) => {
		const query = prefix.trimStart().toLowerCase();
		const items = deps.sortedTasks()
			.filter((task) => !query || task.id.toLowerCase().startsWith(query) || String(task.pid).startsWith(query))
			.map((task) => ({
				description: `${summarizeTaskStatus(task.status, task.exitCode, task.terminationReason)} · ${task.command}`,
				label: task.id,
				value: task.id,
			}));
		return items.length > 0 ? items : null;
	};

	pi.registerCommand(BG_COMMAND, {
		description: "Background shell task dashboard and controls.",
		getArgumentCompletions(prefix) {
			const trimmed = prefix.trimStart();
			const parts = trimmed.split(/\s+/).filter(Boolean);
			if (parts.length === 0 || (parts.length === 1 && !trimmed.endsWith(" "))) {
				return [
					{ label: "list", value: "list", description: "Show tracked tasks" },
					{ label: "next", value: "next", description: "Move the next bash command to background" },
					{ label: "run", value: "run ", description: "Spawn a background shell task" },
					{ label: "log", value: "log ", description: "Show task log tail" },
					{ label: "watch", value: "watch ", description: "Open the dashboard focused on a task" },
					{ label: "stop", value: "stop ", description: "Terminate a task, or \"all\" for every running task" },
					{ label: "clear", value: "clear", description: "Remove finished tasks" },
				].filter((option) => option.value.trim().startsWith(trimmed.toLowerCase()));
			}
			const [subcommand] = parts;
			if (!(subcommand === "log" || subcommand === "stop" || subcommand === "watch")) return null;
			if (parts.length > 2 || (parts.length === 2 && trimmed.endsWith(" "))) return null;
			const taskQuery = parts[1]?.toLowerCase() ?? "";
			const taskItems = deps.sortedTasks()
				.filter((task) => !taskQuery || task.id.toLowerCase().startsWith(taskQuery) || String(task.pid).startsWith(taskQuery))
				.map((task) => ({
					description: `${summarizeTaskStatus(task.status, task.exitCode, task.terminationReason)} · ${task.command}`,
					label: task.id,
					value: `${subcommand} ${task.id}`,
				}));
			return taskItems.length > 0 ? taskItems : null;
		},
		handler: async (args, ctx) => {
			deps.setActiveCtx(ctx);
			const trimmed = args.trim();
			if (!trimmed) { await openDashboard(ctx, deps.dashboardDeps); return; }
			if (trimmed === "list") { ctx.ui.notify(deps.formatTaskListText(), "info"); return; }
			if (trimmed === "next") { deps.armForcedBackground(ctx, "command"); return; }
			if (trimmed === "clear") { ctx.ui.notify(`Removed ${deps.clearFinishedTasks()} finished background task(s).`, "info"); return; }
			if (trimmed.startsWith("run ")) {
				const task = deps.spawnTask({ command: trimmed.slice(4), cwd: ctx.cwd });
				ctx.ui.notify(`Started ${task.id} (pid ${task.pid}) in the background.`, "info");
				return;
			}
			const inspectMatch = trimmed.match(/^(?:watch|log)\s+(.+)$/);
			if (inspectMatch) {
				const task = deps.resolveTask(inspectMatch[1]?.trim());
				if (!task) { ctx.ui.notify("No background task matched that id or pid.", "warning"); return; }
				if (trimmed.startsWith("log ")) ctx.ui.notify(formatTaskLog(deps.getTaskOutput(task), task.logFile, ctx.cwd), "info");
				else await openDashboard(ctx, deps.dashboardDeps, task);
				return;
			}
			if (trimmed.startsWith("stop ")) {
				const stopped = deps.requestStop(deps.resolveTask(trimmed.slice(5).trim()), "user", "operator");
				ctx.ui.notify(stopped.message, stopped.ok ? "info" : "warning");
				return;
			}
			ctx.ui.notify(`Unknown /${BG_COMMAND} action. Try run <command>, list, log <id>, watch <id>, stop <id>, or clear.`, "warning");
		},
	});

	pi.registerCommand(`${BG_COMMAND}:list`, {
		description: "Show tracked background tasks",
		handler: async (_args, ctx) => { deps.setActiveCtx(ctx); ctx.ui.notify(deps.formatTaskListText(), "info"); },
	});
	pi.registerCommand(`${BG_COMMAND}:next`, {
		description: "Move the next bash command to a background task",
		handler: async (_args, ctx) => { deps.setActiveCtx(ctx); deps.armForcedBackground(ctx, "command"); },
	});
	pi.registerCommand(`${BG_COMMAND}:clear`, {
		description: "Remove finished background tasks",
		handler: async (_args, ctx) => { deps.setActiveCtx(ctx); ctx.ui.notify(`Removed ${deps.clearFinishedTasks()} finished background task(s).`, "info"); },
	});
	pi.registerCommand(`${BG_COMMAND}:run`, {
		description: "Spawn a background shell task: /bg:run <command>",
		handler: async (args, ctx) => {
			deps.setActiveCtx(ctx);
			const command = args.trim();
			if (!command) { ctx.ui.notify("Usage: /bg:run <command>", "warning"); return; }
			const task = deps.spawnTask({ command, cwd: ctx.cwd });
			ctx.ui.notify(`Started ${task.id} (pid ${task.pid}) in the background.`, "info");
		},
	});
	pi.registerCommand(`${BG_COMMAND}:stop`, {
		description: "Terminate a running background task: /bg:stop <id>",
		getArgumentCompletions: taskIdCompletions,
		handler: async (args, ctx) => {
			deps.setActiveCtx(ctx);
			const stopped = deps.requestStop(deps.resolveTask(args.trim()), "user", "operator");
			ctx.ui.notify(stopped.message, stopped.ok ? "info" : "warning");
		},
	});
}

function registerShortcuts(pi: ExtensionAPI, deps: RegistrationDeps): void {
	if (deps.dashboardShortcut !== "none") {
		pi.registerShortcut(deps.dashboardShortcut, {
			description: "Open the background task dashboard",
			handler: async (ctx) => {
				deps.setActiveCtx(ctx as ExtensionContext);
				await openDashboard(ctx as ExtensionContext, deps.dashboardDeps);
			},
		});
	}
	if (deps.dashboardShortcut.toLowerCase() !== "f5") {
		pi.registerShortcut("f5", {
			description: "Open the background task dashboard",
			handler: async (ctx) => {
				deps.setActiveCtx(ctx as ExtensionContext);
				await openDashboard(ctx as ExtensionContext, deps.dashboardDeps);
			},
		});
	}
	if (deps.backgroundBashShortcut !== "none") {
		pi.registerShortcut(deps.backgroundBashShortcut, {
			description: "Move the next not-yet-started bash command to a background task",
			handler: async (ctx) => {
				deps.setActiveCtx(ctx as ExtensionContext);
				deps.armForcedBackground(ctx as ExtensionContext, "shortcut");
			},
		});
	}
	if (deps.widgetToggleShortcut !== "none") {
		pi.registerShortcut(deps.widgetToggleShortcut, {
			description: "Toggle background task mini-dashboard",
			handler: async (ctx) => {
				deps.setActiveCtx(ctx as ExtensionContext);
				deps.toggleWidget();
			},
		});
	}
}

export function registerAll(pi: ExtensionAPI, deps: RegistrationDeps): void {
	// Initial registration happens before the session mode is known, so it is the
	// conservative compatibility surface with `bg_task` only. `bg_status` is
	// deliberately NOT registered here: a mode that must not expose it can never
	// have to remove a definition it already declared.
	registerBgTaskTool(pi, deps, "compat");
	registerCommands(pi, deps);
	registerShortcuts(pi, deps);
}

/**
 * Declares the tool surface for the mode the session actually started in. Called
 * from `session_start`, which is when Pi first tells the extension its mode.
 *
 * - `tui`: `bg_task` is re-registered with exactly spawn/get/stop/list and
 *   `bg_status` is not registered at all.
 * - `print`/`json`/`rpc`/anything unknown: `bg_status` is registered with its
 *   compatibility actions and `bg_task` keeps the full action set, including the
 *   bounded `wait` a child or headless caller may need before it returns.
 *
 * Nothing is ever removed and no active-tool list is rewritten: Pi activates a
 * newly registered tool through its ordinary registration path and honours an
 * existing allow/exclude selection, so a user, child or other extension's choice
 * is preserved by construction rather than repaired afterwards.
 */
export function applyTaskToolSurface(pi: ExtensionAPI, deps: RegistrationDeps, mode: string | undefined): TaskToolSurface {
	const surface = taskToolSurfaceFor(mode);
	registerBgTaskTool(pi, deps, surface);
	if (surface === "compat") registerBgStatusTool(pi, deps);
	return surface;
}
