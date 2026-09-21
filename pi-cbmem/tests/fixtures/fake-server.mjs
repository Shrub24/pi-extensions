#!/usr/bin/env node
/*
 * A stand-in for the codebase-memory server, enough to exercise the client:
 * initialize, tools/call, JSON-RPC errors, and a crash command that kills the
 * process so the reconnect path can be tested.
 *
 * Usage: node fake-server.mjs [--fail-tool name] [--slow-tool name]
 */
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";

const failTool = process.argv.includes("--fail-tool") ? "search_graph" : null;
const slowTool = process.argv.includes("--slow-tool") ? "search_graph" : null;
const calls = [];

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let request;
	try {
		request = JSON.parse(trimmed);
	} catch {
		return;
	}

	if (request.method === "initialize") {
		write({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				protocolVersion: "2025-06-18",
				serverInfo: { name: "fake-cbm", version: "test" },
				capabilities: { tools: { listChanged: false } },
				instructions: "fake",
			},
		});
		return;
	}

	if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;

	if (request.method === "tools/call") {
		const { name, arguments: args = {} } = request.params ?? {};
		calls.push({ name, args });
		if (name === "crash") {
			process.exit(7);
		}
		if (name === "flaky") {
			// Crash once per marker file, so a respawned child answers. The marker
			// lives outside the process because a fresh process has fresh state.
			const marker = process.env.FAKE_CRASH_MARKER;
			if (marker && !existsSync(marker)) {
				writeFileSync(marker, "");
				process.exit(7);
			}
		}
		if (name === "hang") return; // never answer; the client timeout has to fire
		if (name === "protocol_error") {
			write({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "missing required argument: project" } });
			return;
		}
		if (name === "not_json") {
			process.stdout.write("this is not json\n");
			return;
		}
		const respond = () =>
			write({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					content: [
						{
							type: "text",
							text: JSON.stringify({ tool: name, args, call: calls.length }),
						},
					],
				},
			});
		if (slowTool && name === slowTool) setTimeout(respond, 250);
		else respond();
		return;
	}

	write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
});

process.on("SIGTERM", () => process.exit(0));
