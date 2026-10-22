import { afterAll, expect, test } from "bun:test";

import { startExtensionHost } from "./fixtures/extension-host.js";

// A completion wake is the result delivery, so it does not wait for the end of a
// run. It waits only the short batch window, so tasks finishing together arrive
// as one message, and Pi queues it as steer while a run is in flight. A wake
// never waits when no sibling is still running.
const host = await startExtensionHost({ settings: { exitWakeBatchMs: 5_000, exitWakeRunBatchMs: 300, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const bgTask = () => host.tools.get("bg_task")!;
const exitCalls = () =>
	host.messages.filter(([message]) => {
		const details = (message as { details?: { eventType?: string; grouped?: boolean } })?.details;
		return details?.eventType === "exit" || details?.grouped === true;
	});
const spawn = async (command: string) => ((await bgTask().execute("c", { action: "spawn", command })).details.task as { id: string }).id;
async function until(predicate: () => boolean, budgetMs = 5_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
}

test("an exit during a run is sent as steer without waiting for the run to end", async () => {
	await host.dispatch("agent_start");
	const before = exitCalls().length;
	const id = await spawn("printf 'in-run\\n'");
	await host.settledTask(id);
	await until(() => exitCalls().length > before);

	const [message, options] = exitCalls()[before]!;
	expect(JSON.stringify(message), "the wake names its task").toContain(id);
	expect(options, "a run in flight queues it as steer").toMatchObject({ deliverAs: "steer", triggerTurn: true });
	await bgTask().execute("c", { action: "get", id });
});

test("tasks finishing inside the batch window share one steer message", async () => {
	await host.dispatch("agent_start");
	const before = exitCalls().length;
	const ids = [await spawn("printf 'a\\n'"), await spawn("sleep 0.15; printf 'b\\n'")];
	for (const id of ids) await host.settledTask(id);
	await until(() => exitCalls().length > before);
	await Bun.sleep(400);

	const delivered = exitCalls().slice(before);
	expect(delivered, "one grouped message, not one per task").toHaveLength(1);
	const [message, options] = delivered[0]!;
	for (const id of ids) expect(JSON.stringify(message), `${id} is named by the group`).toContain(id);
	expect(options).toMatchObject({ deliverAs: "steer", triggerTurn: true });
	for (const id of ids) await bgTask().execute("c", { action: "get", id });
});

test("retrieving a result inside the window drops the wake the agent no longer needs", async () => {
	const before = exitCalls().length;
	// A running sibling keeps the exit inside the window.
	const sibling = await spawn("sleep 30");
	const id = await spawn("printf 'read-first\\n'");
	await host.settledTask(id);
	await bgTask().execute("c", { action: "get", id });
	await bgTask().execute("c", { action: "stop", id: sibling });
	await Bun.sleep(600);

	const named = exitCalls().slice(before).filter(([message]) => JSON.stringify(message).includes(`"id":"${id}"`));
	expect(named, "the retrieval was the delivery; no wake follows it").toHaveLength(0);
});

test("a lone task is delivered at once, not after the idle window", async () => {
	await host.settle();
	const before = exitCalls().length;
	const id = await spawn("printf 'lone\\n'");
	await host.settledTask(id);
	await until(() => exitCalls().length > before, 1_500);
	expect(exitCalls().length, "no sibling is running, so the 5 s idle window does not apply").toBe(before + 1);
	await bgTask().execute("c", { action: "get", id });
});

test("the idle window holds an exit only while a sibling is still running", async () => {
	await host.settle();
	const before = exitCalls().length;
	const quick = await spawn("printf 'quick\\n'");
	const slow = await spawn("sleep 1.2; printf 'slow\\n'");
	await host.settledTask(quick);
	await Bun.sleep(500);
	expect(exitCalls().length, "the quick exit waits for the sibling that may finish with it").toBe(before);
	await host.settledTask(slow);
	await until(() => exitCalls().length > before, 1_500);
	const delivered = exitCalls().slice(before);
	expect(delivered, "the last exit releases the group as one message").toHaveLength(1);
	for (const id of [quick, slow]) expect(JSON.stringify(delivered[0])).toContain(id);
	for (const id of [quick, slow]) await bgTask().execute("c", { action: "get", id });
});
