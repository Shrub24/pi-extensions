import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mock, test } from "node:test";

let deleteBeforeRead = false;
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
    renameSync: realFs.renameSync,
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
  validByteLimit,
  validDisabledDefinitions,
  validCommonChildExtensions,
  validModelPattern,
  validModelScopes,
  validSoftTimeout,
  validWorkerContextBudget,
} = await import("./config.ts");
const { herdsmanConfigPath, herdsmanDataRoot } = await import("./storage.ts");
configPath = herdsmanConfigPath();

function resetConfig(): void {
  realFs.rmSync(herdsmanDataRoot(), { recursive: true, force: true });
}

// Nix renders config.json; the extension only reads it, so tests render it too.
function renderConfig(record: Record<string, unknown>): void {
  realFs.mkdirSync(herdsmanDataRoot(), { recursive: true });
  realFs.writeFileSync(herdsmanConfigPath(), `${JSON.stringify(record, null, 2)}\n`);
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

test("common child extensions are an optional validated exact set", () => {
  realFs.mkdirSync(herdsmanDataRoot(), { recursive: true });
  realFs.writeFileSync(
    herdsmanConfigPath(),
    JSON.stringify({ commonChildExtensions: ["/extensions/base.ts", "npm:tool"] }),
  );
  assert.deepEqual(readConfig().commonChildExtensions, [
    "/extensions/base.ts",
    "npm:tool",
  ]);
  assert.equal(validCommonChildExtensions([]), true);
  assert.equal(validCommonChildExtensions(["/extension.ts"]), true);
  assert.equal(validCommonChildExtensions(["/extension.ts", "/extension.ts"]), false);
  assert.equal(validCommonChildExtensions([" "]), false);

  realFs.writeFileSync(
    herdsmanConfigPath(),
    JSON.stringify({ commonChildExtensions: ["/extension.ts", "/extension.ts"] }),
  );
  assert.throws(() => readConfig(), /commonChildExtensions/);
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

test("saved-session cap accepts nonnegative integers and rejects invalid limits", () => {
  assert.equal(readConfig().savedSessionLimit, 10);
  renderConfig({ savedSessionLimit: 0 });
  assert.equal(readConfig().savedSessionLimit, 0);
  renderConfig({ savedSessionLimit: 7 });
  assert.equal(readConfig().savedSessionLimit, 7);
  for (const invalid of [-1, 1.5, NaN, Infinity, "10"]) {
    renderConfig({ savedSessionLimit: invalid });
    assert.throws(() => readConfig(), /savedSessionLimit/);
  }
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
    savedSessionLimit: 10,
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

test("rendered retain-workers, soft-timeout, context-budget, and compaction values are validated on read", () => {
  for (const [record, field] of [
    [{ retainWorkers: "true" }, "retainWorkers"],
    [{ workerCompaction: "false" }, "workerCompaction"],
    [{ softTimeoutMs: -1 }, "softTimeoutMs"],
    [{ softTimeoutMs: 1.5 }, "softTimeoutMs"],
    [{ softTimeoutMs: "300000" }, "softTimeoutMs"],
    [{ workerContextBudgetTokens: 1 }, "workerContextBudgetTokens"],
    [{ workerContextBudgetTokens: 1.5 }, "workerContextBudgetTokens"],
  ] as const) {
    renderConfig(record);
    assert.throws(() => readConfig(), new RegExp(`Invalid Pi Herdsman config field ${field}`));
  }
});

test("a read racing with final reset treats ENOENT as absent", () => {
  renderConfig({ spawnPlacement: "tab" });
  deleteBeforeRead = true;
  assert.deepEqual(readConfig(), DEFAULT_CONFIG);
});
