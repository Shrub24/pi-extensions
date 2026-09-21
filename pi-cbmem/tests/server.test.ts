import { expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CbmServer, TransportError } from "../extensions/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures", "fake-server.mjs");

/** The fixture is executable on its own, so it is the binary the client spawns. */
chmodSync(FAKE, 0o755);

function fakeServer(timeoutMs = 5_000): CbmServer {
	return new CbmServer({ binary: FAKE, cwd: here, requestTimeoutMs: timeoutMs, env: process.env });
}

test("connects, calls a tool, and returns the content", async () => {
	const server = fakeServer();
	try {
		await server.connect();
		expect(server.state).toBe("ready");
		expect(server.pid).toBeGreaterThan(0);

		const result = await server.call("search_graph", { query: "stop" });
		const text = result.content?.[0]?.text ?? "";
		expect(JSON.parse(text)).toEqual({ tool: "search_graph", args: { query: "stop" }, call: 1 });
	} finally {
		server.stop();
	}
});

test("a JSON-RPC error is reported as the tool's error, not as a transport failure", async () => {
	const server = fakeServer();
	try {
		await server.connect();
		await expect(server.call("protocol_error", {})).rejects.toThrow("missing required argument: project");
		// The connection survives a tool-level error.
		expect(server.state).toBe("ready");
		const result = await server.call("list_projects", {});
		expect(result.content?.[0]?.text).toContain("list_projects");
	} finally {
		server.stop();
	}
});

test("a timeout rejects the call and leaves the connection usable", async () => {
	const server = fakeServer(200);
	try {
		await server.connect();
		await expect(server.call("hang", {})).rejects.toThrow(/timed out after 200 ms/);
		const result = await server.call("search_graph", { query: "x" });
		expect(result.content?.[0]?.text).toContain("search_graph");
	} finally {
		server.stop();
	}
});

test("a crash mid-call reconnects once and completes the call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-cbmem-flaky-"));
	const marker = join(dir, "crashed");
	const server = new CbmServer({
		binary: FAKE,
		cwd: here,
		requestTimeoutMs: 5_000,
		env: { ...process.env, FAKE_CRASH_MARKER: marker },
	});
	try {
		await server.connect();
		const firstPid = server.pid;
		// The first `flaky` kills the child; the respawned one answers.
		const result = await server.call("flaky", { query: "after-crash" });
		expect(JSON.parse(result.content?.[0]?.text ?? "{}").args).toEqual({ query: "after-crash" });
		expect(server.pid).not.toBe(firstPid);
		expect(server.state).toBe("ready");
	} finally {
		server.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a crash that repeats on every attempt surfaces the transport error", async () => {
	const server = fakeServer();
	try {
		await server.connect();
		// `crash` kills the child before it answers, so both attempts fail.
		await expect(server.call("crash", {})).rejects.toThrow(TransportError);
		expect(server.state).toBe("failed");
	} finally {
		server.stop();
	}
});

test("a stopped server refuses further calls", async () => {
	const server = fakeServer();
	await server.connect();
	server.stop();
	expect(server.state).toBe("stopped");
	await expect(server.call("search_graph", {})).rejects.toThrow(/stopped/);
});

test("a missing binary fails with a spawn error and leaves the server failed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-cbmem-"));
	writeFileSync(join(dir, "not-executable"), "#!/bin/sh\nexit 1\n");
	try {
		const server = new CbmServer({
			binary: join(dir, "does-not-exist"),
			cwd: here,
			requestTimeoutMs: 1_000,
		});
		await expect(server.connect()).rejects.toThrow(/ENOENT|exited|not running/);
		expect(server.state).toBe("failed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("aborting a call rejects it without killing the connection", async () => {
	const server = fakeServer();
	try {
		await server.connect();
		const controller = new AbortController();
		const pending = server.call("hang", {}, controller.signal);
		setTimeout(() => controller.abort(), 50);
		await expect(pending).rejects.toThrow(/aborted/);
		const result = await server.call("search_graph", { query: "y" });
		expect(result.content?.[0]?.text).toContain("search_graph");
	} finally {
		server.stop();
	}
});
