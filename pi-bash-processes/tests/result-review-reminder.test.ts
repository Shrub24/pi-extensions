// A finished result the agent has not retrieved is reminded once, when the agent
// goes idle: a single concise message that starts no turn, never repeated and
// never re-armed by a restart.

import { afterAll, expect, test } from "bun:test";

import { startExtensionHost, type ExtensionHost, type HostTool } from "./fixtures/extension-host.js";

const host: ExtensionHost = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const bgTask = (): HostTool => host.tools.get("bg_task")!;
const reviews = () =>
	host.messages.filter(([message]) => (message as { details?: { eventType?: string } })?.details?.eventType === "result-review");

async function finished(command: string): Promise<string> {
	const spawned = await bgTask().execute("review", { action: "spawn", command, softTimeoutMs: 300 });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	return id;
}

test("an unretrieved result is reminded once at idle, as a message that starts no turn", async () => {
	await host.dispatch("before_agent_start");
	const id = await finished("printf 'unread\\n'");
	await Bun.sleep(500);
	expect(reviews(), "no interval fires for a finished task, and nothing is sent mid-run").toHaveLength(0);

	await host.settle();
	expect(reviews(), "the first idle follows the run its completion wake started: nothing to add").toHaveLength(0);
	await host.dispatch("before_agent_start");
	await host.settle();
	expect(reviews(), "a later idle with the result still unread sends the one advisory").toHaveLength(1);
	const [message, options] = reviews()[0]!;
	expect(JSON.stringify(message)).toContain(`${id} · exit 0`);
	expect(JSON.stringify(message), "the retrieval instruction is stated once, not per task").toContain('Retrieve a result with bg_task action:\\"get\\" id: <id>');
	expect(options, "it costs no model turn of its own").toMatchObject({ triggerTurn: false });

	await host.settle();
	await Bun.sleep(400);
	expect(reviews(), "never repeated, by idle or by interval").toHaveLength(1);

	await host.dispatch("session_start");
	await host.settle();
	expect(reviews(), "a restart does not re-arm it").toHaveLength(1);
	expect((await host.listTasks()).find((task) => task.id === id)?.resultResolution, "a reminder resolves nothing").toBeUndefined();
});

test("a result retrieved before idle is not reminded", async () => {
	const before = reviews().length;
	const id = await finished("printf 'read\\n'");
	await bgTask().execute("review-get", { action: "get", id });
	await host.settle();
	await host.dispatch("before_agent_start");
	await host.settle();
	expect(reviews().length).toBe(before);
});
