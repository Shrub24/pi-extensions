// Clearing and dismissing (openspec `background-unread-results` tasks 1.1-1.2).
//
// `clear` has two modes and both are explicit. A targeted clear removes a
// finished result that was already handed over, and *dismisses* one that was
// never retrieved, recording a deliberate discard as its own resolution kind.
// A bulk clear keeps what is still owed and says so. Running work is never
// reachable from either mode.

import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { startExtensionHost, type ExtensionHost, type HostTool } from "./fixtures/extension-host.js";
import { bindBackgroundWorkAssignment, queryBackgroundWorkSnapshot } from "../extensions/background-work.js";

const SESSION = `extension-host-${process.pid}`;
const scope = (requestId: string) => ({ sessionId: SESSION, requestId });

const hosts: ExtensionHost[] = [];
afterAll(() => Promise.all(hosts.map((host) => host.dispose())));

/** Each test gets its own session state: an unresolved leftover would refuse a later bind. */
async function freshHost(): Promise<{ host: ExtensionHost; bgTask: () => HostTool; listed: (id: string) => Promise<Record<string, any> | undefined> }> {
	const host = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
	hosts.push(host);
	await host.dispatch("before_agent_start");
	return {
		host,
		bgTask: () => host.tools.get("bg_task")!,
		listed: async (id: string) => (await host.listTasks()).find((task) => task.id === id),
	};
}

const outstandingOf = (host: ExtensionHost, requestId: string) => {
	const result = queryBackgroundWorkSnapshot(host.events, scope(requestId));
	if (result.state === "ready" || result.state === "reconciling") return result.snapshot.outstanding;
	return null;
};

test(
	"a targeted clear removes the named finished task and never touches running work",
	async () => {
	const { bgTask, listed, host } = await freshHost();
	const spawnSettled = async (label: string): Promise<string> => {
		const spawned = await bgTask().execute(label, { action: "spawn", command: `printf '${label}\\n'` });
		const id = (spawned.details.task as { id: string }).id;
		await host.settledTask(id);
		return id;
	};
	const [first, second, third] = [await spawnSettled("clear-first"), await spawnSettled("clear-second"), await spawnSettled("clear-third")];
	// The named task's result is handed over first, so this clear is a removal.
	await bgTask().execute("clear-second-get", { action: "get", id: second });
	const running = (await bgTask().execute("clear-running", { action: "spawn", command: "sleep 30" })).details.task as { id: string };

	const cleared = await bgTask().execute("clear-one", { action: "clear", ids: [second] });
	expect(cleared.content[0]?.text ?? "", "the clear reports what it removed").toContain("Removed 1");

	expect(await listed(second), "the named task is gone").toBeUndefined();
	expect(await listed(first), "an unnamed finished task survives").toBeTruthy();
	expect(await listed(third), "and so does every other one").toBeTruthy();
	expect(await listed(running.id), "running work is never cleared").toBeTruthy();
	expect((await listed(running.id))?.status, "and it is still running").toBe("running");

	await bgTask().execute("clear-stop", { action: "stop", id: running.id });
	},
	60_000,
);

test(
	"a dismissed result is its own resolution kind, retires the obligation, and stays on record",
	async () => {
	const { bgTask, listed, host } = await freshHost();
	expect(bindBackgroundWorkAssignment(host.events, scope("req-dismiss"))).toStrictEqual({ state: "bound" });
	const spawnSettled = async (label: string): Promise<string> => {
		const spawned = await bgTask().execute(label, { action: "spawn", command: `printf '${label}\\n'` });
		const id = (spawned.details.task as { id: string }).id;
		await host.settledTask(id);
		return id;
	};
	const delivered = await spawnSettled("dismiss-delivered");
	const dismissed = await spawnSettled("dismiss-dismissed");
	// The delivered one is the control: a dismissal must be told apart from it.
	await bgTask().execute("dismiss-get", { action: "get", id: delivered });
	expect((await listed(delivered))?.resultResolution).toBe("delivered");
	expect(outstandingOf(host, "req-dismiss"), "a retrieval retires its obligation").toStrictEqual([
		{ taskId: dismissed, state: "awaiting-result-review", reason: expect.stringContaining("awaiting an actual result handoff") },
	]);

	const cleared = await bgTask().execute("dismiss-one", { action: "clear", ids: [dismissed] });
	const text = cleared.content[0]?.text ?? "";
	expect(text, "the dismissal is reported as a dismissal").toContain("Dismissed 1");
	expect(text, "and never as a handoff").not.toContain("retrieved");
	const record = await listed(dismissed);
	expect(record?.resultResolution, "a deliberate discard is not a delivery or a capture error").toBe("dismissed");
	expect(record, "the row is kept for the retention window, not deleted on the spot").toBeTruthy();
	expect(existsSync(String(record?.logFile)), "and so is the captured output it referred to").toBe(true);
	expect(outstandingOf(host, "req-dismiss"), "a dismissed result is no longer outstanding").toStrictEqual([]);

	// A dismissal aimed at running work is refused and changes nothing.
	const running = (await bgTask().execute("dismiss-running", { action: "spawn", command: "sleep 30" })).details.task as { id: string };
	await bgTask().execute("dismiss-running-clear", { action: "clear", ids: [running.id] });
	const untouched = await listed(running.id);
	expect(untouched?.status, "running work is refused a dismissal").toBe("running");
	expect(untouched?.resultResolution, "and records nothing").toBeUndefined();

	await bgTask().execute("dismiss-stop", { action: "stop", id: running.id });
	},
	60_000,
);
