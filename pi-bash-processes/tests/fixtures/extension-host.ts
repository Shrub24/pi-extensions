import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createToolRegistry, declaredActionEnum } from "./tool-surface-harness.js";

/**
 * In-process host for the background-tasks extension: the real extension
 * loaded against a minimal Pi surface, with the package's own settings file,
 * so a test can dispatch the events Pi emits and call the registered tools
 * directly.
 *
 * Unlike the spawn fixtures there is no native interception here: commands run
 * for real, which is what the codemode contracts need — a script's bash has to
 * finish on its own instead of being driven by a fake child, and Pi's own bash
 * tool is the real one.
 *
 * One host per test file: the host environment (HOME, the agent directory, the
 * task directory) is process-wide and Pi's settings reads are memoized over it,
 * so a second host started after the first serves its own settings to both.
 * Bun runs one file at a time, so a host created at a file's top level owns the
 * environment until its `dispose()`.
 */
export interface HostTool {
	name: string;
	/** `outputSchema` the tool declares to Pi and to codemode scripts. */
	outputSchema?: unknown;
	/** The parameter schema Pi validates a call against before `execute`. */
	parameters?: unknown;
	/** Description declared to Pi, for the effective-prompt audit. */
	description?: string;
	/** One-line "Available tools" snippet Pi shows for an active tool. */
	promptSnippet?: string;
	/** Guideline bullets Pi appends while this tool is active. */
	promptGuidelines?: string[];
	/** How the model reaches the tool. Default: `"direct"`. */
	exposure?: string;
	/** Pi's `defaultActive === false` opt-out from activation on registration. */
	defaultActive?: boolean;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
		ctx?: unknown,
	): Promise<HostToolResult>;
}
export interface HostToolResult {
	content: { type: string; text?: string }[];
	details: Record<string, any>;
	structuredContent?: Record<string, any>;
	isError?: boolean;
}

export interface ExtensionHost {
	/** Temp root holding the agent dir, home, task logs and working directory. */
	root: string;
	/** Working directory commands run in. */
	cwd: string;
	/** The session context Pi hands a tool's `execute()`. */
	ctx: ExtensionContext;
	tools: Map<string, HostTool>;
	/** Every `pi.sendMessage` call, wakes included. */
	messages: unknown[][];
	/** Every `pi.appendEntry` call: the extension's persisted state. */
	entries: unknown[];
	/** The handler results of one `agent_settled` boundary. */
	settle(): Promise<unknown[]>;
	dispatch(event: string, payload?: unknown): Promise<unknown[]>;
	/** `bg_task list` tasks, as the model would see them. */
	listTasks(): Promise<Record<string, any>[]>;
	/** The names Pi declares to the model, in registration order. */
	activeTools(): string[];
	/** Every registered tool, whether active or not, as Pi reports it. */
	allTools(): { name: string; description?: string; promptGuidelines?: string[]; exposure: string; actionEnum: string[] | null }[];
	/**
	 * The model-visible prompt surface: the "Available tools" snippet and the
	 * Guidelines bullets Pi builds from the ACTIVE tools only. This is the audit
	 * surface a mode's guidance has to be judged on — not the TypeBox literal a
	 * tool happened to be registered with.
	 */
	systemPromptSurface(): { availableTools: string[]; guidelines: string[] };
	/**
	 * Bounded wait for a task's terminal record *and* its certified capture.
	 *
	 * `status !== "running"` alone is not terminal readiness: the process can be
	 * closed while the writer still holds its last bytes, in which case the
	 * product's own rule says the capture is not a complete handoff yet. A test
	 * that waits only on `status` can therefore read a log whose final bytes have
	 * not landed and mis-attribute a fixture race to the product. This waits on
	 * the readiness the contract actually names, and fails loudly rather than
	 * returning with the precondition unmet.
	 */
	settledTask(id: string, budgetMs?: number): Promise<Record<string, any>>;
	dispose(): Promise<void>;
}

export interface ExtensionHostOptions {
	/** Package settings merged over the host defaults. */
	settings?: Record<string, unknown>;
	/**
	 * The session mode Pi reports on `ctx.mode`. Defaults to `"print"`, the
	 * conservative compatibility mode, so a test opts in to the TUI surface
	 * explicitly instead of inheriting it.
	 */
	mode?: string;
	/**
	 * An explicit tool allowlist, as `--tools` or a configured selection supplies.
	 * Pi activates a newly registered tool only when the allowlist names it, and
	 * never registers an excluded one.
	 */
	activeTools?: string[];
	/** An explicit tool exclusion, as a configured `disabledTools` entry supplies. */
	excludedTools?: string[];
	/**
	 * Extra `kendex.extensionManager.config` entries, by package id. The intent
	 * argument's mode is read by `pi-tool-renderer` from its own package config,
	 * and the extension reads it while registering its tools.
	 */
	packageConfig?: Record<string, Record<string, unknown>>;
}

const PACKAGE_ID = "@vanillagreen/pi-background-tasks";

export async function startExtensionHost(options: ExtensionHostOptions = {}): Promise<ExtensionHost> {
	const scratch = resolve(import.meta.dir, "../../../..", "tmp");
	mkdirSync(scratch, { recursive: true });
	const root = realpathSync(mkdtempSync(join(scratch, "extension-host-")));
	const cwd = join(root, "work");
	for (const name of ["agent", "home", "logs", "work"]) mkdirSync(join(root, name));
	// Only settings this contract needs: finished-task retention and the wake
	// debounce stay out of the way, and the foreground window is short enough
	// that a command meant to outlive it does.
	writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({
		kendex: {
			extensionManager: {
				config: {
					[PACKAGE_ID]: { showWidget: false, exitWakeBatchMs: 0, foregroundYieldMs: 20_000, ...options.settings },
					...options.packageConfig,
				},
			},
		},
	}));

	const previousEnv = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		PATH: process.env.PATH,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_BG_TASK_DIR: process.env.PI_BG_TASK_DIR,
		PI_BG_CONSUME_LOG: process.env.PI_BG_CONSUME_LOG,
		PI_BG_LOG_DIR: process.env.PI_BG_LOG_DIR,
		PI_BG_LOG_GLOB: process.env.PI_BG_LOG_GLOB,
		PI_BG_REAL_PATH: process.env.PI_BG_REAL_PATH,
	};
	// The extension resolves its settings and task directory from the
	// environment, so these must be in place before the module is imported. A
	// host must also not start inside another managed bash: with that session's
	// shim directory still on PATH, one of its shims would resolve to itself
	// through the inherited PI_BG_REAL_PATH instead of to the real tool.
	process.env.HOME = join(root, "home");
	process.env.USERPROFILE = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_BG_TASK_DIR = join(root, "logs");
	for (const key of ["PI_BG_CONSUME_LOG", "PI_BG_LOG_DIR", "PI_BG_LOG_GLOB", "PI_BG_REAL_PATH"] as const) delete process.env[key];
	process.env.PATH = (previousEnv.PATH ?? "").split(":").filter((entry) => !entry.endsWith("/shims")).join(":");

	const restoreEnv = () => {
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};

	const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	const tools = new Map<string, HostTool>();
	const messages: unknown[][] = [];
	const entries: unknown[] = [];
	const notifications: unknown[][] = [];
	const entriesForBranch: unknown[] = [];
	const ctx = {
		cwd,
		hasUI: false,
		mode: options.mode ?? "print",
		isIdle: () => true,
		isProjectTrusted: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => `extension-host-${process.pid}`,
			getSessionFile: () => join(cwd, "session.jsonl"),
			getBranch: () => entriesForBranch,
		},
		ui: {
			notify: (...args: unknown[]) => notifications.push(args),
			setWidget() {},
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerTool(tool: HostTool) {
			tools.set(tool.name, tool);
			registry.register(tool);
		},
		getActiveTools: () => registry.getActiveTools(),
		getAllTools: () =>
			registry.getAllTools().map((tool) => ({
				description: tool.description,
				exposure: tool.exposure ?? "direct",
				name: tool.name,
				parameters: tool.parameters,
				promptGuidelines: tool.promptGuidelines,
				sourceInfo: { extensionPath: PACKAGE_ID, source: "extension" },
			})),
		setActiveTools: (names: string[]) => registry.setActiveTools(names),
		refreshTools: () => registry.refresh(),
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
			return () => {};
		},
		appendEntry(customType: string, data: unknown) {
			const entry = { type: "custom", customType, data };
			entries.push(entry);
			entriesForBranch.push(entry);
		},
		sendMessage: (...args: unknown[]) => messages.push(args),
		events: { on: () => () => {} },
	} as unknown as ExtensionAPI;

	// Pi's real registry and prompt rules, shared with the surface tests.
	const registry = createToolRegistry({ activeTools: options.activeTools, excludedTools: options.excludedTools });

	const dispatch = async (event: string, payload?: unknown): Promise<unknown[]> => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload ?? {}, ctx));
		return results;
	};

	try {
		const { default: backgroundTasks } = await import("../../extensions/background-tasks.js");
		backgroundTasks(pi);
		await dispatch("session_start");
	} catch (error) {
		restoreEnv();
		rmSync(root, { recursive: true, force: true });
		throw error;
	}

	const readTasks = async (): Promise<Record<string, any>[]> => {
		const listed = await tools.get("bg_task")!.execute("list-tasks", { action: "list" });
		const tasks = listed.details.tasks;
		return Array.isArray(tasks) ? tasks : [];
	};

	const host: ExtensionHost = {
		root,
		cwd,
		ctx,
		tools,
		messages,
		entries,
		settle: () => dispatch("agent_settled"),
		dispatch,
		listTasks: readTasks,
		activeTools: () => registry.getActiveTools(),
		allTools: () =>
			registry.getAllTools().map((tool) => ({
				actionEnum: declaredActionEnum(tool),
				description: tool.description,
				exposure: tool.exposure ?? "direct",
				name: tool.name,
				promptGuidelines: tool.promptGuidelines,
			})),
		systemPromptSurface: () => registry.systemPromptSurface(),
		async settledTask(id, budgetMs = 20_000) {
			const deadline = Date.now() + budgetMs;
			for (;;) {
				const task = (await readTasks()).find((candidate) => candidate.id === id);
				if (task && task.status !== "running" && task.resultReady === true) return task;
				if (Date.now() >= deadline) {
					throw new Error(`task ${id} did not reach a certified terminal record within ${budgetMs}ms: ${JSON.stringify(task ?? null)}`);
				}
				await Bun.sleep(5);
			}
		},
		async dispose() {
			try {
				await dispatch("session_shutdown");
			} finally {
				restoreEnv();
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
	return host;
}
