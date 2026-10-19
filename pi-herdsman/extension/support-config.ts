import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HerdsmanConfig } from "./config.ts";
import { herdsmanConfigPath } from "./storage.ts";

// Nix renders config.json and the extension only reads it. Tests stand in for
// the render: each call sets or clears one field of the file, and clearing the
// last field removes the file so a read falls back to the defaults.
export function setConfigField<K extends keyof HerdsmanConfig>(
  key: K,
  value: HerdsmanConfig[K] | undefined,
): void {
  const path = herdsmanConfigPath();
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (value === undefined) delete current[key];
  else current[key] = value;
  if (Object.keys(current).length === 0) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}
