import { expect, test } from "bun:test";
import { diff, fingerprint, sectionsOf, usageFlags } from "../extensions/diff.js";

const META = { pid: 1, session: "s.jsonl", at: "2026-10-04T00:00:00.000Z" };

function body(over: Record<string, unknown> = {}) {
  return {
    model: "claude-opus-5-5",
    max_tokens: 32000,
    tools: [{ name: "read", description: "read a file", input_schema: { type: "object" } }],
    system: [
      { type: "text", text: "billing header", cache_control: { ttl: "1h" } },
      { type: "text", text: "identity", cache_control: { ttl: "1h" } },
      { type: "text", text: "<cwd>\n/proj\n</cwd>\n<mcp_servers>\n502 chars of mcp table\n</mcp_servers>" },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "desk" }] },
      { role: "assistant", content: [{ type: "text", text: "ok", cache_control: { ttl: "1h" } }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ],
    ...over,
  };
}

test("sections are named and sized", () => {
  const fp = fingerprint(body(), META);
  const names = fp.system[2].sections.map((s) => s.name);
  expect(names).toEqual(["cwd", "mcp_servers"]);
});

test("marker movement is not a divergence", () => {
  const first = body();
  const second = body();
  // The breakpoint moves to the newest message; content is unchanged.
  (second.messages[1] as any).content = [{ type: "text", text: "ok" }];
  (second.messages[2] as any).content = [{ type: "text", text: "next", cache_control: { ttl: "1h" } }];
  const a = fingerprint(first, META);
  const b = fingerprint(second, META);
  expect(diff(a, b)).toEqual({ kind: "append", detail: "+0 messages" });
});

test("a dropped system section is named with its size", () => {
  const before = fingerprint(body(), META);
  const shrunk = body();
  (shrunk.system[2] as any).text = "<cwd>\n/proj\n</cwd>";
  const after = fingerprint(shrunk, META);
  const d = diff(before, after);
  expect(d.kind).toBe("system");
  expect(d.at).toBe("system[2]");
  expect(d.detail).toMatch(/mcp_servers \d+ch->absent/);
});

test("a tools change is classified before any message change", () => {
  const before = fingerprint(body(), META);
  const withTool = body();
  (withTool.tools as unknown[]).push({ name: "bash", description: "run", input_schema: { type: "object" } });
  (withTool.messages[2] as any).content = [{ type: "text", text: "changed too" }];
  const after = fingerprint(withTool, META);
  expect(diff(before, after).kind).toBe("tools");
});

test("a rewritten message is located", () => {
  const before = fingerprint(body(), META);
  const edited = body();
  (edited.messages[2] as any).content = [{ type: "text", text: "rewritten by a context edit" }];
  const after = fingerprint(edited, META);
  const d = diff(before, after);
  expect(d.kind).toBe("mutate");
  expect(d.at).toBe("messages[2]");
});

test("a shorter prompt is a truncation, not a mutation", () => {
  const before = fingerprint(body(), META);
  const shorter = body();
  shorter.messages = shorter.messages.slice(0, 2);
  const after = fingerprint(shorter, META);
  const d = diff(before, after);
  expect(d.kind).toBe("truncate");
  expect(d.detail).toBe("3 -> 2 messages");
});

test("a parameter change is its own class", () => {
  const before = fingerprint(body(), META);
  const level = body();
  level.max_tokens = 64000;
  const after = fingerprint(level, META);
  const d = diff(before, after);
  expect(d.kind).toBe("params");
  expect(d.detail).toBe("max_tokens");
});

test("cold and re-billed are read from usage", () => {
  const cold = usageFlags({ input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 165051 }, 0);
  expect(cold.promptTokens).toBe(165151);
  expect(cold.cold).toBe(true);

  const reBilled = usageFlags(
    { input_tokens: 0, cache_read_input_tokens: 33716, cache_creation_input_tokens: 133924 },
    167640,
  );
  expect(reBilled.reBilled).toBe(true);
  expect(reBilled.cold).toBe(false);

  const healthy = usageFlags({ input_tokens: 4, cache_read_input_tokens: 167000, cache_creation_input_tokens: 300 }, 167000);
  expect(healthy.reBilled).toBe(false);
  expect(healthy.cold).toBe(false);

  expect(usageFlags(undefined, 0).seen).toBe(false);
});
