import { realpathSync } from "node:fs";
import { resolve } from "node:path";

function canonicalCwd(value: string): string {
  const resolved = resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Whether two working directories name the same place, following symlinks. */
export function sameCwd(observed: unknown, expected: string): boolean {
  if (typeof observed !== "string") return false;
  return canonicalCwd(observed) === canonicalCwd(expected);
}
