import { expect, test } from "bun:test";
import { taskSnapshot } from "../extensions/snapshot.js";
import { scheduleTaskWake, sendTaskWake } from "../extensions/wake-events.js";
import { fakeTask } from "./fixtures/lifecycle.js";
import { sendDeps } from "./fixtures/wake.js";

test("a task snapshot retains delivered wake metadata", () => {
	const task = fakeTask({ id: "bg-7", status: "running", notifyOnOutput: true, lastOutputAt: 1_555 });
	const pending = scheduleTaskWake(task, "output", 1_555);
	const { deps } = sendDeps();
	const sent = sendTaskWake(deps, "output", task, { eventAt: pending.eventAt, sequence: pending.sequence, newOutputTail: "ready\n" });
	expect({ sent, events: taskSnapshot(task).wakeEvents }).toStrictEqual({ sent: true, events: [{
		deliveredAt: 2_000, eventAt: 1_555, eventType: "output", sequence: 1, taskStatusAtEmit: "running",
	}] });
});
