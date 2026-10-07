import { expect, test } from "bun:test";
import { prefixTrace } from "../extensions/diff.js";
import { bustLine, diffReport, overview, traceLines } from "../extensions/report.js";

function subject(over: Record<string, unknown> = {}) {
  return {
    seq: 2,
    at: "2026-10-04T12:12:18.000Z",
    model: "claude-opus-5-5",
    bodyChars: 400000,
    params: { model: "claude-opus-5-5", max_tokens: 32000 },
    tools: { n: 41, hash: "1cc11ddf8d" },
    system: [
      { i: 0, chars: 34952, hash: "aaaa", sections: [] },
      { i: 2, chars: 40773, hash: "bbbb", sections: [{ name: "cwd", chars: 59, hash: "c1" }, { name: "mcp_servers", chars: 502, hash: "m1" }] },
    ],
    messages: [
      { i: 0, role: "user", hash: "h0", chars: 100 },
      { i: 1, role: "assistant", hash: "h1", chars: 200 },
    ],
    breakpoints: [{ at: "system[1]", ttl: "1h" }, { at: "messages[1].content[0]", ttl: "1h" }],
    ...over,
  };
}

test("a prefix trace names the changed section and the divergence point", () => {
  const before = subject();
  const after = subject({
    seq: 3,
    system: [
      { i: 0, chars: 34952, hash: "aaaa", sections: [] },
      { i: 2, chars: 37501, hash: "cccc", sections: [{ name: "cwd", chars: 59, hash: "c1" }] },
    ],
    messages: [
      { i: 0, role: "user", hash: "h0", chars: 100 },
      { i: 1, role: "assistant", hash: "ZZ", chars: 180 },
      { i: 2, role: "tool", hash: "h2", chars: 40 },
    ],
  });
  const lines = prefixTrace(before, after).join("\n");
  expect(lines).toContain("system[2]");
  expect(lines).toContain("mcp_servers");
  expect(lines).toContain("502ch → absent");
  expect(lines).toContain("first divergence at messages[1]");
  expect(lines).toContain("array 2 → 3");
});

test("an unchanged head reads as same, not as a re-bill", () => {
  const lines = prefixTrace(subject(), subject({ seq: 3 })).join("\n");
  expect(lines).toContain("breakpoints  same");
  expect(lines).toContain("tools        same");
  expect(lines).toContain("messages     same");
  expect(lines).not.toContain("!!");
});

test("no predecessor is reported as such", () => {
  expect(prefixTrace(null, subject()).join("\n")).toContain("no previous request");
});

const records = [
  { kind: "request", session: "s", seq: 1, at: "2026-10-04T11:00:00.000Z", model: "m", utility: false, divergence: { kind: "first" }, tools: { n: 41, hash: "a" }, messages: [], system: [], bodyChars: 1000 },
  { kind: "response", session: "s", seq: 1, at: "2026-10-04T11:00:01.000Z", usageSource: "stream_event", usage: { read: 100000, write: 0, input: 10, output: 20, promptTokens: 100010 }, cold: false, reBilled: false, divergence: { kind: "first" } },
  { kind: "cause", session: "s", event: "session_compact", at: "2026-10-04T11:05:00.000Z" },
  { kind: "request", session: "s", seq: 2, at: "2026-10-04T11:06:00.000Z", model: "m", utility: false, divergence: { kind: "system", at: "system[2]", detail: "mcp_servers 502ch->absent" }, tools: { n: 41, hash: "a" }, messages: [], system: [], bodyChars: 380000 },
  { kind: "response", session: "s", seq: 2, at: "2026-10-04T11:06:02.000Z", usageSource: "stream_event", usage: { read: 33716, write: 133924, input: 0, output: 30, promptTokens: 167640 }, cold: false, reBilled: true, divergence: { kind: "system", at: "system[2]", detail: "mcp_servers 502ch->absent" } },
];

test("the overview counts busts, tokens and causes", () => {
  const lines = overview(records, { scope: "this session" }).join("\n");
  expect(lines).toContain("requests 2");
  expect(lines).toContain("partial 1");
  expect(lines).toContain("re-billed 133.9k");
  expect(lines).toContain("session_compact 1");
  expect(lines).toContain("/reqcap diff");
});

test("the trace lists one line per request with its verdict", () => {
  const lines = traceLines(records, 10);
  expect(lines.length).toBe(2);
  expect(lines[0]).toContain("healthy");
  expect(lines[1]).toContain("partial");
  expect(lines[1]).toContain("system[2]");
});

test("the diff report resolves a seq to its predecessor", () => {
  const lines = diffReport(records, 2).join("\n");
  expect(lines).toContain("prefix trace");
  expect(lines).toContain("#1");
});

test("a bust line carries cost and cause", () => {
  const line = bustLine(records[4] as any, records[3] as any);
  expect(line).toContain("RE-BILL");
  expect(line).toContain("write=133,924");
  expect(line).toContain("system[2]");
});

// `seq` counts per process, so a log holding two processes has a #1 in each. The
// comparison has to stay inside one chain rather than pair the two #1s up.
const twoChains = [
  { kind: "request", session: "s", pid: 100, key: "k1", seq: 1, at: "2026-10-04T11:00:00.000Z", model: "m", tools: { n: 1, hash: "a" }, messages: [], system: [], bodyChars: 10, divergence: { kind: "first" } },
  { kind: "response", session: "s", pid: 100, seq: 1, usage: { read: 0, write: 0, input: 10, output: 1, promptTokens: 10 }, cold: true, reBilled: false },
  { kind: "request", session: "s", pid: 200, key: "k2", seq: 1, at: "2026-10-04T11:00:05.000Z", model: "m", tools: { n: 1, hash: "a" }, messages: [], system: [], bodyChars: 10, divergence: { kind: "first" } },
  { kind: "response", session: "s", pid: 200, seq: 1, usage: { read: 0, write: 0, input: 10, output: 1, promptTokens: 10 }, cold: true, reBilled: false },
];

test("a diff report stays inside one process chain", () => {
  const lines = diffReport(twoChains as any, 1).join("\n");
  expect(lines).toContain("no previous request");
  expect(lines).toContain("2 chains have seq 1");
  expect(lines).toContain("pid 200");
});

test("the trace names the process only once a log holds two", () => {
  const two = traceLines(twoChains as any, 10);
  expect(two.length).toBe(2);
  for (const line of two) expect(line).toContain("pid=");
  for (const line of traceLines(records, 10)) expect(line).not.toContain("pid=");
});
