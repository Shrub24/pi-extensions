import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BusSocket,
	type BusSourceTask,
	busTasks,
	createRadarBusPublisher,
	directoryIsTrusted,
	helloLine,
	radarSocketPath,
	tasksLine,
} from "../radar-bus.js";

const SESSION = "c1a2b3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
// A copy of agent-radar `docs/radar-bus.fixture.json` (contract v1), the file both
// sides test against. Re-copy it when Radar revises the contract.
const FIXTURE = join(import.meta.dir, "../../tests/fixtures/radar-bus.fixture.json");

const task = (id: string, extra: Partial<BusSourceTask> = {}): BusSourceTask => ({
	id,
	status: "running",
	startedAt: 1_000,
	pid: 4242,
	lastOutputAt: null,
	outputBytes: 0,
	exitCode: null,
	...extra,
});

const until = async (condition: () => boolean, ms = 2_000): Promise<void> => {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("condition not met");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

function listen(): { path: string; lines: string[]; connections: () => number; server: Server } {
	const dir = mkdtempSync(join(tmpdir(), "radar-bus-"));
	const path = join(dir, "radar.sock");
	const lines: string[] = [];
	let connections = 0;
	const server = createServer((connection) => {
		connections += 1;
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
	server.listen(path);
	cleanup.push(() => {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { path, lines, connections: () => connections, server };
}

const publisherFor = (path: string, extra: Parameters<typeof createRadarBusPublisher>[0] = {}) => {
	const publisher = createRadarBusPublisher({ env: { RADAR_SOCKET: path }, uid: 1, throttleMs: 40, ...extra });
	cleanup.push(() => publisher.close());
	return publisher;
};

test("the unresolved tasks are projected in the bus's vocabulary with absent fields omitted", () => {
	expect(
		busTasks([
			task("bg-1", { lastOutputAt: 5_000, outputBytes: 18_244 }),
			task("bg-2", { status: "completed", resultReady: false, exitCode: 0, pid: 9 }),
			task("bg-3", { status: "completed", resultReady: true, exitCode: 3, outputBytes: 65_536 }),
			task("bg-4", { status: "completed", resultReady: true, resultResolution: "delivered" }),
		]),
	).toEqual([
		{ id: "bg-1", state: "running", pid: 4242, started_at: 1_000, last_output_at: 5_000, output_bytes: 18_244 },
		{ id: "bg-2", state: "flushing", started_at: 1_000, output_bytes: 0, exit_code: 0 },
		{ id: "bg-3", state: "review", started_at: 1_000, output_bytes: 65_536, exit_code: 3 },
	]);
});

test("command and cwd are sent bounded, and no log path can reach a line", () => {
	const source = {
		...task("bg-1"),
		command: "curl -H 'token: hunter2'",
		cwd: "/home/me/secret",
		logFile: "/tmp/hunter2.log",
		title: "hunter2",
	} as BusSourceTask;
	const line = tasksLine(busTasks([source]));
	const sent = JSON.parse(line).tasks[0];
	expect(sent.command).toBe("curl -H 'token: hunter2'");
	expect(sent.cwd).toBe("/home/me/secret");
	expect(Object.keys(sent).sort()).toEqual(["command", "cwd", "id", "output_bytes", "pid", "started_at", "state"]);
	// Radar's obligation 6 bounds both, and a log path is never a field.
	expect(line).not.toContain("hunter2.log");
	const long = busTasks([{ ...task("bg-1"), command: "x".repeat(400), cwd: "/" + "y".repeat(400) } as BusSourceTask]);
	expect(long[0]!.command).toHaveLength(256);
	expect(long[0]!.cwd).toHaveLength(256);
	// A task without them omits them rather than sending an empty or null value.
	expect(Object.keys(busTasks([task("bg-1")])[0]!).sort()).toEqual(["id", "output_bytes", "pid", "started_at", "state"]);
});

test("every emitted line has the shape of Radar's published fixture", () => {
	const fixture = readFileSync(FIXTURE, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const hello = JSON.parse(helloLine(SESSION, "8c7d:p2"));
	expect(hello).toEqual(fixture[0]);
	expect(JSON.parse(helloLine(SESSION, undefined))).toEqual(fixture[1]);
	expect(JSON.parse(tasksLine([]))).toEqual(fixture.find((m: any) => m.type === "tasks" && m.tasks.length === 0));
	const full = fixture.find((m: any) => m.type === "tasks" && m.tasks.length === 3);
	// The fixture's review task carries the decided command/cwd, so both come from
	// Radar's published example rather than from a second copy of the strings here.
	const example = full.tasks.find((task: any) => task.state === "review");
	const built = JSON.parse(
		tasksLine(
			busTasks([
				task("bg-1", { startedAt: 1759218000123, lastOutputAt: 1759218074567, outputBytes: 18244, pid: 48213 }),
				task("bg-2", { status: "completed", resultReady: false, startedAt: 1759218010000, lastOutputAt: 1759218060000, outputBytes: 9917 }),
				task("bg-3", {
					status: "completed",
					resultReady: true,
					startedAt: 1759217900000,
					lastOutputAt: 1759218000000,
					outputBytes: 65536,
					exitCode: 0,
					command: example.command,
					cwd: example.cwd,
				}),
			]),
		),
	);
	expect(example.command, "the fixture carries the decided command/cwd").toBeDefined();
	expect(built.tasks[2]!.command).toBe(example.command);
	expect(built.tasks[2]!.cwd).toBe(example.cwd);
	// Same keys and types as the fixture; the fixture's pids on exited tasks are illustrative.
	for (const [index, expected] of full.tasks.entries()) {
		for (const key of Object.keys(built.tasks[index])) expect(typeof built.tasks[index][key]).toBe(typeof expected[key]);
		expect(built.tasks[index].state).toBe(expected.state);
	}
});

test("the socket path follows Radar's binding order", () => {
	expect(radarSocketPath({ RADAR_SOCKET: "/x/r.sock", XDG_RUNTIME_DIR: "/run/u" }, 7)).toEqual({ path: "/x/r.sock", trusted: true });
	expect(radarSocketPath({ XDG_RUNTIME_DIR: "/run/u" }, 7)).toEqual({ path: "/run/u/agent-radar/radar.sock", trusted: false });
	expect(radarSocketPath({}, 7)).toEqual({ path: "/tmp/agent-radar-7/radar.sock", trusted: false });
});

test("a directory is trusted only when owned, 0700 and not a symlink", () => {
	const root = mkdtempSync(join(tmpdir(), "radar-trust-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const uid = process.getuid!();
	const good = join(root, "good");
	mkdirSync(good, { mode: 0o700 });
	expect(directoryIsTrusted(good, uid)).toBe(true);
	expect(directoryIsTrusted(good, uid + 1)).toBe(false);
	const loose = join(root, "loose");
	mkdirSync(loose);
	require("node:fs").chmodSync(loose, 0o755);
	expect(directoryIsTrusted(loose, uid)).toBe(false);
	const link = join(root, "link");
	symlinkSync(good, link);
	expect(directoryIsTrusted(link, uid)).toBe(false);
	expect(directoryIsTrusted(join(root, "missing"), uid)).toBe(false);
});

test("an untrusted directory is never dialled", async () => {
	let dialled = 0;
	const publisher = createRadarBusPublisher({
		env: { XDG_RUNTIME_DIR: "/nonexistent" },
		uid: 1,
		trustedDirectory: () => false,
		dial: () => {
			dialled += 1;
			throw new Error("must not dial");
		},
	});
	cleanup.push(() => publisher.close());
	publisher.update(SESSION, undefined, busTasks([task("bg-1")]));
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(dialled).toBe(0);
});

test("a session that never has a task opens no connection", async () => {
	const server = listen();
	const publisher = publisherFor(server.path);
	publisher.update(SESSION, undefined, []);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(server.connections()).toBe(0);
});

test("hello, then the full list, then an explicit empty list on the same connection", async () => {
	const server = listen();
	const publisher = publisherFor(server.path);
	publisher.update(SESSION, "8c7d:p2", busTasks([task("bg-1")]));
	await until(() => server.lines.length >= 2);
	publisher.update(SESSION, "8c7d:p2", busTasks([task("bg-1"), task("bg-2", { startedAt: 2_000 })]));
	await until(() => server.lines.length >= 3);
	publisher.update(SESSION, "8c7d:p2", []);
	await until(() => server.lines.length >= 4);
	const messages = server.lines.map((line) => JSON.parse(line));
	expect(messages[0]).toEqual({ type: "hello", v: 1, session: SESSION, pane: "8c7d:p2", ops: [] });
	expect(messages[1].tasks.map((t: any) => t.id)).toEqual(["bg-1"]);
	expect(messages[2].tasks.map((t: any) => t.id)).toEqual(["bg-1", "bg-2"]);
	expect(messages[3]).toEqual({ type: "tasks", tasks: [] });
	expect(server.connections()).toBe(1);
});

test("counter-only churn is coalesced to the latest list per throttle window", async () => {
	const server = listen();
	const publisher = publisherFor(server.path);
	publisher.update(SESSION, undefined, busTasks([task("bg-1")]));
	await until(() => server.lines.length >= 2);
	for (let bytes = 1; bytes <= 50; bytes++) publisher.update(SESSION, undefined, busTasks([task("bg-1", { outputBytes: bytes })]));
	await until(() => server.lines.length >= 3);
	await new Promise((resolve) => setTimeout(resolve, 120));
	const sent = server.lines.slice(2).map((line) => JSON.parse(line));
	expect(sent.length).toBeLessThanOrEqual(2);
	expect(sent.at(-1).tasks[0].output_bytes).toBe(50);
});

test("a state change goes out promptly, not after the throttle window", async () => {
	const server = listen();
	const publisher = publisherFor(server.path, { throttleMs: 60_000 });
	publisher.update(SESSION, undefined, busTasks([task("bg-1")]));
	await until(() => server.lines.length >= 2);
	publisher.update(SESSION, undefined, busTasks([task("bg-1", { status: "completed", resultReady: false, exitCode: 0 })]));
	await until(() => server.lines.length >= 3, 500);
	expect(JSON.parse(server.lines[2]!).tasks[0].state).toBe("flushing");
});

test("a state change is not held behind a pending counter window", async () => {
	const server = listen();
	const publisher = publisherFor(server.path, { throttleMs: 60_000 });
	publisher.update(SESSION, undefined, busTasks([task("bg-1")]));
	await until(() => server.lines.length >= 2);
	// A counter move parks a message in the throttle window...
	publisher.update(SESSION, undefined, busTasks([task("bg-1", { outputBytes: 10 })]));
	// ...and the exit that follows must not wait for it.
	publisher.update(SESSION, undefined, busTasks([task("bg-1", { status: "completed", resultReady: false, outputBytes: 10, exitCode: 3 })]));
	await until(() => server.lines.length >= 3, 500);
	expect(JSON.parse(server.lines[2]!).tasks[0]).toMatchObject({ state: "flushing", output_bytes: 10, exit_code: 3 });
});

test("a new Pi session id is a new connection with its own hello and full list", async () => {
	const server = listen();
	const publisher = publisherFor(server.path);
	publisher.update(SESSION, undefined, busTasks([task("bg-1")]));
	await until(() => server.lines.length >= 2);
	const next = "0f0f0f0f-0000-4000-8000-000000000000";
	publisher.update(next, undefined, busTasks([task("bg-1")]));
	await until(() => server.connections() === 2 && server.lines.length >= 4);
	expect(JSON.parse(server.lines[2]!)).toMatchObject({ type: "hello", session: next });
	expect(JSON.parse(server.lines[3]!).tasks).toHaveLength(1);
});

test("Radar absent or refusing never throws, and retries only while tasks are outstanding", async () => {
	const dir = mkdtempSync(join(tmpdir(), "radar-absent-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	let attempts = 0;
	const publisher = createRadarBusPublisher({
		env: { RADAR_SOCKET: join(dir, "none.sock") },
		uid: 1,
		reconnectMinMs: 10,
		reconnectMaxMs: 20,
		dial: (path) => {
			attempts += 1;
			return require("node:net").createConnection(path) as BusSocket;
		},
	});
	cleanup.push(() => publisher.close());
	expect(() => publisher.update(SESSION, undefined, busTasks([task("bg-1")]))).not.toThrow();
	await until(() => attempts >= 3);
	publisher.update(SESSION, undefined, []);
	await new Promise((resolve) => setTimeout(resolve, 40));
	const settled = attempts;
	await new Promise((resolve) => setTimeout(resolve, 80));
	expect(attempts).toBe(settled);
});

test("a peer that stops reading holds only the latest list", async () => {
	const written: string[] = [];
	let drain: (() => void) | undefined;
	let needDrain = false;
	const socket: BusSocket = {
		write: (line) => {
			written.push(line);
			return true;
		},
		end: () => undefined,
		destroy: () => undefined,
		on: (event, listener) => {
			if (event === "connect") queueMicrotask(listener);
			if (event === "drain") drain = listener;
		},
		get writableNeedDrain() {
			return needDrain;
		},
	};
	const publisher = createRadarBusPublisher({ env: { RADAR_SOCKET: "/x" }, uid: 1, dial: () => socket, throttleMs: 0 });
	cleanup.push(() => publisher.close());
	publisher.update(SESSION, undefined, busTasks([task("bg-1")]));
	await until(() => written.length === 2);
	needDrain = true;
	for (let index = 0; index < 100; index++) publisher.update(SESSION, undefined, busTasks([task("bg-1"), task(`bg-${index + 2}`)]));
	expect(written).toHaveLength(2);
	needDrain = false;
	drain?.();
	expect(written).toHaveLength(3);
	expect(JSON.parse(written[2]!).tasks.at(-1).id).toBe("bg-101");
});
