import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractSessionId, normalizeLogPayload, normalizeParentRef } from "../src/index.ts";

describe("extractSessionId", () => {
  test("strips the timestamp prefix from an interactive session file stem", () => {
    const uuid = "019123ab-c1d0-7ef4-9a4b-1c2d3e4f5a6b";
    assert.equal(extractSessionId(`1728000000000_${uuid}`), uuid);
  });

  test("returns a bare UUID stem unchanged", () => {
    const uuid = "019123ab-c1d0-7ef4-9a4b-1c2d3e4f5a6b";
    assert.equal(extractSessionId(uuid), uuid);
  });

  test("returns a non-UUID stem unchanged (backward-compatible value)", () => {
    assert.equal(extractSessionId("e2e"), "e2e");
    assert.equal(extractSessionId("my-named-session"), "my-named-session");
  });

  test("does not match a UUID that is not terminal in the stem", () => {
    assert.equal(
      extractSessionId("019123ab-c1d0-7ef4-9a4b-1c2d3e4f5a6b_extra"),
      "019123ab-c1d0-7ef4-9a4b-1c2d3e4f5a6b_extra",
    );
    assert.equal(extractSessionId("not-a-uuid-at-all"), "not-a-uuid-at-all");
  });
});

describe("normalizeParentRef (orchestrator env values)", () => {
  const uuid = "019123ab-c1d0-7ef4-9a4b-1c2d3e4f5a6b";

  test("reduces every published shape to the bare UUID so parent ids join against pi.session.id", () => {
    assert.equal(normalizeParentRef(uuid), uuid, "bare UUID unchanged");
    assert.equal(normalizeParentRef(`1728000000000_${uuid}`), uuid, "stem reduced to UUID");
    assert.equal(normalizeParentRef(`/runs/42/1728000000000_${uuid}.jsonl`), uuid, "full path reduced to UUID");
    assert.equal(normalizeParentRef("  " + uuid + "  "), uuid, "surrounding whitespace trimmed");
  });

  test("keeps values without a UUID verbatim so custom session names still join", () => {
    assert.equal(normalizeParentRef("my-orchestrator-run"), "my-orchestrator-run");
    assert.equal(normalizeParentRef("/runs/42/session"), "session");
  });

  test("returns undefined for unset, empty, and whitespace-only values", () => {
    assert.equal(normalizeParentRef(undefined), undefined);
    assert.equal(normalizeParentRef(""), undefined);
    assert.equal(normalizeParentRef("   "), undefined);
  });
});

/**
 * The pi-otel:log channel accepts payloads from other extensions, which are
 * untrusted. normalizeLogPayload is the validation boundary: it must reject
 * non-objects and payloads without a usable eventName, coerce severity to a
 * known value, and drop attribute values the OTLP log model cannot carry
 * (nested objects, arrays) while keeping scalars and clamping long strings.
 */
describe("normalizeLogPayload (pi-otel:log channel validation)", () => {
  test("accepts a well-formed payload", () => {
    const out = normalizeLogPayload({
      eventName: "my-ext.event",
      severity: "warn",
      body: "hello",
      attributes: { ok: true, n: 3, s: "x" },
    });
    assert.deepEqual(out, {
      eventName: "my-ext.event",
      severity: "warn",
      body: "hello",
      attributes: { ok: true, n: 3, s: "x" },
    });
  });

  test("rejects non-objects", () => {
    assert.equal(normalizeLogPayload(null), null);
    assert.equal(normalizeLogPayload(undefined), null);
    assert.equal(normalizeLogPayload("nope"), null);
    assert.equal(normalizeLogPayload(42), null);
    assert.equal(normalizeLogPayload([], ), null);
  });

  test("rejects payloads without a string eventName", () => {
    assert.equal(normalizeLogPayload({ severity: "info" }), null);
    assert.equal(normalizeLogPayload({ eventName: 42 }), null);
    assert.equal(normalizeLogPayload({ eventName: "" }), null);
  });

  test("coerces unknown severity to info", () => {
    const out = normalizeLogPayload({ eventName: "e", severity: "bogus" });
    assert.equal(out!.severity, "info");
  });

  test("defaults missing body to empty string", () => {
    const out = normalizeLogPayload({ eventName: "e" });
    assert.equal(out!.body, "");
  });

  test("drops non-scalar attribute values", () => {
    const out = normalizeLogPayload({
      eventName: "e",
      attributes: {
        keep_str: "s",
        keep_num: 1,
        keep_bool: true,
        drop_obj: { nested: "secret" },
        drop_arr: [1, 2, 3],
        drop_null: null,
        drop_undef: undefined,
      },
    });
    assert.deepEqual(out!.attributes, {
      keep_str: "s",
      keep_num: 1,
      keep_bool: true,
    });
    // Ensure the nested secret value is not present anywhere in the output.
    assert.ok(!JSON.stringify(out!.attributes).includes("secret"));
  });

  test("accepts attributes when missing entirely", () => {
    const out = normalizeLogPayload({ eventName: "e" });
    assert.deepEqual(out!.attributes, {});
  });

  test("clamps long string attribute values to the attribute ceiling", () => {
    const long = "a".repeat(100 * 1024);
    const out = normalizeLogPayload({ eventName: "e", attributes: { big: long } });
    const v = out!.attributes.big as string;
    assert.ok(v.length < long.length, "value was clamped");
    assert.ok(v.endsWith("…[truncated]"), "truncation marker present");
    assert.ok(Buffer.byteLength(v, "utf8") <= 64 * 1024, "within 64 KiB");
  });

  test("clamps an oversized eventName", () => {
    const long = "e".repeat(100 * 1024);
    const out = normalizeLogPayload({ eventName: long });
    const v = out!.eventName as string;
    assert.ok(v.length < long.length, "eventName was clamped");
    assert.ok(v.endsWith("…[truncated]"), "truncation marker present");
    assert.ok(Buffer.byteLength(v, "utf8") <= 64 * 1024, "within 64 KiB");
  });

  test("clamps a long body", () => {
    const long = "b".repeat(100 * 1024);
    const out = normalizeLogPayload({ eventName: "e", body: long });
    assert.ok(out!.body.length < long.length);
    assert.ok(out!.body.endsWith("…[truncated]"));
  });
});
