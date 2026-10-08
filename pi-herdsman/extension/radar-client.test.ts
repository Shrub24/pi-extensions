import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	RADAR_MAX_LINE_BYTES,
	createRadarClient,
	untrustedControlSocket,
	type RadarClient,
	type RadarClientOptions,
	type RadarSocket,
} from "./radar-client.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UID = process.getuid?.() ?? 0;
const FIXTURE_WRITER = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";

/**
 * The daemon contract fixture vendored byte-for-byte from agent-radar at commit
 * `92ea9d37fdabafae88b1b41dfc7964b657d6c911`
 * (`docs/reference/agent-registration.fixture.jsonl`). Vendored rather than
 * fetched so the wire this client encodes stays pinned to a reviewable revision.
 * The vendor fixture's own request/response pairs, in file order.
 */
function fixtureExchanges(): Array<{ request: any; response: any }> {
	const lines = readFileSync(
		new URL("../docs/reference/agent-registration.fixture.jsonl", import.meta.url),
		"utf8",
	)
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as any);
	return lines
		.map((line: any, index: number) => ({ line, next: lines[index + 1] }))
		.filter(
			(entry) => entry.line.kind === "request" && entry.next?.kind === "response",
		)
		.map((entry) => ({ request: entry.line, response: entry.next }));
}

/** The raw reply line a fake daemon writes, or `undefined` for silence. */
type Answer = (request: any) => string | undefined;

const reply = (request: any, result: unknown): string =>
	JSON.stringify({ id: request.id, result });

const refuse = (request: any, code: string, message = ""): string =>
	JSON.stringify({ id: request.id, error: { code, message } });

class FakeSocket implements RadarSocket {
	private listeners = new Map<string, (value?: unknown) => void>();
	private answer: Answer;
	private requests: any[];
	constructor(answer: Answer, requests: any[]) {
		this.answer = answer;
		this.requests = requests;
	}
	on(event: string, listener: (value?: unknown) => void): unknown {
		this.listeners.set(event, listener);
		return this;
	}
	write(text: string): unknown {
		for (const line of text.split("\n").filter(Boolean)) {
			const request = JSON.parse(line);
			this.requests.push(request);
			queueMicrotask(() => {
				const body = this.answer(request);
				if (body !== undefined)
					this.listeners.get("data")?.(Buffer.from(`${body}\n`, "utf8"));
			});
		}
		return true;
	}
	connect(): void {
		this.listeners.get("connect")?.();
	}
	destroy(): void {}
}

type Fixture = {
	root: string;
	directory: string;
	path: string;
	requests: any[];
	dialled: number;
	server: Server;
	client(options?: RadarClientOptions): RadarClient;
};

/**
 * A fixture socket root that satisfies the trust check: the directory is 0700
 * and a real unix socket is bound at the path, while every dial is answered by
 * an in-memory fake. The daemon's own behaviour never runs here.
 */
function makeFixture(answer: Answer): Fixture {
	const root = mkdtempSync(join(tmpdir(), "radar-client-test-"));
	const directory = join(root, "socket");
	mkdirSync(directory, { mode: 0o700 });
	chmodSync(directory, 0o700);
	const path = join(directory, "control.sock");
	const requests: any[] = [];
	const server = createServer();
	const fixture: Fixture = {
		root,
		directory,
		path,
		requests,
		dialled: 0,
		server,
		client: (options = {}) =>
			createRadarClient({
				env: { RADAR_CONTROL_SOCKET: path },
				uid: UID,
				dial: () => {
					fixture.dialled += 1;
					const socket = new FakeSocket(answer, requests);
					queueMicrotask(() => socket.connect());
					return socket;
				},
				...options,
			}),
	};
	return fixture;
}

async function listen(fixture: Fixture): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		fixture.server.once("error", reject);
		fixture.server.listen(fixture.path, () => {
			fixture.server.removeListener("error", reject);
			resolve();
		});
	});
}

function cleanup(fixture: Fixture): void {
	rmSync(fixture.root, { recursive: true, force: true });
	if (fixture.server.listening) fixture.server.close();
}

test("an untrusted control socket is refused without dialling", async () => {
	const fixture = makeFixture(() => undefined);
	try {
		const absent = fixture.client();
		assert.deepEqual(await absent.ping(), {
			ok: false,
			code: "absent",
			message: `${fixture.path} is unavailable (ENOENT)`,
		});

		writeFileSync(fixture.path, "");
		assert.match(untrustedControlSocket(fixture.path, UID) ?? "", /not a socket/);

		chmodSync(fixture.directory, 0o755);
		assert.match(
			untrustedControlSocket(fixture.path, UID) ?? "",
			/not mode 0700/,
		);

		assert.equal(fixture.dialled, 0);
	} finally {
		cleanup(fixture);
	}
});

test("ping requires protocol 1 and the agent_registry capability", async () => {
	const answers = [
		(request: any) =>
			reply(request, { protocol: 2, capabilities: ["agent_registry"] }),
		(request: any) =>
			reply(request, {
				protocol: 1,
				backend: "sqlite",
				capabilities: ["agent_registry"],
			}),
	];
	const fixture = makeFixture((request) => answers.shift()?.(request));
	try {
		await listen(fixture);
		const client = fixture.client();
		const wrongVersion = await client.ping();
		assert.equal(wrongVersion.ok, false);
		assert.equal(wrongVersion.ok ? "" : wrongVersion.code, "unsupported");
		const capable = await client.ping();
		assert.deepEqual(capable, {
			ok: true,
			value: {
				protocol: 1,
				backend: "sqlite",
				capabilities: ["agent_registry"],
			},
		});
	} finally {
		cleanup(fixture);
	}
});

test("failed registry negotiation is retried on the same client", async () => {
	let negotiations = 0;
	const fixture = makeFixture((request) => {
		if (request.method === "ping") {
			negotiations += 1;
			return negotiations === 1
				? undefined
				: reply(request, { protocol: 1, capabilities: ["agent_registry"] });
		}
		return reply(request, { registration: { agent_id: UUID_A } });
	});
	try {
		await listen(fixture);
		const client = fixture.client({ timeoutMs: 100 });
		const first = await client.register({ source: "herdsman-pi", incarnation: UUID_A });
		assert.equal(first.ok, false);
		assert.equal(first.ok ? "" : first.code, "timeout");
		assert.equal((await client.ping()).ok, true);
		const recovered = await client.register({ source: "herdsman-pi", incarnation: UUID_A });
		assert.deepEqual(recovered, { ok: true, value: { agent_id: UUID_A } });
		assert.equal(negotiations, 3);
	} finally {
		cleanup(fixture);
	}
});

test("ping refuses a daemon that cannot register agents", async () => {
	const fixture = makeFixture((request) =>
		reply(request, { protocol: 1, capabilities: ["presence"] }),
	);
	try {
		await listen(fixture);
		const result = await fixture.client().ping();
		assert.equal(result.ok, false);
		assert.equal(result.ok ? "" : result.code, "unsupported");
		assert.match(result.ok ? "" : result.message, /agent_registry/);
	} finally {
		cleanup(fixture);
	}
});

test("a reply is bounded, valid JSON and matched to its request id", async () => {
	const replies: string[] = [
		"not json",
		JSON.stringify({ id: UUID_B, result: {} }),
		JSON.stringify({ id: "", result: {} }),
		`${JSON.stringify({ result: {} })}`,
	];
	const fixture = makeFixture(() => replies.shift());
	try {
		await listen(fixture);
		const client = fixture.client();
		for (const expected of [
			"reply is not JSON",
			"reply does not match the request id",
			"reply does not match the request id",
			"reply does not match the request id",
		]) {
			const result = await client.ping();
			assert.equal(result.ok, false);
			assert.equal(result.ok ? "" : result.code, "protocol");
			assert.equal(result.ok ? "" : result.message, expected);
		}
	} finally {
		cleanup(fixture);
	}
});

test("an oversized reply is abandoned rather than buffered", async () => {
	const fixture = makeFixture((request) =>
		JSON.stringify({
			id: request.id,
			result: { padding: "x".repeat(RADAR_MAX_LINE_BYTES) },
		}),
	);
	try {
		await listen(fixture);
		const result = await fixture.client().ping();
		assert.equal(result.ok, false);
		assert.equal(result.ok ? "" : result.code, "protocol");
		assert.match(result.ok ? "" : result.message, /line bound/);
	} finally {
		cleanup(fixture);
	}
});

test("nothing gets a reply when the daemon never answers", async () => {
	const fixture = makeFixture(() => undefined);
	try {
		await listen(fixture);
		const result = await fixture
			.client({ timeoutMs: 20 })
			.register({ source: "herdsman-pi", incarnation: UUID_A });
		assert.equal(result.ok, false);
		assert.equal(result.ok ? "" : result.code, "timeout");
	} finally {
		cleanup(fixture);
	}
});

test("daemon refusals pass through and unknown codes do not", async () => {
	const codes = ["refused", "not_found", "made_up"];
	const fixture = makeFixture((request) =>
		refuse(request, codes.shift() ?? "refused", "fenced"),
	);
	try {
		await listen(fixture);
		const client = fixture.client();
		for (const [code, message] of [
			["refused", "refused: fenced"],
			["not_found", "not_found: fenced"],
			["internal", "made_up: fenced"],
		]) {
			const result = await client.ping();
			assert.deepEqual(result, { ok: false, code, message });
		}
	} finally {
		cleanup(fixture);
	}
});

test("unsupported daemons are never sent registry methods", async () => {
	const fixture = makeFixture((request) =>
		reply(request, { protocol: 1, capabilities: ["presence"] }),
	);
	try {
		await listen(fixture);
		const unsupported = fixture.client();
		assert.equal(
			(await unsupported.register({ source: "herdsman-pi", incarnation: UUID_A })).ok,
			false,
		);
		assert.deepEqual(fixture.requests.map(({ method }) => method), ["ping"]);
	} finally {
		cleanup(fixture);
	}
});

test("registry calls put only the contract's own fields on the wire", async () => {
	const fixture = makeFixture((request) => {
		switch (request.method) {
			case "ping":
				return reply(request, { protocol: 1, capabilities: ["agent_registry"] });
			case "agent.register":
				return reply(request, { registration: { agent_id: UUID_A } });
			case "agent.acquire":
				return reply(request, {
					writer: {
						handle: UUID_B,
						source: "herdsman-pi",
						incarnation: UUID_A,
						generation: 1,
						sequence: 0,
					},
				});
			case "agent.publish":
				return reply(request, { channel: { writer: { sequence: 7 } } });
			default:
				return reply(request, {});
		}
	});
	try {
		await listen(fixture);
		const client = fixture.client();
		const registered = await client.register({
			source: "herdsman-pi",
			incarnation: UUID_A,
			session: UUID_B,
			owner: "owner",
			run: "run",
			label: "worker",
			location: { backend: "tmux", pane: "%1" },
			process: { boot_id: "boot", pid: 42, start_ticks: 99 },
		});
		assert.deepEqual(registered, { ok: true, value: { agent_id: UUID_A } });

		const acquired = await client.acquire({
			agent_id: UUID_A,
			channel: "execution",
			publisher: {
				source: "herdsman-pi",
				incarnation: UUID_A,
				reporting_owner: "owner",
			},
		});
		assert.equal(acquired.ok, true);
		assert.equal(acquired.ok ? acquired.value.handle : "", UUID_B);

		const published = await client.publish({
			agent_id: UUID_A,
			channel: "execution",
			writer_handle: UUID_B,
			sequence: 0,
			snapshot: { activity: "working" },
		});
		assert.deepEqual(published, { ok: true, value: { sequence: 7 } });
		await client.retire({
			agent_id: UUID_A,
			channel: "execution",
			writer_handle: UUID_B,
		});

		assert.deepEqual(
			fixture.requests.map(({ version, method }) => [version, method]),
			[
				[1, "ping"],
				[1, "agent.register"],
				[1, "agent.acquire"],
				[1, "agent.publish"],
				[1, "agent.retire"],
			],
		);
		assert.deepEqual(
			fixture.requests.filter(({ method }) => method !== "ping").map(({ method, params }) => [
				method,
				params,
			]),
			[
				[
					"agent.register",
					{
						source: "herdsman-pi",
						incarnation: UUID_A,
						session: UUID_B,
						owner: "owner",
						run: "run",
						label: "worker",
						location: { backend: "tmux", pane: "%1" },
						process: { boot_id: "boot", pid: 42, start_ticks: 99 },
					},
				],
				[
					"agent.acquire",
					{
						agent_id: UUID_A,
						channel: "execution",
						publisher: {
							source: "herdsman-pi",
							incarnation: UUID_A,
							reporting_owner: "owner",
						},
					},
				],
				[
					"agent.publish",
					{
						agent_id: UUID_A,
						channel: "execution",
						writer_handle: UUID_B,
						sequence: 0,
						snapshot: { activity: "working" },
					},
				],
				[
					"agent.retire",
					{
						agent_id: UUID_A,
						channel: "execution",
						writer_handle: UUID_B,
					},
				],
			],
		);
	} finally {
		cleanup(fixture);
	}
});

test("an ambivalent registration reply is not a registration", async () => {
	const fixture = makeFixture((request) =>
		request.method === "ping"
			? reply(request, { protocol: 1, capabilities: ["agent_registry"] })
			: reply(request, { registration: { agent_id: "not-a-uuid" } }),
	);
	try {
		await listen(fixture);
		const result = await fixture
			.client()
			.register({ source: "herdsman-pi", incarnation: UUID_A });
		assert.equal(result.ok, false);
		assert.equal(result.ok ? "" : result.code, "protocol");
	} finally {
		cleanup(fixture);
	}
});

test("the vendored daemon contract round-trips through this client", async () => {
	const exchanges = fixtureExchanges();
	const byMethod = (method: string) =>
		exchanges.find((entry) => entry.request.method === method)!.request.params;
	const fixture = makeFixture((request) => {
		if (request.method === "ping")
			return reply(request, { protocol: 1, capabilities: ["agent_registry"] });
		const exchange = exchanges.find(
			(entry) => entry.request.method === request.method,
		);
		if (exchange === undefined) return undefined;
		const body = JSON.parse(JSON.stringify(exchange.response));
		body.id = request.id;
		for (const writer of [body.result?.writer, body.result?.channel?.writer])
			if (writer?.handle === "<opaque-uuid>") writer.handle = FIXTURE_WRITER;
		return JSON.stringify(body);
	});
	try {
		await listen(fixture);
		const client = fixture.client();

		// The fixture's registration exercises its optional private launch
		// specification, which would put paths on the wire and advertises nothing
		// this client needs, so the vendor's request minus `launch` is what this
		// client emits.
		const { launch, ...registration } = byMethod("agent.register");
		assert.ok(launch, "the fixture covers the optional launch specification");
		assert.deepEqual(await client.register(registration), {
			ok: true,
			value: { agent_id: "8a1f5c30-6f4b-4c58-9c7b-2d0e1a9f4b22" },
		});

		const acquire = byMethod("agent.acquire");
		assert.deepEqual(await client.acquire(acquire), {
			ok: true,
			value: {
				handle: FIXTURE_WRITER,
				source: "herdsman-owner",
				incarnation: "9f8e7d6c-4321-4def-8abc-0123456789ab",
				reporting_owner: "owner-1",
				generation: 1,
				sequence: 0,
			},
		});

		const publish = byMethod("agent.publish");
		assert.deepEqual(await client.publish(publish), {
			ok: true,
			value: { sequence: 1 },
		});
		const retire = byMethod("agent.retire");
		assert.deepEqual(await client.retire(retire), {
			ok: true,
			value: undefined,
		});

		assert.deepEqual(
			fixture.requests.map((request) => [
				request.version,
				request.method,
				request.params,
			]),
			[
				[1, "ping", {}],
				[1, "agent.register", registration],
				[1, "agent.acquire", acquire],
				[1, "agent.publish", publish],
				[1, "agent.retire", retire],
			],
		);
		// The vendor fixture's private-path sentinel never reaches the wire.
		assert.equal(JSON.stringify(fixture.requests).includes("SENTINEL"), false);
	} finally {
		cleanup(fixture);
	}
});

test("the control socket path follows the environment", async () => {
	const fixture = makeFixture(() => undefined);
	try {
		assert.equal(fixture.client().socketPath(), join(fixture.directory, "control.sock"));
		assert.equal(
			createRadarClient({ env: {}, uid: 7 }).socketPath(),
			"/tmp/agent-radar-7/control.sock",
		);
		assert.equal(
			createRadarClient({ env: { XDG_RUNTIME_DIR: "/run/user/7" }, uid: 7 })
				.socketPath(),
			"/run/user/7/agent-radar/control.sock",
		);
	} finally {
		cleanup(fixture);
	}
});
