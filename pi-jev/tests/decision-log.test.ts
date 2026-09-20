import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDecisionLog, parseJsonl } from "../extensions/decision-log.js";

const ASK = JSON.stringify({
	record: "ask",
	version: 1,
	ts: "2026-09-19T00:00:00.000Z",
	requestId: "req-1",
	mode: "shadow",
	judge: { model: "jev-latest", packVersion: "permission-pack-v1", stateVersion: "permission-state-v1" },
	stateHash: "abc",
	stateChars: 10,
	truncated: [],
	bands: [],
	would: "defer",
	verdict: "defer",
	latencyMs: 100,
	usage: null,
	error: null,
});

function tempPath(): string {
	return join(mkdtempSync(join(tmpdir(), "pi-jev-log-")), "decisions.jsonl");
}

test("parsing skips a torn final line and anything that is not a record", () => {
	const text = [ASK, "", "{ not json", JSON.stringify({ record: "other" }), '{"record":"decision"', JSON.stringify({ record: "decision", requestId: "req-1" })].join("\n");
	const records = parseJsonl(text);
	expect(records.map((record) => record.record)).toEqual(["ask", "decision"]);
});

test("a written record reads back", () => {
	const log = openDecisionLog({ path: tempPath() });
	log.write(JSON.parse(ASK));
	log.write({ record: "decision", version: 1, ts: "2026-09-19T00:00:01.000Z", requestId: "req-1", resolution: "user_approved", result: "allow", surface: "bash", value: "ls", origin: null, matchedPattern: null, agentName: null, forwarded: false });
	expect(log.read().map((record) => record.record)).toEqual(["ask", "decision"]);
	expect(log.read()[1]?.requestId).toBe("req-1");
});

test("an unreadable log yields nothing rather than throwing", () => {
	const log = openDecisionLog({ path: tempPath() });
	expect(log.read()).toEqual([]);
	const unwritable = openDecisionLog({ path: "/proc/definitely/not/writable.jsonl" });
	expect(() => unwritable.write(JSON.parse(ASK))).not.toThrow();
	expect(unwritable.read()).toEqual([]);
});

test("the file rotates once at the size limit, keeping the previous generation", () => {
	const path = tempPath();
	const log = openDecisionLog({ path, maxBytes: 200 });
	log.write(JSON.parse(ASK));
	expect(readFileSync(path, "utf8").length).toBeGreaterThan(200);

	log.write({ ...JSON.parse(ASK), requestId: "req-2" });
	expect(readFileSync(`${path}.1`, "utf8")).toContain('"requestId":"req-1"');
	const current = readFileSync(path, "utf8");
	expect(current).toContain('"requestId":"req-2"');
	expect(current).not.toContain('"requestId":"req-1"');
	expect(log.read().map((record) => record.requestId)).toEqual(["req-2"]);
});
