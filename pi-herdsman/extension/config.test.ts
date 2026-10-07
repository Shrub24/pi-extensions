import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { basename, dirname } from "node:path";
import { mock, test } from "node:test";

let deleteBeforeRead = false;
let failConfigRename = false;
let configPath: string | undefined;
const testAgentDir =
  process.env.PI_CODING_AGENT_DIR ?? "/tmp/pi-herdsman-config-test";
const { parseFrontmatter: nativeParseFrontmatter } = await import(
  "@earendil-works/pi-coding-agent"
);
mock.module("@earendil-works/pi-coding-agent", {
  namedExports: {
    getAgentDir: () => testAgentDir,
    parseFrontmatter: nativeParseFrontmatter,
  },
});
mock.module("node:fs", {
  namedExports: {
    chmodSync: realFs.chmodSync,
    closeSync: realFs.closeSync,
    constants: realFs.constants,
    existsSync: realFs.existsSync,
    fsyncSync: realFs.fsyncSync,
    fstatSync: realFs.fstatSync,
    lstatSync: realFs.lstatSync,
    mkdirSync: realFs.mkdirSync,
    openSync: realFs.openSync,
    readFileSync: (path: string, encoding: BufferEncoding) => {
      if (deleteBeforeRead && configPath !== undefined && path === configPath) {
        deleteBeforeRead = false;
        realFs.unlinkSync(path);
      }
      return realFs.readFileSync(path, encoding);
    },
    readSync: realFs.readSync,
    realpathSync: realFs.realpathSync,
    renameSync: (from: string, to: string) => {
      if (
        failConfigRename &&
        configPath !== undefined &&
        dirname(from) === dirname(configPath) &&
        basename(from).startsWith(`.${basename(configPath)}.`) &&
        !basename(from).startsWith(`.${basename(configPath)}.lock.`)
      ) {
        failConfigRename = false;
        const error = new Error(
          "injected config rename failure",
        ) as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return realFs.renameSync(from, to);
    },
    readdirSync: realFs.readdirSync,
    rmdirSync: realFs.rmdirSync,
    statSync: realFs.statSync,
    unlinkSync: realFs.unlinkSync,
    writeFileSync: realFs.writeFileSync,
    writeSync: realFs.writeSync,
  },
});

const {
  DEFAULT_CONFIG,
  DEFAULT_SOFT_TIMEOUT_MS,
  DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS,
  MAX_BYTE_LIMIT,
  MAX_SOFT_TIMEOUT_MS,
  MAX_WORKER_CONTEXT_BUDGET_TOKENS,
  MIN_BYTE_LIMIT,
  MIN_WORKER_CONTEXT_BUDGET_TOKENS,
  readConfig,
  updateConfig,
  validByteLimit,
  validDisabledDefinitions,
  validModelPattern,
  validModelScopes,
  validSoftTimeout,
  validWorkerContextBudget,
} = await import("./config.ts");
const { herdsmanConfigPath, herdsmanDataRoot } = await import("./storage.ts");
const { claimProcessLock } = await import("./lock.ts");
configPath = herdsmanConfigPath();

function resetConfig(): void {
  realFs.rmSync(herdsmanDataRoot(), { recursive: true, force: true });
}

test.afterEach(resetConfig);

test("missing config resolves to defaults without creating storage", () => {
  resetConfig();
  assert.deepEqual(readConfig(), DEFAULT_CONFIG);
  assert.equal(readConfig().contextRetirement, false);
  assert.equal(readConfig().workerCompaction, true);
  assert.equal(realFs.existsSync(herdsmanDataRoot()), false);
});

test("documented soft-deadline, retention, and worker-budget defaults match", () => {
  resetConfig();
  // docs/reference/configuration.md documents exactly these values.
  assert.equal(DEFAULT_SOFT_TIMEOUT_MS, 300_000);
  assert.equal(readConfig().softTimeoutMs, 300_000);
  assert.equal(readConfig().retainWorkers, true);
  assert.equal(DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS, 200_000);
  assert.equal(readConfig().workerContextBudgetTokens, 200_000);
  assert.equal(readConfig().workerCompaction, true);
});

test("soft-timeout and retain-workers overlays accept only valid values", () => {
  realFs.mkdirSync(herdsmanDataRoot(), { recursive: true });
  realFs.writeFileSync(
    herdsmanConfigPath(),
    JSON.stringify({ softTimeoutMs: 0, retainWorkers: false }),
  );
  assert.deepEqual(readConfig(), {
    ...DEFAULT_CONFIG,
    softTimeoutMs: 0,
    retainWorkers: false,
  });
  realFs.writeFileSync(
    herdsmanConfigPath(),
    JSON.stringify({
      softTimeoutMs: MAX_SOFT_TIMEOUT_MS,
      workerContextBudgetTokens: MAX_WORKER_CONTEXT_BUDGET_TOKENS,
      retainWorkers: true,
    }),
  );
  assert.equal(readConfig().softTimeoutMs, MAX_SOFT_TIMEOUT_MS);
  assert.equal(
    readConfig().workerContextBudgetTokens,
    MAX_WORKER_CONTEXT_BUDGET_TOKENS,
  );
  assert.equal(readConfig().retainWorkers, true);
  assert.equal(validSoftTimeout(0), true);
  assert.equal(validSoftTimeout(MAX_SOFT_TIMEOUT_MS), true);
  assert.equal(
    validWorkerContextBudget(MIN_WORKER_CONTEXT_BUDGET_TOKENS),
    true,
  );
  assert.equal(validWorkerContextBudget(MAX_WORKER_CONTEXT_BUDGET_TOKENS), true);
});

test("partial and complete valid configs overlay defaults", () => {
  realFs.mkdirSync(herdsmanDataRoot(), { recursive: true });
  realFs.writeFileSync(
    herdsmanConfigPath(),
    JSON.stringify({ spawnPlacement: "split", contextRetirement: false }),
  );
  assert.deepEqual(readConfig(), {
    ...DEFAULT_CONFIG,
    spawnPlacement: "split",
    contextRetirement: false,
  });
  realFs.writeFileSync(
    herdsmanConfigPath(),
    JSON.stringify({
      spawnPlacement: "tab",
      inlineAttachmentLimitBytes: MIN_BYTE_LIMIT,
      mailboxPayloadLimitBytes: MAX_BYTE_LIMIT,
    }),
  );
  assert.deepEqual(readConfig(), {
    spawnPlacement: "tab",
    contextRetirement: false,
    retainWorkers: true,
    softTimeoutMs: DEFAULT_SOFT_TIMEOUT_MS,
    workerContextBudgetTokens: DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS,
    workerCompaction: true,
    inlineAttachmentLimitBytes: MIN_BYTE_LIMIT,
    mailboxPayloadLimitBytes: MAX_BYTE_LIMIT,
    disabledDefinitions: [],
    modelScopes: {},
  });
  realFs.writeFileSync(herdsmanConfigPath(), JSON.stringify({ workerCompaction: false }));
  assert.equal(readConfig().workerCompaction, false);
});

test("invalid values, malformed JSON, non-object roots, and unknown keys fail clearly", () => {
  realFs.mkdirSync(herdsmanDataRoot(), { recursive: true });
  for (const [content, message] of [
    ['{"spawnPlacement":"invalid"}', "spawnPlacement"],
    [
      `{"inlineAttachmentLimitBytes":${MIN_BYTE_LIMIT - 1}}`,
      "inlineAttachmentLimitBytes",
    ],
    [
      `{"mailboxPayloadLimitBytes":${MAX_BYTE_LIMIT + 1}}`,
      "mailboxPayloadLimitBytes",
    ],
    [
      `{"mailboxPayloadLimitBytes":${MIN_BYTE_LIMIT + 0.5}}`,
      "mailboxPayloadLimitBytes",
    ],
    ['{"contextRetirement":"false"}', "contextRetirement"],
    ['{"retainWorkers":"true"}', "retainWorkers"],
    ['{"workerCompaction":"true"}', "workerCompaction"],
    ['{"workerCompaction":1}', "workerCompaction"],
    ['{"softTimeoutMs":-1}', "softTimeoutMs"],
    ['{"softTimeoutMs":1.5}', "softTimeoutMs"],
    ['{"softTimeoutMs":"300000"}', "softTimeoutMs"],
    [`{"softTimeoutMs":${MAX_SOFT_TIMEOUT_MS + 1}}`, "softTimeoutMs"],
    [`{"workerContextBudgetTokens":${MIN_WORKER_CONTEXT_BUDGET_TOKENS - 1}}`, "workerContextBudgetTokens"],
    ['{"workerContextBudgetTokens":1.5}', "workerContextBudgetTokens"],
    ['{"workerContextBudgetTokens":"200000"}', "workerContextBudgetTokens"],
    [`{"workerContextBudgetTokens":${MAX_WORKER_CONTEXT_BUDGET_TOKENS + 1}}`, "workerContextBudgetTokens"],
    ["{", "Invalid Pi Herdsman config JSON"],
    ["[]", "root must be an object"],
    ['{"typo":true}', "unknown field typo"],
    ['{"disabledDefinitions":"scout"}', "disabledDefinitions"],
    ['{"disabledDefinitions":["scout","scout"]}', "disabledDefinitions"],
    ['{"disabledDefinitions":[""]}', "disabledDefinitions"],
    ['{"disabledDefinitions":["   "]}', "disabledDefinitions"],
    ['{"disabledDefinitions":[1]}', "disabledDefinitions"],
    ['{"modelScopes":[]}', "modelScopes"],
    ['{"modelScopes":{"allow":[]}}', "modelScopes"],
    ['{"modelScopes":{"allow":[""]}}', "modelScopes"],
    ['{"modelScopes":{"allow":["a b"]}}', "modelScopes"],
    ['{"modelScopes":{"typo":["a"]}}', "modelScopes"],
    ['{"modelScopes":{"agents":{"scout":{}}}}', "modelScopes"],
    ['{"modelScopes":{"agents":{"scout":{"allow":["a"],"extra":1}}}}', "modelScopes"],
  ] as const) {
    realFs.writeFileSync(herdsmanConfigPath(), content);
    assert.throws(() => readConfig(), new RegExp(message));
  }
  assert.equal(validByteLimit(MIN_BYTE_LIMIT), true);
  assert.equal(validByteLimit(MAX_BYTE_LIMIT), true);
  assert.equal(validByteLimit(MIN_BYTE_LIMIT + 0.5), false);
  assert.equal(validSoftTimeout(-1), false);
  assert.equal(validSoftTimeout(1.5), false);
  assert.equal(
    validWorkerContextBudget(MIN_WORKER_CONTEXT_BUDGET_TOKENS - 1),
    false,
  );
  assert.equal(validWorkerContextBudget(1.5), false);
  assert.equal(validDisabledDefinitions(["scout"]), true);
  assert.equal(validDisabledDefinitions([]), true);
  assert.equal(validDisabledDefinitions(["scout", "scout"]), false);
  assert.equal(validDisabledDefinitions(Array.from({ length: 64 }, (_, i) => `a${i}`)), true);
  assert.equal(validDisabledDefinitions(Array.from({ length: 65 }, (_, i) => `a${i}`)), false);
  assert.equal(validModelScopes({}), true);
  assert.equal(validModelScopes({ allow: ["openai-codex/*"] }), true);
  assert.equal(validModelScopes({ agents: {} }), true);
  assert.equal(validModelScopes({ agents: { scout: { allow: ["$inherited"] } } }), true);
  assert.equal(validModelScopes({ allow: [] }), false);
  assert.equal(validModelScopes({ agents: { scout: {} } }), false);
  assert.equal(validModelScopes({ agents: { scout: { allow: ["a"], extra: 1 } } }), false);
  assert.equal(validModelPattern("omniroute/explorer"), true);
  assert.equal(validModelPattern("$inherited"), true);
  assert.equal(validModelPattern(""), false);
  assert.equal(validModelPattern("a b"), false);
  assert.equal(validModelPattern(1), false);
});

test("updates preserve configured keys, reset one key, and delete the final config", () => {
  updateConfig("spawnPlacement", "tab");
  updateConfig("contextRetirement", false);
  updateConfig("retainWorkers", false);
  updateConfig("softTimeoutMs", 0);
  updateConfig("workerContextBudgetTokens", 180_000);
  updateConfig("workerCompaction", false);
  updateConfig("mailboxPayloadLimitBytes", 64 * 1024);
  assert.deepEqual(
    JSON.parse(realFs.readFileSync(herdsmanConfigPath(), "utf8")),
    {
      spawnPlacement: "tab",
      contextRetirement: false,
      retainWorkers: false,
      softTimeoutMs: 0,
      workerContextBudgetTokens: 180_000,
      workerCompaction: false,
      mailboxPayloadLimitBytes: 64 * 1024,
    },
  );
  assert.equal(readConfig().spawnPlacement, "tab");
  assert.equal(readConfig().contextRetirement, false);
  assert.equal(readConfig().retainWorkers, false);
  assert.equal(readConfig().softTimeoutMs, 0);
  assert.equal(readConfig().workerContextBudgetTokens, 180_000);
  assert.equal(readConfig().workerCompaction, false);
  updateConfig("spawnPlacement", undefined);
  assert.deepEqual(
    JSON.parse(realFs.readFileSync(herdsmanConfigPath(), "utf8")),
    {
      contextRetirement: false,
      retainWorkers: false,
      softTimeoutMs: 0,
      workerContextBudgetTokens: 180_000,
      workerCompaction: false,
      mailboxPayloadLimitBytes: 64 * 1024,
    },
  );
  updateConfig("retainWorkers", undefined);
  assert.equal(readConfig().retainWorkers, true);
  updateConfig("softTimeoutMs", undefined);
  assert.equal(readConfig().softTimeoutMs, DEFAULT_SOFT_TIMEOUT_MS);
  updateConfig("workerContextBudgetTokens", undefined);
  assert.equal(
    readConfig().workerContextBudgetTokens,
    DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS,
  );
  updateConfig("workerCompaction", undefined);
  assert.equal(readConfig().workerCompaction, true);
  updateConfig("mailboxPayloadLimitBytes", undefined);
  updateConfig("contextRetirement", undefined);
  assert.equal(realFs.existsSync(herdsmanConfigPath()), false);
  assert.deepEqual(readConfig(), DEFAULT_CONFIG);
});

test("update rejects invalid retain-workers, soft-timeout, context-budget, and compaction values", () => {
  resetConfig();
  assert.throws(
    () => updateConfig("retainWorkers", "true" as never),
    /Invalid Pi Herdsman config field retainWorkers/,
  );
  assert.throws(
    () => updateConfig("workerCompaction", "false" as never),
    /Invalid Pi Herdsman config field workerCompaction/,
  );
  assert.throws(
    () => updateConfig("softTimeoutMs", -1),
    /Invalid Pi Herdsman config field softTimeoutMs/,
  );
  assert.throws(
    () => updateConfig("workerContextBudgetTokens", 1),
    /Invalid Pi Herdsman config field workerContextBudgetTokens/,
  );
  assert.throws(
    () => updateConfig("workerContextBudgetTokens", 1.5),
    /Invalid Pi Herdsman config field workerContextBudgetTokens/,
  );
  assert.throws(
    () => updateConfig("softTimeoutMs", 1.5),
    /Invalid Pi Herdsman config field softTimeoutMs/,
  );
  assert.throws(
    () => updateConfig("softTimeoutMs", "300000" as never),
    /Invalid Pi Herdsman config field softTimeoutMs/,
  );
  assert.equal(realFs.existsSync(herdsmanConfigPath()), false);
});

test("a read racing with final reset treats ENOENT as absent", () => {
  updateConfig("spawnPlacement", "tab");
  deleteBeforeRead = true;
  assert.deepEqual(readConfig(), DEFAULT_CONFIG);
});

test("failed atomic replacement preserves the old config and cleans its temporary file", () => {
  updateConfig("spawnPlacement", "tab");
  const before = realFs.readFileSync(herdsmanConfigPath(), "utf8");
  failConfigRename = true;
  assert.throws(
    () => updateConfig("inlineAttachmentLimitBytes", 64 * 1024),
    /injected config rename failure/,
  );
  assert.equal(realFs.readFileSync(herdsmanConfigPath(), "utf8"), before);
  assert.deepEqual(
    realFs
      .readdirSync(herdsmanDataRoot())
      .filter((entry) => entry.startsWith(".config.json.")),
    [],
  );
});

test("config updates honor the shared process lock", () => {
  const release = claimProcessLock(`${herdsmanConfigPath()}.lock`, {
    name: "Pi Herdsman config update",
  });
  try {
    assert.throws(
      () => updateConfig("spawnPlacement", "split"),
      /Pi Herdsman config update is in progress/,
    );
  } finally {
    release();
  }
});
