// Disposable Herdr-free acceptance against a tmux-backed Radar daemon.
//
// Drives the pinned daemon's control plane through the extension's own Radar
// client, with a real child process in a daemon-created tmux pane. Everything
// lives under one temporary root and one uniquely named tmux server, both
// removed on exit. Herdr is made unreachable, not assumed absent: the sanitised
// environment drops every HERDR_* name, points HERDR_SOCKET_PATH at a path that
// does not exist, and runs with a PATH that contains no herdr binary.
//
// Usage:
//   RADAR_BIN=/path/to/radar node scripts/herdr-free-acceptance.mjs
//
// Exits 0 only when every item passed. A failed or not-reached item exits 1, so
// a partial run cannot be reported as a pass.

import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const clientUrl = pathToFileURL(resolve(here, "../extension/radar-client.ts")).href;

if (process.argv[2] === "--child") {
	await runChild();
} else {
	process.exitCode = await runAcceptance();
}

// ---------------------------------------------------------------- child ----

async function runChild() {
	const { createRadarClient } = await import(clientUrl);
	const { RADAR_SPAWN_TOKEN_ENV } = await import(clientUrl);
	const client = createRadarClient({ env: process.env });
	const source = "herdr-free-acceptance-child";
	const incarnation = randomUUID();
	const session = randomUUID();
	const registered = await client.register({
		source,
		incarnation,
		label: "herdr-free-acceptance-child",
		process: processClaim(),
		spawn_token: process.env[RADAR_SPAWN_TOKEN_ENV],
	});
	const published = registered.ok
		? await client.context({
				agent_id: registered.value.agent_id,
				publisher: { source, incarnation },
				sequence: 1,
				context: { session },
			})
		: undefined;
	writeFileSync(
		process.env.ACC_CHILD_REPORT,
		JSON.stringify({
			registered,
			published,
			source,
			incarnation,
			session,
			pid: process.pid,
			herdrEnvironment: Object.keys(process.env).filter((name) => name.startsWith("HERDR_")),
			herdrBinaryOnPath: (process.env.PATH ?? "").split(":").filter((dir) => dir && existsSync(join(dir, "herdr"))),
		}),
	);
	// Keep the pane's foreground process alive until the close path removes it.
	setInterval(() => {}, 1 << 30);
}

function processClaim() {
	const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return {
		boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
		pid: process.pid,
		start_ticks: Number(fields[19]),
	};
}

// ----------------------------------------------------------- acceptance ----

async function runAcceptance() {
	const radarBin = process.env.RADAR_BIN;
	if (!radarBin || !existsSync(radarBin)) {
		console.error("RADAR_BIN must name the pinned radar binary");
		return 1;
	}
	const root = mkdtempSync(join(tmpdir(), "pihfa-"));
	const server = `pihfa-${randomUUID().slice(0, 8)}`;
	const socket = join(root, "s", "control.sock");
	const stateDir = join(root, "state");
	const herdrSocket = join(root, "no-herdr.sock");
	mkdirSync(join(root, "s"), { recursive: true, mode: 0o700 });
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const env = sanitisedEnvironment(root, herdrSocket);
	const herdrProof = await proveHerdrUnavailable(env, herdrSocket);
	const items = [];
	const record = (item, status, detail) => items.push({ item, status, detail });
	let daemon;
	let tmuxSocket;

	try {
		const binaryHash = createHash("sha256").update(readFileSync(radarBin)).digest("hex");
		await tmux(server, env, ["-f", "/dev/null", "new-session", "-d", "-s", "op", "-x", "160", "-y", "45", "sleep 86400"]);
		const operatorPane = (await tmux(server, env, ["display-message", "-p", "-t", "op", "#{pane_id}"])).trim();
		tmuxSocket = (await tmux(server, env, ["display-message", "-p", "#{socket_path}"])).trim();

		daemon = spawn(radarBin, ["daemon"], {
			env: { ...env, RADAR_CONTROL_BACKEND: "tmux", RADAR_TMUX_SERVER: server, RADAR_CONTROL_STATE: stateDir, RADAR_CONTROL_SOCKET: socket },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const daemonStderr = [];
		daemon.stderr.on("data", (chunk) => daemonStderr.push(String(chunk)));
		await waitFor(() => existsSync(socket), 10_000, "daemon socket");

		const { createRadarClient } = await import(clientUrl);
		const client = createRadarClient({ env: { RADAR_CONTROL_SOCKET: socket } });

		// 1. Handshake: the daemon must be the tmux backend on the named server.
		const ping = await client.ping();
		herdrProof.daemonHerdrNames = environmentNames(daemon.pid).filter((name) => name.startsWith("HERDR_"));
		const pingOk =
			ping.ok &&
			ping.value.backend === "tmux" &&
			ping.value.instance === server &&
			["spawn.v1", "spawn.close.v1", "events.v1", "registry.v1"].every((c) => ping.value.capabilities.includes(c));
		record("handshake", pingOk ? "passed" : "failed", pingOk ? `backend=tmux instance=${server}` : JSON.stringify(ping));

		// Parent: a registered operator located on its own pane, with published session context.
		const inventory = await client.observe();
		const operatorRow = inventory.ok ? inventory.value.panes.find((p) => p.pane_id === `tmux:${server}:${operatorPane}`) : undefined;
		const operatorSession = randomUUID();
		const operatorIncarnation = randomUUID();
		const parent = operatorRow
			? await client.register({
					source: "herdr-free-acceptance-operator",
					incarnation: operatorIncarnation,
					session: operatorSession,
					label: "herdr-free-acceptance-operator",
					location: {
						backend: "tmux",
						instance: server,
						workspace: operatorRow.workspace_id,
						tab: operatorRow.tab_id,
						pane: operatorRow.pane_id,
					},
				})
			: undefined;
		const parentAgent = parent?.ok ? parent.value.agent_id : undefined;
		if (parentAgent)
			await client.context({
				agent_id: parentAgent,
				publisher: { source: "herdr-free-acceptance-operator", incarnation: operatorIncarnation },
				sequence: 1,
				context: { session: operatorSession },
			});

		// 2. Launch: the daemon creates a pane under the operator and runs the child in it.
		const reportPath = join(root, "child.json");
		const spawnRequest = randomUUID();
		const spawned = parentAgent
			? await client.spawn({
					request_id: spawnRequest,
					parent: parentAgent,
					parent_session_id: operatorSession,
					executable: process.execPath,
					argv: [fileURLToPath(import.meta.url), "--child"],
					env: { ACC_CHILD_REPORT: reportPath, RADAR_CONTROL_SOCKET: socket },
				})
			: undefined;
		const childPane = spawned?.ok ? spawned.value.location?.pane : undefined;
		const launchOk = spawned?.ok && spawned.value.created === "completed" && spawned.value.launched === "completed";
		record("launch", launchOk ? "passed" : "failed", launchOk ? `spawn ${spawnRequest} created+launched in a daemon pane` : JSON.stringify(spawned));

		// 3. Exact binding: the child's own registration must be the edge's bound agent.
		const report = await waitForChildReport(reportPath, 15_000);
		herdrProof.childHerdrNames = report?.herdrEnvironment;
		herdrProof.childHerdrBinariesOnPath = report?.herdrBinaryOnPath;
		const topology = await waitForBinding(client, spawnRequest, 15_000);
		const bound = topology?.edge?.bound?.agent_id;
		const bindingOk = report !== undefined && bound !== undefined && report.registered.ok && report.registered.value.agent_id === bound;
		record("exact child binding", bindingOk ? "passed" : "failed", bindingOk ? `bound agent_id ${bound} equals the child's own registration` : `child=${JSON.stringify(report?.registered)} edge=${JSON.stringify(topology)}`);

		// 4. Readiness at the Radar layer: the process verdict for the exact bound agent.
		const verdict = bound ? await client.agentGet(bound) : undefined;
		const verified = verdict?.ok && verdict.value.claimed && verdict.value.verification === "verified";
		record("readiness (radar process verdict)", verified ? "passed" : "failed", `agent.get process verdict: ${JSON.stringify(verdict)}`);
		record("readiness (herdsman startup acknowledgment)", "not_reached", "requires a Herdsman operator launch and the child extension; no non-LLM entry point exists (no control socket)");

		// 5. First assignment and result: needs a live Herdsman child and a model turn.
		record("first assignment and result", "not_reached", "requires a Herdsman mailbox assignment to a live child and a model turn; not driven by this script");

		// 6. Context publication: the child's session, read back from the registry.
		const childContext = bound ? await rawCall(socket, "agent.get", { agent_id: bound }) : undefined;
		const childSessionSeen = childContext?.result?.agent?.context?.context?.session ?? childContext?.result?.context?.context?.session;
		const contextOk = report !== undefined && childSessionSeen === report.session;
		record("context publication (client seam, read back via agent.get)", contextOk ? "passed" : "failed", contextOk ? `agent.get context.session equals the child's published session ${report.session}` : `read back ${JSON.stringify(childContext)}`);

		// 7. Close: the exact child pane closes; the same request replays without a second effect.
		const closeRequest = randomUUID();
		const close = report
			? await client.childClose({
					request_id: closeRequest,
					spawn_request_id: spawnRequest,
					source: report.source,
					incarnation: report.incarnation,
					intent: "complete",
				})
			: undefined;
		const replay = report
			? await client.childClose({
					request_id: closeRequest,
					spawn_request_id: spawnRequest,
					source: report.source,
					incarnation: report.incarnation,
					intent: "complete",
				})
			: undefined;
		const paneGone = childPane !== undefined ? !(await paneReported(client, childPane)) : false;
		const closeOk = close?.ok && close.value.outcome === "completed" && replay?.ok && replay.value.outcome === "completed" && paneGone;
		record("close", closeOk ? "passed" : "failed", closeOk ? `childClose completed; replay returned the stored outcome; pane ${childPane} no longer reported` : `close=${JSON.stringify(close)} replay=${JSON.stringify(replay)} paneGone=${paneGone}`);

		// 8. Saved-session continuation: needs a Herdsman continuation of the first worker.
		record("saved-session continuation", "not_reached", "requires a Herdsman continuation of a completed worker; not driven by this script");

		// 9. Event reconciliation after a resync: the journal is read, a stale epoch is
		// forced to expire, and reading resumes from the adopted cursor without replay.
		const first = await client.events({ after: 0, wait_ms: 0 });
		const page = first.ok && first.value.kind === "page" ? first.value : undefined;
		const expired = await client.events({ after: 0, epoch: "stale-epoch-for-acceptance", wait_ms: 0 });
		const resumed = expired.ok && expired.value.kind === "expired" ? await client.events({ after: expired.value.sequence, epoch: expired.value.epoch, wait_ms: 0 }) : undefined;
		const after = await client.spawnGet(spawnRequest);
		const resyncOk =
			page !== undefined &&
			expired.ok &&
			expired.value.kind === "expired" &&
			resumed?.ok === true &&
			resumed.value.kind === "page" &&
			after.ok &&
			after.value.edge.bound?.agent_id === bound;
		record("event journal resync (Radar side only; Herdsman watcher not reached)", resyncOk ? "passed" : "failed", resyncOk ? `page to seq ${page.sequence}; stale epoch expired to ${expired.value.epoch}; resumed without replay; spawn.get re-read` : `first=${JSON.stringify(first)} expired=${JSON.stringify(expired)} resumed=${JSON.stringify(resumed)} after=${JSON.stringify(after)}`);

		const unhandled = daemonStderr.join("").trim();
		if (unhandled) console.error(`daemon stderr:\n${unhandled}`);
		return finish(items, { radarBin, binaryHash, server, herdrProof });
	} catch (error) {
		record("harness", "failed", error instanceof Error ? error.message : String(error));
		return finish(items, { radarBin, server, herdrProof });
	} finally {
		if (daemon && daemon.exitCode === null) {
			daemon.kill("SIGTERM");
			await new Promise((done) => daemon.once("exit", done));
		}
		await tmux(server, env, ["kill-server"]).catch(() => {});
		if (tmuxSocket) rmSync(tmuxSocket, { force: true });
		rmSync(root, { recursive: true, force: true });
	}
}

function finish(items, meta) {
	const passed = items.every((item) => item.status === "passed");
	console.log(JSON.stringify({ ...meta, items, passed }, null, 2));
	return passed ? 0 : 1;
}

function sanitisedEnvironment(root, herdrSocket) {
	const env = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (name.startsWith("HERDR_") || name === "TMUX" || name === "TMUX_PANE") continue;
		env[name] = value;
	}
	env.HERDR_SOCKET_PATH = herdrSocket;
	env.PATH = herdrFreeBinDirectory(join(root, "bin"), process.env.PATH ?? "");
	return env;
}

/**
 * A directory holding a link to every executable on `path` except `herdr`.
 *
 * Dropping whole PATH entries is not enough: tmux and herdr share one profile
 * directory, so removing the directory would remove tmux too.
 */
function herdrFreeBinDirectory(bin, path) {
	mkdirSync(bin, { recursive: true });
	const linked = new Set();
	for (const dir of path.split(":")) {
		if (!dir || !existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (name === "herdr" || linked.has(name)) continue;
			if (!isExecutable(join(dir, name))) continue;
			symlinkSync(join(dir, name), join(bin, name));
			linked.add(name);
		}
	}
	return bin;
}

function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

async function proveHerdrUnavailable(env, herdrSocket) {
	// `command -v` exits 1 when the name is absent; any other failure is not proof.
	const probe = await execFileAsync("sh", ["-c", "command -v herdr"], { env }).then(
		() => "found",
		(error) => {
			if (error.code === 1) return "absent";
			throw error;
		},
	);
	return {
		herdrOnSanitisedPath: probe,
		herdrSocketPath: herdrSocket,
		herdrSocketExists: existsSync(herdrSocket),
		herdrEnvNames: Object.keys(env).filter((name) => name.startsWith("HERDR_") && name !== "HERDR_SOCKET_PATH"),
	};
}

function environmentNames(pid) {
	return readFileSync(`/proc/${pid}/environ`, "utf8")
		.split("\0")
		.filter(Boolean)
		.map((entry) => entry.slice(0, entry.indexOf("=")));
}

async function tmux(server, env, args) {
	const { stdout } = await execFileAsync("tmux", ["-L", server, ...args], { env });
	return stdout;
}

async function waitFor(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function waitForChildReport(path, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
		await new Promise((done) => setTimeout(done, 100));
	}
	return undefined;
}

async function waitForBinding(client, requestId, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const topology = await client.spawnGet(requestId);
		if (topology.ok && topology.value.edge.bound?.agent_id) return topology.value;
		await new Promise((done) => setTimeout(done, 200));
	}
	return undefined;
}

async function paneReported(client, paneId) {
	const inventory = await client.observe();
	return inventory.ok && inventory.value.panes.some((pane) => pane.pane_id === paneId);
}

// One raw JSON-line call, for the registry reads the client does not decode.
function rawCall(socketPath, method, params) {
	return new Promise((done, fail) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		socket.setTimeout(5_000, () => fail(new Error(`${method} timed out`)));
		socket.on("error", fail);
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			socket.end();
			done(JSON.parse(buffer.slice(0, newline)));
		});
		socket.write(`${JSON.stringify({ version: 2, id: randomUUID(), method, params })}\n`);
	});
}
