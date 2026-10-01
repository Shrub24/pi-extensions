import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { CONFIG_ID } from "./constants.js";
import { expandHome, piUserDir, readPackageConfig } from "./package-config.js";
import { installReadShims } from "./read-shim.js";
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

/** Directory holding the managed-bash read shims (cat/tail/head/…, pi-bg). */
export function shimDir(): string {
	return join(taskDir(), "shims");
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

let prunedBridgeSockets = false;
/**
 * Drops control sockets whose owning process is gone. Best effort, once per
 * process. Liveness is the pid the name records, so this needs no probing: a
 * socket left by a crashed session is removed the next time any session starts,
 * and one still owned by a live process is left alone.
 */
function pruneStaleBridgeSockets(): void {
	if (prunedBridgeSockets) return;
	prunedBridgeSockets = true;
	const dir = bridgeRuntimeDir();
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith(BRIDGE_SOCKET_SUFFIX)) continue;
		const owner = /-([0-9]+)\.sock$/.exec(entry);
		if (!owner) continue;
		const pid = Number(owner[1]);
		if (pid === process.pid) continue;
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch (error) {
			alive = (error as NodeJS.ErrnoException).code === "EPERM";
		}
		if (alive) continue;
		try {
			rmSync(join(dir, entry), { force: true });
		} catch {
			// Best effort.
		}
	}
}

/**
 * Append-only file the read shims write to when a managed log is read.
 * Drained (and truncated) before any wake is handed over, so a read that
 * happened while the run was still going cancels that task's wake.
 *
 * Per process, not one shared file: the task dir is shared by every Pi session
 * on the machine, while a drain matches records against its own task map and
 * truncates whatever it read. With one shared file, any other session's flush
 * could swallow a record before the session that owns the task saw it — the
 * read was silently lost and the exit wake fired anyway.
 */
export function consumeLogPath(): string {
	return join(taskDir(), `consumed-${process.pid}.log`);
}

let prunedConsumeLogs = false;
/** Drops per-process consume logs whose session is long gone. Best effort, once per process. */
function pruneStaleConsumeLogs(): void {
	if (prunedConsumeLogs) return;
	prunedConsumeLogs = true;
	try {
		const dir = taskDir();
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		for (const entry of readdirSync(dir)) {
			if (!/^consumed-\d+\.log$/.test(entry) || entry === `consumed-${process.pid}.log`) continue;
			const file = join(dir, entry);
			try {
				if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
			} catch {
				// Best effort.
			}
		}
	} catch {
		// Best effort.
	}
}

/** The directory one session's task logs live in, under taskLanesRoot. */
export function taskLaneDir(sessionId: string): string {
	return join(taskLanesRoot(), sessionId.replace(/[^\w.-]+/g, "_"));
}

/**
 * The environment for a managed shell. `laneDir` is the task lane whose logs
 * the read shims must recognise, so a read of a task log is recorded against
 * the session that owns it.
 */
export function taskEnv(laneDir: string, bridge?: { socketPath: string; sessionId: string }): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const binDir = join(piUserDir(), "bin");
	if (existsSync(binDir)) {
		const current = env.PATH || "";
		const parts = current.split(delimiter).filter(Boolean);
		if (!parts.includes(binDir)) env.PATH = [binDir, ...parts].join(delimiter);
	}
	// Managed bash gets the read shims on PATH so a plain `tail`/`cat`/`grep`
	// read of a task log is observable without guessing at command strings.
	return { ...env, ...readShimEnv(laneDir, bridge) };
}

/**
 * PATH overlay that installs the managed-bash read shims and tells them which
 * paths count as task logs and where to report a read. The shims exec the real
 * binary, so behavior is unchanged except for the side-channel append.
 *
 * `bridgeSocketPath`/`sessionId` are the declared CLI's half: without them
 * `pi-bg get|list|stop` reports an unavailable endpoint instead of guessing.
 */
export function readShimEnv(laneDir: string, bridge?: { socketPath: string; sessionId: string }): Record<string, string> {
	pruneStaleConsumeLogs();
	pruneStaleBridgeSockets();
	const dir = installReadShims(shimDir());
	const env = bridge
		? { PI_BG_SOCKET: bridge.socketPath, PI_BG_SESSION: bridge.sessionId }
		: {};
	if (!dir) return env;
	return {
		...env,
		PATH: [dir, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
		PI_BG_CONSUME_LOG: consumeLogPath(),
		PI_BG_LOG_DIR: laneDir,
		PI_BG_LOG_GLOB: `${laneDir}/*`,
		PI_BG_REAL_PATH: process.env.PATH ?? "",
	};
}
