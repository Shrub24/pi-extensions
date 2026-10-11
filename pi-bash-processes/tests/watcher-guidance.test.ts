import { afterAll, expect, test } from "bun:test";

import { startExtensionHost } from "./fixtures/extension-host.js";
import { fakeTask } from "./fixtures/lifecycle.js";
import { sendDeps } from "./fixtures/wake.js";
import { sendTaskWake } from "../extensions/wake-events.js";
import { WAKE_CONSUMER_OFFER, type WakeConsumerEventBus, type WakeConsumerOffer } from "../extensions/wake-consumer.js";

// The per-task watcher instruction is producer-side data: the tool stores it,
// an extend replaces it only when it is given one, and the soft reminder hands
// it to whichever consumer is listening. Nothing here decides a wake itself.
const host = await startExtensionHost();
afterAll(() => host.dispose());

const execute = (params: Record<string, unknown>) => host.tools.get("bg_task")!.execute("watcher-call", params);
const listed = async (id: string): Promise<Record<string, any> | undefined> => (await host.listTasks()).find((task) => task.id === id);

test("spawn stores watcher guidance and an extend replaces it only when given one", async () => {
	const spawned = await execute({
		action: "spawn",
		command: "sleep 30",
		softTimeoutMs: 60_000,
		watcherGuidance: "  Only wake me if this is blocked.  ",
	});
	const id = spawned.details.task.id as string;
	expect((await listed(id))?.watcherGuidance).toBe("Only wake me if this is blocked.");

	// An extend that says nothing about the watcher moves only the window.
	await execute({ action: "extend", id, softTimeoutMs: 90_000 });
	expect((await listed(id))?.watcherGuidance).toBe("Only wake me if this is blocked.");

	await execute({ action: "extend", id, watcherGuidance: "Wake me on the first failed upload." });
	expect((await listed(id))?.watcherGuidance).toBe("Wake me on the first failed upload.");

	await execute({ action: "stop", id: "all" });
});

test("a soft reminder offers the task's watcher guidance, and offers none without one", () => {
	const offers: WakeConsumerOffer[] = [];
	const bus: WakeConsumerEventBus = {
		on: () => () => {},
		emit(channel, data) {
			if (channel === WAKE_CONSUMER_OFFER) offers.push(data as WakeConsumerOffer);
		},
	};
	const remind = (watcherGuidance?: string): void => {
		const task = fakeTask({ id: "bg-soft", status: "running", softTimeoutMs: 60_000, ...(watcherGuidance ? { watcherGuidance } : {}) });
		const { deps, messages } = sendDeps("partial output");
		sendTaskWake({ ...deps, advisoryBus: bus, sessionId: () => "session-1", isCurrent: () => true }, "soft-timeout", task);
		// With no consumer claiming, the reminder is still delivered as it always was.
		expect(messages).toHaveLength(1);
	};

	remind("Only wake me if this is blocked.");
	remind();

	expect(offers.map((offer) => [offer.source, offer.kind, offer.dispatchGuidance])).toStrictEqual([
		["pi-background-tasks", "soft-timeout", "Only wake me if this is blocked."],
		["pi-background-tasks", "soft-timeout", undefined],
	]);
});
