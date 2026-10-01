import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogWriter, LOG_FLUSH_DELAY_MS, LOG_WRITE_STALL_MS } from "../extensions/log-writer.js";
import { beginResultFinalization, buildTaskResultObservation, completeResultFinalization, taskReadiness } from "../extensions/task-result.js";
import type { ManagedTask } from "../extensions/types.js";
import { fakeTask } from "./fixtures/lifecycle.js";

/**
 * A log writer whose writes are answered by the test, with the production
 * window timer and stall deadline captured instead of scheduled. Every write
 * in flight is held until `release` names it, which is what makes "the process
 * has exited but the last bytes are still in the writer's queue" a real,
 * deterministic state instead of a race the suite has to hope for.
 */
function heldLogWriter() {
	const writes: { file: string; text: string }[] = [];
	const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
	const stalls: (() => void)[] = [];
	let window: (() => void) | null = null;
	const writer = createLogWriter({
		append(file, text) {
			writes.push({ file, text });
			return new Promise<void>((resolve, reject) => pending.push({ reject, resolve }));
		},
		setTimer(cb, ms) {
			if (ms === LOG_FLUSH_DELAY_MS) window = cb;
			else if (ms === LOG_WRITE_STALL_MS) stalls.push(cb);
			else throw new Error(`readiness_barrier.delay=${ms}`);
			return { ms, unref() {} } as unknown as NodeJS.Timeout;
		},
		clearTimer(handle) {
			if ((handle as unknown as { ms: number }).ms === LOG_FLUSH_DELAY_MS) window = null;
		},
	});
	return {
		writer,
		writes,
		releaseAll: () => { for (const { resolve } of pending.splice(0)) resolve(); },
		rejectAll: (error: Error) => { for (const { reject } of pending.splice(0)) reject(error); },
		fireStall: () => { for (const stall of stalls.splice(0)) stall(); },
		pendingWrites: () => pending.length,
		pendingWindow: () => window !== null,
	};
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("terminal readiness waits on the log flush, not on the process close", async () => {
	const log = heldLogWriter();
	const task: ManagedTask = fakeTask({ id: "bg-1", resultReady: false, startedAt: 1_700_000_000_000, status: "running" });

	expect(taskReadiness(task), "a live process is running").toBe("running");

	// finalizeTask: the process half of the transition lands first.
	beginResultFinalization(task);
	task.status = "completed";
	task.exitCode = 0;
	task.child = null;
	expect(taskReadiness(task), "process exit alone is finalizing").toBe("finalizing");

	// The chunk the child wrote last is still only in the writer's queue.
	log.writer.append(task.logFile, "last marker\n");
	const written = log.writer.flush(task.logFile);
	expect(written, "the terminal result holds a pending flush").not.toBeNull();
	await settle();
	expect(log.pendingWrites(), "the write is issued and unanswered").toBe(1);
	expect(taskReadiness(task), "output still queued is never reported as a terminal result").toBe("finalizing");
	expect(log.writer.settled(task.logFile), "the log is not settled while the write is in flight").toBe(false);

	log.releaseAll();
	await written;
	completeResultFinalization(task, log.writer.settled(task.logFile));
	expect(taskReadiness(task), "after the flush the retained output is the terminal result").toBe("terminal");
	expect(log.writer.settled(task.logFile), "and the file's queue is gone").toBe(true);
	expect(log.writes.map((write) => write.text).join(""), "the final bytes reached the log").toBe("last marker\n");
});

test("a stalled write still releases the flush barrier, with the loss counted in the log", async () => {
	const log = heldLogWriter();
	const task: ManagedTask = fakeTask({ id: "bg-2", resultReady: false, status: "running" });

	beginResultFinalization(task);
	task.status = "failed";
	task.exitCode = 1;
	log.writer.append(task.logFile, "kept before the stall\n");
	const written = log.writer.flush(task.logFile);
	expect(written).not.toBeNull();
	await settle();

	// The deadline frees every waiter rather than holding the task's close open.
	log.fireStall();
	await written;

	completeResultFinalization(task);
	expect(taskReadiness(task), "a stalled log still resolves the barrier").toBe("terminal");
	expect(log.writer.settled(task.logFile), "a stalled file is not settled, and the caller can see that").toBe(false);
});

test("a flush with nothing pending resolves readiness without inventing a write", () => {
	const log = heldLogWriter();
	const task: ManagedTask = fakeTask({ id: "bg-3", resultReady: false, status: "running" });

	beginResultFinalization(task);
	task.status = "completed";
	expect(log.writer.flush(task.logFile), "an empty queue has nothing to flush").toBeNull();
	completeResultFinalization(task, log.writer.settled(task.logFile));
	expect(taskReadiness(task), "a clean exit reaches terminal readiness immediately").toBe("terminal");
	expect(log.writes, "and no diagnostic write was fabricated").toEqual([]);
});

test("a failed write releases the barrier but never yields a complete result", async () => {
	const log = heldLogWriter();
	const task: ManagedTask = fakeTask({ id: "bg-4", logFile: join(mkdtempSync(join(tmpdir(), "readiness-")), "bg-4.log"), resultReady: false, startedAt: 1_700_000_000_000, status: "running" });

	beginResultFinalization(task);
	task.status = "completed";
	task.exitCode = 0;
	log.writer.append(task.logFile, "bytes the disk refused\n");
	const written = log.writer.flush(task.logFile);
	expect(written, "the terminal result still holds a pending flush").not.toBeNull();
	await settle();

	// The disk refuses the write: the bytes are counted, not kept, and the
	// barrier still releases so the task's close is never held hostage.
	log.rejectAll(new Error("ENOSPC"));
	await written;

	completeResultFinalization(task, log.writer.settled(task.logFile));
	expect(
		{ readiness: taskReadiness(task), complete: task.outputComplete },
		"a failed write resolves the barrier without claiming a complete capture",
	).toStrictEqual({ readiness: "terminal", complete: false });
	expect(log.writer.settled(task.logFile), "an unsettled file is observable to the caller").toBe(false);

	// The retained log holds what the disk kept before it refused; the refused
	// bytes survive only in the writer's count.
	writeFileSync(task.logFile, "earlier kept batch\n");
	const observation = buildTaskResultObservation({
		logSettled: log.writer.settled(task.logFile),
		now: task.updatedAt,
		output: { ok: true, output: readFileSync(task.logFile, "utf8") },
		outputPreviewChars: 2_000,
		task,
	});
	expect(
		{ readiness: observation.readiness, complete: observation.outputComplete, error: observation.outputError, preview: observation.outputPreview },
		"the terminal read is short, and says so instead of claiming the complete output",
	).toStrictEqual({ readiness: "terminal", complete: false, error: undefined, preview: "earlier kept batch\n" });
	expect(log.writes.map((write) => write.text).join(""), "the failure is recorded in the log, not silently dropped").toBe("bytes the disk refused\n");
});
