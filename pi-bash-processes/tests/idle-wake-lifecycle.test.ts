import { afterAll, expect, test } from "bun:test";

import { startExtensionHost } from "./fixtures/extension-host.js";

// Pi 1.2.0 runs triggerTurn wakes through before_agent_start, so idle and busy
// deliveries can use the same native message path.
//
// One host per file: the host environment is process-wide, so the idle state is
// flipped in place for the busy control instead of starting a second host.
const host = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const execute = (params: Record<string, unknown>) => host.tools.get("bg_task")!.execute("idle-wake-call", params);
const eventMessages = (type: string) =>
	host.messages.filter(([message]) => (message as { details?: { eventType?: string } })?.details?.eventType === type);
const exitFor = (id: string) =>
	eventMessages("exit").find(([message]) => JSON.stringify(message).includes(id));

/** Bounded harness wait; never part of the product surface. */
async function until(predicate: () => boolean, budgetMs = 15_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
}

async function runToExit(command: string): Promise<string> {
	const spawned = await execute({ action: "spawn", command, notifyOnExit: true });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	await until(() => Boolean(exitFor(id)));
	return id;
}

test("an idle completion wake starts a prepared triggerTurn run", async () => {
	const id = await runToExit("printf 'idle-wake\\n'");
	const exit = exitFor(id)!;
	expect(exit[1]).toMatchObject({ triggerTurn: true });
	expect(host.userMessages).toHaveLength(0);
});

test("a busy session keeps its existing triggerTurn delivery", async () => {
	host.setIdle(() => false);
	try {
		const before = host.userMessages.length;
		const id = await runToExit("printf 'busy-wake\\n'");
		expect(exitFor(id)![1]).toMatchObject({ triggerTurn: true });
		expect(host.userMessages.length, "a busy run already carries prepared options").toBe(before);
	} finally {
		host.setIdle(() => true);
	}
});
