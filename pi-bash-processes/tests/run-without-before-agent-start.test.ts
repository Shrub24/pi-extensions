import { afterAll, expect, test } from "bun:test";

import { startExtensionHost } from "./fixtures/extension-host.js";

// A run Pi starts without `before_agent_start` (a follow-up, or a peer
// extension's trigger-turn wake) is still a run in flight: an exit during it is
// held, and reading the task consumes it. Otherwise the exit is sent as a
// follow-up the agent has already acted on.
const host = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const exits = () => host.messages.filter(([message]) => (message as { details?: { eventType?: string } })?.details?.eventType === "exit");

test("an exit during a run that began at agent_start is held, and a stop of the finished task consumes it", async () => {
	await host.dispatch("agent_start");
	const spawned = await host.tools.get("bg_task")!.execute("c1", { action: "spawn", command: "printf 'done\\n'" });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	expect(exits(), "the exit is held while the run is in flight").toHaveLength(0);

	await host.tools.get("bg_task")!.execute("c2", { action: "stop", id });
	await host.dispatch("agent_end");
	await host.dispatch("agent_settled");
	expect(exits(), "the agent already read the result, so no wake follows").toHaveLength(0);
});
