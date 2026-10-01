import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type BridgeHandler,
	type BridgeRequest,
	BRIDGE_MAX_REQUEST_BYTES,
	createBridgeServer,
	parseBridgeRequest,
	parseBridgeResponse,
	requestBridge,
	taskGeneration,
} from "../extensions/bridge.js";
import { PI_BG_CLIENT_FILE } from "../extensions/pi-bg.js";
import { installReadShims } from "../extensions/read-shim.js";

// The declared CLI's transport, and the early feasibility gate for the whole
// phase: two sessions answering side by side without seeing each other's tasks,
// the generated `pi-bg` reaching a live endpoint from a real shell, and every
// bounded failure (no endpoint, no interpreter, malformed request, silent
// endpoint) reported as an outcome instead of guessed at.

const root = mkdtempSync(join(tmpdir(), "pi-bg-bridge-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const shimDir = installReadShims(join(root, "shims"))!;

interface FakeTask {
	id: string;
	startedAt: number;
	command: string;
	status: string;
	readiness: string;
	outputComplete: boolean;
	preview: string;
	captureError?: string;
}

/** A handler over a fixed task list: enough to prove routing and isolation. */
function fakeHandler(session: string, tasks: FakeTask[]): BridgeHandler {
	return async (request: BridgeRequest) => {
		if (request.op === "list") {
			return {
				ok: true,
				result: {
					tasks: tasks.map((task) => ({
						command: task.command,
						generation: taskGeneration(task),
						id: task.id,
						outputBytes: task.preview.length,
						outputComplete: task.outputComplete,
						pid: 1000,
						readiness: task.readiness,
						startedAt: task.startedAt,
						status: task.status,
						updatedAt: task.startedAt,
					})),
				},
			};
		}
		const task = tasks.find((candidate) => candidate.id === request.id);
		if (!task) return { ok: false, error: { code: "unknown-task", message: `no task ${request.id} in ${session}` } };
		if (request.generation !== undefined && request.generation !== taskGeneration(task)) {
			return { ok: false, error: { code: "stale-generation", message: `${task.id} was replaced` } };
		}
		return {
			ok: true,
			result: {
				captureError: task.captureError,
				output: { kind: "preview", partial: task.readiness !== "terminal", text: task.preview, truncated: false },
				task: {
					command: task.command,
					generation: taskGeneration(task),
					id: task.id,
					outputBytes: task.preview.length,
					outputComplete: task.outputComplete,
					pid: 1000,
					readiness: task.readiness,
					startedAt: task.startedAt,
					status: task.status,
					updatedAt: task.startedAt,
				},
			},
		};
	};
}

test("a request line is validated before any handler sees it", () => {
	// Protocol version, allowlist, and required fields are the bridge's own
	// contract: a client that gets one wrong must be answered, not crashed on.
	const cases: [string, string][] = [
		["", "malformed"],
		["not json", "malformed"],
		["[]", "malformed"],
		['{"op":"list"}', "unsupported-version"],
		['{"v":2,"op":"list"}', "unsupported-version"],
		['{"v":1,"op":"exec"}', "unsupported-op"],
		['{"v":1}', "unsupported-op"],
		['{"v":1,"op":"get"}', "malformed"],
		['{"v":1,"op":"stop","id":"  "}', "malformed"],
		['{"v":1,"op":"get","id":"bg-1","output":"scrollback"}', "malformed"],
		['{"v":1,"op":"get","id":"bg-1","session":7}', "malformed"],
	];
	for (const [line, code] of cases) {
		const parsed = parseBridgeRequest(line);
		expect(parsed.ok, `line ${line} must be refused`).toBe(false);
		if (!parsed.ok) expect(parsed.error.code, `line ${line}`).toBe(code);
	}
	const ok = parseBridgeRequest('{"v":1,"op":"get","id":"bg-3","output":"full","session":"s","generation":"bg-3@1"}');
	expect(ok.ok).toBe(true);
	if (ok.ok) expect(ok.request).toEqual({ v: 1, op: "get", id: "bg-3", output: "full", session: "s", generation: "bg-3@1" });
	// A response is validated the same way, so a wrong-version endpoint cannot be
	// mistaken for a live one.
	expect(parseBridgeResponse('{"v":1,"ok":false,"error":{"code":"unknown-task","message":"nope"}}')).toStrictEqual({
		ok: false, error: { code: "unknown-task", message: "nope" },
	});
	expect(parseBridgeResponse("<html>")).toStrictEqual({ ok: false, error: { code: "malformed", message: "endpoint response is not JSON" } });
	expect(parseBridgeResponse('{"v":9,"ok":true}')).toEqual({ ok: false, error: { code: "unsupported-version", message: "endpoint speaks protocol version 9" } });
});

test("two sessions answer side by side without reaching each other's tasks", async () => {
	const taskA: FakeTask = { command: "build --watch", id: "bg-3", outputComplete: true, preview: "alpha\n", readiness: "running", startedAt: 1_700_000_000_000, status: "running" };
	const taskB: FakeTask = { command: "deploy --prod", id: "bg-3", outputComplete: true, preview: "bravo\n", readiness: "running", startedAt: 1_700_000_500_000, status: "running" };
	const socketA = join(root, "sess-a.sock");
	const socketB = join(root, "sess-b.sock");
	const serverA = createBridgeServer({ handle: fakeHandler("sess-A", [taskA]), session: "sess-A", socketPath: socketA });
	const serverB = createBridgeServer({ handle: fakeHandler("sess-B", [taskB]), session: "sess-B", socketPath: socketB });
	await serverA.start();
	await serverB.start();
	try {
		// The same short id in both sessions: each endpoint answers with its own.
		const fromA = await requestBridge({ session: "sess-A", socketPath: socketA }, { op: "get", id: "bg-3" });
		const fromB = await requestBridge({ session: "sess-B", socketPath: socketB }, { op: "get", id: "bg-3" });
		expect(fromA.ok && fromA.response.ok && fromA.response.result.task?.command).toBe("build --watch");
		expect(fromB.ok && fromB.response.ok && fromB.response.result.task?.command).toBe("deploy --prod");
		expect(fromA.ok && fromA.response.ok && fromA.response.session).toBe("sess-A");

		// Naming the other session on a session's own endpoint is refused: the
		// socket path is scoping, the check is the boundary.
		const foreign = await requestBridge({ session: "sess-B", socketPath: socketA }, { op: "list" });
		expect(foreign.ok).toBe(false);
		if (!foreign.ok) expect(foreign.error.code).toBe("foreign-session");

		// A stale generation token from the other session's task is refused even
		// when the id matches.
		const stale = await requestBridge({ session: "sess-A", socketPath: socketA }, { op: "get", id: "bg-3", generation: taskGeneration(taskB) });
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.error.code).toBe("stale-generation");

		// Listing is scoped the same way.
		const listA = await requestBridge({ socketPath: socketA }, { op: "list" });
		expect(listA.ok && listA.response.ok && listA.response.result.tasks?.map((task) => task.command)).toEqual(["build --watch"]);
	} finally {
		await serverA.stop();
		await serverB.stop();
	}
	// Stopping removes the endpoint, and a request for it is an honest failure.
	expect(existsSync(socketA)).toBe(false);
	const gone = await requestBridge({ socketPath: socketA, timeoutMs: 500 }, { op: "list" });
	expect(gone.ok).toBe(false);
	if (!gone.ok) expect(gone.error.code).toBe("unavailable");
});

test("an endpoint that accepts but never answers is bounded, not hung", async () => {
	const { createServer } = await import("node:net");
	const silentPath = join(root, "silent.sock");
	// Accepts and says nothing: the client's deadline has to end this. The
	// accepted socket is tracked so the fixture's own teardown is bounded too.
	const accepted = new Set<import("node:net").Socket>();
	const silent = createServer((socket) => {
		accepted.add(socket);
		socket.on("close", () => accepted.delete(socket));
	});
	await new Promise<void>((resolve) => silent.listen(silentPath, () => resolve()));
	try {
		const started = Date.now();
		const outcome = await requestBridge({ socketPath: silentPath, timeoutMs: 200 }, { op: "list" });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("unavailable");
		expect(Date.now() - started).toBeLessThan(2_000);
	} finally {
		for (const socket of [...accepted]) socket.destroy();
		accepted.clear();
		await new Promise<void>((resolve) => silent.close(() => resolve()));
	}
});

test("an oversized request line is refused without touching the handler", async () => {
	const socketPath = join(root, "oversized.sock");
	let handled = 0;
	const server = createBridgeServer({
		handle: async () => {
			handled += 1;
			return { ok: true, result: {} };
		},
		session: "sess-A",
		socketPath,
	});
	await server.start();
	try {
		const { connect } = await import("node:net");
		const answer = await new Promise<string>((resolve, reject) => {
			let buffer = "";
			const socket = connect(socketPath);
			socket.setEncoding("utf8");
			socket.on("error", reject);
			socket.on("data", (chunk: string) => {
				buffer += chunk;
			});
			socket.on("close", () => resolve(buffer));
			socket.on("connect", () => socket.write("x".repeat(BRIDGE_MAX_REQUEST_BYTES + 1)));
		});
		const parsed = parseBridgeResponse(answer.trim());
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error.code).toBe("malformed");
		expect(handled).toBe(0);
	} finally {
		await server.stop();
	}
});

// --- The generated CLI, driven from a real shell -------------------------
//
// Deliberately asynchronous. `spawnSync` would block *this* process's event
// loop, and the endpoint being called lives in this process too, so the client
// could not be answered until the call it is waiting on returned: a synchronous
// caller deadlocks itself. The manager's own managed-bash path spawns and awaits,
// which is what these assertions must exercise.

interface CliRun {
	status: number | null;
	stderr: string;
	stdout: string;
}

/** The absolute shell path: a case below strips PATH on purpose. */
const bashBin = (() => {
	const found = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" });
	return (found.stdout ?? "").trim() || "bash";
})();

/**
 * The PATH a managed shell sees. The ambient PATH may already carry this
 * machine's own shim directory, and a shim that finds *itself* as the real
 * binary recurses forever; the product avoids that by exporting
 * PI_BG_REAL_PATH, so the fixture does the same and drops any outer shim
 * overlay from the base.
 */
const basePath = (process.env.PATH ?? "")
	.split(":")
	.filter((entry) => entry && !entry.includes("kendex-pi-bg"))
	.join(":");
const managedPath = [shimDir, basePath].filter(Boolean).join(":");

/** The environment a managed command runs with, as the product assembles it. */
const managedEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
	HOME: root,
	PATH: managedPath,
	PI_BG_REAL_PATH: basePath,
	PI_BG_RUNTIME: process.execPath,
	...extra,
});

/** Run the installed `pi-bg` the way a managed command would. */
async function runCli(args: string[], env: Record<string, string | undefined>): Promise<CliRun> {
	const { spawn } = await import("node:child_process");
	return new Promise<CliRun>((resolve, reject) => {
		const child = spawn(bashBin, [join(shimDir, "pi-bg"), ...args], { env: managedEnv(env) });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi-bg ${args.join(" ")} did not finish; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
		}, 20_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (status: number | null) => {
			clearTimeout(timer);
			resolve({ status, stderr, stdout });
		});
	});
}

test("pi-bg list, get and stop are answered by the session endpoint", async () => {
	const socketPath = join(root, "cli.sock");
	const task: FakeTask = { command: "sleep 30", id: "bg-7", outputComplete: true, preview: "still going\n", readiness: "running", startedAt: 1_700_000_000_000, status: "running" };
	let stopped = 0;
	const server = createBridgeServer({
		handle: async (request) => {
			if (request.op === "stop") stopped += 1;
			return fakeHandler("sess-A", [task])(request);
		},
		session: "sess-A",
		socketPath,
	});
	await server.start();
	const env = { PI_BG_SESSION: "sess-A", PI_BG_SOCKET: socketPath };
	try {
		const list = await runCli(["list"], env);		expect({ status: list.status, stdout: list.stdout }).toEqual({
			status: 0,
			stdout: "bg-7\trunning\trunning\tcomplete\tsleep 30\n",
		});
		// Retrieval metadata goes to stderr, so stdout stays a clean pipeline.
		expect(list.stderr).toContain("kendex: result=ok");

		const get = await runCli(["get", "bg-7"], env);
		expect({ status: get.status, stdout: get.stdout }).toEqual({ status: 0, stdout: "still going\n" });
		expect(get.stderr).toContain("kendex: task=bg-7");
		expect(get.stderr).toContain("kendex: readiness=running");
		// The CLI is told what it may hand off, never where the mutable log lives.
		expect(get.stderr).not.toContain(".log");

		const stop = await runCli(["stop", "bg-7"], env);
		expect({ status: stop.status, stdout: stop.stdout }).toEqual({ status: 0, stdout: "still going\n" });
		expect(stopped).toBe(1);

		const missing = await runCli(["get", "bg-404"], env);
		expect({ status: missing.status, stdout: missing.stdout }).toEqual({ status: 1, stdout: "" });
		expect(missing.stderr).toContain("code=unknown-task");

		const usage = await runCli(["frobnicate"], env);
		expect(usage.status).toBe(2);
		expect(usage.stderr).toContain("usage: pi-bg");
	} finally {
		await server.stop();
	}
});

test("a capture that is not certified is handed over as a management failure", async () => {
	const socketPath = join(root, "incomplete.sock");
	const task: FakeTask = {
		captureError: "the capture was never certified complete and no process is left to finish it; the bytes shown are all that survive",
		command: "make build",
		id: "bg-9",
		outputComplete: false,
		preview: "half a build log\n",
		readiness: "incomplete",
		startedAt: 1_700_000_000_000,
		status: "stopped",
	};
	const server = createBridgeServer({ handle: fakeHandler("sess-A", [task]), session: "sess-A", socketPath });
	await server.start();
	try {
		const get = await runCli(["get", "bg-9"], { PI_BG_SESSION: "sess-A", PI_BG_SOCKET: socketPath });
		// The surviving bytes still reach the caller, but the command does not
		// report success: the handoff was not a complete result.
		expect({ status: get.status, stdout: get.stdout }).toEqual({ status: 1, stdout: "half a build log\n" });
		expect(get.stderr).toContain("code=capture-incomplete");
	} finally {
		await server.stop();
	}
});

test("without an endpoint or an interpreter the CLI says so instead of guessing", async () => {
	const unset = await runCli(["list"], { PI_BG_SOCKET: undefined });
	expect(unset.status).toBe(3);
	expect(unset.stderr).toContain("PI_BG_SOCKET is not set");

	const missing = await runCli(["list"], { PI_BG_SOCKET: join(root, "nothing.sock") });
	expect(missing.status).toBe(3);
	expect(missing.stderr).toContain("code=unavailable");

	// No runtime on PATH and no override: an actionable error, not a silent
	// fallback to something that might answer differently.
	const { spawn } = await import("node:child_process");
	const noRuntime = await new Promise<CliRun>((resolve, reject) => {
		const child = spawn(bashBin, [join(shimDir, "pi-bg"), "list"], {
			env: { HOME: root, PATH: "/nonexistent", PI_BG_SOCKET: join(root, "nothing.sock") },
		});		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (status: number | null) => resolve({ status, stderr, stdout: "" }));
	});
	expect(noRuntime.status).toBe(3);
	expect(noRuntime.stderr).toContain("no bun or node interpreter found");
});

test("the endpoint is installed beside the CLI and reachable only from this session", () => {
	// The client ships with the wrapper, so a PATH lookup finds both.
	expect(existsSync(join(shimDir, PI_BG_CLIENT_FILE))).toBe(true);
	expect(existsSync(join(shimDir, "pi-bg"))).toBe(true);
});
