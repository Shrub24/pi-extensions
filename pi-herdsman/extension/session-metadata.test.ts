import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OPERATOR_ROLES,
  SESSION_METADATA_ENTRY,
  SESSION_METADATA_VERSION,
  readSessionMetadata,
  updateSessionMetadata,
  type SessionMetadata,
} from "./session-metadata.ts";

const OPERATOR_KEYS = ["kind", "role", "sessionId", "version"];
const MANAGED_KEYS = [
  "definition",
  "kind",
  "label",
  "parentSessionId",
  "role",
  "sessionId",
  "version",
];
const operator = (sessionId: string, role = "lead"): SessionMetadata => ({
  version: 1,
  sessionId,
  kind: "operator",
  role,
});
const managed = (
  sessionId: string,
  parentSessionId: string,
  definition = "worker",
): SessionMetadata => ({
  version: 1,
  sessionId,
  kind: "managed",
  role: definition,
  parentSessionId,
  definition,
  label: "impl",
});
const entry = (data: unknown) => ({
  type: "custom",
  customType: SESSION_METADATA_ENTRY,
  data,
});

test("version-1 operator and managed records survive a reader round trip", () => {
  const sessionId = randomUUID();
  assert.deepEqual(
    readSessionMetadata([entry(operator(sessionId))], sessionId),
    { status: "available", metadata: operator(sessionId) },
  );
  const record = managed(sessionId, randomUUID(), "researcher");
  assert.deepEqual(readSessionMetadata([entry(record)], sessionId), {
    status: "available",
    metadata: record,
  });
  assert.deepEqual(readSessionMetadata([], sessionId), { status: "absent" });
  // Only Herdsman's own custom entry type carries classification.
  assert.deepEqual(
    readSessionMetadata(
      [
        { type: "message", data: operator(sessionId) },
        {
          type: "custom",
          customType: "pi-herdsman-role",
          data: operator(sessionId),
        },
        { type: "custom", customType: SESSION_METADATA_ENTRY },
        { type: "custom", customType: SESSION_METADATA_ENTRY, data: "text" },
      ],
      sessionId,
    ),
    { status: "absent" },
  );
});

test("the latest current-session record wins", () => {
  const sessionId = randomUUID();
  assert.deepEqual(
    readSessionMetadata(
      [
        entry(operator(sessionId, "lead")),
        entry(managed(sessionId, randomUUID())),
        entry(operator(sessionId, "chief")),
      ],
      sessionId,
    ),
    { status: "available", metadata: operator(sessionId, "chief") },
  );
});

test("foreign records are ignored before their payload is validated", () => {
  const sessionId = randomUUID();
  const foreign = randomUUID();
  assert.deepEqual(
    readSessionMetadata(
      [
        entry({ sessionId: foreign, kind: "managed", nonsense: true }),
        entry({ kind: "operator", role: "lead" }),
        entry({ sessionId: 42 }),
        entry({ sessionId: ` ${sessionId} ` }),
        entry(operator(sessionId, "manager")),
      ],
      sessionId,
    ),
    { status: "available", metadata: operator(sessionId, "manager") },
  );
  // A fork holding only its source's records is not classified by them.
  assert.deepEqual(
    readSessionMetadata([entry(managed(foreign, sessionId))], sessionId),
    { status: "absent" },
  );
});

test("malformed and unsupported current records are unavailable, never guessed", () => {
  const sessionId = randomUUID();
  for (const data of [
    { version: 1, sessionId, kind: "operator" },
    operator(sessionId, "foreman" as never),
    { ...operator(sessionId), kind: "worker" },
    { ...operator(sessionId), paneId: "w:p1" },
    { ...operator(sessionId), version: 2 },
    { version: 2, sessionId, kind: "operator", role: "lead" },
    { version: 1, sessionId, kind: "managed", role: "worker" },
    { ...managed(sessionId, randomUUID()), label: "" },
    { ...managed(sessionId, randomUUID()), parentSessionId: "not-a-uuid" },
    { ...managed(sessionId, randomUUID()), definition: " worker" },
  ]) {
    const read = readSessionMetadata([entry(data)], sessionId);
    assert.equal(read.status, "unavailable", JSON.stringify(data));
    assert.match(
      (read as { reason: string }).reason,
      /pi-herdsman-session-metadata/,
      JSON.stringify(data),
    );
  }
  // An earlier readable record cannot rescue an unreadable latest one.
  assert.equal(
    readSessionMetadata(
      [entry(operator(sessionId, "lead")), entry({ version: 1, sessionId })],
      sessionId,
    ).status,
    "unavailable",
  );
  // Nor can a write proceed on top of one.
  const entries: unknown[] = [entry({ version: 7, sessionId })];
  const outcome = updateSessionMetadata(entries, operator(sessionId), (data) =>
    entries.push(entry(data)),
  );
  assert.equal(outcome.status, "unavailable");
  assert.equal(entries.length, 1);
});

test("updates append only meaningful changes and preserve managed origin", () => {
  const sessionId = randomUUID();
  const entries: unknown[] = [];
  const append = (data: SessionMetadata) => entries.push(entry(data));
  const write = (metadata: SessionMetadata) =>
    updateSessionMetadata(entries, metadata, append);

  assert.deepEqual(write(operator(sessionId, "lead")), {
    status: "appended",
    metadata: operator(sessionId, "lead"),
  });
  assert.deepEqual(write(operator(sessionId, "lead")), {
    status: "unchanged",
    metadata: operator(sessionId, "lead"),
  });
  assert.equal(entries.length, 1, "a repeated startup must not duplicate");
  assert.deepEqual(write(operator(sessionId, "chief")), {
    status: "appended",
    metadata: operator(sessionId, "chief"),
  });
  assert.equal(entries.length, 2, "a role change appends a new record");
  assert.deepEqual(readSessionMetadata(entries, sessionId), {
    status: "available",
    metadata: operator(sessionId, "chief"),
  });

  // A managed session opened without managed launch environment keeps its origin.
  const owned: unknown[] = [];
  const writeOwned = (metadata: SessionMetadata) =>
    updateSessionMetadata(owned, metadata, (data) => owned.push(entry(data)));
  const worker = managed(sessionId, randomUUID());
  assert.deepEqual(writeOwned(worker), { status: "appended", metadata: worker });
  assert.deepEqual(writeOwned(worker), { status: "unchanged", metadata: worker });
  const newOwner = managed(sessionId, randomUUID());
  assert.deepEqual(writeOwned(newOwner), {
    status: "appended",
    metadata: newOwner,
  });
  assert.deepEqual(readSessionMetadata(owned, sessionId), {
    status: "available",
    metadata: newOwner,
  });
  assert.deepEqual(writeOwned(operator(sessionId, "lead")), {
    status: "preserved",
    metadata: newOwner,
  });
  assert.equal(owned.length, 2);
});

test("the reference page's examples are exactly what the reader accepts", () => {
  const doc = readFileSync(
    new URL("../docs/reference/session-organization.md", import.meta.url),
    "utf8",
  );
  const examples = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((match) =>
    JSON.parse(match[1]!),
  );
  assert.deepEqual(
    examples.map((example) => example.data?.kind),
    ["operator", "managed"],
    "the page documents both record shapes",
  );
  for (const example of examples) {
    assert.equal(example.type, "custom");
    assert.equal(example.customType, SESSION_METADATA_ENTRY);
    assert.equal(example.data.version, SESSION_METADATA_VERSION);
    if (example.data.kind === "operator")
      assert.ok(
        (OPERATOR_ROLES as readonly string[]).includes(example.data.role),
        example.data.role,
      );
    assert.deepEqual(
      Object.keys(example.data).sort(),
      example.data.kind === "operator" ? OPERATOR_KEYS : MANAGED_KEYS,
    );
    const read = readSessionMetadata(
      [{ ...example, data: { ...example.data } }],
      example.data.sessionId,
    );
    assert.deepEqual(read, {
      status: "available",
      metadata: example.data,
    });
  }
});

test("real session JSONL keeps records session-scoped and legacy identity untouched", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-herdsman-metadata-"));
  const sessionDir = join(cwd, "sessions");
  const owner = randomUUID();
  try {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const started = SessionManager.create(cwd, sessionDir);
    const sessionId = started.getSessionId();
    // The existing identity entry is written first and must stay untouched.
    const legacy = { sessionId, definition: "worker", label: "impl" };
    started.appendCustomEntry("pi-herdsman-agent-definition", legacy);
    assert.equal(
      updateSessionMetadata(started.getEntries(), managed(sessionId, owner), (data) =>
        started.appendCustomEntry(SESSION_METADATA_ENTRY, data),
      ).status,
      "appended",
    );
    started.appendMessage({
      role: "user",
      content: [{ type: "text", text: "start" }],
    });
    const path = started.getSessionFile()!;
    assert.equal(existsSync(path), true, "metadata is persisted to JSONL");

    // A reload keeps the record, and a repeated startup appends nothing.
    const reopened = SessionManager.open(path, sessionDir);
    assert.deepEqual(readSessionMetadata(reopened.getEntries(), sessionId), {
      status: "available",
      metadata: managed(sessionId, owner),
    });
    assert.equal(
      updateSessionMetadata(reopened.getEntries(), managed(sessionId, owner), (data) =>
        reopened.appendCustomEntry(SESSION_METADATA_ENTRY, data),
      ).status,
      "unchanged",
    );
    const changedOwner = managed(sessionId, randomUUID());
    assert.equal(
      updateSessionMetadata(reopened.getEntries(), changedOwner, (data) =>
        reopened.appendCustomEntry(SESSION_METADATA_ENTRY, data),
      ).status,
      "appended",
      "an owner change appends",
    );
    assert.deepEqual(readSessionMetadata(reopened.getEntries(), sessionId), {
      status: "available",
      metadata: changedOwner,
    });

    const lines: any[] = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const persisted = lines.filter(
      (line) => line.customType === SESSION_METADATA_ENTRY,
    );
    assert.equal(persisted.length, 2);
    for (const line of persisted)
      assert.deepEqual(
        Object.keys(line.data).sort(),
        MANAGED_KEYS,
        "persisted metadata carries no pane, path or live-state keys",
      );
    const definitions = lines.filter(
      (line) => line.customType === "pi-herdsman-agent-definition",
    );
    assert.equal(definitions.length, 1);
    assert.deepEqual(definitions[0].data, legacy);
    assert.deepEqual(Object.keys(definitions[0].data).sort(), [
      "definition",
      "label",
      "sessionId",
    ]);
    const operatorKeys = Object.keys(operator(sessionId)).sort();
    assert.deepEqual(operatorKeys, OPERATOR_KEYS);

    // A fork that copies its source's records is not classified by them.
    const fork = SessionManager.create(cwd, sessionDir);
    fork.appendMessage({
      role: "user",
      content: [{ type: "text", text: "fork" }],
    });
    appendFileSync(
      fork.getSessionFile()!,
      `${JSON.stringify({ ...persisted[1], id: randomUUID(), parentId: null })}\n`,
    );
    const forkReload = SessionManager.open(fork.getSessionFile()!, sessionDir);
    const forkId = forkReload.getSessionId();
    assert.notEqual(forkId, sessionId);
    assert.deepEqual(
      readSessionMetadata(forkReload.getEntries(), forkId),
      { status: "absent" },
      "copied foreign records do not classify the fork",
    );
    assert.equal(
      updateSessionMetadata(forkReload.getEntries(), operator(forkId), (data) =>
        forkReload.appendCustomEntry(SESSION_METADATA_ENTRY, data),
      ).status,
      "appended",
    );
    assert.deepEqual(readSessionMetadata(forkReload.getEntries(), forkId), {
      status: "available",
      metadata: operator(forkId),
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
