import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  formatTraceparent,
  inheritedTraceparent,
  parseTraceparent,
  publishTraceparent,
  resetInheritedTraceparent,
} from "../src/traceparent.ts";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("formatTraceparent", () => {
  test("formats ids and flags as version 00", () => {
    assert.equal(
      formatTraceparent({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: 1,
        isRemote: false,
      }),
      VALID,
    );
  });

  test("renders unsampled flags", () => {
    const value = formatTraceparent({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 0,
      isRemote: false,
    });
    assert.ok(value?.endsWith("-00"));
  });

  test("returns undefined for an empty context (no-op tracer)", () => {
    assert.equal(
      formatTraceparent({ traceId: "", spanId: "", traceFlags: 0, isRemote: false }),
      undefined,
    );
  });
});

describe("parseTraceparent", () => {
  test("parses a valid header into a remote context", () => {
    assert.deepEqual(parseTraceparent(VALID), {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
      isRemote: true,
    });
  });

  test("lowercases ids and trims surrounding whitespace", () => {
    const parsed = parseTraceparent(` 00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01 `);
    assert.equal(parsed?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(parsed?.spanId, "00f067aa0ba902b7");
  });

  test("accepts trailing vendor fields", () => {
    assert.equal(parseTraceparent(`${VALID}-extra`)?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  });

  test("rejects absent, malformed, and forbidden values", () => {
    for (const value of [
      undefined,
      "",
      "   ",
      "not-a-traceparent",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
      "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-zz",
    ]) {
      assert.equal(parseTraceparent(value), undefined, `rejected: ${String(value)}`);
    }
  });
});

describe("inheritedTraceparent", () => {
  const env = {} as NodeJS.ProcessEnv;

  beforeEach(() => {
    resetInheritedTraceparent();
  });

  afterEach(() => {
    resetInheritedTraceparent();
  });

  test("reads the environment value", () => {
    env.TRACEPARENT = VALID;
    assert.equal(inheritedTraceparent(env)?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  });

  test("is undefined when nothing was inherited", () => {
    delete env.TRACEPARENT;
    assert.equal(inheritedTraceparent(env), undefined);
  });

  test("reads once per process, so a context published for children is never mistaken for one inherited", () => {
    delete env.TRACEPARENT;
    assert.equal(inheritedTraceparent(env), undefined);
    // This process later publishes its own run context for its children.
    env.TRACEPARENT = VALID;
    assert.equal(inheritedTraceparent(env), undefined, "the memoized value still stands");
  });
});

describe("publishTraceparent", () => {
  const env = {} as NodeJS.ProcessEnv;

  test("sets the value and restores the previous one on withdrawal", () => {
    env.TRACEPARENT = "outer";
    const withdraw = publishTraceparent(VALID, env);
    assert.equal(env.TRACEPARENT, VALID);
    withdraw();
    assert.equal(env.TRACEPARENT, "outer");
  });

  test("deletes the variable when the previous value was unset", () => {
    delete env.TRACEPARENT;
    const withdraw = publishTraceparent(VALID, env);
    withdraw();
    assert.equal("TRACEPARENT" in env, false);
  });

  test("withdrawal is idempotent and leaves a foreign value alone", () => {
    delete env.TRACEPARENT;
    const withdraw = publishTraceparent(VALID, env);
    env.TRACEPARENT = "someone-else";
    withdraw();
    withdraw();
    assert.equal(env.TRACEPARENT, "someone-else", "a value we did not install is not clobbered");
  });
});
