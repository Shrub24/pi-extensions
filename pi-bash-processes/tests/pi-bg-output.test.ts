import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startExtensionHost, type HostTool } from "./fixtures/extension-host.js";

// The declared full-output handoff, end to end against the real manager.
//
// What is being pinned here: an immutable artifact whose contents equal the
// captured combined output (not a tail, not a preview), a running snapshot that
// later output cannot mutate, and a receipt that commits only after the bytes
// actually reached the caller — with a closed pipe leaving the completion
// obligation exactly where it was.
const host = await startExtensionHost();
afterAll(() => host.dispose());

const scratch = mkdtempSync(join(tmpdir(), "pi-bg-output-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const bgTask = (): HostTool => host.tools.get("bg_task")!;
const bash = (): HostTool => host.tools.get("bash")!;

const spawned = (result: { details: Record<string, unknown> }) => result.details.task as { id: string };

/** A managed command, reporting its exit code and combined text. */
const bashRun = async (command: string) => {
	try {
		const result = await bash().execute("managed", { command }, undefined, undefined, host.ctx);
		return { exitCode: (result.structuredContent as { exit_code?: number } | undefined)?.exit_code ?? 0, output: result.content[0]?.text ?? "" };
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		return { exitCode: Number(/Command exited with code (\d+)/.exec(text)?.[1] ?? 1), output: text };
	}
};

const listed = async (id: string) => (await host.listTasks()).find((task) => task.id === id);

/** Wait until a task's retained log has grown to at least `minBytes`. */
async function awaitLogBytes(id: string, minBytes: number, budgetMs = 30_000): Promise<number> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const record = await listed(id);
		const size = record?.logFile ? statSync(record.logFile as string).size : 0;
		if (size >= minBytes) return size;
		if (Date.now() >= deadline) return size;
		await Bun.sleep(10);
	}
}

/**
 * Wait until a task's retained log holds `needle`, or the budget lapses. A
 * running capture reaches the file through a coalescing writer, so a read
 * issued before the flush would snapshot a boundary the task has already
 * passed.
 */
async function awaitLogContains(id: string, needle: string, budgetMs = 20_000): Promise<string> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const record = await listed(id);
		const text = record?.logFile ? readFileSync(record.logFile as string, "utf8") : "";
		if (needle === "" || text.includes(needle)) return text;
		if (Date.now() >= deadline) return text;
		await Bun.sleep(10);
	}
}

test("a full read redirects the capture byte-for-byte, with no retrieval metadata in the file", async () => {
	// Markers at the start, middle and end, so a preview (which shows a tail) or
	// a failed mid-file copy is visibly different from the whole capture.
	const command = [
		"printf 'PREFIX-MARKER\\n'",
		"for i in $(seq 1 400); do printf 'line-%s\\n' \"$i\"; done",
		"printf 'MIDDLE-MARKER\\n'",
		"for i in $(seq 401 800); do printf 'line-%s\\n' \"$i\"; done",
		"printf 'SUFFIX-MARKER\\n'",
		"printf 'stderr-marker\\n' >&2",
	].join("; ");
	const task = spawned(await bgTask().execute("output-spawn", { action: "spawn", command }));
	await host.settledTask(task.id);
	const record = await listed(task.id);
	const captured = readFileSync(record!.logFile as string, "utf8");

	const file = join(scratch, "full.txt");
	const redirected = await bashRun(`pi-bg get ${task.id} --output > ${file}`);
	expect(redirected.exitCode, redirected.output).toBe(0);
	// The file is the artifact, comparison included: no `kendex:` line, no preview.
	const written = readFileSync(file, "utf8");
	expect(written).toBe(captured);
	expect(written).toContain("PREFIX-MARKER");
	expect(written).toContain("MIDDLE-MARKER");
	expect(written).toContain("SUFFIX-MARKER");
	expect(written).toContain("stderr-marker");
	expect(written).not.toContain("kendex:");
	expect(redirected.output).toContain(`kendex: task=${task.id}`);
	expect(redirected.output).toContain("kendex: ack=terminal");

	// A pipe into a filter is the same declared operation, and the metadata still
	// goes to stderr rather than into the pipe.
	const filtered = await bashRun(`pi-bg get ${task.id} --output | grep -c MARKER`);
	expect(filtered.exitCode).toBe(0);
	expect(filtered.output).toContain("3");
	expect(filtered.output).toContain("kendex: ack=");
});

test("output larger than 1 MiB keeps its prefix, middle and suffix", async () => {
	// Roughly 4 MiB: well past both the preview cap and any single read buffer, so
	// a streamed copy that stopped early would lose the suffix.
	const command = [
		"printf 'PREFIX-MARKER\\n'",
		"head -c 2000000 /dev/zero | tr '\\0' 'a'",
		"printf '\\nMIDDLE-MARKER\\n'",
		"head -c 2000000 /dev/zero | tr '\\0' 'b'",
		"printf '\\nSUFFIX-MARKER\\n'",
	].join("; ");
	const task = spawned(await bgTask().execute("output-large", { action: "spawn", command }));
	await host.settledTask(task.id);
	const record = await listed(task.id);

	const file = join(scratch, "large.txt");
	const redirected = await bashRun(`pi-bg get ${task.id} --output > ${file}`);
	expect(redirected.exitCode, redirected.output).toBe(0);
	const written = readFileSync(file, "utf8");
	expect(written.length).toBeGreaterThan(4_000_000);
	expect(written.startsWith("PREFIX-MARKER\n")).toBe(true);
	expect(written).toContain("MIDDLE-MARKER");
	expect(written.endsWith("SUFFIX-MARKER\n")).toBe(true);
	// The artifact and the retained log are the same bytes for a settled capture.
	expect(statSync(file).size).toBe(statSync(record!.logFile as string).size);
});

test("a running snapshot is immutable: output produced later cannot change it", async () => {
	// Writes a prefix, waits long enough to be snapshotted mid-flight, then
	// appends. The first artifact must not grow when the second half arrives.
	const task = spawned(
		await bgTask().execute("output-running", {
			action: "spawn",
			command: "printf 'FIRST-HALF\\n'; sleep 3; printf 'SECOND-HALF\\n'",
		}),
	);
	// Wait for the prefix to be captured rather than guessing at a sleep: the
	// snapshot boundary must be taken after the flush that carries it.
	await awaitLogContains(task.id, "FIRST-HALF");

	const file = join(scratch, "partial.txt");
	const first = await bashRun(`pi-bg get ${task.id} --output > ${file}`);
	expect(first.exitCode, first.output).toBe(0);
	const snapshot = readFileSync(file, "utf8");
	expect(snapshot).toBe("FIRST-HALF\n");
	expect(first.output, "a running handoff is labelled partial").toContain("kendex: readiness=running");

	await host.settledTask(task.id, 20_000);
	// The task finished, but the artifact handed over earlier did not change.
	expect(readFileSync(file, "utf8")).toBe(snapshot);

	// A second full read now sees the whole capture, at its own boundary.
	const secondFile = join(scratch, "final.txt");
	const second = await bashRun(`pi-bg get ${task.id} --output > ${secondFile}`);
	expect(second.exitCode, second.output).toBe(0);
	expect(readFileSync(secondFile, "utf8")).toBe("FIRST-HALF\nSECOND-HALF\n");
	expect(second.output).toContain("kendex: readiness=terminal");
});

test("a running full read resets the review clock and never acknowledges the completion", async () => {
	const task = spawned(
		await bgTask().execute("output-review", {
			action: "spawn",
			command: "printf 'start\\n'; sleep 4; printf 'end\\n'",
		}),
	);
	await Bun.sleep(300);
	const before = await listed(task.id);

	const file = join(scratch, "review.txt");
	const read = await bashRun(`pi-bg get ${task.id} --output > ${file}`);
	expect(read.exitCode, read.output).toBe(0);
	expect(read.output, "a running handoff is a review, not an acknowledgment").toContain("kendex: ack=review");
	const after = await listed(task.id);
	expect(after!.lastReviewedAt).toBeGreaterThanOrEqual(before!.startedAt as number);
	expect(after!.exitNotified, "the completion stays owed").toBeFalsy();

	// The task still finishes on its own and its exit wake is still delivered.
	await host.settledTask(task.id);
	expect((await listed(task.id))?.exitCode).toBe(0);
});

test("a closed pipe leaves the handoff uncommitted, and a completed read then commits it", async () => {
	// A running task: its review clock is the observable that a successful
	// handoff moves and a failed one must not, and its output is large enough
	// that `head` really does close the pipe early.
	const command = "head -c 3000000 /dev/zero | tr '\\0' 'z'; printf '\\nTAIL-MARKER\\n'; sleep 60";
	const task = spawned(await bgTask().execute("output-epipe", { action: "spawn", command }));
	// Wait for a genuinely large capture: an empty or short one could not fill the
	// pipe, and a "successful" write to a pipe nobody closed proves nothing.
	await awaitLogBytes(task.id, 1_000_000);
	expect((await listed(task.id))?.lastReviewedAt, "nothing has been reviewed yet").toBeUndefined();

	// `head` closes the pipe after the first bytes. The write fails, so the CLI
	// must not accept the receipt: the bytes the caller kept were not the result.
	const piped = await bashRun(`set -o pipefail; pi-bg get ${task.id} --output | head -c 64 > /dev/null`);
	expect(piped.exitCode, `expected a failed handoff, got: ${piped.output}`).not.toBe(0);
	expect(piped.output, "the failure is reported as a pipe failure").toContain("epipe");
	expect((await listed(task.id))?.lastReviewedAt, "an interrupted handoff never commits the review").toBeUndefined();

	// The same read, completed, is a successful handoff and does commit it. The
	// task is still running, so the artifact must be the flushed capture's own
	// bytes up to the boundary the manager reported.
	const captured = await awaitLogContains(task.id, "TAIL-MARKER");
	const file = join(scratch, "epipe-recovered.txt");
	const complete = await bashRun(`pi-bg get ${task.id} --output > ${file}`);
	expect(complete.exitCode, complete.output).toBe(0);
	expect(complete.output).toContain("kendex: ack=review");
	const boundary = Number(/kendex: outputBytes=(\d+)/.exec(complete.output)?.[1] ?? -1);
	expect(boundary).toBeGreaterThan(3_000_000);
	const written = readFileSync(file, "utf8");
	expect(written).toContain("TAIL-MARKER");
	expect(written, "the artifact holds the flushed capture, not a stale prefix").toBe(captured.slice(0, written.length));
	expect((await listed(task.id))?.lastReviewedAt, "the committed handoff records the review").toBeGreaterThan(0);

	await bgTask().execute("output-epipe-stop", { action: "stop", id: task.id });
});

test("stop returns the result under the same id, and a full read of it still succeeds", async () => {
	const task = spawned(await bgTask().execute("output-stop", { action: "spawn", command: "printf 'before-stop\\n'; sleep 60" }));
	await Bun.sleep(400);

	const stopped = await bashRun(`pi-bg stop ${task.id}`);
	expect(stopped.exitCode, stopped.output).toBe(0);
	expect(stopped.output).toContain("before-stop");
	const record = await listed(task.id);
	expect(record?.id).toBe(task.id);
	expect(record?.status, "a confirmed stop is a terminal task, not a signal we sent").not.toBe("running");

	// Same id, same operation surface: the retained capture is still retrievable.
	const file = join(scratch, "stopped.txt");
	const read = await bashRun(`pi-bg get ${task.id} --output > ${file}`);
	expect(read.exitCode, read.output).toBe(0);
	expect(readFileSync(file, "utf8")).toContain("before-stop");
	expect(read.output).toContain(`kendex: task=${task.id}`);
});

test("a naturally finished task reports its real exit code through the same stop/get surface", async () => {
	const task = spawned(await bgTask().execute("output-natural", { action: "spawn", command: "printf 'bye\\n'; exit 7" }));
	await host.settledTask(task.id);

	// Stopping something already finished is a successful report of the real
	// outcome, not a fabricated termination.
	const stopped = await bashRun(`pi-bg stop ${task.id}`);
	expect(stopped.exitCode, stopped.output).toBe(0);
	expect(stopped.output).toContain("bye");
	const record = await listed(task.id);
	expect({ status: record?.status, exitCode: record?.exitCode }).toEqual({ status: "failed", exitCode: 7 });
});
