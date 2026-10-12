// The session-wide blocking-work read, through the real extension on Pi's shared
// bus: the payload is the same `{ respond }` shape pi-herdsman emits, and an
// unanswered query is unknown. A running task blocks; once it has stopped, its
// certified unread result is advisory and does not.

import { afterAll, expect, test } from "bun:test";

import { startExtensionHost, type ExtensionHost } from "./fixtures/extension-host.js";
import { SESSION_OUTSTANDING_CHANNEL } from "../extensions/background-work.js";

const host: ExtensionHost = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const outstanding = (): number | undefined => {
	let count: number | undefined;
	host.events.emit(SESSION_OUTSTANDING_CHANNEL, { respond: (value: number) => (count = value) });
	return count;
};

test("an empty restored session answers zero", () => {
	expect(outstanding()).toBe(0);
});

test("a running task blocks the session until it is stopped and delivered", async () => {
	await host.dispatch("before_agent_start");
	const spawned = await host.tools.get("bg_task")!.execute("session-outstanding-spawn", { action: "spawn", command: "sleep 30" });
	const id = (spawned.details.task as { id: string }).id;
	expect(outstanding()).toBe(1);

	await host.tools.get("bg_task")!.execute("session-outstanding-stop", { action: "stop", id });
	await host.settledTask(id);
	expect(outstanding()).toBe(0);
});

test("a finished result nobody has retrieved is advisory, not waiting", async () => {
	const spawned = await host.tools.get("bg_task")!.execute("session-outstanding-quick", { action: "spawn", command: "true" });
	const finished = await host.settledTask((spawned.details.task as { id: string }).id);
	expect(finished.resultResolution, "no get was made, so the result is unretrieved").toBeUndefined();
	expect(outstanding()).toBe(0);
});
