import { afterAll, expect, test } from "bun:test";

import { startExtensionHost } from "./fixtures/extension-host.js";

// A chunk the pattern rejected has been examined; it must not be examined again
// when later output arrives. The observable effect is the wake a later match
// sends: it carries the output that arrived since the last examination, not the
// whole run of rejected output that came before it.
const host = await startExtensionHost({ settings: { outputSettleMs: 50, exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const outputWakes = () =>
	host.messages
		.map(([message]) => message as { details?: { eventType?: string } })
		.filter((message) => message?.details?.eventType === "output");

test("a match after rejected output wakes with the new output only", async () => {
	const spawned = await host.tools.get("bg_task")!.execute("cursor-1", {
		action: "spawn",
		command: "printf 'noise-one\\n'; sleep 0.4; printf 'noise-two\\n'; sleep 0.4; printf 'READY\\n'; sleep 0.4",
		notifyOnOutput: true,
		notifyOnExit: false,
		notifyPattern: "READY",
	});
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);

	const woken = outputWakes();
	expect(woken, "the matching chunk produced exactly one output wake").toHaveLength(1);
	const tail = (woken[0] as { details: { outputTail: string } }).details.outputTail;
	expect(tail).toContain("READY");
	expect(tail, "rejected output is not re-delivered with the match").not.toContain("noise-one");
});
