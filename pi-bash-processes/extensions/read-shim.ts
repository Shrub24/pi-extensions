import { chmodSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PI_BG_CLIENT_FILE, piBgClientSource, piBgWrapperScript } from "./pi-bg.js";

/**
 * Read shims for managed bash.
 *
 * Reading a finished task's log with `tail`, `cat`, `grep`, or `less` is the
 * agent consuming that task's result — the same act as `bg_task log`. Detecting
 * that by pattern-matching the agent's command string is a guess: it misses
 * composed commands and fires on anything that merely names the path (rm, stat,
 * tests). Real binaries cannot be guessed about, so the managed bash
 * environment gets thin wrappers on PATH for the read tools. Each wrapper
 * passes the invocation straight through to the real binary and appends any
 * managed log path in its arguments to a consume log the extension drains
 * before handing over a wake.
 *
 * Wrappers only ever observe arguments — never stdin payloads — so they cannot
 * false-positive on command text that merely mentions a path.
 */

const READ_TOOLS = ["cat", "tail", "head", "grep", "less", "bat", "zcat"] as const;

/** Appends any managed-log path argument to the consume log, then execs the real tool. */
function readWrapper(tool: string): string {
	return `#!/usr/bin/env bash
# kendex read shim for ${tool}: report managed-log reads, then run the real tool.
real="$(PATH="\${PI_BG_REAL_PATH:-$PATH}" command -v ${tool} 2>/dev/null)"
if [ -z "$real" ]; then
	echo "${tool}: not found" >&2
	exit 127
fi
if [ -n "\${PI_BG_CONSUME_LOG:-}" ] && [ -n "\${PI_BG_LOG_GLOB:-}" ]; then
	for arg in "$@"; do
		case "$arg" in
			-*) continue ;;
			*.running|*.running.*) continue ;;
			$PI_BG_LOG_GLOB)
				[ -f "$arg" ] || continue
				if [ -f "$arg.running" ]; then
					name="\${arg##*/}"
					echo "kendex: \${name%-\*} is still running; this read is a poll and does not consume the exit wake. Prefer ending the turn, or bg_task action:\"wait\"." >&2
					continue
				fi
				printf '%s\\n' "$arg" >>"$PI_BG_CONSUME_LOG" 2>/dev/null
				;;
		esac
	done
fi
exec "$real" "$@"
`;
}

/**
 * Writes the read wrappers and the `pi-bg` CLI once per task dir. Returns the
 * shim directory, or null where the platform has no POSIX shell to wrap
 * (Windows falls back to the previous behavior: no interception at all, and no
 * declared CLI — the Pi-tool operations keep their existing platform support).
 */
export function installReadShims(dir: string): string | null {
	if (process.platform === "win32") return null;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		for (const tool of READ_TOOLS) {
			const file = join(dir, tool);
			writeFileSync(file, readWrapper(tool), { mode: 0o700 });
			chmodSync(file, 0o700);
		}
		const helper = join(dir, "pi-bg");
		writeFileSync(helper, piBgWrapperScript(), { mode: 0o700 });
		chmodSync(helper, 0o700);
		// The declared operations are answered by the session's socket, so the
		// CLI needs a real program to speak it: a POSIX shell cannot open a Unix
		// socket without an extra tool on the host.
		const client = join(dir, PI_BG_CLIENT_FILE);
		writeFileSync(client, piBgClientSource(), { mode: 0o700 });
		chmodSync(client, 0o700);
		return dir;
	} catch {
		return null;
	}
}

/**
 * Managed-log paths read since the last drain, as a set of file paths. Draining
 * empties the log so a read is only ever reported once.
 */
export function drainConsumedLogPaths(file: string): Set<string> {
	const paths = new Set<string>();
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return paths;
	}
	try {
		truncateSync(file, 0);
	} catch {
		// A log we cannot empty is re-read next time; duplicate consumption is
		// harmless (the wake is already gone).
	}
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) paths.add(trimmed);
	}
	return paths;
}
