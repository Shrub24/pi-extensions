import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The operator-selected binary a managed child runs. Herdsman reads it from its
 * own process environment when it builds a launch, so the value is fixed for
 * the lead's lifetime and changing it takes effect on the next lead restart.
 */
export const CHILD_COMMAND_ENV = "PI_HERDSMAN_CHILD_COMMAND";

/**
 * One read of `PI_HERDSMAN_CHILD_COMMAND`: unset (no command configured), the
 * executable to run, or the configured value with the reason it cannot be run.
 * Unset and empty both mean unconfigured, which keeps a launch without the
 * variable byte-identical to one before this input existed.
 */
export type ChildCommandLookup =
  | Readonly<{ kind: "unset" }>
  | Readonly<{ kind: "resolved"; command: string }>
  | Readonly<{ kind: "invalid"; value: string; reason: string }>;

function isExecutableFile(path: string): boolean {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats !== undefined && stats.isFile() && (stats.mode & 0o111) !== 0;
}

/** The absolute path a configured command names, or why it names no executable. */
function executableCommand(
  value: string,
  path: string | undefined,
): string | undefined {
  if (value.includes("/"))
    return isAbsolute(value) && isExecutableFile(value) ? value : undefined;
  for (const directory of (path ?? "").split(delimiter))
    if (directory !== "") {
      const candidate = join(directory, value);
      if (isExecutableFile(candidate)) return candidate;
    }
  return undefined;
}

export function resolveChildCommand(
  env: NodeJS.ProcessEnv = process.env,
): ChildCommandLookup {
  const value = env[CHILD_COMMAND_ENV];
  if (value === undefined || value === "") return { kind: "unset" };
  const command = executableCommand(value, env.PATH);
  return command === undefined
    ? {
        kind: "invalid",
        value,
        reason: `${CHILD_COMMAND_ENV}=${JSON.stringify(value)} must name an absolute path to an executable or a command on PATH`,
      }
    : { kind: "resolved", command };
}
