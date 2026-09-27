import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { clampAttr, fingerprint, GEN_AI_SYSTEM } from "../src/attrs.ts";

describe("GEN_AI_SYSTEM", () => {
  test("is 'pi'", () => {
    assert.equal(GEN_AI_SYSTEM, "pi");
  });
});

describe("clampAttr", () => {
  test("passes through short strings unchanged", () => {
    assert.equal(clampAttr("hello"), "hello");
  });

  test("serializes objects to JSON", () => {
    assert.equal(clampAttr({ a: 1 }), '{"a":1}');
  });

  test("serializes arrays to JSON", () => {
    assert.equal(clampAttr([1, "two", true]), '[1,"two",true]');
  });

  test("serializes Error to a stack-bearing string", () => {
    const s = clampAttr(new Error("boom"));
    assert.match(s, /Error: boom/);
  });

  test("handles null and undefined without throwing", () => {
    // JSON.stringify(null) === "null" (the 4-char string). For undefined,
    // JSON.stringify returns undefined, which our `?? "null"` fallback turns
    // into the same "null" string.
    assert.equal(clampAttr(null), "null");
    assert.equal(clampAttr(undefined), "null");
  });

  test("handles bigint", () => {
    // bigint: the replacer turns 42n into the string "42", then JSON.stringify
    // wraps that returned string in quotes -> the literal sequence "42".
    assert.equal(clampAttr(42n), '"42"');
  });

  test("handles functions", () => {
    const s = clampAttr(function named() { return 1; });
    // replacer returns '[function named]' (a string) -> JSON re-quotes it.
    assert.equal(s, '"[function named]"');
  });

  test("truncates strings exceeding 64 KiB and keeps total under the limit", () => {
    const big = "x".repeat(70_000);
    const out = clampAttr(big);
    assert.ok(Buffer.byteLength(out, "utf8") <= 64 * 1024, "output must fit under 64 KiB");
    assert.ok(out.endsWith("…[truncated]"), "must end with truncation marker");
    // original content preserved up to the cut point
    assert.ok(out.startsWith("x".repeat(1000)));
  });

  test("truncation is byte-safe (never splits a multi-byte UTF-8 sequence)", () => {
    // '⚡' is 3 bytes in UTF-8. Build a string whose byte length straddles the
    // limit in the middle of a character.
    const char = "⚡";
    const charBytes = Buffer.byteLength(char, "utf8");
    const fill = "a".repeat(64 * 1024 - Math.floor(charBytes / 2));
    const big = fill + char.repeat(100);
    const out = clampAttr(big);
    // The output, decoded as UTF-8, must be valid (no replacement chars from a
    // split sequence). Round-trip through Buffer to validate.
    const decoded = Buffer.from(out, "utf8").toString("utf8");
    assert.ok(decoded.length > 0);
    assert.ok(!decoded.includes("\uFFFD"), "no U+FFFD replacement chars from split multibyte");
  });

  test("truncation lands on a UTF-8 character boundary for 4-byte chars", () => {
    // The truncation point is computed in byte space against the UTF-8 buffer,
    // so it must never cut in the middle of a multi-byte sequence. 𝄞 (U+1D11E)
    // is a 4-byte UTF-8 char encoded as a surrogate pair in JS. An earlier
    // implementation walked back using UTF-16 charCodeAt against UTF-8 byte
    // masks, which never matched for code points above U+00FF and could leave
    // the cut mid-character. Repeat across many offsets to cover the boundary.
    const ch = "𝄞"; // 4 bytes in UTF-8, 2 UTF-16 code units
    const chBytes = Buffer.byteLength(ch, "utf8");
    assert.equal(chBytes, 4);
    // Fill so the limit falls inside a run of 4-byte chars at various offsets.
    for (const offset of [0, 1, 2, 3, 4, 5]) {
      const fill = "a".repeat(64 * 1024 - offset);
      const big = fill + ch.repeat(1000);
      const out = clampAttr(big);
      const buf = Buffer.from(out, "utf8");
      assert.ok(buf.length <= 64 * 1024, `fits under 64 KiB at offset ${offset}`);
      // No U+FFFD when decoded means no sequence was split.
      const decoded = buf.toString("utf8");
      assert.ok(!decoded.includes("\uFFFD"), `no replacement char at offset ${offset}`);
      assert.ok(out.endsWith("…[truncated]"), `marker present at offset ${offset}`);
    }
  });

  test("handles circular references without throwing", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const s = clampAttr(a);
    assert.match(s, /circular/);
  });

  test("shared (non-circular) references serialize at every occurrence", () => {
    // A DAG: the same object in two places is not a cycle. Tool arguments
    // commonly repeat references; degrading them to [circular] lost content.
    const shared = { x: 1 };
    const s = clampAttr({ a: shared, b: shared });
    assert.deepEqual(JSON.parse(s), { a: { x: 1 }, b: { x: 1 } });
  });

  test("a root that sits on a cycle still serializes its other fields", () => {
    const a: Record<string, unknown> = { name: "root" };
    a.self = a;
    const s = clampAttr(a);
    assert.deepEqual(JSON.parse(s), { name: "root", self: "[circular]" });
  });

  test("repeated Error instances serialize at every occurrence", () => {
    const e = new Error("boom");
    const s = clampAttr({ first: e, second: e });
    assert.ok(s.includes("boom"), "content present");
    const parsed = JSON.parse(s) as { first: unknown; second: unknown };
    assert.ok(parsed.first && parsed.second, "both occurrences serialized");
  });

  test("handles nested circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a.peer = b;
    b.peer = a;
    const s = clampAttr({ outer: a });
    assert.ok(s.includes('"outer"'));
    // Should not have thrown; output contains a serialization marker.
    assert.ok(s.length > 0);
  });

  test("truncates large objects too", () => {
    const big = { data: "x".repeat(70_000) };
    const out = clampAttr(big);
    assert.ok(Buffer.byteLength(out, "utf8") <= 64 * 1024);
    assert.ok(out.endsWith("…[truncated]"));
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
