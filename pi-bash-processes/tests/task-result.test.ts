import { expect, test } from "bun:test";

import {
	acknowledgeCompletion,
	beginResultFinalization,
	buildTaskResultObservation,
	completeResultFinalization,
	completionOwed,
	readRetainedOutput,
	reviewArmedAt,
	reviewDeadlineFor,
	reviewReminderArmed,
	selectPrunableFinishedTasks,
	taskReadiness,
	type TaskResultTask,
} from "../extensions/task-result.js";

const START = 1_700_000_000_000;

const resultTask = (overrides: Partial<TaskResultTask> = {}): TaskResultTask => ({
	command: "build --watch",
	cwd: "/work",
	exitCode: null,
	exitNotified: false,
	expiresAt: null,
	id: "bg-1",
	notifyOnExit: true,
	outputBytes: 0,
	pid: 4242,
	resultReady: false,
	softTimeoutMs: 60_000,
	startedAt: START,
	status: "running",
	updatedAt: START,
	...overrides,
});

test("readiness separates the process clock from the output clock", () => {
	const task = resultTask();
	expect(taskReadiness(task), "an active process is running").toBe("running");

	beginResultFinalization(task);
	task.status = "completed";
	task.exitCode = 0;
	expect(taskReadiness(task), "process exit alone is not terminal readiness").toBe("finalizing");

	completeResultFinalization(task, true);
	expect(
		{ readiness: taskReadiness(task), complete: task.outputComplete },
		"the flush barrier is what makes the result terminal, and the writer's answer is what makes it complete",
	).toStrictEqual({ readiness: "terminal", complete: true });

	const restored = resultTask({ status: "stopped", resultReady: true, updatedAt: START + 10 });
	expect(taskReadiness(restored), "a rehydrated terminal task is ready").toBe("terminal");
	expect(taskReadiness(resultTask({ status: "failed", resultReady: undefined })), "an absent latch reads as finalizing, never terminal").toBe("finalizing");
});

/**
 * `restored` is what makes an unsettled record unrecoverable: the same state
 * that a live task will settle on its own can never advance in a process that
 * has no writer for it. A rehydrated capture the record left uncertified must
 * therefore stay uncertified even when the code that finalizes it — the orphan
 * watcher, whose task has no producer left — asserts completeness for a file
 * this process never wrote.
 */
test("a rehydrated capture the record left uncertified cannot be certified later", () => {
	const restored = resultTask({ outputComplete: false, restored: true, status: "stopped" });
	expect(taskReadiness(restored), "a rehydrated task with no writer cannot be finalizing").toBe("incomplete");

	completeResultFinalization(restored, true);
	expect(
		{ readiness: taskReadiness(restored), complete: restored.outputComplete },
		"the process clock advances; the durable record still outvotes the claim",
	).toStrictEqual({ readiness: "terminal", complete: false });

	// A live task's own writer still decides: the record is not a veto on the
	// queue that holds the bytes, and a live unsettled flush can still advance.
	const live = resultTask();
	beginResultFinalization(live);
	live.status = "completed";
	expect(taskReadiness(live), "a live unsettled flush is finalizing, not incomplete").toBe("finalizing");
	completeResultFinalization(live, true);
	expect({ readiness: taskReadiness(live), complete: live.outputComplete }, "the live writer's own answer stands").toStrictEqual({ readiness: "terminal", complete: true });
});

test("retained output distinguishes a missing log from an empty one", () => {
	const rows = [
		{
			name: "present and empty is a real empty result",
			file: "/logs/bg-1.log",
			exists: true,
			read: () => "",
			expected: { ok: true, output: "" },
		},
		{
			name: "present output is returned whole",
			file: "/logs/bg-1.log",
			exists: true,
			read: () => "alpha\nbeta\n",
			expected: { ok: true, output: "alpha\nbeta\n" },
		},
		{
			name: "a log that is gone is an explicit error",
			file: "/logs/bg-1.log",
			exists: false,
			read: () => "",
			expected: { ok: false, error: "retained output is gone (/logs/bg-1.log); the task may have expired" },
		},
		{
			name: "an unreadable log is an explicit error",
			file: "/logs/bg-1.log",
			exists: true,
			read: () => { throw new Error("EACCES"); },
			expected: { ok: false, error: "retained output unreadable (/logs/bg-1.log): EACCES" },
		},
		{
			name: "no recorded log file is an explicit error",
			file: "",
			exists: true,
			read: () => "ignored",
			expected: { ok: false, error: "no retained output file for this task" },
		},
	] as const;

	expect.assertions(rows.length + 1);
	expect(rows.length, "retained-output table must contain rows").toBeGreaterThan(0);
	for (const row of rows) {
		expect(readRetainedOutput(row.file, { exists: () => row.exists, read: row.read }), row.name).toEqual(row.expected);
	}
});

test("one result observation serves running, finalizing, and terminal reads", () => {
	const running = buildTaskResultObservation({
		logSettled: true,
		now: START + 5_000,
		output: { ok: true, output: "line one\nline two\n" },
		outputPreviewChars: 500,
		task: resultTask({ outputBytes: 18, reviewedOutputBytes: 18 }),
	});
	expect(running, "a running review reports progress, not a result").toStrictEqual({
		command: "build --watch",
		completionOwed: false,
		cwd: "/work",
		elapsedMs: 5_000,
		exitCode: null,
		hardDeadlineAt: null,
		id: "bg-1",
		outputBytes: 18,
		outputChanged: false,
		outputComplete: false,
		outputPreview: "line one\nline two\n",
		outputPreviewTruncated: false,
		outputRevision: 18,
		pid: 4242,
		readiness: "running",
		reviewDeadlineAt: START + 60_000,
		startedAt: START,
		status: "running",
		terminationReason: undefined,
		updatedAt: START,
	});

	const finalizing = buildTaskResultObservation({
		logSettled: true,
		now: START + 9_000,
		output: { ok: true, output: "partial\n" },
		outputPreviewChars: 500,
		task: resultTask({ exitCode: null, outputBytes: 8, status: "stopped", updatedAt: START + 8_000 }),
	});
	expect(
		{ readiness: finalizing.readiness, completionOwed: finalizing.completionOwed, elapsedMs: finalizing.elapsedMs, changed: finalizing.outputChanged },
		"a finalizing read reports the process state without acknowledging completion",
	).toStrictEqual({ readiness: "finalizing", completionOwed: true, elapsedMs: 8_000, changed: true });

	const terminal = buildTaskResultObservation({
		logSettled: true,
		now: START + 20_000,
		output: { ok: true, output: "0123456789" },
		outputPreviewChars: 4,
		task: resultTask({ exitCode: 0, exitNotified: true, outputBytes: 10, resultReady: true, reviewedOutputBytes: 10, status: "completed", updatedAt: START + 10_000 }),
	});
	expect(
		{ readiness: terminal.readiness, completionOwed: terminal.completionOwed, complete: terminal.outputComplete, preview: terminal.outputPreview, truncated: terminal.outputPreviewTruncated, elapsedMs: terminal.elapsedMs, changed: terminal.outputChanged },
		"a terminal read carries the bounded preview and no outstanding obligation",
	).toStrictEqual({ readiness: "terminal", completionOwed: false, complete: true, preview: "[...truncated]\n6789", truncated: true, elapsedMs: 10_000, changed: false });

	const unreadable = buildTaskResultObservation({
		logSettled: true,
		now: START + 1,
		output: { ok: false, error: "retained output is gone (/logs/bg-1.log); the task may have expired" },
		outputPreviewChars: 500,
		task: resultTask({ outputBytes: 4, status: "completed", updatedAt: START }),
	});
	expect(
		{ preview: unreadable.outputPreview, error: unreadable.outputError, complete: unreadable.outputComplete },
		"a failed output read is surfaced, never an empty success",
	).toStrictEqual({ preview: "", error: "retained output is gone (/logs/bg-1.log); the task may have expired", complete: false });
});

test("completion obligation follows readiness and the notification contract", () => {
	expect(completionOwed(resultTask()), "a running task owes nothing yet").toBe(false);
	expect(completionOwed(resultTask({ exitCode: 0, status: "completed" })), "an unacknowledged terminal task owes a notification").toBe(true);
	expect(completionOwed(resultTask({ exitCode: 0, exitNotified: true, status: "completed" })), "an acknowledged task owes nothing").toBe(false);
	expect(completionOwed(resultTask({ exitCode: 0, notifyOnExit: false, status: "completed" })), "a task with exit wakes disabled owes nothing").toBe(false);
	expect(completionOwed(resultTask({ exitCode: 0, resultReady: false, status: "completed" })), "a finalizing task still owes the notification").toBe(true);
});

test("the review clock measures from the last review, never from output or the hard deadline", () => {
	expect(reviewArmedAt(resultTask()), "an unreviewed task measures from its start").toBe(START);
	expect(reviewDeadlineFor(resultTask()), "the first review falls due one interval after start").toBe(START + 60_000);
	expect(reviewDeadlineFor(resultTask({ softTimeoutMs: 0 })), "a disabled interval has no deadline").toBeNull();
	expect(reviewDeadlineFor(resultTask({ softTimeoutMs: undefined })), "an absent interval setting has no deadline").toBeNull();

	const reviewed = resultTask({ lastReviewedAt: START + 30_000, outputBytes: 9_999, reviewedOutputBytes: 12, status: "completed" });
	expect(reviewDeadlineFor(reviewed), "the next review is measured from the review, not from task age or output volume").toBe(START + 90_000);
	expect(reviewDeadlineFor(resultTask({ expiresAt: START + 5_000 })), "the hard ceiling never moves the review deadline").toBe(START + 60_000);

	expect(reviewReminderArmed(resultTask()), "a running task with an enabled interval arms one reminder").toBe(true);
	expect(reviewReminderArmed(resultTask({ softTimeoutMs: 0 })), "a disabled interval arms nothing").toBe(false);
	expect(reviewReminderArmed(resultTask({ status: "completed" })), "a terminal task gets no progress reminder").toBe(false);
	expect(reviewReminderArmed(resultTask({ stopReason: "user" })), "a task already being stopped arms nothing").toBe(false);
});

test("completion acknowledgment is one idempotent, durable entry point", () => {
	const task = { exitNotified: false, id: "bg-1" };
	const persisted: string[] = [];
	const cancelled: string[] = [];
	const hooks = {
		cancelHeldWake: (id: string) => { cancelled.push(id); return true; },
		persist: (target: { id: string }) => { persisted.push(target.id); },
	};

	expect(acknowledgeCompletion(task, hooks), "the first call records the obligation and drops the held wake").toStrictEqual({ acknowledged: true, heldWakeCancelled: true });
	expect({ task, persisted, cancelled }, "the acknowledgment is persisted once").toStrictEqual({ task: { exitNotified: true, id: "bg-1" }, persisted: ["bg-1"], cancelled: ["bg-1"] });

	expect(acknowledgeCompletion(task, hooks), "a repeated call changes nothing durable").toStrictEqual({ acknowledged: false, heldWakeCancelled: true });
	expect({ persisted, cancelled }, "an already-acknowledged task is not persisted a second time").toStrictEqual({ persisted: ["bg-1"], cancelled: ["bg-1", "bg-1"] });

	// A caller that is placing the held wake itself must not cancel it.
	task.exitNotified = false;
	persisted.length = 0;
	cancelled.length = 0;
	expect(acknowledgeCompletion(task, hooks, { cancelHeld: false }), "placing a wake records the obligation without cancelling its own wake").toStrictEqual({ acknowledged: true, heldWakeCancelled: false });
	expect({ persisted, cancelled }, "and persists the obligation").toStrictEqual({ persisted: ["bg-1"], cancelled: [] });
});

test("retention pruning never touches active work, protected results, or the newest finished tasks", () => {
	const tasks = Array.from({ length: 5 }, (_, index) => ({
		id: `bg-${index + 1}`,
		status: index === 4 ? ("running" as const) : ("completed" as const),
		updatedAt: START + index * 1_000,
	}));

	expect(selectPrunableFinishedTasks(tasks, { maxFinished: 10 }), "nothing is pruned below the bound").toStrictEqual([]);
	expect(selectPrunableFinishedTasks(tasks, { maxFinished: 2 }).map((task) => task.id), "the oldest finished tasks go first, in order").toStrictEqual(["bg-1", "bg-2"]);
	expect(selectPrunableFinishedTasks(tasks, { maxFinished: 0 }).map((task) => task.id), "a running task is never pruned").toStrictEqual(["bg-1", "bg-2", "bg-3", "bg-4"]);
	expect(
		selectPrunableFinishedTasks(tasks, { maxFinished: 2, protectedIds: new Set(["bg-1"]) }).map((task) => task.id),
		"protecting a task prunes it neither directly nor to make room for another",
	).toStrictEqual(["bg-2"]);
});

test("a terminal read over an unsettled log is short, not complete", () => {
	const observation = buildTaskResultObservation({
		logSettled: false,
		now: START + 30_000,
		output: { ok: true, output: "tail after the failed write\n" },
		outputPreviewChars: 500,
		task: resultTask({ exitCode: 0, exitNotified: true, outputBytes: 900, resultReady: true, reviewedOutputBytes: 900, status: "completed", updatedAt: START + 20_000 }),
	});
	expect(
		{ readiness: observation.readiness, error: observation.outputError, complete: observation.outputComplete },
		"the process half of readiness landed, so the caller must judge completeness from its own flag",
	).toStrictEqual({ readiness: "terminal", error: undefined, complete: false });
});
