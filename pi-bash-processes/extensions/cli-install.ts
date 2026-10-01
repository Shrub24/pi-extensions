import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PI_BG_CLIENT_FILE, piBgClientSource, piBgWrapperScript } from "./pi-bg.js";

/**
 * Installs the declared `pi-bg` CLI for managed shells.
 *
 * This module used to install *read shims* as well: PATH wrappers on
 * `cat`/`tail`/`grep`/… that watched which log path a command opened and
 * appended it to a per-process consume log the extension drained before handing
 * over a wake. That was inference — it turned an ordinary file read into a
 * notification acknowledgment — and it has been retired along with the consume
 * log it fed. What remains is the declared surface only: `pi-bg get|list|stop`
 * speak to the session's own socket, so a result is handed over and acknowledged
 * through exactly one operation, and a plain read of a log file changes nothing.
 *
 * Returns the bin directory, or null where the platform has no POSIX shell to
 * run the wrapper (Windows keeps the Pi-tool operations, which never used this
 * channel).
 */
export function installDeclaredCli(dir: string): string | null {
	if (process.platform === "win32") return null;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const helper = join(dir, "pi-bg");
		writeFileSync(helper, piBgWrapperScript(), { mode: 0o700 });
		chmodSync(helper, 0o700);
		// The declared operations are answered by the session's socket, so the CLI
		// needs a real program to speak it: a POSIX shell cannot open a Unix socket
		// without an extra tool on the host.
		const client = join(dir, PI_BG_CLIENT_FILE);
		writeFileSync(client, piBgClientSource(), { mode: 0o700 });
		chmodSync(client, 0o700);
		return dir;
	} catch {
		return null;
	}
}
