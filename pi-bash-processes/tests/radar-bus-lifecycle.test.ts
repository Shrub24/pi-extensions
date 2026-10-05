import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startExtensionHost } from "./fixtures/extension-host.js";

// The Radar bus through the real extension (openspec `bash-processes-radar-bus`):
// a live unix server stands in for Radar while this session spawns, finishes and
// retrieves real tasks. The wire shape itself is Radar's v1 contract, checked
// against the vendored fixture in extensions/__tests__/radar-bus.test.ts; this
// file checks the sequence a real session produces and the order it produces it
// in — including that publishing resolves nothing.
process.env.HERDR_PANE_ID = "radar-bus-life";

const dir = mkdtempSync(join(tmpdir(), "radar-bus-lifecycle-"));
const socketPath = join(dir, "radar.sock");
/** Every line Radar received, tagged with the connection that carried it. */
const received: { connection: number; message: any }[] = [];
let connections = 0;
let closedConnections = 0;
const server: Server = createServer((connection: Socket) => {
	const id = ++connections;
	let buffer = "";
	connection.on("close", () => {
		closedConnections += 1;
	});
	connection.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let index: number;
		while ((index = buffer.indexOf("\n")) >= 0) {
			received.push({ connection: id, message: JSON.parse(buffer.slice(0, index)) });
			buffer = buffer.slice(index + 1);
		}
	});
});
await new Promise<void>((resolve, reject) => {
	server.once("error", reject);
	server.listen(socketPath, () => resolve());
});
const host = await startExtensionHost({ mode: "tui" });
// The host fixture points RADAR_SOCKET at its own scratch path; this session
// publishes to this test's listener instead. The extension resolves the socket
// when it first has something to publish, so setting it after the host starts
// is still before this session's first task.
process.env.RADAR_SOCKET = socketPath;
afterAll(async () => {
	delete process.env.HERDR_PANE_ID;
	await host.dispose();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(dir, { recursive: true, force: true });
});

/** Bounded harness wait; never part of the product surface. */
async function until(predicate: () => boolean, budgetMs = 5_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
	expect(predicate()).toBe(true);
}

const linesOn = (connection: number): any[] =>
	received.filter((line) => line.connection === connection).map((line) => line.message);
const tasksOn = (connection: number): any[] => linesOn(connection).filter((message) => message.type === "tasks");
const stateOf = (message: any, id: string): string | undefined =>
	message.tasks.find((task: any) => task.id === id)?.state;

const spawn = async (command: string): Promise<string> => {
	const result = await host.tools.get("bg_task")!.execute("radar-bus-spawn", { action: "spawn", command });
	return (result.details.task as { id: string }).id;
};
const recordFor = async (id: string) => (await host.listTasks()).find((task) => task.id === id);

test("a real session publishes hello, running with its counters, review with the exit code, then the empty list", async () => {
	const command = "for i in 1 2 3 4 5 6 7 8 9 10; do echo line-$i; sleep 0.1; done";
	const id = await spawn(command);

	await until(() => tasksOn(1).some((message) => stateOf(message, id) === "running"));
	expect(linesOn(1)[0], "hello comes first, with the session and the pane").toEqual({
		type: "hello",
		v: 1,
		session: host.ctx.sessionManager.getSessionId(),
		pane: "radar-bus-life",
		ops: [],
	});
	expect(linesOn(1).every((message) => message.type === "hello" || message.type === "tasks")).toBe(true);
	// Counter movement while the task runs: the pane tokens carry no counters, so
	// the bus can only have this from the output path.
	await until(() => tasksOn(1).some((message) => (message.tasks[0]?.output_bytes ?? 0) > 0));

	await host.settledTask(id);
	await until(() => tasksOn(1).some((message) => stateOf(message, id) === "flushing"));
	await until(() => tasksOn(1).some((message) => stateOf(message, id) === "review"));
	const states = tasksOn(1).map((message) => stateOf(message, id));
	const at = (state: string) => states.indexOf(state);
	expect(at("flushing"), "the exit is published before the capture is certified").toBeGreaterThan(at("running"));
	expect(at("review")).toBeGreaterThan(at("flushing"));
	const review = tasksOn(1).find((message) => stateOf(message, id) === "review").tasks[0];
	expect(review).toMatchObject({ id, state: "review", exit_code: 0 });
	// The row's label: the real command and its working directory, and no log path.
	expect(review.command).toBe(command);
	expect(review.cwd).toBe(join(host.root, "work"));
	expect(review.log_file).toBeUndefined();
	// The protocol's timestamps are Unix milliseconds; a seconds value would read
	// as 1970 here and never trip a shape check.
	expect(Date.now() - review.started_at, "started_at is Unix milliseconds").toBeLessThan(60_000);
	expect(Date.now() - review.last_output_at, "last_output_at is Unix milliseconds").toBeLessThan(60_000);
	expect(connections, "one connection for the session").toBe(1);
	expect((await recordFor(id))?.resultResolution, "publishing resolves nothing").toBeUndefined();

	await host.tools.get("bg_task")!.execute("radar-bus-get", { action: "get", id });
	await until(() => tasksOn(1).at(-1).tasks.length === 0);
	expect(connections, "the empty list keeps the connection").toBe(1);
	expect((await recordFor(id))?.resultResolution, "reading the result is what resolves it").toBe("delivered");
});

test("a new session id is a new connection with its own hello and full list", async () => {
	const before = connections;
	const next = "0f0f0f0f-1111-4222-8333-444455556666";
	(host.ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => next;
	await host.dispatch("session_start");
	await Bun.sleep(50);
	expect(connections, "a session with nothing outstanding opens no connection").toBe(before);

	const id = await spawn("printf 'second session\\n'");
	await until(() => connections === before + 1);
	await until(() => tasksOn(before + 1).some((message) => stateOf(message, id) === "running"));
	expect(linesOn(before + 1)[0], "the new connection introduces the new session").toEqual({
		type: "hello",
		v: 1,
		session: next,
		pane: "radar-bus-life",
		ops: [],
	});
	expect(tasksOn(before + 1)[0].tasks).toMatchObject([{ id, state: "running" }]);
});

test("session_shutdown closes the connection", async () => {
	const open = connections - closedConnections;
	expect(open, "the session still holds the connection this test closes").toBeGreaterThan(0);
	await host.dispatch("session_shutdown");
	await until(() => closedConnections === connections);
});
