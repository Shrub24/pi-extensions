import assert from "node:assert/strict";
import test from "node:test";

import { decodeWaitingEvidence, type WaitingEvidence } from "./background-waiting.ts";

const scope = { sessionId: "session-alpha", requestId: "request-alpha" };

const minimalValue = () => ({
  sessionId: "session-alpha",
  requestId: "request-alpha",
  provider: { id: "background-provider", version: 4 },
  revision: 7,
  taskIds: ["bg-1"],
});

/** Every rejection is a backgroundWaiting.-prefixed, bounded, input-free error. */
const assertWaitingError = (fn: () => unknown, rawInputNeedle?: string): void => {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error, `expected an Error, received ${String(error)}`);
    assert.ok(error.message.startsWith("backgroundWaiting."), `unexpected error prefix: ${error.message}`);
    assert.ok(error.message.length <= 512, `error message longer than 512 characters: ${error.message.length}`);
    if (rawInputNeedle !== undefined) {
      assert.ok(!error.message.includes(rawInputNeedle), `error message interpolates raw input: ${error.message}`);
    }
    return true;
  });
};

test("decodes a minimal valid value into a canonical copy", () => {
  const input = minimalValue();
  const decoded = decodeWaitingEvidence(input, scope);
  assert.deepEqual(decoded, {
    sessionId: "session-alpha",
    requestId: "request-alpha",
    provider: { id: "background-provider", version: 4 },
    revision: 7,
    taskIds: ["bg-1"],
  } satisfies WaitingEvidence);
  assert.notStrictEqual(decoded.provider, input.provider, "provider must be copied, not aliased");
  assert.notStrictEqual(decoded.taskIds, input.taskIds, "taskIds must be copied, not aliased");
});

test("an empty task list is valid: a blocked reconciliation carries no decidable list", () => {
  const decoded = decodeWaitingEvidence({ ...minimalValue(), taskIds: [] }, scope);
  assert.deepEqual(decoded.taskIds, []);
  assert.equal(decoded.revision, 7);
});

test("identity strings are validated but never trimmed or rewritten", () => {
  const padded = { ...minimalValue(), sessionId: " session-alpha ", requestId: " request-alpha " };
  // Not a scope match: the padded value differs from expectedScope verbatim.
  assertWaitingError(() => decodeWaitingEvidence(padded, scope));

  const longScope = { sessionId: "x".repeat(256), requestId: "y".repeat(256) };
  const atLimit = decodeWaitingEvidence(
    { ...minimalValue(), sessionId: "x".repeat(256), requestId: "y".repeat(256) },
    longScope,
  );
  assert.equal(atLimit.sessionId.length, 256, "the 256-character boundary is inclusive");
});

test("exact scope mismatch is rejected without interpolating the raw identity", () => {
  assertWaitingError(
    () => decodeWaitingEvidence({ ...minimalValue(), sessionId: "intruder-session" }, scope),
    "intruder-session",
  );
  assertWaitingError(
    () => decodeWaitingEvidence({ ...minimalValue(), requestId: "intruder-request" }, scope),
    "intruder-request",
  );
});

test("missing fields are rejected one by one", () => {
  for (const field of ["sessionId", "requestId", "provider", "revision", "taskIds"] as const) {
    const value = minimalValue() as Record<string, unknown>;
    delete value[field];
    assertWaitingError(() => decodeWaitingEvidence(value, scope));
  }
});

test("unknown fields are rejected without naming the raw input", () => {
  assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), surprise: "unexpected-value" }, scope), "unexpected-value");
  assertWaitingError(
    () => decodeWaitingEvidence({ ...minimalValue(), provider: { id: "background-provider", version: 4, extra: "provider-extra" } }, scope),
    "provider-extra",
  );
});

test("non-object evidence and non-object provider are rejected", () => {
  for (const value of [null, undefined, "evidence", 42, ["session-alpha"]]) {
    assertWaitingError(() => decodeWaitingEvidence(value, scope));
  }
  for (const provider of [null, "provider", 42, ["background-provider"]]) {
    assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), provider }, scope));
  }
});

test("incomplete provider objects are rejected field by field", () => {
  assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), provider: {} }, scope));
  assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), provider: { id: "background-provider" } }, scope));
  assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), provider: { version: 4 } }, scope));
});

test("provider version must be a positive safe integer; numeric strings never count", () => {
  for (const version of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "4", null, true]) {
    assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), provider: { id: "background-provider", version } }, scope));
  }
});

test("revision must be a nonnegative safe integer; numeric strings never count", () => {
  for (const revision of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "7", null, true]) {
    assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), revision }, scope));
  }
  assert.equal(decodeWaitingEvidence({ ...minimalValue(), revision: 0 }, scope).revision, 0, "zero is a valid revision");
});

test("identity fields reject empty, whitespace-only, over-long and non-string values", () => {
  const badIdentities: unknown[] = ["", "   ", "\t\n", "x".repeat(257), 7, null, true];
  for (const sessionId of badIdentities) {
    assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), sessionId }, scope));
  }
  for (const requestId of badIdentities) {
    assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), requestId }, scope));
  }
  for (const id of badIdentities) {
    assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), provider: { id, version: 4 } }, scope));
  }
});

test("taskIds must be an array of bounded unique identities", () => {
  for (const taskIds of ["bg-1", null, 42, { "0": "bg-1" }]) {
    assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), taskIds }, scope));
  }
  assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), taskIds: ["bg-1", "bg-1"] }, scope));
  for (const badTaskId of ["", "   ", "x".repeat(257), 7, null]) {
    assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), taskIds: [badTaskId] }, scope));
  }
});

test("128 task ids pass the bound and 129 fail it", () => {
  const atBound = Array.from({ length: 128 }, (_, index) => `bg-${index}`);
  const decoded = decodeWaitingEvidence({ ...minimalValue(), taskIds: atBound }, scope);
  assert.equal(decoded.taskIds.length, 128);
  assert.deepEqual(decoded.taskIds, atBound);

  const overBound = Array.from({ length: 129 }, (_, index) => `bg-${index}`);
  assertWaitingError(() => decodeWaitingEvidence({ ...minimalValue(), taskIds: overBound }, scope));
});

test("canonical serialized evidence beyond 64 KiB UTF-8 is rejected, never truncated", () => {
  // 128 DISTINCT ids, each one emoji repeated: 256 UTF-16 units (an
  // in-bounds identity) but 512 UTF-8 bytes each, so the canonical record
  // crosses 64 KiB — distinctness keeps the rejection on the byte budget,
  // never on the duplicate-task rule.
  const wideTaskIds = Array.from({ length: 128 }, (_, index) => String.fromCodePoint(0x1f600 + index).repeat(128));
  assert.equal(new Set(wideTaskIds).size, 128, "the ids are distinct");
  assert.ok(wideTaskIds.every((id) => id.length === 256), "each id stays within the identity bound");
  const encodedBytes = Buffer.byteLength(JSON.stringify({ ...minimalValue(), taskIds: wideTaskIds }), "utf8");
  assert.ok(encodedBytes > 65536, `encoded evidence must exceed the budget, got ${encodedBytes} bytes`);
  assert.throws(
    () => decodeWaitingEvidence({ ...minimalValue(), taskIds: wideTaskIds }, scope),
    (error: unknown) => {
      assert.ok(error instanceof Error, `expected an Error, received ${String(error)}`);
      assert.ok(error.message.startsWith("backgroundWaiting."), `unexpected error prefix: ${error.message}`);
      assert.ok(
        error.message.includes("65536-byte state budget"),
        `expected the state-budget rejection, got: ${error.message}`,
      );
      assert.ok(error.message.length <= 512, `error message longer than 512 characters: ${error.message.length}`);
      return true;
    },
  );
});

test("later input mutation cannot mutate accepted evidence", () => {
  const input = minimalValue();
  const decoded = decodeWaitingEvidence(input, scope);

  input.sessionId = "mutated-session";
  input.provider.id = "mutated-provider";
  input.provider.version = 99;
  input.revision = 99;
  input.taskIds.push("bg-injected");
  input.taskIds[0] = "bg-mutated";

  assert.equal(decoded.sessionId, "session-alpha");
  assert.equal(decoded.provider.id, "background-provider");
  assert.equal(decoded.provider.version, 4);
  assert.equal(decoded.revision, 7);
  assert.deepEqual(decoded.taskIds, ["bg-1"]);
});
