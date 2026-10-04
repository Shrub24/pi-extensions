import { afterAll, expect, test } from "bun:test";

import { startExtensionHost } from "./fixtures/extension-host.js";

// A wake that starts an idle run must go through the prompt lifecycle.
// `pi.sendMessage(..., { triggerTurn: true })` starts that run without
// `before_agent_start` (earendil-works/pi#5581, #10267), so the run is never
// prepared with the system-prompt options every extension contributed and its
// second request rebuilds the prompt from base options, dropping those sections
// mid-run and re-billing the whole prompt. An idle session is therefore woken by
// a short user prompt, which runs `prompt()`; a busy session keeps its steer,
// where the run already carries prepared options.
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

test("an idle completion wake is appended, and a user prompt starts the run", async () => {
	const id = await runToExit("printf 'idle-wake\\n'");
	const exit = exitFor(id)!;
	// Appended with no delivery options: neither `triggerTurn` (which would skip
	// `before_agent_start`) nor a steer.
	expect(exit[1]).toStrictEqual({});
	// The run is started by the short user prompt, which goes through `prompt()`.
	expect(host.userMessages).toHaveLength(1);
	expect(String(host.userMessages[0]?.[0])).toContain("background task notification");
	expect(host.userMessages[0]?.[1]).toBeUndefined();
});

test("a busy session keeps the triggerTurn steer and starts no user prompt", async () => {
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
