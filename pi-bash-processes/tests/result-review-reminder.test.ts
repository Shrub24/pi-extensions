// The review reminder outlives the process (openspec `background-unread-results`
// task 1.3). A terminal result nobody retrieved is still owed after a restart, so
// the interval the live task was carrying is re-armed for the result it left
// behind, and the reminder names both ways out.

import { afterAll, expect, test } from "bun:test";

import { startExtensionHost, type ExtensionHost, type HostTool } from "./fixtures/extension-host.js";

const host: ExtensionHost = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0 } });
afterAll(() => host.dispose());

const bgTask = (): HostTool => host.tools.get("bg_task")!;
const reviewWakes = (): string[] =>
	host.messages
		.map((call) => call[0] as { content?: unknown; details?: { eventType?: string } })
		.filter((message) => message?.details?.eventType === "result-review")
		.map((message) => String(message.content ?? ""));

async function until(predicate: () => boolean, budgetMs = 5_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
}

test("a restored terminal result re-arms the reminder for the output it owes", async () => {
	await host.dispatch("before_agent_start");
	// A short interval, so the restored deadline is already behind the restart.
	const spawned = await bgTask().execute("restore-review", { action: "spawn", command: "printf 'restored\\n'", softTimeoutMs: 300 });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	expect(reviewWakes(), "an unretrieved result is not reminded before its interval elapses").toStrictEqual([]);

	// A restart replays the branch: the finished task comes back with its
	// interval, and its result is still unread.
	await host.dispatch("session_start");
	await until(() => reviewWakes().length > 0);
	const reminder = reviewWakes()[0] ?? "";
	expect(reminder, "the restored result is reminded").toContain(`${id} finished, and its result is still unretrieved`);
	expect(reminder, "and the reminder says what it owes").toContain(`bg_task action:"get" id: ${id}`);
	expect(reminder, "including the way to settle it without reading it").toContain(`bg_task action:"clear" ids:["${id}"]`);
	expect((await host.listTasks()).find((task) => task.id === id)?.resultResolution, "the reminder is not a resolution").toBeUndefined();
});
