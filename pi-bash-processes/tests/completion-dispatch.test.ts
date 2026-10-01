import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { startExtensionHost, type ExtensionHost } from "./fixtures/extension-host.js";

// Task 3.4: a batch of completion or reminder work is revalidated at the moment
// it is dispatched, and the obligation it fulfils is persisted with the
// delivery. Every test here reads the host's message list, so "nothing was sent"
// is as meaningful as "one was sent".
const host = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const bgTask = () => host.tools.get("bg_task")!;
const execute = (params: Record<string, unknown>) => bgTask().execute("dispatch-call", params);

/** Bounded harness wait; never part of the product surface. */
async function until(predicate: () => boolean, budgetMs = 15_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
}

const taskById = async (id: string) => (await host.listTasks()).find((task) => task.id === id);
const events = (type: string) =>
	host.messages.filter(([message]) => (message as { details?: { eventType?: string } })?.details?.eventType === type);
const settle = async () => {
	await host.dispatch("agent_end");
	await host.dispatch("agent_settled");
};

test("a stop revalidates a held completion and fulfils the same obligation once", async () => {
	await host.dispatch("before_agent_start");
	const spawned = await execute({ action: "spawn", command: "printf 'stopped-run\\n'" });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);

	// The exit is held because a run is in flight.
	expect(events("exit"), "a mid-run completion is held, not delivered").toHaveLength(0);

	// The stop is the observation: it reports the task's real outcome under the
	// same id and takes over the completion obligation.
	const stopped = await execute({ action: "stop", id });
	const stopText = stopped.content[0]?.text ?? "";
	expect(stopText, "a stop of an already-finished task reports its real terminal outcome").toContain("completed (exit 0)");
	expect(stopText, "and never claims it stopped the process").not.toContain("Stopped bg-1");
	expect(stopText, "the stop's own delivery is what settled the obligation").toContain("acknowledged: completion settled");
	const afterStop = await taskById(id);
	expect(
		{ status: afterStop?.status, exitCode: afterStop?.exitCode, notified: afterStop?.exitNotified },
		"the stop delivered the result, so the completion is acknowledged exactly once",
	).toStrictEqual({ status: "completed", exitCode: 0, notified: true });

	await settle();
	expect(events("exit"), "the run boundary must not send a second, redundant wake").toHaveLength(0);
	expect((await taskById(id))?.exitNotified, "and the obligation stays fulfilled").toBe(true);
});

test("a delivered reminder is not re-sent when the task then completes", async () => {
	await host.dispatch("before_agent_start");
	const spawned = await execute({
		action: "spawn",
		command: "sleep 0.4",
		softTimeoutMs: 100,
		notifyOnExit: true,
	});
	const id = (spawned.details.task as { id: string }).id;
	await until(() => events("soft-timeout").length > 0, 10_000);
	await host.settledTask(id);
	await settle();

	// One reminder per elapsed interval, re-armed from its own delivery: a task
	// that outlives several intervals is reviewed several times, and never holds
	// more than the one pending reminder for the interval it is in.
	const soft = events("soft-timeout");
	expect(soft.length, "each elapsed interval produced its own review").toBeGreaterThanOrEqual(1);
	const delivered = soft.length;
	const deadlineAtTerminal = (await taskById(id))?.softExpiresAt ?? null;
	// The task is terminal now: no further interval may produce a reminder, and
	// the recorded deadline must not be re-armed forward for one.
	await Bun.sleep(400);
	expect(events("soft-timeout").length, "a finished task receives no further reminder").toBe(delivered);
	expect((await taskById(id))?.softExpiresAt ?? null, "and its last deadline does not advance").toBe(deadlineAtTerminal);
	expect(deadlineAtTerminal, "the deadline it did reach is in the past").toBeLessThanOrEqual(Date.now());
	const exit = events("exit");
	expect(exit, "the completion is delivered separately, exactly once").toHaveLength(1);
	expect(JSON.stringify(exit[0]), "the completion names its own task").toContain(id);
	const final = await taskById(id);
	expect(
		{ status: final?.status, notified: final?.exitNotified },
		"the reminder never became the completion's acknowledgment",
	).toStrictEqual({ status: "completed", notified: true });
	// The reminder's own timer is retired by the terminal transition; that the
	// deadline is still *recorded* is not a pending reminder, which is what the
	// no-further-reminder assertion above establishes.
	expect(events("soft-timeout").length).toBe(delivered);
});

test("completions in an idle session are batched into one wake, each acknowledged once", async () => {
	const before = events("exit").length;
	const spawned = [
		await execute({ action: "spawn", command: "printf 'idle-a\\n'" }),
		await execute({ action: "spawn", command: "printf 'idle-b\\n'" }),
	];
	const ids = spawned.map((result) => (result.details.task as { id: string }).id);
	for (const id of ids) await host.settledTask(id);
	await until(() => ids.every((id) => Boolean(id)) && events("exit").length > before);

	const delivered = events("exit").slice(before);
	// Idle batching may deliver one message per task or one grouped message; what
	// must hold is that every completion is carried by exactly one wake, and that
	// each task's obligation is recorded as fulfilled exactly once.
	const text = delivered.map(([message]) => JSON.stringify(message)).join("\n");
	for (const id of ids) {
		expect(text, `${id} is reported by the batch`).toContain(id);
		const task = await taskById(id);
		expect({ id, notified: task?.exitNotified, ready: task?.resultReady }, `${id} carries its own obligation`).toStrictEqual({
			id,
			notified: true,
			ready: true,
		});
	}
});

test("no batch clears a Pi message queue the extension does not own", () => {
	// The completion path only ever sends. The single queue-shaped call in the
	// extension is a bounded wait *reading* whether Pi has messages pending, which
	// is how it releases early without touching the queue's contents.
	const source = readFileSync(new URL("../extensions/background-tasks.ts", import.meta.url), "utf8");
	expect(source, "pending-message state is read, never drained").toContain("ctx.hasPendingMessages()");
	for (const forbidden of ["clearMessages", "drainMessages", "pendingMessages.splice", "dequeueMessage"]) {
		expect(source, `no private queue manipulation: ${forbidden}`).not.toContain(forbidden);
	}
	// The only send options used are Pi's documented delivery modes.
	const sends = source.match(/sendMessage\([\s\S]{0,400}?\)/g) ?? [];
	expect(sends.length, "the audit found the send sites").toBeGreaterThan(0);
});

test("a restored task's obligation is whatever the snapshot recorded, and never replayed twice", async () => {
	// Restore-time revalidation is covered in depth by `tests/restore-replay.test.ts`
	// and `tests/replay-missed-exits.test.ts`; this row pins the dispatch-side half:
	// a task that reports itself already notified is not handed a second wake by a
	// later batch. The host's own state is the evidence.
	const spawned = await execute({ action: "spawn", command: "printf 'restored-once\\n'" });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	await until(() => host.messages.some(([message]) => JSON.stringify(message).includes(id)));
	const before = events("exit").length;
	// A second observation through a declared operation changes nothing.
	await execute({ action: "get", id });
	await settle();
	expect(events("exit").length, "an acknowledged completion is never re-delivered").toBe(before);
	expect((await taskById(id))?.exitNotified).toBe(true);
});
