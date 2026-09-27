/**
 * Single source of truth for the extension's own version.
 *
 * Read once from this package's package.json at module load and cached. Every
 * tracer/meter/logger registration and the self-test command read it from
 * here, so a release bump in package.json propagates without code edits.
 */

import { readFileSync } from "node:fs";

let cached: string | undefined;

/** The extension's version string (falls back to "0.0.0" if unreadable). */
export function extensionVersion(): string {
  if (cached !== undefined) return cached;
  try {
    // Resolved relative to this source file so it works regardless of the
    // installer's node_modules layout (jiti dev runs, packed installs, etc.).
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    cached = typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
    return cached;
  } catch {
    cached = "0.0.0";
    return cached;
  }
}
