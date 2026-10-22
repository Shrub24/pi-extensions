// Pi tool / command / shortcut registrations for pi-background-tasks.
//
// The host closure builds a RegistrationDeps
// object from its private state and calls registerAll(pi, deps). Each
// registration handler captures `deps` via closure, so the extracted
// module stays free of cross-module mutable state.

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { BG_COMMAND } from "./constants.js";
import { duplicateTaskNote } from "./auto-background.js";
import { getIntent, intentHardRequired, intentModeFor, intentParameters, intentPrepare, intentSuffix, stripIntent, withIntentParameter } from "./intent.js";
import { BASH_TASK_GUIDELINES, BG_TASK_ACTIONS } from "./tool-surface.js";
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
	/** True when a deferred exit wake for this task was dropped. */
	consumeObservedExitWake: (taskId: string) => boolean;
	armForcedBackground: (ctx: ExtensionContext, source: "shortcut" | "command") => void;
	toggleWidget: () => void;
	dashboardDeps: DashboardDeps;
	dashboardShortcut: string;
	backgroundBashShortcut: string;
	widgetToggleShortcut: string;
}

/** `bg_task` guidance, appended to the system prompt only while the tool is active. */
function bgTaskGuidelines(): string[] {
	return [
		...BASH_TASK_GUIDELINES,
		"Use bg_task list/get/stop/extend to inspect, re-arm, or terminate tasks started by bg_task or /bg. get is the task's result, including its readiness and outcome.",
	"A soft reminder is a check-in, not a result: completion always wakes you, so softTimeoutMs only sets how often you are reminded. For a build, test run, or watcher, set softTimeoutMs at spawn to about its expected duration (or 0 to disable reminders); re-arm later with bg_task action:\"extend\" id:... softTimeoutMs:....",
	"Set needsResult:false at spawn for work whose result you will not read (a smoke test, a timing wait, a log tail): its completion is still reported, but it starts no turn, asks for no retrieval, and never holds an assignment open.",
		"After a task starts, continue independent work; when there is nothing left to do, end the turn and let its wake arrive. A soft reminder is the decision point if it takes longer than expected.",
		"Use bg_task for pi-bridge, session, tmux, agent/delegate, or log monitoring instead of raw foreground bash polling loops.",
		"If a bash monitor is auto-backgrounded, continue the turn and inspect it later with bg_task get/list/stop rather than waiting on foreground bash.",
	];
}

/** Bash-specific prompt guidance; the shared task contract is contributed by `bg_task`. */
export function bashPromptGuidelines(): string[] {
	return ["You can inspect PI_* environment variables for current model and session details."];
}

/** The `bg_task` parameter schema. */
const bgTaskSchema = () => Type.Object({
	action: StringEnum(BG_TASK_ACTIONS, {
		description: "spawn=start a task, get=the task's result (state, outcome, output preview or full immutable output), stop=terminate and return the result, list=show tasks, extend=reset the soft reminder, optionally at a new interval",
	}),
	command: Type.Optional(Type.String({ description: "Shell command for action=spawn" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for action=spawn" })),
	id: Type.Optional(Type.String({ description: "Task id for action=get, action=stop, or action=extend." })),
	notifyOnExit: Type.Optional(Type.Boolean({ description: "Wake the agent when the task exits. Defaults to true." })),
	needsResult: Type.Optional(Type.Boolean({
		description: "Whether the task's result is meant to be consumed. Defaults to true. Set false for informational work (a smoke test, a timing wait, a log tail): completion is still reported, but the wake starts no turn, asks for no retrieval, and the task never holds an assignment open.",
	})),
	notifyOnOutput: Type.Optional(Type.Boolean({ description: "Wake the agent when new output arrives. Defaults to false." })),
	notifyPattern: Type.Optional(Type.String({ description: "Substring or /regex/flags gate for output wakeups." })),
	notifyMode: Type.Optional(StringEnum(NOTIFY_MODES, {
		description: "Output wake mode: always=every output update, transition=only changed output tail hash, first-match-only=one notifyPattern match then suppress output wakes. Default: first-match-only when notifyPattern is set, transition otherwise (set 'always' explicitly to opt into every-output wakes).",
	})),
	dedupeKey: Type.Optional(Type.String({ description: "Optional key used by notifyMode=transition to coalesce matching output wakes across tasks." })),
	pid: Type.Optional(Type.Number({ description: "PID for action=get or action=stop" })),
	output: Type.Optional(StringEnum(["preview", "full"] as const, {
		description: "For action=get or action=stop: preview=an inline preview of captured output (default), full=flush the capture and hand over the complete immutable output for this task.",
	})),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Hard timeout for spawned tasks. Defaults to 0 (disabled)." })),
	softTimeoutMs: Type.Optional(Type.Number({
		description: "Soft progress reminder in milliseconds for action=spawn, or for action=extend to re-arm it later. Set it generously for a long-running task such as a watcher or log monitor, or 0 to disable it. Defaults to 600000 (10 minutes). Soft expiry never stops the process: it asks the agent to continue or stop.",
	})),
	title: Type.Optional(Type.String({ description: "Optional display label for action=spawn" })),
	watcherGuidance: Type.Optional(Type.String({
		maxLength: 240,
		description: "Optional instruction for the soft reminder's advisory offer: action=spawn sets it, action=extend replaces it, and an extend that omits it keeps the stored one. A wake consumer may read it when deciding whether the reminder is worth delivering now. It is data for that consumer, never a command the task runs, and it changes no reminder when no consumer is loaded.",
	})),
});

/**
 * Registers `bg_task`. Pi activates a newly registered tool through its ordinary
 * registration path, so a user or child selection that already excluded the name
 * is never overridden.
 */
export function registerBgTaskTool(pi: ExtensionAPI, deps: RegistrationDeps): void {
	pi.registerTool({
		renderShell: "self",
		name: "bg_task",
		intent: "start, inspect, or stop a managed background process",
		label: "Background Task",
		description: "Spawn, inspect, and stop explicit background shell tasks. Tasks write persistent logs, do not time out by default, stop as a process group on Unix, and can wake the agent on exit or matching output. The background-tasks extension also auto-diverts recognized bash monitoring loops before they block.",
		promptSnippet: "Spawn, inspect, and stop explicit non-blocking background shell tasks.",
		promptGuidelines: bgTaskGuidelines(),
		parameters: intentParameters("bg_task", bgTaskSchema()), async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			const intent = getIntent(params);
			if (params.action === "spawn" && intent) {
				params.title = typeof params.title === "string" && params.title.trim() ? params.title : intent;
			}
			if (params.action === "list") {
				const tasks = deps.sortedTasks().map(deps.rememberSnapshot);
				return makeToolResult(deps.formatTaskListText(), { action: "list", tasks: bgToolResultTasks(tasks) });
			}
			if (params.action === "spawn") {
				const task = deps.spawnTask({
					command: params.command ?? "",
					cwd: params.cwd,
					notifyOnExit: params.notifyOnExit,
					needsResult: params.needsResult,
					notifyOnOutput: params.notifyOnOutput,
					notifyPattern: params.notifyPattern,
					notifyMode: params.notifyMode,
					dedupeKey: params.dedupeKey,
					timeoutSeconds: params.timeoutSeconds,
					softTimeoutMs: params.softTimeoutMs,
					watcherGuidance: params.watcherGuidance,
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
			const task = deps.resolveTask(params.id, params.pid);
			if (!task) throw new Error("No background task matched that id or pid.");
			if (params.action === "extend") {
				const extended = deps.extendSoftTimeout(task, params.softTimeoutMs, params.watcherGuidance);
				if (!extended.ok) throw new Error(extended.message);
				return makeToolResult(extended.message, { action: "extend", task: compactBackgroundTaskSnapshot(deps.rememberSnapshot(task)) });
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
 * loss metadata and no acknowledgment, and is described as such.
 */
async function getResultResult(
	deps: RegistrationDeps,
	task: ManagedTask,
	output: "preview" | "full" | undefined,
	action: "get" | "stop",
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
			if (trimmed === "clear") { const { removed, kept } = deps.clearFinishedTasks(); ctx.ui.notify(`Removed ${removed} finished background task(s).${kept > 0 ? ` Kept ${kept} running or unretrieved task(s).` : ""}`, "info"); return; }
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
		handler: async (_args, ctx) => { deps.setActiveCtx(ctx); const { removed, kept } = deps.clearFinishedTasks(); ctx.ui.notify(`Removed ${removed} finished background task(s).${kept > 0 ? ` Kept ${kept} running or unretrieved task(s).` : ""}`, "info"); },
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
	registerCommands(pi, deps);
	registerShortcuts(pi, deps);
}
