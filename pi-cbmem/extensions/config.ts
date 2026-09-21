/*
 * Settings for pi-cbmem, read from the user settings file only.
 *
 * The graph index is machine-wide state and the tool surface decides where the
 * agent spends its context, so a repository must not be able to point the
 * extension at another binary or another project. Project-scope settings are
 * therefore ignored; only `kendex.extensionManager.config["@vanillagreen/pi-cbmem"]`
 * in the user settings file is read.
 *
 * Environment overrides are read after the file so a shell or a test can pin
 * them without editing settings.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CONFIG_ID = "@vanillagreen/pi-cbmem";

/** Binary to spawn as an MCP stdio server. */
export const DEFAULT_BINARY = "codebase-memory-mcp";

export interface CbmemConfig {
	/** Master switch. Off registers no tools and spawns nothing. */
	enabled: boolean;
	/** Executable name or absolute path. */
	binary: string;
	/**
	 * Explicit project name. Unset means the name is derived from the session
	 * cwd with the same algorithm the server uses, so a query lands on the
	 * project the auto-index just refreshed.
	 */
	project?: string;
	/**
	 * Connect at session_start instead of on the first tool call. The
	 * connection is what triggers the server's auto-index and watcher
	 * registration, so leaving this on keeps the graph warm.
	 */
	connectOnSessionStart: boolean;
	/**
	 * Tools to leave unregistered, by exact name. A group name may be used:
	 * `admin` covers the four mutating tools.
	 */
	disabledTools: string[];
	/**
	 * Tools to register, by exact name or group. Empty means "all of the
	 * non-admin set". An allowlist wins over `disabledTools`.
	 */
	enabledTools: string[];
	/** Register the mutating tools (index_repository, delete_project, manage_adr, ingest_traces). */
	adminTools: boolean;
	/**
	 * Per-call timeout in milliseconds. 0 disables it. A timeout is reported as
	 * a tool error; the server keeps the connection.
	 */
	requestTimeoutMs: number;
	/** Show a one-time warning when the server cannot start or dies. */
	notifyOnError: boolean;
}

export const ADMIN_TOOLS = ["index_repository", "delete_project", "manage_adr", "ingest_traces"] as const;

/** Tool-group names accepted in `enabledTools` / `disabledTools`. */
export const TOOL_GROUPS: Record<string, readonly string[]> = {
	admin: ADMIN_TOOLS,
	all: [],
};

export const DEFAULTS: CbmemConfig = {
	enabled: true,
	binary: DEFAULT_BINARY,
	project: undefined,
	connectOnSessionStart: true,
	disabledTools: [],
	enabledTools: [],
	adminTools: false,
	requestTimeoutMs: 120_000,
	notifyOnError: true,
};

/** The Pi agent directory, honouring pi's own override. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_CODING_AGENT_DIR?.trim();
	if (override) {
		const expanded =
			override === "~" ? homedir() : override.startsWith("~/") ? join(homedir(), override.slice(2)) : override;
		return resolve(expanded);
	}
	return join(homedir(), ".pi", "agent");
}

function userSettingsPath(env: NodeJS.ProcessEnv): string {
	return join(agentDir(env), "settings.json");
}

/** The `kendex.extensionManager.config[CONFIG_ID]` block, or an empty record. */
export function readSettingsFile(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
	const path = userSettingsPath(env);
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			kendex?: { extensionManager?: { config?: Record<string, unknown> } };
		};
		const config = parsed?.kendex?.extensionManager?.config?.[CONFIG_ID];
		return config && typeof config === "object" && !Array.isArray(config)
			? (config as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function pickString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function pickNumber(value: unknown, min: number, max: number): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
	}
	return undefined;
}

/** A list of tool names or group names; unknown entries are kept so a typo is visible, not silent. */
function pickNames(value: unknown): string[] | undefined {
	const raw =
		typeof value === "string"
			? value.split(",")
			: Array.isArray(value)
				? value
				: undefined;
	if (!raw) return undefined;
	const names = raw
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	return names.length > 0 ? names : [];
}

/** Expand group names (`admin`) into tool names; leaves plain names untouched. */
export function expandToolNames(names: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const name of names) {
		const group = TOOL_GROUPS[name];
		if (group && group.length > 0) {
			for (const member of group) out.add(member);
		} else {
			out.add(name);
		}
	}
	return out;
}

/**
 * Merge file settings and environment over the defaults, in that order.
 * Env names follow the extension's own prefix; the `CBM_*` names upstream
 * documents are left alone, because they belong to the server process.
 */
export function resolveConfig(
	settings: Record<string, unknown> = {},
	env: NodeJS.ProcessEnv = process.env,
): CbmemConfig {
	const config: CbmemConfig = { ...DEFAULTS, disabledTools: [], enabledTools: [] };

	const enabled =
		env.PI_CBMEM_DISABLED === "1"
			? false
			: pickBoolean(settings.enabled) ?? (env.PI_CBMEM_DISABLED === "0" ? true : undefined);
	if (enabled !== undefined) config.enabled = enabled;

	const binary = pickString(env.PI_CBMEM_BINARY) ?? pickString(settings.binary);
	if (binary) config.binary = binary;

	const project = pickString(env.PI_CBMEM_PROJECT) ?? pickString(settings.project);
	if (project) config.project = project;

	const connect =
		(env.PI_CBMEM_CONNECT_ON_SESSION_START === undefined
			? undefined
			: env.PI_CBMEM_CONNECT_ON_SESSION_START !== "0") ?? pickBoolean(settings.connectOnSessionStart);
	if (connect !== undefined) config.connectOnSessionStart = connect;

	const admin =
		(env.PI_CBMEM_ADMIN_TOOLS === undefined ? undefined : env.PI_CBMEM_ADMIN_TOOLS === "1") ??
		pickBoolean(settings.adminTools);
	if (admin !== undefined) config.adminTools = admin;

	const disabled = pickNames(env.PI_CBMEM_DISABLED_TOOLS) ?? pickNames(settings.disabledTools);
	if (disabled) config.disabledTools = disabled;

	const enabledTools = pickNames(env.PI_CBMEM_TOOLS) ?? pickNames(settings.enabledTools);
	if (enabledTools) config.enabledTools = enabledTools;

	const timeout = pickNumber(env.PI_CBMEM_REQUEST_TIMEOUT_MS, 0, 3_600_000) ?? pickNumber(settings.requestTimeoutMs, 0, 3_600_000);
	if (timeout !== undefined) config.requestTimeoutMs = timeout;

	const notify =
		(env.PI_CBMEM_NOTIFY === undefined ? undefined : env.PI_CBMEM_NOTIFY !== "0") ??
		pickBoolean(settings.notifyOnError);
	if (notify !== undefined) config.notifyOnError = notify;

	return config;
}

/**
 * Project name derivation, a port of the server's `cbm_project_name_from_path`
 * (src/pipeline/fqn.c). The server names a project from its own cwd, so this
 * must stay byte-identical: a mismatch resolves no database and every query
 * fails with "project not found".
 *
 * Rules: realpath first, keep [A-Za-z0-9._-], transliterate every non-ASCII
 * byte to two lowercase hex digits, map everything else to '-', collapse
 * repeated '-' and '.', trim leading '-'/'.' and trailing '-'.
 */
export function projectFromPath(path: string): string {
	let real = path;
	try {
		real = realpathSync.native(path);
	} catch {
		/* keep the given path */
	}
	let mapped = "";
	for (const byte of Buffer.from(real, "utf8")) {
		if (
			(byte >= 0x61 && byte <= 0x7a) ||
			(byte >= 0x41 && byte <= 0x5a) ||
			(byte >= 0x30 && byte <= 0x39) ||
			byte === 0x2e ||
			byte === 0x5f ||
			byte === 0x2d
		) {
			mapped += String.fromCharCode(byte);
		} else if (byte >= 0x80) {
			mapped += "0123456789abcdef"[(byte >> 4) & 0xf] + "0123456789abcdef"[byte & 0xf];
		} else {
			mapped += "-";
		}
	}
	mapped = mapped.replace(/-+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+/, "");
	mapped = mapped.replace(/-+$/, "");
	return mapped === "" ? "root" : mapped;
}

/**
 * The project a session in `cwd` belongs to, or undefined when cwd is not a
 * project root the server would index. Mirrors the server's `detect_session`:
 * `/` and `$HOME` are skipped rather than indexed.
 */
export function sessionProjectFor(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const home = env.HOME?.trim();
	if (cwd === "/" || (home && cwd === home)) return undefined;
	const name = projectFromPath(cwd);
	return name === "root" ? undefined : name;
}
