import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startExtensionHost } from "./fixtures/extension-host.js";

// The pane-facts gate: a session that is not a TUI never writes to a pane, even
// inside Herdr. Print mode is the conservative default a headless/child session
// runs in. The Radar bus is not pane-gated — it follows the Pi session and
// joins by session UUID — so this file pins both halves of that difference.
process.env.HERDR_PANE_ID = "pane-gating-test";

const dir = mkdtempSync(join(tmpdir(), "radar-bus-gating-"));
const socketPath = join(dir, "radar.sock");
const lines: string[] = [];
const server: Server = createServer((connection: Socket) => {
	let buffer = "";
	connection.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let index: number;
		while ((index = buffer.indexOf("\n")) >= 0) {
			lines.push(buffer.slice(0, index));
			buffer = buffer.slice(index + 1);
		}
	});
});
await new Promise<void>((resolve, reject) => {
	server.once("error", reject);
	server.listen(socketPath, () => resolve());
});

const host = await startExtensionHost({ mode: "print" });
// The host fixture points RADAR_SOCKET at its own scratch path; this session
// publishes to this test's listener instead.
process.env.RADAR_SOCKET = socketPath;
afterAll(async () => {
	delete process.env.HERDR_PANE_ID;
	await host.dispose();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(dir, { recursive: true, force: true });
});

const messages = () => lines.map((line) => JSON.parse(line));

test("a non-TUI session publishes nothing even with a pane id", async () => {
	const result = await host.tools.get("bg_task")!.execute("pane-facts-gating", { action: "spawn", command: "printf 'headless\\n'" });
	const id = (result.details.task as { id: string }).id;
	await host.settledTask(id);
	expect(host.execCalls.filter(({ command }) => command === "herdr")).toHaveLength(0);
});

test("the same non-TUI session still publishes its tasks on the bus", async () => {
	const result = await host.tools.get("bg_task")!.execute("bus-gating-spawn", { action: "spawn", command: "printf 'headless bus\\n'; sleep 2" });
	const id = (result.details.task as { id: string }).id;
	const named = () => messages().find((message) => message.type === "tasks" && message.tasks.some((task: any) => task.id === id));
	const deadline = Date.now() + 5_000;
	while (named() === undefined && Date.now() < deadline) await Bun.sleep(5);
	expect(messages()[0], "the bus follows the session, not the pane").toEqual({
		type: "hello",
		v: 1,
		session: host.ctx.sessionManager.getSessionId(),
		pane: "pane-gating-test",
		ops: [],
	});
	expect(named().tasks.find((task: any) => task.id === id)).toMatchObject({ id, state: "running" });
	expect(host.execCalls.filter(({ command }) => command === "herdr"), "and writes no pane token").toHaveLength(0);
});
