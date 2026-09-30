import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { CONFIG_ID } from "./constants.js";
import { installReadShims } from "./read-shim.js";
import type { kendexConfig } from "./types.js";

export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

function projectSettingsPath(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi", "settings.json");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(current, ".pi")) || existsSync(join(current, ".git")) || existsSync(join(current, ".kendex-lock.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi", "settings.json");
		current = parent;
	}
}

const PROJECT_TRUST_SYMBOL = Symbol.for("kendex.pi.project-trust");

interface ProjectTrustRegistry {
	projectSettings?: Map<string, boolean>;
}

function projectTrustRegistry(): ProjectTrustRegistry {
	const host = globalThis as unknown as Record<PropertyKey, ProjectTrustRegistry | undefined>;
	const existing = host[PROJECT_TRUST_SYMBOL];
	if (existing) return existing;
	const created: ProjectTrustRegistry = {};
	host[PROJECT_TRUST_SYMBOL] = created;
	return created;
}

export function recordProjectTrust(ctx: { cwd?: string; isProjectTrusted?: () => boolean }): void {
	if (!ctx.cwd) return;
	let trusted = true;
	try {
		trusted = ctx.isProjectTrusted?.() === true;
	} catch {
		trusted = false;
	}
	const registry = projectTrustRegistry();
	if (!registry.projectSettings) registry.projectSettings = new Map();
	registry.projectSettings.set(projectSettingsPath(ctx.cwd), trusted);
}

function projectSettingsTrusted(settingsPath: string): boolean {
	return projectTrustRegistry().projectSettings?.get(settingsPath) === true;
}

/** Root-anchored as `crates/core/src/harness/pi.rs::pi_root_is_absolute_for`
 * means it, which `isAbsolute` is not: it calls a driveless `\root` absolute
 * where the renderer does not, putting the two on different roots. Hoisted, so
 * a circular import cannot reach it inside a temporal dead zone. */
function rootAnchored(path: string, windows: boolean): boolean { return windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(path) : path.startsWith("/"); }

function piSettingsPaths(cwd = process.cwd()): string[] {
	const override = expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "");
	const userDir = resolve(rootAnchored(override, process.platform === "win32") ? override : expandHome("~/.pi/agent"));
	const user = join(userDir, "settings.json");
	const project = projectSettingsPath(cwd);
	return projectSettingsTrusted(project) ? [user, project] : [user];
}

export function readPackageConfig(packageId: string, cwd?: string): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const settingsPath of piSettingsPaths(cwd)) {
		if (!existsSync(settingsPath)) continue;
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
			const config = parsed?.kendex?.extensionManager?.config?.[packageId];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional manager config.
		}
	}
	return merged;
}

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

function taskDir(): string {
	const configured = settingString("taskDir", "");
	return process.env.PI_BG_TASK_DIR?.trim() || (configured ? resolve(expandHome(configured)) : join(tmpdir(), "kendex-pi-bg"));
}

function safeLabel(input: string): string {
	return input.replaceAll(/[^a-z0-9-]+/gi, "-").replaceAll(/^-+|-+$/g, "").slice(0, 48) || "task";
}

export function logFilePath(id: string, now: number = Date.now()): string {
	const dir = taskDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return join(dir, `${safeLabel(id)}-${now}.log`);
}

/** Directory holding every managed task's log file. */
export function logDir(): string {
	const dir = taskDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
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

function piAgentDir(): string {
	const configured = expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "");
	return rootAnchored(configured, process.platform === "win32") ? resolve(configured) : join(homedir(), ".pi", "agent");
}

export function taskEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const binDir = join(piAgentDir(), "bin");
	if (existsSync(binDir)) {
		const current = env.PATH || "";
		const parts = current.split(delimiter).filter(Boolean);
		if (!parts.includes(binDir)) env.PATH = [binDir, ...parts].join(delimiter);
	}
	// Managed bash gets the read shims on PATH so a plain `tail`/`cat`/`grep`
	// read of a task log is observable without guessing at command strings.
	return { ...env, ...readShimEnv() };
}

/**
 * PATH overlay that installs the managed-bash read shims and tells them which
 * paths count as task logs and where to report a read. The shims exec the real
 * binary, so behavior is unchanged except for the side-channel append.
 */
export function readShimEnv(): Record<string, string> {
	pruneStaleConsumeLogs();
	const dir = installReadShims(shimDir());
	if (!dir) return {};
	return {
		PATH: [dir, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
		PI_BG_CONSUME_LOG: consumeLogPath(),
		PI_BG_LOG_DIR: logDir(),
		PI_BG_LOG_GLOB: `${logDir()}/*`,
		PI_BG_REAL_PATH: process.env.PATH ?? "",
	};
}
