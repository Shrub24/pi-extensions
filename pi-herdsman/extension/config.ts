import {
  closeSync,
  chmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { claimProcessLock } from "./lock.ts";
import { herdsmanConfigPath } from "./storage.ts";
import { isSpawnPlacement, type SpawnPlacement } from "./core.ts";

const DEFAULT_BYTE_LIMIT = 128 * 1024;
export const MIN_BYTE_LIMIT = 1024;
export const MAX_BYTE_LIMIT = 1024 * 1024;
export const DEFAULT_SOFT_TIMEOUT_MS = 5 * 60_000;
export const MAX_SOFT_TIMEOUT_MS = 2_147_483_647;

export type HerdsmanConfig = {
  spawnPlacement: SpawnPlacement;
  contextRetirement: boolean;
  retainWorkers: boolean;
  softTimeoutMs: number;
  inlineAttachmentLimitBytes: number;
  mailboxPayloadLimitBytes: number;
};

export const DEFAULT_CONFIG: HerdsmanConfig = {
  spawnPlacement: "subtree",
  contextRetirement: false,
  retainWorkers: false,
  softTimeoutMs: DEFAULT_SOFT_TIMEOUT_MS,
  inlineAttachmentLimitBytes: DEFAULT_BYTE_LIMIT,
  mailboxPayloadLimitBytes: DEFAULT_BYTE_LIMIT,
};

export function validByteLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_BYTE_LIMIT &&
    value <= MAX_BYTE_LIMIT
  );
}

// Advisory soft-deadline windows accept any non-negative integer; 0 disables
// the feature entirely, which `validByteLimit`'s 1 KiB floor cannot express.
export function validSoftTimeout(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SOFT_TIMEOUT_MS
  );
}

type ConfigKey = keyof HerdsmanConfig;
const CONFIG_KEYS = new Set<ConfigKey>([
  "spawnPlacement",
  "contextRetirement",
  "retainWorkers",
  "softTimeoutMs",
  "inlineAttachmentLimitBytes",
  "mailboxPayloadLimitBytes",
]);

function parseRawConfig(content: string): Partial<HerdsmanConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid Pi Herdsman config JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid Pi Herdsman config: root must be an object");
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!CONFIG_KEYS.has(key as ConfigKey))
      throw new Error(`Invalid Pi Herdsman config: unknown field ${key}`);
  const result: Partial<HerdsmanConfig> = {};
  if ("spawnPlacement" in record) {
    if (!isSpawnPlacement(record.spawnPlacement))
      throw new Error("Invalid Pi Herdsman config field spawnPlacement");
    result.spawnPlacement = record.spawnPlacement;
  }
  for (const key of ["contextRetirement", "retainWorkers"] as const)
    if (key in record) {
      if (typeof record[key] !== "boolean")
        throw new Error(`Invalid Pi Herdsman config field ${key}`);
      result[key] = record[key];
    }
  if ("softTimeoutMs" in record) {
    if (!validSoftTimeout(record.softTimeoutMs))
      throw new Error("Invalid Pi Herdsman config field softTimeoutMs");
    result.softTimeoutMs = record.softTimeoutMs;
  }
  for (const key of [
    "inlineAttachmentLimitBytes",
    "mailboxPayloadLimitBytes",
  ] as const)
    if (key in record) {
      if (!validByteLimit(record[key]))
        throw new Error(`Invalid Pi Herdsman config field ${key}`);
      result[key] = record[key];
    }
  return result;
}

function readRawConfig(): Partial<HerdsmanConfig> {
  const path = herdsmanConfigPath();
  try {
    return parseRawConfig(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function readConfig(): HerdsmanConfig {
  return { ...DEFAULT_CONFIG, ...readRawConfig() };
}

function writeConfigAtomically(path: string, content: string): void {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function updateConfig<K extends ConfigKey>(
  key: K,
  value: HerdsmanConfig[K] | undefined,
): void {
  const path = herdsmanConfigPath();
  const release = claimProcessLock(`${path}.lock`, {
    name: "Pi Herdsman config update",
  });
  try {
    const current = readRawConfig();
    if (value !== undefined) {
      if (key === "spawnPlacement" && !isSpawnPlacement(value))
        throw new Error("Invalid Pi Herdsman config field spawnPlacement");
      if (
        (key === "contextRetirement" || key === "retainWorkers") &&
        typeof value !== "boolean"
      )
        throw new Error(`Invalid Pi Herdsman config field ${key}`);
      if (key === "softTimeoutMs" && !validSoftTimeout(value))
        throw new Error("Invalid Pi Herdsman config field softTimeoutMs");
      if (
        key !== "spawnPlacement" &&
        key !== "contextRetirement" &&
        key !== "retainWorkers" &&
        key !== "softTimeoutMs" &&
        !validByteLimit(value)
      )
        throw new Error(`Invalid Pi Herdsman config field ${key}`);
      current[key] = value;
    } else delete current[key];
    if (Object.keys(current).length)
      writeConfigAtomically(path, `${JSON.stringify(current, null, 2)}\n`);
    else {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    release();
  }
}
