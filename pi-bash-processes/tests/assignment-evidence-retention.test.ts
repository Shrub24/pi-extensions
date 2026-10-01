// Assignment evidence through retention and explicit control (openspec
// `herdsman-background-handoffs` tasks 2.1-2.2): automatic retention pruning
// and `clear` must never turn an unread assignment-owned result into
// completion — the provider would read the emptied map as resolved. Resolved
// history and unassociated tasks keep their old pruning/clearing behavior.

import { afterAll, expect, test } from "bun:test";

import { startExtensionHost, type ExtensionHost, type HostTool } from "./fixtures/extension-host.js";
import { bindBackgroundWorkAssignment, queryBackgroundWorkSnapshot } from "../extensions/background-work.js";

const host: ExtensionHost = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const SESSION = `extension-host-${process.pid}`;
const scope = (requestId: string) => ({ sessionId: SESSION, requestId });
const bgTask = (): HostTool => host.tools.get("bg_task")!;
const listed = async (id: string) => (await host.listTasks()).find((task) => task.id === id);
const outstandingOf = (requestId: string) => {
	const result = queryBackgroundWorkSnapshot(host.events, scope(requestId));
	if (result.state === "ready" || result.state === "reconciling") return result.snapshot.outstanding;
	return null;
};

async function until(predicate: () => boolean | Promise<boolean>, budgetMs = 30_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!(await predicate()) && Date.now() < deadline) await Bun.sleep(10);
}

test(
	"retention overflow keeps a notified-but-unretrieved owned result and prunes only resolved history",
	async () => {
	await host.dispatch("before_agent_start");
	expect(bindBackgroundWorkAssignment(host.events, scope("req-retain"))).toStrictEqual({ state: "bound" });

	const first = await bgTask().execute("retain-owned", { action: "spawn", command: "printf 'owned-unread\\n'" });
	const ownedId = (first.details.task as { id: string }).id;
	await host.settledTask(ownedId);

	// Deliver its completion wake: notified, but never retrieved.
	await host.dispatch("agent_end");
	await host.dispatch("agent_settled");
	expect((await listed(ownedId))?.exitNotified, "the completion wake was delivered").toBe(true);
	expect((await listed(ownedId))?.resultResolution, "notification is not resolution").toBeUndefined();

	// Overflow the finished bound with resolved history: spawn past the
	// 50-task bound, then resolve each so it becomes prunable. The spawns are
	// issued together so their flush windows overlap instead of serializing.
	const resolvedIds: string[] = [];
	for (let index = 0; index < 52; index += 1) {
		const spawned = await bgTask().execute(`retain-fill-${index}`, { action: "spawn", command: `printf 'fill-${index}\\n'` });
		resolvedIds.push((spawned.details.task as { id: string }).id);
	}
	await until(async () => {
		const records = await host.listTasks();
		return resolvedIds.every((id) => records.find((record) => record.id === id)?.resultReady === true);
	});
	for (const id of resolvedIds) {
		await bgTask().execute(`retain-get-${id}`, { action: "get", id });
	}
	// Retention runs when a task finalizes; one more completion therefore
	// triggers the bound against the resolved history just created.
	const triggerSpawn = await bgTask().execute("retain-trigger", { action: "spawn", command: "printf 'retain-trigger\\n'" });
	const triggerId = (triggerSpawn.details.task as { id: string }).id;
	await host.settledTask(triggerId);
	await bgTask().execute("retain-trigger-get", { action: "get", id: triggerId });
	// Wait until the bound has actually evicted from the fill set.
	await until(async () => {
		const records = await host.listTasks();
		return resolvedIds.filter((id) => records.some((record) => record.id === id)).length <= 50;
	});
	const records = await host.listTasks();
	expect(
		resolvedIds.filter((id) => records.some((record) => record.id === id)).length,
		"prunable history was evicted down to the bound",
	).toBeLessThanOrEqual(50);
	expect(records.some((record) => record.id === ownedId), "the unread assignment-owned result survived the bound").toBe(true);
	expect((await listed(ownedId))?.resultResolution, "eviction attempts never record a resolution").toBeUndefined();
	expect(outstandingOf("req-retain"), "the provider still counts the preserved evidence").toStrictEqual([
		{ taskId: ownedId, state: "awaiting-result-review", reason: expect.stringContaining("awaiting an actual result handoff") },
	]);

	// Retrieval still retires it, and the prunable bound applies again.
	await bgTask().execute("retain-owned-get", { action: "get", id: ownedId });
	expect((await listed(ownedId))?.resultResolution).toBe("delivered");
	expect(outstandingOf("req-retain")).toStrictEqual([]);
	},
	60_000,
);

test(
	"clear skips an owned unresolved result — loudly — and removes unassociated and resolved tasks",
	async () => {
	await host.dispatch("before_agent_start");
	expect(bindBackgroundWorkAssignment(host.events, scope("req-clear"))).toStrictEqual({ state: "bound" });
	const owned = await bgTask().execute("clear-owned", { action: "spawn", command: "printf 'clear-owned\\n'" });
	const ownedId = (owned.details.task as { id: string }).id;
	await host.settledTask(ownedId);

	// A restart drops the binding, so this spawn is unassociated; a second
	// spawn under the old binding is resolved history. Both must clear.
	await host.dispatch("session_start");
	const orphan = await bgTask().execute("clear-orphan", { action: "spawn", command: "printf 'clear-orphan\\n'" });
	const orphanId = (orphan.details.task as { id: string }).id;
	await host.settledTask(orphanId);
	await bgTask().execute("clear-orphan-get", { action: "get", id: orphanId });

	const cleared = await bgTask().execute("clear-owned-run", { action: "clear" });
	const text = cleared.content[0]?.text ?? "";
	expect(text, "the clear still reports its removals").toContain("Removed");
	expect(text, "and it names what it kept instead of hiding the skip").toContain("Kept 1");
	expect(await listed(orphanId), "unassociated history clears").toBeUndefined();
	expect(await listed(ownedId), "the owned unresolved result is kept").toBeTruthy();
	expect((await listed(ownedId))?.resultResolution, "and stays unresolved").toBeUndefined();

	// Retrieving it is the documented path to clearing it afterwards.
	await bgTask().execute("clear-owned-get", { action: "get", id: ownedId });
	const clearedAgain = await bgTask().execute("clear-owned-again", { action: "clear" });
	expect(clearedAgain.content[0]?.text ?? "").toContain("Removed");
	expect(await listed(ownedId), "a delivered result clears like any finished task").toBeUndefined();
	},
	60_000,
);
