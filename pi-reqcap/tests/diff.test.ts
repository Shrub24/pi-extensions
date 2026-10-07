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

test("a removed message reads as a removal, not a mutation", () => {
  const before = body({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "user", content: "c" }] });
  const after = body({ messages: [{ role: "user", content: "a" }, { role: "user", content: "c" }] });
  const d = diff(fingerprint(before, META), fingerprint(after, META));
  expect(d.kind).toBe("removed");
  expect(d.at).toBe("messages[1]");

  const inserted = body({ messages: [{ role: "user", content: "a" }, { role: "user", content: "n" }, { role: "user", content: "c" }] });
  const d2 = diff(fingerprint(after, META), fingerprint(inserted, META));
  expect(d2.kind).toBe("inserted");
  expect(d2.at).toBe("messages[1]");
});

test("an edited message in place is still a mutation", () => {
  const before = body({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] });
  const after = body({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b2" }] });
  expect(diff(fingerprint(before, META), fingerprint(after, META)).kind).toBe("mutate");
});

test("an OpenAI-shaped prompt is not double counted", () => {
  // The gateway reports prompt_tokens inclusive of the cached part.
  const u = usageFlags({ prompt_tokens: 30288, cached_tokens: 6144, prompt_tokens_details: { cached_tokens: 6144 }, completion_tokens: 99 }, 0);
  expect(u.read).toBe(6144);
  expect(u.input).toBe(24144);
  expect(u.promptTokens).toBe(30288);
});

test("a provider that never caches the whole prefix is not a re-bill", () => {
  const u = usageFlags({ prompt_tokens: 60799, prompt_tokens_details: { cached_tokens: 30336 } }, 60596, 30208);
  expect(u.promptTokens).toBe(60799);
  expect(u.reBilled).toBe(false);
});

test("a collapsed cached prefix is a re-bill even without a write charge", () => {
  const grew = usageFlags({ prompt_tokens: 227944, prompt_tokens_details: { cached_tokens: 7040 } }, 225732, 66432);
  expect(grew.reBilled).toBe(true);
  const shrank = usageFlags({ prompt_tokens: 223532, prompt_tokens_details: { cached_tokens: 56704 } }, 232294, 232064);
  expect(shrank.reBilled).toBe(true);
  const warm = usageFlags({ prompt_tokens: 232066, prompt_tokens_details: { cached_tokens: 230656 } }, 230784, 230272);
  expect(warm.reBilled).toBe(false);
});
