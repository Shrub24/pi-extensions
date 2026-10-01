import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { startExtensionHost, type ExtensionHost, type HostTool } from "./fixtures/extension-host.js";

// The lifecycle contract the retrieval contract is built on, exercised against
// the real extension: a terminal result becomes ready only after its log flush,
// its completion notification is acknowledged exactly once and durably, further
// retrievals stay available, and a replacement run starts from a clean slate.
const host = await startExtensionHost();
afterAll(() => host.dispose());

const bgTask = (): HostTool => host.tools.get("bg_task")!;
const execute = (params: Record<string, unknown>) => bgTask().execute("lifecycle-call", params);

/** Bounded harness wait; never part of the product surface. */
async function until(predicate: () => boolean, budgetMs = 10_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
}

const listed = async (id: string): Promise<Record<string, any> | undefined> => (await host.listTasks()).find((task) => task.id === id);
const exitWakes = () => host.messages.filter(([message]) => (message as { details?: { eventType?: string } })?.details?.eventType === "exit");
const spawned = (result: { details: Record<string, any> }) => result.details.task as Record<string, any>;

/** Wait until none of `ids` is running any more, or the budget lapses. */
async function untilSettled(ids: string[], budgetMs = 15_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const tasks = await host.listTasks();
		if (ids.every((id) => tasks.find((task) => task.id === id)?.status !== "running")) return;
		if (Date.now() >= deadline) return;
		await Bun.sleep(5);
	}
}

test("a finished command is retrievable, and its completion is acknowledged once", async () => {
	const spawnResult = await execute({ action: "spawn", command: "printf 'alpha\\nbeta\\n'" });
	const id = spawned(spawnResult).id;
	await until(() => exitWakes().length > 0);
	const task = await listed(id);

	expect(
		{ status: task?.status, exitCode: task?.exitCode, resultReady: task?.resultReady, exitNotified: task?.exitNotified },
		"the terminal result is ready and its one host notification is recorded",
	).toStrictEqual({ status: "completed", exitCode: 0, resultReady: true, exitNotified: true });

	// Retrieval is repeatable and carries the final flushed bytes.
	const first = await execute({ action: "log", id });
	const second = await execute({ action: "log", id });
	expect({ first: first.content[0]?.text, repeated: second.content[0]?.text === first.content[0]?.text }).toStrictEqual({
		first: "alpha\nbeta\n",
		repeated: true,
	});
	expect(exitWakes(), "a repeated retrieval never creates a second notification").toHaveLength(1);
	expect((await listed(id))?.status, "and does not retire the handle").toBe("completed");

	// A retained log that is gone is an explicit expiry error, not empty success.
	rmSync(task!.logFile as string, { force: true });
	const expired = await execute({ action: "log", id });
	expect(expired.content[0]?.text).toContain("retained output is gone");
});

test("a replacement run starts unacknowledged and unready, leaving the older snapshot intact", async () => {
	const first = spawned(await execute({ action: "spawn", command: "sleep 30" }));
	const second = spawned(await execute({ action: "spawn", command: "sleep 30" }));
	const secondTask = await listed(second.id);

	expect(
		{ distinct: first.id !== second.id, sequential: Number(second.id.slice(3)) - Number(first.id.slice(3)) },
		"a replacement gets a fresh generation, never a reused id",
	).toStrictEqual({ distinct: true, sequential: 1 });
	expect(
		{ ready: secondTask?.resultReady, acknowledged: secondTask?.exitNotified, status: secondTask?.status },
		"the replacement starts running, unready, and unacknowledged",
	).toStrictEqual({ ready: false, acknowledged: false, status: "running" });
	expect((await listed(first.id))?.supersededBy, "the older run is marked superseded").toBe(second.id);

	const listText = (await execute({ action: "list" })).content[0]?.text ?? "";
	expect(listText).toContain(`superseded by ${second.id}`);

	// A confirmed stop delivers the same readiness contract under the same id.
	const stopText = (await execute({ action: "stop", id: "all" })).content[0]?.text ?? "";
	expect(stopText).toContain("Stopped");
	await untilSettled([first.id, second.id]);
	const firstAfter = await listed(first.id);
	const secondAfter = await listed(second.id);
	expect(
		{
			first: { status: firstAfter?.status, ready: firstAfter?.resultReady },
			second: { status: secondAfter?.status, ready: secondAfter?.resultReady },
		},
		"every confirmed stop ends with a ready retained result",
	).toStrictEqual({ first: { status: "stopped", ready: true }, second: { status: "stopped", ready: true } });
	expect((await execute({ action: "log", id: second.id })).details.action, "and its output stays retrievable under the same id").toBe("log");
});

test("the hard process ceiling is immutable across retrieval, listing, and the legacy soft reset", async () => {
	const bounded = spawned(await execute({ action: "spawn", command: "sleep 30", timeoutSeconds: 3_600 }));
	await execute({ action: "log", id: bounded.id });
	await execute({ action: "list" });
	expect(
		{ hard: (await listed(bounded.id))?.expiresAt, soft: (await listed(bounded.id))?.softExpiresAt },
		"neither a retrieval nor a listing moves either deadline",
	).toStrictEqual({ hard: bounded.expiresAt, soft: bounded.softExpiresAt });

	const extended = await execute({ action: "extend", id: bounded.id, softTimeoutMs: 120_000 });
	const afterExtend = await listed(bounded.id);
	expect(extended.content[0]?.text, "the soft reset says what it does not touch").toContain("Hard timeout is unchanged");
	expect({ hard: afterExtend?.expiresAt, softTimeoutMs: afterExtend?.softTimeoutMs }, "the hard ceiling is unchanged and only the review window moved")
		.toStrictEqual({ hard: bounded.expiresAt, softTimeoutMs: 120_000 });
	expect(afterExtend?.softExpiresAt, "the new window is a fresh interval, not the old deadline").not.toBe(bounded.softExpiresAt);

	const unbounded = spawned(await execute({ action: "spawn", command: "sleep 30", timeoutSeconds: 0 }));
	await execute({ action: "log", id: unbounded.id });
	await execute({ action: "list" });
	expect((await listed(unbounded.id))?.expiresAt, "a task with no configured ceiling never acquires one").toBeNull();

	await execute({ action: "stop", id: "all" });
	await untilSettled([bounded.id, unbounded.id]);
});

test("output activity never resets the review interval", async () => {
	const noisy = spawned(await execute({
		action: "spawn",
		command: "sh -c 'for i in 1 2 3; do echo tick-$i; sleep 0.05; done; sleep 30'",
		notifyOnOutput: true,
	}));
	const atSpawn = await listed(noisy.id);

	const deadline = Date.now() + 10_000;
	let withOutput = atSpawn;
	while (Date.now() < deadline) {
		const task = await listed(noisy.id);
		if ((task?.outputBytes ?? 0) > (atSpawn?.outputBytes ?? 0)) { withOutput = task; break; }
		await Bun.sleep(5);
	}

	expect(
		{
			grew: (withOutput?.outputBytes ?? 0) > (atSpawn?.outputBytes ?? 0),
			hard: withOutput?.expiresAt,
			soft: withOutput?.softExpiresAt,
		},
		"a chatty task cannot postpone its own review or move its hard ceiling",
	).toStrictEqual({ grew: true, hard: atSpawn?.expiresAt, soft: atSpawn?.softExpiresAt });

	await execute({ action: "stop", id: "all" });
	await untilSettled([noisy.id]);
});

/**
 * Task 3.5: the hard ceiling is absolute. Repeated inspection while the deadline
 * approaches cannot move it, and the process is signalled at the deadline the
 * spawn recorded — a get/list storm is not a way to keep a task alive past its
 * budget. The legacy soft reset is exercised in the test above; this one drives
 * the deadline itself.
 */
test("repeated inspection never moves the absolute hard limit", async () => {
	const task = spawned(await execute({ action: "spawn", command: "sleep 60", timeoutSeconds: 1 }));
	const original = task.expiresAt as number;
	expect(original, "the spawn recorded an absolute deadline").toBeGreaterThan(Date.now() - 1_000);

	const deadline = Date.now() + 20_000;
	let inspections = 0;
	let observed: Record<string, any> | undefined;
	while (Date.now() < deadline) {
		observed = await listed(task.id);
		expect(observed?.expiresAt, "no inspection moves the recorded deadline").toBe(original);
		inspections += 1;
		if (observed?.status !== "running") break;
		await Bun.sleep(5);
	}

	// A `get` storm across the deadline: the ceiling is the spawn's, not the
	// inspection's.
	await execute({ action: "log", id: task.id });
	await untilSettled([task.id]);
	const final = await listed(task.id);
	expect(
		{ inspections: inspections > 5, status: final?.status, reason: final?.terminationReason, hard: final?.expiresAt },
		"the task ended at its own hard ceiling despite continuous inspection",
	).toStrictEqual({ inspections: true, status: "timed_out", reason: "timeout", hard: original });
	expect(final?.updatedAt, "and it ended around the deadline it recorded, not later").toBeLessThanOrEqual(original + 5_000);
});
