import { expect, test } from "bun:test";
import { replayMissedExitsLifecycle, type LifecycleHooks } from "../extensions/lifecycle.js";
import { restoredTaskFromSnapshot, taskSnapshot } from "../extensions/snapshot.js";
import { acknowledgeCompletion, beginResultFinalization, buildTaskResultObservation, completeResultFinalization, completionOwed, reviewDeadlineFor, reviewReminderArmed, taskReadiness } from "../extensions/task-result.js";
import type { BackgroundTaskSnapshot, BackgroundTaskStatus, BackgroundTaskTerminationReason, ProcessIdentity } from "../extensions/types.js";
import { fakeIdent, fakeSnapshot, fakeTask, reading, recordingHooks } from "./fixtures/lifecycle.js";

interface RestoreReplayRow {
	name: string;
	snapshot: Partial<BackgroundTaskSnapshot>;
	identity: ProcessIdentity | null;
	expected: {
		status: BackgroundTaskStatus;
		closed: boolean;
		beforeNotified: boolean;
		afterNotified: boolean;
		reason: BackgroundTaskTerminationReason | undefined;
		replayed: number;
		eventIds: string[];
	};
}

const rows: RestoreReplayRow[] = [
	{
		name: "dead same-session running snapshot is stopped before exit replay",
		snapshot: { id: "bg-3", status: "running", exitCode: null, outputBytes: 89, exitNotified: false, notifyOnExit: true, procIdent: fakeIdent(2409160) },
		identity: null,
		expected: { status: "stopped", closed: true, beforeNotified: false, afterNotified: true, reason: "reconcile-on-restart", replayed: 1, eventIds: ["bg-3"] },
	},
	{
		name: "matching live identity remains running without an exit replay",
		snapshot: { id: "bg-3", status: "running", pid: 4242, notifyOnExit: true, procIdent: fakeIdent(4242) },
		identity: fakeIdent(4242),
		expected: { status: "running", closed: false, beforeNotified: false, afterNotified: false, reason: undefined, replayed: 0, eventIds: [] },
	},
	{
		name: "foreign-session snapshot is ineligible before replay",
		snapshot: { id: "bg-other", status: "running", exitNotified: false, notifyOnExit: true, sessionId: "sess-OTHER" },
		identity: null,
		expected: { status: "stopped", closed: true, beforeNotified: true, afterNotified: true, reason: "reconcile-on-restart", replayed: 0, eventIds: [] },
	},
];

test("restore followed by missed exit replay", async () => {
	expect.assertions(rows.length + 1);
	expect(rows.length, "restore-replay table must contain rows").toBeGreaterThan(0);
	for (const row of rows) {
		const recorder = recordingHooks();
		const restored = await restoredTaskFromSnapshot(fakeSnapshot(row.snapshot), {
			identityProbe: async () => reading(row.identity), sessionId: "sess-1", now: 1_700_000_100_000,
		});
		// Capture the restore result before replay can change exitNotified.
		const before = { status: restored.status, closed: restored.closed, exitNotified: restored.exitNotified };
		const replayed = replayMissedExitsLifecycle([restored], recorder.hooks);
		expect({ before, replayed, afterNotified: restored.exitNotified, hooks: recorder.observe([restored]) }, row.name).toStrictEqual({
			before: { status: row.expected.status, closed: row.expected.closed, exitNotified: row.expected.beforeNotified },
			replayed: row.expected.replayed, afterNotified: row.expected.afterNotified,
			hooks: {
				events: row.expected.eventIds.map((id) => ({ type: "exit", id, reason: row.expected.reason, sameTask: true })),
				persists: row.expected.replayed, remembers: row.expected.replayed, refreshes: 0, timerClears: 0,
			},
		});
	}
});

/**
 * Conservative restore of the readiness/review fields. A snapshot written
 * before these fields existed establishes readiness by reconciliation; a
 * snapshot that recorded an incomplete capture keeps it. A legacy snapshot
 * must also keep the interval it was carrying — not re-derive a new one.
 */
test("restore preserves a legacy review interval and reconciles unknown readiness", async () => {
	const legacyTerminal = fakeSnapshot({ exitCode: 0, resultReady: undefined, softTimeoutMs: 600_000, status: "completed", updatedAt: 1_700_000_010_000 });
	const finished = await restoredTaskFromSnapshot(legacyTerminal, {
		identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000,
	});
	expect(
		{ readiness: taskReadiness(finished), resultReady: finished.resultReady, outputComplete: finished.outputComplete, reviewDeadlineAt: reviewDeadlineFor(finished) },
		"a snapshot that recorded no readiness is reconciled once, and is not upgraded by a later field's arrival",
	).toStrictEqual({ readiness: "terminal", resultReady: true, outputComplete: true, reviewDeadlineAt: 1_700_000_000_000 + 600_000 });

	const legacy = fakeSnapshot({ softExpiresAt: 1_700_000_500_000, softTimeoutMs: 60_000, status: "running", pid: 4242, procIdent: fakeIdent(4242) });
	delete (legacy as { lastReviewedAt?: number }).lastReviewedAt;
	// A running snapshot's readiness is not unknown so much as unstarted: the
	// process was still writing when this was persisted.
	delete (legacy as { resultReady?: boolean }).resultReady;
	const restoredLegacy = await restoredTaskFromSnapshot(legacy, {
		identityProbe: async () => ({ kind: "identity", identity: fakeIdent(4242) }),
		sessionId: "sess-1",
		now: 1_700_000_100_000,
	});
	expect(
		{ lastReviewedAt: restoredLegacy.lastReviewedAt, reviewDeadlineAt: reviewDeadlineFor(restoredLegacy) },
		"a snapshot without the review field keeps the deadline it persisted",
	).toStrictEqual({ lastReviewedAt: 1_700_000_440_000, reviewDeadlineAt: 1_700_000_500_000 });
});

/**
 * A snapshot taken inside the flush window records `resultReady === false`.
 * Restore has no process left to finish that flush and a fresh, empty writer
 * queue, so re-deriving readiness there would hand back the very late-output
 * race the retrieval contract forbids. The task must come back as an
 * unrecoverable incomplete capture: not acknowledged by a get/stop, not a
 * complete capture, and not described as something that will finish flushing
 * later — nobody is left to flush it.
 */
test("a terminal snapshot taken mid-flush restores without becoming a ready result", async () => {
	const midFlush = fakeSnapshot({
		exitCode: 1,
		outputBytes: 4_096,
		resultReady: false,
		outputComplete: false,
		status: "failed",
		updatedAt: 1_700_000_010_000,
	});
	const restored = await restoredTaskFromSnapshot(midFlush, {
		identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000,
	});

	expect(
		{ status: restored.status, readiness: taskReadiness(restored), resultReady: restored.resultReady, outputComplete: restored.outputComplete },
		"an interrupted capture keeps its own readiness instead of being reconciled into a complete result",
	).toStrictEqual({ status: "failed", readiness: "incomplete", resultReady: false, outputComplete: false });

	// The notification obligation is untouched by readiness: this is the same
	// task the live path would have woken on, so its exit is still owed.
	const observation = buildTaskResultObservation({
		logSettled: true,
		now: 1_700_000_100_000,
		output: { ok: true, output: "partial\n" },
		outputPreviewChars: 500,
		task: restored,
	});
	expect(
		{ ready: taskReadiness(restored) === "terminal", complete: observation.outputComplete, owed: completionOwed(restored) },
		"a retrieval over it may not acknowledge completion, and its output is never advertised as complete",
	).toStrictEqual({ ready: false, complete: false, owed: true });
});

/**
 * A snapshot taken after the barrier released over a writer that dropped bytes
 * records `resultReady === true` with `outputComplete === false`. The process
 * half of readiness did land, so the restored task is a terminal result — but
 * a short one, and the fresh writer queue must not talk the observation into
 * calling it complete.
 */
test("a terminal snapshot whose writer dropped bytes restores as a short capture", async () => {
	const short = fakeSnapshot({ exitCode: 0, outputBytes: 900, resultReady: true, outputComplete: false, status: "completed", updatedAt: 1_700_000_010_000 });
	const restored = await restoredTaskFromSnapshot(short, {
		identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000,
	});

	expect(
		{ readiness: taskReadiness(restored), resultReady: restored.resultReady, outputComplete: restored.outputComplete },
		"the settled half of readiness survives, the dropped bytes survive with it",
	).toStrictEqual({ readiness: "terminal", resultReady: true, outputComplete: false });

	// A restarted manager owns an empty queue for this file, which is exactly
	// why `logSettled` alone cannot be the answer here.
	const observation = buildTaskResultObservation({
		logSettled: true,
		now: 1_700_000_100_000,
		output: { ok: true, output: "the bytes that survived\n" },
		outputPreviewChars: 500,
		task: restored,
	});
	expect(
		{ preview: observation.outputPreview, error: observation.outputError, complete: observation.outputComplete },
		"the retained output is handed back as explicitly short, never as a complete snapshot",
	).toStrictEqual({ preview: "the bytes that survived\n", error: undefined, complete: false });
});

/**
 * The same record reachable from the other direction: a *running* snapshot is
 * written before any capture is established, so the modern presence of
 * `resultReady` marks it as "not certified" rather than as the legacy absence
 * of the field. If the manager dies mid-flight the pid is gone on the next
 * start, the task is coerced to stopped — and it must not come back as a
 * ready, complete result over a log the previous process never finished
 * writing. A legacy snapshot (no record at all) is still reconciled, and an
 * acknowledged one still stays silent.
 */
test("a running snapshot whose capture was never certified never restores as a complete result", async () => {
	const unestablished = fakeSnapshot({ pid: 2409160, procIdent: fakeIdent(2409160), resultReady: false, status: "running" });
	const restored = await restoredTaskFromSnapshot(unestablished, {
		identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000,
	});
	expect(
		{ status: restored.status, readiness: taskReadiness(restored), resultReady: restored.resultReady, outputComplete: restored.outputComplete },
		"the manager's death is not evidence that the last flush landed",
	).toStrictEqual({ status: "stopped", readiness: "incomplete", resultReady: false, outputComplete: false });

	// Whatever survived in the retained log is still handed back — labelled,
	// and never as the complete output of the command.
	const observation = buildTaskResultObservation({
		logSettled: true,
		now: 1_700_000_100_000,
		output: { ok: true, output: "the bytes that survived\n" },
		outputPreviewChars: 500,
		task: restored,
	});
	expect(
		{ preview: observation.outputPreview, readiness: observation.readiness, complete: observation.outputComplete, owed: observation.completionOwed },
		"partial bytes stay reachable, and neither readiness nor completeness is over-claimed",
	).toStrictEqual({ preview: "the bytes that survived\n", readiness: "incomplete", complete: false, owed: true });

	// The migration contract is unchanged. A snapshot that recorded nothing
	// (legacy) still reaches reconciliation — including the running shape this
	// fix touches — and an acknowledged legacy snapshot still stays silent.
	const legacyRunning = fakeSnapshot({ exitNotified: false, pid: 2409160, procIdent: fakeIdent(2409160), resultReady: undefined, status: "running" });
	const legacyRestored = await restoredTaskFromSnapshot(legacyRunning, {
		identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000,
	});
	expect(
		{ status: legacyRestored.status, readiness: taskReadiness(legacyRestored), complete: legacyRestored.outputComplete, replayed: replayMissedExitsLifecycle([legacyRestored], recordingHooks().hooks) },
		"a snapshot with no record is reconciled, and its coerced exit is still replayed",
	).toStrictEqual({ status: "stopped", readiness: "terminal", complete: true, replayed: 1 });

	const legacyAcknowledged = fakeSnapshot({ exitCode: 0, exitNotified: true, resultReady: undefined, status: "completed", updatedAt: 1_700_000_010_000 });
	const acknowledged = await restoredTaskFromSnapshot(legacyAcknowledged, {
		identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000,
	});
	expect(
		{ readiness: taskReadiness(acknowledged), complete: acknowledged.outputComplete, replayed: replayMissedExitsLifecycle([acknowledged], recordingHooks().hooks) },
		"an acknowledged legacy snapshot stays silent",
	).toStrictEqual({ readiness: "terminal", complete: true, replayed: 0 });
});

test("an acknowledged legacy snapshot never replays because a new field is absent", async () => {
	const snapshot = fakeSnapshot({ exitCode: 0, exitNotified: true, resultReady: undefined, status: "completed", updatedAt: 1_700_000_010_000 });
	const restored = await restoredTaskFromSnapshot(snapshot, { identityProbe: async () => reading(null), sessionId: "sess-1" });
	expect({ exitNotified: restored.exitNotified, replayed: replayMissedExitsLifecycle([restored], recordingHooks().hooks), owed: completionOwed(restored) })
		.toStrictEqual({ exitNotified: true, replayed: 0, owed: false });
});
/**
 * A live task whose review deadline passed while Pi was down restores with the
 * one interval it was carrying. Coalescing is structural: the deadline is a
 * function of the last review, so a long outage yields one overdue review, not
 * one per missed interval.
 */
test("an overdue review restores as one reminder", async () => {
	const snapshot = fakeSnapshot({ pid: 4242, procIdent: fakeIdent(4242), softExpiresAt: 1_700_000_060_000, softTimeoutMs: 60_000, status: "running" });
	const restored = await restoredTaskFromSnapshot(snapshot, {
		identityProbe: async () => ({ kind: "identity", identity: fakeIdent(4242) }),
		sessionId: "sess-1",
		now: 1_700_000_900_000,
	});
	expect(
		{ deadline: reviewDeadlineFor(restored), lastReviewedAt: restored.lastReviewedAt, armed: reviewReminderArmed(restored) },
		"one pending review at the persisted deadline",
	).toStrictEqual({ deadline: 1_700_000_060_000, lastReviewedAt: 1_700_000_000_000, armed: true });
});

/**
 * The replayed exit wake settles its obligation through the same shared
 * acknowledgment the live exit wake and every retrieval use. A replayed wake
 * and a delivered one must not be able to disagree about what the record
 * means, so the replay may not keep a private `exitNotified = true` write.
 */
function ackReplayHooks() {
	const events: string[] = [];
	const acknowledged: string[] = [];
	const remembers: string[] = [];
	const persistCalls: string[] = [];
	// A wake this process still holds for the task: the host-notification
	// acknowledgment production wires must leave it alone.
	const held = new Set(["bg-3"]);
	const hooks: LifecycleHooks = {
		acknowledgeCompletion: (task) => acknowledgeCompletion(
			task,
			{
				cancelHeldWake: (id) => held.delete(id),
				persist: (target) => {
					acknowledged.push(target.id);
				},
			},
			{ cancelHeld: false },
		),
		clearTaskTimers: () => {},
		persistSnapshots: () => {
			persistCalls.push("batch");
			return { appendEntry: true, sidecar: true };
		},
		refreshUi: () => {},
		rememberSnapshot: (task) => {
			remembers.push(task.id);
			return { ...task };
		},
		sendTaskEvent: (type, task) => {
			events.push(`${type}:${task.id}`);
			return true;
		},
	};
	return { acknowledged, events, held, hooks, persistCalls, remembers };
}

test("replay acknowledges each exit through the shared entry point, once", async () => {
	const snapshot = fakeSnapshot({ id: "bg-3", status: "running", exitNotified: false, notifyOnExit: true, procIdent: fakeIdent(2409160) });
	const restored = await restoredTaskFromSnapshot(snapshot, { identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000 });
	const recorder = ackReplayHooks();

	expect(replayMissedExitsLifecycle([restored], recorder.hooks), "the missed exit is replayed").toBe(1);
	expect(
		{ exitNotified: restored.exitNotified, events: recorder.events, acknowledged: recorder.acknowledged, remembers: recorder.remembers, persistCalls: recorder.persistCalls, held: [...recorder.held] },
		"the shared acknowledgment records the obligation and persists it, and the replay writes no obligation of its own",
	).toStrictEqual({
		exitNotified: true,
		events: ["exit:bg-3"],
		acknowledged: ["bg-3"],
		remembers: [],
		persistCalls: ["batch"],
		held: ["bg-3"],
	});

	// A second pass finds nothing to replay: the obligation is already the
	// task's own record, so no event, no acknowledgment write and no snapshot.
	expect(replayMissedExitsLifecycle([restored], recorder.hooks), "a repeated replay replays nothing").toBe(0);
	expect(
		{ events: recorder.events, acknowledged: recorder.acknowledged, persistCalls: recorder.persistCalls },
		"and creates no second notification or durable write",
	).toStrictEqual({ events: ["exit:bg-3"], acknowledged: ["bg-3"], persistCalls: ["batch"] });
});

/**
 * The hook-less fallback is what a test-injected lifecycle keeps working, and
 * it must stay batched: one remember per replayed task, one persist for the
 * batch.
 */
test("without a shared hook the replay keeps its batched record-and-persist fallback", async () => {
	const restored = await restoredTaskFromSnapshot(
		fakeSnapshot({ id: "bg-3", status: "running", exitNotified: false, notifyOnExit: true, procIdent: fakeIdent(2409160) }),
		{ identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000 },
	);
	const recorder = recordingHooks();
	expect(replayMissedExitsLifecycle([restored], recorder.hooks), "the fallback still replays").toBe(1);
	expect(recorder.observe([restored]), "one remembered snapshot and one batch persist, no ack hook involved").toStrictEqual({
		events: [{ type: "exit", id: "bg-3", reason: "reconcile-on-restart", sameTask: true }],
		persists: 1, remembers: 1, refreshes: 0, timerClears: 0,
	});
});

/**
 * The `session_shutdown` handler stamps a terminal status on the tasks it
 * kills and persists immediately, before the flush it drains afterwards. That
 * snapshot therefore says "terminal process, no settled flush" — the same
 * record finalizeTask would leave mid-flush — and must restore the same way.
 */
test("a task stopped at session_shutdown restores as not-ready, not as a final result", async () => {
	const stoppedAtShutdown = fakeSnapshot({ exitCode: null, resultReady: false, status: "stopped", stopReason: "shutdown", terminationReason: "session-shutdown", updatedAt: 1_700_000_010_000 });
	const restored = await restoredTaskFromSnapshot(stoppedAtShutdown, {
		identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000,
	});
	expect(
		{ status: restored.status, readiness: taskReadiness(restored), outputComplete: restored.outputComplete },
		"an unconfirmed flush survives the restart as an unconfirmed flush",
	).toStrictEqual({ status: "stopped", readiness: "incomplete", outputComplete: false });
	expect(replayMissedExitsLifecycle([restored], recordingHooks().hooks), "its exit is still owed and still replayed").toBe(1);
});

/**
 * The round trip the extension actually performs. A command that exited
 * cleanly persists both halves of readiness, and the durable record is what
 * lets a restore keep calling the capture complete instead of having to infer
 * it from a writer queue that no longer exists.
 */
test("a cleanly finished command survives the persist/restore round trip as complete", async () => {
	const task = fakeTask({ exitCode: null, startedAt: 1_700_000_000_000, status: "running", updatedAt: 1_700_000_000_000 });
	beginResultFinalization(task);
	task.status = "completed";
	task.exitCode = 0;
	task.updatedAt = 1_700_000_010_000;
	completeResultFinalization(task, true);

	const persisted = taskSnapshot(task);
	expect(
		{ resultReady: persisted.resultReady, outputComplete: persisted.outputComplete },
		"the snapshot carries both halves of the capture record",
	).toStrictEqual({ resultReady: true, outputComplete: true });

	const restored = await restoredTaskFromSnapshot(persisted, { identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000 });
	expect(
		{ readiness: taskReadiness(restored), resultReady: restored.resultReady, outputComplete: restored.outputComplete },
		"and a restore of it is a ready, complete terminal result",
	).toStrictEqual({ readiness: "terminal", resultReady: true, outputComplete: true });
});

test("a foreign-session terminal snapshot is closed, not left awaiting review", async () => {
	const foreign = await restoredTaskFromSnapshot(
		fakeSnapshot({ id: "bg-fork", status: "completed", exitCode: 0, exitNotified: true, sessionId: "sess-OTHER" }),
		{ identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000 },
	);
	expect(foreign.resultResolution).toBe("delivered");
	const own = await restoredTaskFromSnapshot(
		fakeSnapshot({ id: "bg-own", status: "completed", exitCode: 0, exitNotified: true, sessionId: "sess-1" }),
		{ identityProbe: async () => reading(null), sessionId: "sess-1", now: 1_700_000_100_000 },
	);
	expect(own.resultResolution).toBeUndefined();
});
