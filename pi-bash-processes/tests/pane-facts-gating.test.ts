import { afterAll, expect, test } from "bun:test";

import { startExtensionHost } from "./fixtures/extension-host.js";

// The pane-facts gate: a session that is not a TUI never writes to a pane, even
// inside Herdr. Print mode is the conservative default a headless/child session
// runs in.
process.env.HERDR_PANE_ID = "pane-gating-test";
const host = await startExtensionHost({ mode: "print" });
afterAll(async () => {
	delete process.env.HERDR_PANE_ID;
	await host.dispose();
});

test("a non-TUI session publishes nothing even with a pane id", async () => {
	const result = await host.tools.get("bg_task")!.execute("pane-facts-gating", { action: "spawn", command: "printf 'headless\\n'" });
	const id = (result.details.task as { id: string }).id;
	await host.settledTask(id);
	expect(host.execCalls.filter(({ command }) => command === "herdr")).toHaveLength(0);
});
