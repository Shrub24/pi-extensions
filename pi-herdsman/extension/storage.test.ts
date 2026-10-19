import assert from "node:assert/strict";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import test from "node:test";
import { agentMailboxPath } from "./mailbox.ts";
import { supervisionRuntime } from "./supervision.ts";
import {
  herdsmanDataRoot,
  herdsmanConfigPath,
  herdsmanTempRoot,
  resolveResultRef,
  resultPath,
  resultRef,
} from "./storage.ts";

test("recoverable Herdsman state lives under Pi agent data", () => {
  const root = join(getAgentDir(), "pi-herdsman");
  assert.equal(herdsmanDataRoot(), root);
  assert.equal(herdsmanConfigPath(), join(root, "config.json"));
  assert.equal(
    dirname(resultPath("550e8400-e29b-41d4-a716-446655440000")),
    join(root, "results"),
  );
  assert.equal(
    dirname(agentMailboxPath("workspace", "agent")),
    join(root, "runtime", "mailboxes-v4"),
  );
  assert.equal(
    dirname(supervisionRuntime("socket with spaces").root),
    join(root, "runtime", "supervision-v2"),
  );
  assert.notEqual(herdsmanTempRoot().startsWith(root), true);
});

test("an explicit Herdsman data root is shared across Pi agent directories", () => {
  const previousRoot = process.env.PI_HERDSMAN_DATA_DIR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const sharedRoot = "/tmp/pi-herdsman-shared";
  process.env.PI_HERDSMAN_DATA_DIR = sharedRoot;
  process.env.PI_CODING_AGENT_DIR = "/tmp/pi-role-agent";
  try {
    assert.equal(herdsmanDataRoot(), sharedRoot);
    assert.equal(
      dirname(agentMailboxPath("workspace", "agent")),
      join(sharedRoot, "runtime", "mailboxes-v4"),
    );
  } finally {
    if (previousRoot === undefined) delete process.env.PI_HERDSMAN_DATA_DIR;
    else process.env.PI_HERDSMAN_DATA_DIR = previousRoot;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("PI_HERDSMAN_DATA_DIR must be absolute", () => {
  const previousRoot = process.env.PI_HERDSMAN_DATA_DIR;
  process.env.PI_HERDSMAN_DATA_DIR = "relative/path";
  try {
    assert.throws(() => herdsmanDataRoot(), /must be an absolute path/);
  } finally {
    if (previousRoot === undefined) delete process.env.PI_HERDSMAN_DATA_DIR;
    else process.env.PI_HERDSMAN_DATA_DIR = previousRoot;
  }
});

test("result references use canonical request UUIDs", () => {
  const requestId = "550e8400-e29b-41d4-a716-446655440000";
  const ref = resultRef(requestId);
  assert.equal(ref, `result:${requestId}`);
  assert.equal(resolveResultRef(ref), resultPath(requestId));
  for (const input of [
    "result:",
    "result:not-a-uuid",
    "result:../../file",
    "result:550e8400-e29b-41d4-a716-44665544000",
    "result:550E8400-e29b-41d4-a716-446655440000",
  ]) {
    assert.throws(() => resolveResultRef(input));
  }
  assert.equal(resolveResultRef("ordinary.txt"), undefined);
});
