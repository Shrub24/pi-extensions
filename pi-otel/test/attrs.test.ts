import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { textAttr, fingerprint, GEN_AI_SYSTEM } from "../src/attrs.ts";

describe("GEN_AI_SYSTEM", () => {
  test("is 'pi'", () => {
    assert.equal(GEN_AI_SYSTEM, "pi");
  });
});

describe("textAttr", () => {
  test("passes through short strings unchanged", () => {
    assert.equal(textAttr("hello"), "hello");
  });

  test("serializes objects to JSON", () => {
    assert.equal(textAttr({ a: 1 }), '{"a":1}');
  });

  test("serializes arrays to JSON", () => {
    assert.equal(textAttr([1, "two", true]), '[1,"two",true]');
  });

  test("serializes Error to a stack-bearing string", () => {
    const s = textAttr(new Error("boom"));
    assert.match(s, /Error: boom/);
  });

  test("handles null and undefined without throwing", () => {
    // JSON.stringify(null) === "null" (the 4-char string). For undefined,
    // JSON.stringify returns undefined, which our `?? "null"` fallback turns
    // into the same "null" string.
    assert.equal(textAttr(null), "null");
    assert.equal(textAttr(undefined), "null");
  });

  test("handles bigint", () => {
    // bigint: the replacer turns 42n into the string "42", then JSON.stringify
    // wraps that returned string in quotes -> the literal sequence "42".
    assert.equal(textAttr(42n), '"42"');
  });

  test("handles functions", () => {
    const s = textAttr(function named() { return 1; });
    // replacer returns '[function named]' (a string) -> JSON re-quotes it.
    assert.equal(s, '"[function named]"');
  });

  test("keeps a string above the former 64 KiB ceiling in full", () => {
    // Truncation was removed: what the model or a tool produced is exported
    // whole, so a backend never renders a silently shortened prompt, tool
    // argument or tool result. Multi-byte content survives because nothing is
    // ever cut in byte space.
    const big = `${ "x".repeat(70_000) }⚡𝄞`;
    const out = textAttr(big);
    assert.equal(out, big);
    assert.ok(Buffer.byteLength(out, "utf8") > 64 * 1024, "payload stays above the old ceiling");
  });

  test("handles circular references without throwing", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const s = textAttr(a);
    assert.match(s, /circular/);
  });

  test("shared (non-circular) references serialize at every occurrence", () => {
    // A DAG: the same object in two places is not a cycle. Tool arguments
    // commonly repeat references; degrading them to [circular] lost content.
    const shared = { x: 1 };
    const s = textAttr({ a: shared, b: shared });
    assert.deepEqual(JSON.parse(s), { a: { x: 1 }, b: { x: 1 } });
  });

  test("a root that sits on a cycle still serializes its other fields", () => {
    const a: Record<string, unknown> = { name: "root" };
    a.self = a;
    const s = textAttr(a);
    assert.deepEqual(JSON.parse(s), { name: "root", self: "[circular]" });
  });

  test("repeated Error instances serialize at every occurrence", () => {
    const e = new Error("boom");
    const s = textAttr({ first: e, second: e });
    assert.ok(s.includes("boom"), "content present");
    const parsed = JSON.parse(s) as { first: unknown; second: unknown };
    assert.ok(parsed.first && parsed.second, "both occurrences serialized");
  });

  test("handles nested circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a.peer = b;
    b.peer = a;
    const s = textAttr({ outer: a });
    assert.ok(s.includes('"outer"'));
    // Should not have thrown; output contains a serialization marker.
    assert.ok(s.length > 0);
  });

  test("keeps an object above the former 64 KiB ceiling in full", () => {
    const big = { data: "x".repeat(70_000) };
    const out = textAttr(big);
    assert.deepEqual(JSON.parse(out), big);
  });
});

describe("fingerprint", () => {
  test("returns bytes, lines, and a short hash", () => {
    const fp = fingerprint("hello\nworld");
    assert.equal(fp.bytes, 11);
    assert.equal(fp.lines, 2);
    assert.match(String(fp.hash_short), /^[0-9a-f]{8}$/);
  });

  test("empty string -> 0 bytes, 0 lines", () => {
    const fp = fingerprint("");
    assert.equal(fp.bytes, 0);
    assert.equal(fp.lines, 0);
  });

  test("same input produces same fingerprint (deterministic)", () => {
    assert.deepEqual(fingerprint("abc"), fingerprint("abc"));
  });

  test("different inputs produce different fingerprints", () => {
    assert.notDeepEqual(fingerprint("abc"), fingerprint("abd"));
  });

  test("accepts non-string input (serialized)", () => {
    const fp = fingerprint({ a: 1 });
    assert.equal(fp.bytes, Buffer.byteLength('{"a":1}', "utf8"));
    assert.equal(fp.lines, 1);
  });

  test("byte count is UTF-8 aware, not char count", () => {
    const fp = fingerprint("⚡"); // 3 bytes, 1 char
    assert.equal(fp.bytes, 3);
  });
});

describe("metric names", () => {
  test("only spec-true client metrics carry gen_ai names", async () => {
    const { METRIC_OP_DURATION, METRIC_TOKEN_USAGE, METRIC_LLM_TTFT, METRIC_LLM_TIME_TO_COMPLETION, METRIC_TOOL_CALLS } = await import("../src/attrs.ts");
    // The client metric set in every released convention (v1.28 through
    // v1.37) is exactly these two; anything else we emit lives under pi.*.
    assert.equal(METRIC_OP_DURATION, "gen_ai.client.operation.duration");
    assert.equal(METRIC_TOKEN_USAGE, "gen_ai.client.token.usage");
    assert.equal(METRIC_LLM_TTFT, "pi.llm.time_to_first_token");
    assert.equal(METRIC_LLM_TIME_TO_COMPLETION, "pi.llm.time_to_completion");
    assert.equal(METRIC_TOOL_CALLS, "pi.tool.calls");
  });
});
