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
// A managed worker is compacted once its context reaches this many tokens,
// whatever the model's window is: the point is a lean working context, not
// protection against the window alone. A window smaller than the budget still
// bounds it, because the route clamps the completion budget near the top of the
// window and answers with a single token and a length stop.
export const DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS = 200_000;
export const MIN_WORKER_CONTEXT_BUDGET_TOKENS = 16_384;
export const MAX_WORKER_CONTEXT_BUDGET_TOKENS = 1_000_000;
export const MAX_DISABLED_DEFINITIONS = 64;
export const MAX_MODEL_PATTERNS = 64;
export const MAX_MODEL_PATTERN_LENGTH = 128;

/** One definition's model allow list. */
export type ModelScope = { allow: string[] };

/**
 * Operator policy for which models a delegated agent may run on. A candidate
 * must satisfy every scope that exists: the global list and the definition's own
 * list are restrictions, never exemptions.
 */
export type ModelScopes = {
  allow?: string[];
  agents?: Record<string, ModelScope>;
};

export type HerdsmanConfig = {
  spawnPlacement: SpawnPlacement;
  contextRetirement: boolean;
  retainWorkers: boolean;
  softTimeoutMs: number;
  workerContextBudgetTokens: number;
  inlineAttachmentLimitBytes: number;
  mailboxPayloadLimitBytes: number;
  disabledDefinitions: string[];
  modelScopes: ModelScopes;
};

export const DEFAULT_CONFIG: HerdsmanConfig = {
  spawnPlacement: "subtree",
  contextRetirement: false,
  retainWorkers: true,
  softTimeoutMs: DEFAULT_SOFT_TIMEOUT_MS,
  workerContextBudgetTokens: DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS,
  inlineAttachmentLimitBytes: DEFAULT_BYTE_LIMIT,
  mailboxPayloadLimitBytes: DEFAULT_BYTE_LIMIT,
  disabledDefinitions: [],
  modelScopes: {},
};

export function validByteLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_BYTE_LIMIT &&
    value <= MAX_BYTE_LIMIT
  );
}

// A disable list is a bounded set of unique, non-empty definition names. Whether a
// name matches a definition is checked during discovery, the only place the roster
// is known.
export function validDisabledDefinitions(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_DISABLED_DEFINITIONS)
    return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) return false;
    if (seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A model pattern is an exact `provider/model`, a trailing-wildcard `provider/*`,
 * or the reserved `$inherited`, which matches a model the launch inherited rather
 * than pinned.
 */
export function validModelPattern(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_MODEL_PATTERN_LENGTH &&
    !/\s/u.test(value)
  );
}

function validModelPatternList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_MODEL_PATTERNS &&
    value.every(validModelPattern)
  );
}

/** A model scope is an allow list, and nothing else. */
export function validModelScope(value: unknown): value is ModelScope {
  if (!isConfigObject(value)) return false;
  if (Object.keys(value).some((key) => key !== "allow")) return false;
  return validModelPatternList(value.allow);
}

export function validModelScopes(value: unknown): value is ModelScopes {
  if (!isConfigObject(value)) return false;
  if (Object.keys(value).some((key) => key !== "allow" && key !== "agents"))
    return false;
  if ("allow" in value && !validModelPatternList(value.allow)) return false;
  if (!("agents" in value)) return true;
  const agents = value.agents;
  if (!isConfigObject(agents)) return false;
  // An empty `agents` map is the same as omitting it, so a generated config may
  // emit it; an empty allow list is a scope that permits nothing, which is a
  // misconfiguration rather than a policy.
  const names = Object.keys(agents);
  if (names.length > MAX_MODEL_PATTERNS) return false;
  return names.every((name) => validModelScope(agents[name]));
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

// A context budget below a tokenizer's smallest useful summary would compact a
// worker forever without ever gaining room, so the floor is a real figure rather
// than a byte-limit minimum.
export function validWorkerContextBudget(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_WORKER_CONTEXT_BUDGET_TOKENS &&
    value <= MAX_WORKER_CONTEXT_BUDGET_TOKENS
  );
}

type ConfigKey = keyof HerdsmanConfig;
const CONFIG_KEYS = new Set<ConfigKey>([
  "spawnPlacement",
  "contextRetirement",
  "retainWorkers",
  "softTimeoutMs",
  "workerContextBudgetTokens",
  "inlineAttachmentLimitBytes",
  "mailboxPayloadLimitBytes",
  "disabledDefinitions",
  "modelScopes",
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
  if ("workerContextBudgetTokens" in record) {
    if (!validWorkerContextBudget(record.workerContextBudgetTokens))
      throw new Error(
        "Invalid Pi Herdsman config field workerContextBudgetTokens",
      );
    result.workerContextBudgetTokens = record.workerContextBudgetTokens;
  }
  if ("modelScopes" in record) {
    if (!validModelScopes(record.modelScopes))
      throw new Error("Invalid Pi Herdsman config field modelScopes");
    result.modelScopes = record.modelScopes;
  }
  if ("disabledDefinitions" in record) {
    if (!validDisabledDefinitions(record.disabledDefinitions))
      throw new Error("Invalid Pi Herdsman config field disabledDefinitions");
    result.disabledDefinitions = [...record.disabledDefinitions];
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
        key === "workerContextBudgetTokens" &&
        !validWorkerContextBudget(value)
      )
        throw new Error(
          "Invalid Pi Herdsman config field workerContextBudgetTokens",
        );
      if (
        key !== "spawnPlacement" &&
        key !== "contextRetirement" &&
        key !== "retainWorkers" &&
        key !== "softTimeoutMs" &&
        key !== "workerContextBudgetTokens" &&
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
