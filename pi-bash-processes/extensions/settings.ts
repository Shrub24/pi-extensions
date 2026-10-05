import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";

import { CONFIG_ID } from "./constants.js";
import { expandHome, piUserDir, readPackageConfig } from "./package-config.js";
import { installDeclaredCli } from "./cli-install.js";
import { BRIDGE_SOCKET_SUFFIX } from "./bridge.js";
import type { kendexConfig } from "./types.js";

export function readkendexConfig(cwd?: string): kendexConfig {
	return readPackageConfig(CONFIG_ID, cwd) as kendexConfig;
}

export function settingNumber(key: string, fallback: number, cwd?: string): number {
	const value = readkendexConfig(cwd)[key];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function settingBoolean(key: string, fallback: boolean, cwd?: string): boolean {
	const value = readkendexConfig(cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

/**
 * Managed shells run with `pipefail`, so a failing stage fails the pipeline
 * instead of hiding behind the last stage's exit code. Only shells known to
 * accept `-o pipefail` are touched; `managedShellPipefail: false` opts out.
 */
export function pipefailShellArgs(shell: string, args: string[], cwd?: string): string[] {
	if (!settingBoolean("managedShellPipefail", true, cwd)) return args;
	const name = basename(shell);
	return name === "bash" || name === "zsh" ? ["-o", "pipefail", ...args] : args;
}

export function settingString(key: string, fallback: string, cwd?: string): string {
	const value = readkendexConfig(cwd)[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export function settingEnum<T extends string>(key: string, allowed: readonly T[], fallback: T, cwd?: string): T {
	const value = readkendexConfig(cwd)[key];
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function taskDir(): string {
	const configured = settingString("taskDir", "");
	return process.env.PI_BG_TASK_DIR?.trim() || (configured ? resolve(expandHome(configured)) : join(tmpdir(), "kendex-pi-bg"));
}

function safeLabel(input: string): string {
	return input.replaceAll(/[^a-z0-9-]+/gi, "-").replaceAll(/^-+|-+$/g, "").slice(0, 48) || "task";
}

/** The log file for task `id`, in the lane directory `laneDir`. */
export function logFilePath(laneDir: string, id: string, now: number = Date.now()): string {
	return join(laneDir, `${safeLabel(id)}-${now}.log`);
}

/** The folder, inside the task directory, that holds this package's lane
 *  directories. The task directory is a user setting that may hold other
 *  tools' folders; the retention prune reads only this one. */
export function taskLanesRoot(): string {
	return join(taskDir(), "lanes");
}

/** Directory holding the declared `pi-bg` CLI installed for managed shells. */
export function binDir(): string {
	return join(taskDir(), "bin");
}

/**
 * The session-private control socket.
 *
 * Deliberately outside the task directory: that directory is live-output
 * storage (task logs, lanes, retained artifacts), swept by retention that has
 * no business touching a live endpoint, and a user-configurable location that a
 * transient socket has no claim on. The platform's per-user runtime directory
 * is the standard home for it, with the system temp directory as the fallback;
 * the name carries the session and the owning process, so a restart takes a
 * fresh endpoint instead of colliding with one the previous process may still
 * be serving. Session binding itself is enforced by the protocol — a request
 * that names another session is refused — and the 0700 directory keeps the file
 * to this user, which is the same scoping the design asks for and no more.
 */
export function bridgeSocketPath(sessionId: string): string {
	return join(bridgeRuntimeDir(), `${safeSessionName(sessionId)}-${process.pid}${BRIDGE_SOCKET_SUFFIX}`);
}

function bridgeRuntimeDir(): string {
	const base = process.env.XDG_RUNTIME_DIR?.trim();
	return join(base && base.startsWith("/") ? base : tmpdir(), "kendex-pi-bg-ipc");
}

function safeSessionName(sessionId: string): string {
	return sessionId.replace(/[^\w.-]+/g, "_") || "session";
}

/** The directory one session's task logs live in, under taskLanesRoot. */
export function taskLaneDir(sessionId: string): string {
	return join(taskLanesRoot(), sessionId.replace(/[^\w.-]+/g, "_"));
}

/**
 * The environment for a managed shell. `bridge` is the declared CLI's half:
 * without it a `pi-bg get|list|stop` reports an unavailable endpoint instead of
 * guessing at live state.
 */
export function taskEnv(_laneDir: string, bridge?: { socketPath: string; sessionId: string }): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const binDir = join(piUserDir(), "bin");
	if (existsSync(binDir)) {
		const current = env.PATH || "";
		const parts = current.split(delimiter).filter(Boolean);
		if (!parts.includes(binDir)) env.PATH = [binDir, ...parts].join(delimiter);
	}
	// Managed bash gets the declared CLI on PATH. Nothing else is interposed: a
	// plain read of a log file is just a read and changes no notification state.
	return { ...env, ...declaredCliEnv(bridge) };
}

/**
 * PATH overlay that puts the declared `pi-bg` CLI on a managed shell's PATH and
 * names the session endpoint it must speak to.
 *
 * Nothing else is exported any more. The retired read shims also exported
 * `PI_BG_CONSUME_LOG`, `PI_BG_LOG_DIR`, `PI_BG_LOG_GLOB` and `PI_BG_REAL_PATH`
 * so wrappers could report which log a command opened; with the wrappers gone
 * those exports would advertise a live-log path nothing acts on, so they are
 * gone with them.
 */
export function declaredCliEnv(bridge?: { socketPath: string; sessionId: string }): Record<string, string> {
	const env = bridge
		? { PI_BG_SOCKET: bridge.socketPath, PI_BG_SESSION: bridge.sessionId }
		: {};
	const dir = installDeclaredCli(binDir());
	if (!dir) return env;
	return {
		...env,
		PATH: [dir, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
	};
}
