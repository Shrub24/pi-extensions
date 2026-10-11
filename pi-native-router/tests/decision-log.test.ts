import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDecision } from "../src/decision-log";

test("decisions append one JSON line each, private, with identities and reasons only", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-router-log-"));
  try {
    const path = join(dir, "nested", "decisions.jsonl");
    const entry = { at: "2026-10-12T02:00:00.000Z", session: "s1", logical: "route/worker", physical: "opencode-go/deepseek-v4-flash#go-a", account: "go-a", reason: "initial" as const, contextTokens: 1200, floor: 200000 };
    recordDecision(path, entry);
    recordDecision(path, { ...entry, previous: "opencode-go/deepseek-v4-flash#go-a", physical: "opencode-go/mimo-v2.5#go-b", reason: "failover" });
    const lines = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ reason: "failover", previous: "opencode-go/deepseek-v4-flash#go-a" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toMatch(/apiKey|secret|prompt/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a logging failure is reported, never thrown into dispatch", () => {
  const errors: unknown[] = [];
  recordDecision("/proc/definitely/not/writable/decisions.jsonl", { at: "x", session: "s", logical: "route/w", physical: "p/m", reason: "initial" }, error => errors.push(error));
  expect(errors.length).toBe(1);
});
