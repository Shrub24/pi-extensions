import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { CONFIG_ID } from "./constants.js";
import { expandHome, piUserDir, readPackageConfig } from "./package-config.js";
import { installReadShims } from "./read-shim.js";
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
export function taskEnv(laneDir: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const binDir = join(piUserDir(), "bin");
	if (existsSync(binDir)) {
		const current = env.PATH || "";
		const parts = current.split(delimiter).filter(Boolean);
		if (!parts.includes(binDir)) env.PATH = [binDir, ...parts].join(delimiter);
	}
	// Managed bash gets the read shims on PATH so a plain `tail`/`cat`/`grep`
	// read of a task log is observable without guessing at command strings.
	return { ...env, ...readShimEnv(laneDir) };
}

/**
 * PATH overlay that installs the managed-bash read shims and tells them which
 * paths count as task logs and where to report a read. The shims exec the real
 * binary, so behavior is unchanged except for the side-channel append.
 */
export function readShimEnv(laneDir: string): Record<string, string> {
	pruneStaleConsumeLogs();
	const dir = installReadShims(shimDir());
	if (!dir) return {};
	return {
		PATH: [dir, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
		PI_BG_CONSUME_LOG: consumeLogPath(),
		PI_BG_LOG_DIR: laneDir,
		PI_BG_LOG_GLOB: `${laneDir}/*`,
		PI_BG_REAL_PATH: process.env.PATH ?? "",
	};
}
