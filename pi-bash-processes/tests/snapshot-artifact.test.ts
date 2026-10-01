import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareSnapshot } from "../extensions/snapshot-artifact.js";

// The immutability rule, at its source. A caller that has been handed an
// artifact must be able to rely on its bytes: whatever the task does next, the
// file it was pointed at keeps the content it had when it was handed over.
const root = mkdtempSync(join(tmpdir(), "snapshot-artifact-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let sequence = 0;
const fresh = () => join(root, `case-${sequence++}`);

test("a settled capture is its own artifact: nothing is copied and nothing can append", async () => {
	const dir = fresh();
	const log = join(dir, "task.log");
	await Bun.write(log, "whole capture\n");
	const handoff = await prepareSnapshot({ generation: "bg-1@1", laneDir: dir, logFile: log, partial: false, taskId: "bg-1" });
	expect(handoff).toEqual({ ok: true, artifact: { bytes: 14, complete: true, partial: false, path: log, reused: true } });
});

test("a growing capture is copied to a boundary-named artifact, and later output cannot change it", async () => {
	const dir = fresh();
	const log = join(dir, "task.log");
	await Bun.write(log, "prefix\n");
	const first = await prepareSnapshot({ generation: "bg-2@1", laneDir: dir, logFile: log, partial: true, taskId: "bg-2" });
	expect(first.ok).toBe(true);
	if (!first.ok) return;
	expect(first.artifact).toMatchObject({ bytes: 7, complete: false, partial: true, reused: false });

	// The producer keeps writing. The artifact handed over is untouched.
	appendFileSync(log, "more output that arrived later\n");
	expect(readFileSync(first.artifact.path, "utf8")).toBe("prefix\n");
	expect(statSync(first.artifact.path).size).toBe(7);

	// A later read takes its own boundary, so the two artifacts are independent.
	const second = await prepareSnapshot({ generation: "bg-2@1", laneDir: dir, logFile: log, partial: true, taskId: "bg-2" });
	expect(second.ok).toBe(true);
	if (!second.ok) return;
	expect(second.artifact.path).not.toBe(first.artifact.path);
	expect(readFileSync(second.artifact.path, "utf8")).toBe("prefix\nmore output that arrived later\n");
	// The earlier artifact still holds exactly what it was handed over with.
	expect(readFileSync(first.artifact.path, "utf8")).toBe("prefix\n");
});

test("the same boundary is reused rather than rewritten", async () => {
	const dir = fresh();
	const log = join(dir, "task.log");
	await Bun.write(log, "stable prefix\n");
	const first = await prepareSnapshot({ generation: "bg-3@1", laneDir: dir, logFile: log, partial: true, taskId: "bg-3" });
	const again = await prepareSnapshot({ generation: "bg-3@1", laneDir: dir, logFile: log, partial: true, taskId: "bg-3" });
	expect(first.ok && again.ok).toBe(true);
	if (!first.ok || !again.ok) return;
	expect(again.artifact).toMatchObject({ path: first.artifact.path, reused: true });
});

test("an empty capture is a real empty artifact, not a missing one", async () => {
	const dir = fresh();
	const log = join(dir, "task.log");
	await Bun.write(log, "");
	const handoff = await prepareSnapshot({ generation: "bg-4@1", laneDir: dir, logFile: log, partial: true, taskId: "bg-4" });
	expect(handoff.ok).toBe(true);
	if (!handoff.ok) return;
	expect(handoff.artifact.bytes).toBe(0);
	expect(statSync(handoff.artifact.path).size).toBe(0);
});

test("a capture that is gone is an explicit expiry, never an empty success", async () => {
	const dir = fresh();
	const handoff = await prepareSnapshot({ generation: "bg-5@1", laneDir: dir, logFile: join(dir, "nothing.log"), partial: true, taskId: "bg-5" });
	expect(handoff.ok).toBe(false);
	if (!handoff.ok) expect(handoff.code).toBe("expired");
	expect(await prepareSnapshot({ generation: "g", laneDir: dir, logFile: "", partial: false, taskId: "bg-6" })).toMatchObject({ ok: false, code: "expired" });
});

test("a copy that fails is reported as a failure, not as a prepared artifact", async () => {
	const dir = fresh();
	const log = join(dir, "task.log");
	await Bun.write(log, "bytes\n");
	const handoff = await prepareSnapshot({
		deps: { copyPrefix: async () => { throw new Error("no space left on device"); } },
		generation: "bg-7@1",
		laneDir: dir,
		logFile: log,
		partial: true,
		taskId: "bg-7",
	});
	expect(handoff.ok).toBe(false);
	if (!handoff.ok) {
		expect(handoff.code).toBe("internal");
		expect(handoff.message).toContain("no space left on device");
	}
});

test("a task that is replaced cannot collide with the earlier incarnation's artifact", async () => {
	const dir = fresh();
	const log = join(dir, "task.log");
	await Bun.write(log, "first\n");
	const first = await prepareSnapshot({ generation: "bg-8@100", laneDir: dir, logFile: log, partial: true, taskId: "bg-8" });
	await Bun.write(log, "second\n");
	const replacement = await prepareSnapshot({ generation: "bg-8@200", laneDir: dir, logFile: log, partial: true, taskId: "bg-8" });
	expect(first.ok && replacement.ok).toBe(true);
	if (!first.ok || !replacement.ok) return;
	expect(replacement.artifact.path).not.toBe(first.artifact.path);
	expect(readFileSync(first.artifact.path, "utf8")).toBe("first\n");
	expect(readFileSync(replacement.artifact.path, "utf8")).toBe("second\n");
});
