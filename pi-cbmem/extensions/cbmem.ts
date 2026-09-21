/*
 * pi-cbmem — the codebase-memory graph as native Pi tools, over MCP stdio.
 *
 * This extension replaces both halves of the upstream Pi setup: the generated
 * `cbmem.ts` adapter (one-shot `cbm cli` calls, no daemon, no auto-index) and
 * `cbm-toolbox.ts` (which hid the admin tools after registration). Neither file
 * is referenced any more, so `codebase-memory-mcp install --clients=pi` can
 * regenerate or overwrite them without touching this.
 *
 * Connecting is what turns auto-index on: the server derives the session
 * project from its cwd on `initialize`, indexes it in the background, and
 * registers it with the account-wide git watcher. One child per Pi session, so
 * a herdr pane, a subagent, or a second terminal each get their own project
 * while the server dedupes the shared work.
 *
 * The `project` argument is therefore optional everywhere: when the model
 * omits it the session project is filled in, so no project ids have to be
 * remembered. Config lives in the user settings file under
 * `kendex.extensionManager.config["@vanillagreen/pi-cbmem"]`.
 */

import { execFile } from "node:child_process";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { readSettingsFile, resolveConfig, type CbmemConfig, sessionProjectFor } from "./config.js";
import { CbmServer } from "./server.js";
import { selectTools, wireParameters, type ToolSpec } from "./tools.js";

export default function piCbmem(pi: ExtensionAPI): void {
	const config = resolveConfig(readSettingsFile());

	if (!config.enabled) {
		registerStatusCommand(pi, () => config, null, undefined);
		return;
	}

	const specs = selectTools(config);
	let server: CbmServer | null = null;
	let serverCwd: string | undefined;
	let sessionProject: string | undefined;
	let sessionCwd: string | undefined;
	let ui: ExtensionContext["ui"] | undefined;
	let warned = false;

	const notify = (message: string, level: "info" | "warning" | "error" = "warning") => {
		if (!config.notifyOnError && level !== "info") return;
		try {
			ui?.notify(message, level);
		} catch {
			/* no UI in this mode */
		}
	};

	/** One server per session cwd; a new cwd replaces the old child. */
	const ensureServer = (cwd: string): CbmServer => {
		if (server && serverCwd === cwd) return server;
		server?.stop();
		server = new CbmServer({ binary: config.binary, cwd, requestTimeoutMs: config.requestTimeoutMs });
		serverCwd = cwd;
		return server;
	};

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx?.ui;
		const cwd = ctx?.cwd ?? process.cwd();
		sessionCwd = cwd;
		sessionProject = config.project ?? sessionProjectFor(cwd);
		const current = ensureServer(cwd);
		if (config.connectOnSessionStart) {
			void current.connect().catch((error: Error) => {
				// A shutdown that races the handshake is deliberate, not a failure:
				// the server object was stopped while the child was still coming up.
				if (current === server && !warned) {
					warned = true;
					notify(`pi-cbmem: ${error.message}`);
				}
			});
		}
	});

	pi.on("session_shutdown", async () => {
		server?.stop();
		server = null;
		serverCwd = undefined;
	});

	for (const spec of specs) {
		pi.registerTool({
			name: spec.name,
			label: spec.name,
			description: spec.description,
			promptSnippet: spec.snippet,
			...(spec.guidelines ? { promptGuidelines: spec.guidelines } : {}),
			parameters: wireParameters(spec),
			execute: async (_toolCallId, params: Record<string, unknown>, signal: AbortSignal, _onUpdate, ctx) => {
				const cwd = ctx?.cwd ?? sessionCwd ?? process.cwd();
				sessionProject ??= config.project ?? sessionProjectFor(cwd);
				const current = ensureServer(cwd);
				const args = withProject(spec, params, sessionProject);
				const result = await current.call(spec.name, args, signal);
				return {
					content: Array.isArray(result.content)
						? result.content
						: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }],
					details: result,
				};
			},
		});
	}

	registerStatusCommand(pi, () => config, () => server, () => sessionProject, specs);
}

/** Add the session project when the tool takes one and the call left it out. */
function withProject(
	spec: ToolSpec,
	params: Record<string, unknown>,
	sessionProject: string | undefined,
): Record<string, unknown> {
	if (!spec.injectProject || params.project || !sessionProject) return { ...params };
	return { project: sessionProject, ...params };
}

/**
 * `/cbm` — what this session is pointed at, and what the server is doing.
 *
 * Worth having because everything that matters here is invisible: which project
 * the cwd resolved to, whether the child is up, and which tools this config
 * registered. All three are the first things to check when a query comes back
 * "project not found".
 */
function registerStatusCommand(
	pi: ExtensionAPI,
	getConfig: () => CbmemConfig,
	getServer: (() => CbmServer | null) | null,
	getProject: (() => string | undefined) | undefined,
	specs: ToolSpec[] = [],
): void {
	pi.registerCommand?.("cbm", {
		description: "codebase-memory: server, project, and tool status",
		handler: async (args: string, ctx: ExtensionContext) => {
			const config = getConfig();
			const lines: string[] = [];
			lines.push(`pi-cbmem: ${config.enabled ? "enabled" : "disabled"}`);
			if (!config.enabled) {
				lines.push("Set kendex.extensionManager.config[\"@vanillagreen/pi-cbmem\"].enabled to true.");
				notifyLines(ctx, lines);
				return;
			}

			const cwd = ctx?.cwd ?? process.cwd();
			const project = config.project ?? getProject?.() ?? sessionProjectFor(cwd);
			lines.push(`cwd:     ${cwd}`);
			lines.push(`project: ${project ?? "(none — cwd is not a project root)"}`);
			if (config.project) lines.push("         (pinned by config.project)");

			const server = getServer?.() ?? null;
			lines.push(
				`server:  ${server ? `${server.state}${server.pid ? ` pid ${server.pid}` : ""}` : "not started"}` +
					(server?.lastError && server.state === "failed" ? ` — ${server.lastError}` : ""),
			);
			lines.push(`binary:  ${config.binary}`);
			lines.push(`tools:   ${specs.map((spec) => spec.name).join(", ") || "(none registered)"}`);

			if (args.trim() === "config") {
				lines.push("", "config:");
				for (const [key, value] of Object.entries(config)) {
					lines.push(`  ${key} = ${JSON.stringify(value)}`);
				}
			}
			if (args.trim() === "server") {
				const info = await readServerConfig(config.binary, cwd);
				lines.push("", "server config:", ...info);
			}
			notifyLines(ctx, lines);
		},
	});
}

function notifyLines(ctx: ExtensionContext, lines: string[]): void {
	const text = lines.join("\n");
	try {
		ctx.ui.notify(text, "info");
	} catch {
		/* no UI in this mode */
	}
}

/**
 * `codebase-memory-mcp config list` plus `daemon status`, both plain CLI reads
 * that never start the daemon. Best effort: a missing binary or an older build
 * without `daemon status` shows what it can.
 */
async function readServerConfig(binary: string, cwd: string): Promise<string[]> {
	const out: string[] = [];
	for (const args of [["config", "list"], ["daemon", "status"]]) {
		try {
			const text = await run(binary, args, cwd);
			out.push(...text.trim().split("\n").map((line) => `  ${line}`));
		} catch (error) {
			out.push(`  ${args.join(" ")}: ${(error as Error).message}`);
		}
	}
	return out;
}

function run(binary: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(binary, args, { cwd, timeout: 5_000 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}
