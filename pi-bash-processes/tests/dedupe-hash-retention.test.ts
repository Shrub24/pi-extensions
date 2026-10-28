import { afterAll, expect, test } from "bun:test";

import { startExtensionHost } from "./fixtures/extension-host.js";

// A task's output-dedupe hash is dropped with the task. Left behind, the map
// would hold one pair per bash call for the life of the process, and a dedupe
// key a later task reused would be compared against an unrelated task's hash.
const host = await startExtensionHost({ settings: { outputSettleMs: 50, exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

function dedupeEntries(): number {
	const reporters = (globalThis as any)[Symbol.for("pi-memtrace.reporters")] as Map<string, () => Record<string, number>>;
	return reporters?.get("pi-bash-processes.dedupe-hashes")?.().entries ?? -1;
}

const bgTask = () => host.tools.get("bg_task")!;

test("an output wake records a hash, and forgetting the task drops it", async () => {
	expect(dedupeEntries(), "the extension reports its dedupe map").toBe(0);

	const spawned = await bgTask().execute("c", {
		action: "spawn",
		command: "printf 'READY\\n'; sleep 0.5",
		notifyOnOutput: true,
		notifyOnExit: false,
		notifyPattern: "READY",
		// Only transition mode compares output hashes, so only it records one.
		notifyMode: "transition",
	});
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	expect(dedupeEntries(), "the output wake records one hash").toBe(1);

	// The same path that drops a finished task must drop what it left behind.
	await host.clearFinished();
	expect(dedupeEntries(), "forgetting the task forgets its hash").toBe(0);
});

test("a session boundary holds no hashes", async () => {
	const spawned = await bgTask().execute("c", {
		action: "spawn",
		command: "printf 'READY\\n'; sleep 0.5",
		notifyOnOutput: true,
		notifyOnExit: false,
		notifyPattern: "READY",
		notifyMode: "transition",
	});
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	expect(dedupeEntries()).toBe(1);

	await bgTask().execute("c", { action: "get", id });
	await host.dispatch("session_shutdown");
	expect(dedupeEntries(), "a session boundary holds no hashes").toBe(0);
});
