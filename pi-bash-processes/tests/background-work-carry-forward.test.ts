// A worker resumed for a new assignment must not be locked out by the finished,
// unread results of its previous one. Finished work of an earlier request is
// history awaiting review, so binding carries it into the new assignment where
// it stays outstanding until it is actually retrieved. Live work and work that
// belongs to no request still block, and nothing is cleared silently.

import { afterAll, expect, test } from "bun:test";

import { startExtensionHost, type ExtensionHost } from "./fixtures/extension-host.js";
import { bindBackgroundWorkAssignment, queryBackgroundWorkSnapshot } from "../extensions/background-work.js";

const host: ExtensionHost = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const SESSION = `extension-host-${process.pid}`;
const scope = (requestId: string) => ({ sessionId: SESSION, requestId });
const bgTask = () => host.tools.get("bg_task")!;
const listed = async (id: string) => (await host.listTasks()).find((task) => task.id === id);
const spawn = async (command: string): Promise<string> => {
	const spawned = await bgTask().execute("carry-spawn", { action: "spawn", command });
	return (spawned.details.task as { id: string }).id;
};
const outstanding = (requestId: string) => {
	const result = queryBackgroundWorkSnapshot(host.events, scope(requestId));
	if (result.state !== "ready") throw new Error(`expected ready, received ${JSON.stringify(result)}`);
	return result.snapshot.outstanding;
};

test("a finished unread result of an earlier request is carried into the next assignment, then retired by retrieval", async () => {
	await host.dispatch("before_agent_start");
	expect(bindBackgroundWorkAssignment(host.events, scope("req-first"))).toStrictEqual({ state: "bound" });
	const id = await spawn("printf 'first\\n'");
	await host.settledTask(id);
	expect((await listed(id))?.resultResolution, "nothing has retrieved it").toBeUndefined();

	expect(bindBackgroundWorkAssignment(host.events, scope("req-second"))).toStrictEqual({ state: "bound" });
	expect(outstanding("req-second"), "carried work stays outstanding, never cleared").toStrictEqual([
		{ taskId: id, state: "awaiting-result-review", reason: expect.any(String) },
	]);
	expect((await listed(id))?.resultResolution, "carrying resolves nothing").toBeUndefined();

	await bgTask().execute("carry-get", { action: "get", id });
	expect((await listed(id))?.resultResolution).toBe("delivered");
	expect(outstanding("req-second")).toStrictEqual([]);
});

test("a still-running task of an earlier request keeps blocking the next bind", async () => {
	expect(bindBackgroundWorkAssignment(host.events, scope("req-third"))).toStrictEqual({ state: "bound" });
	const id = await spawn("sleep 1");
	const refused = bindBackgroundWorkAssignment(host.events, scope("req-fourth"));
	if (refused.state !== "refused") throw new Error(`expected refused, received ${JSON.stringify(refused)}`);
	expect(refused.reason).toContain(id);
	await host.settledTask(id);
	await bgTask().execute("carry-running-get", { action: "get", id });
});
