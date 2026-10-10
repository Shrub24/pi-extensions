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
/** The fixture's successor writer handle, for its replacement exchange. */
const FIXTURE_SUCCESSOR = "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b";

/** The fixture's generated placeholders, resolved to real values. */
const FIXTURE_HANDLES: Record<string, string> = {
	"<opaque-uuid>": FIXTURE_WRITER,
	"<observed-incumbent-handle>": FIXTURE_WRITER,
	"<replacement-opaque-uuid>": FIXTURE_SUCCESSOR,
};

function materialise(value: unknown): any {
	return JSON.parse(
		JSON.stringify(value).replace(
			/<(?:observed-incumbent-handle|replacement-opaque-uuid|opaque-uuid)>/g,
			(name) => FIXTURE_HANDLES[name]!,
		),
	);
}

/**
 * The daemon contract fixture vendored byte-for-byte from agent-radar at commit
 * `da0ba99a09643736e39c44903d69ffdc1e5df65b`
 * (`docs/reference/agent-registration.fixture.jsonl`). Vendored rather than
 * fetched so the wire this client encodes stays pinned to a reviewable revision.
 * The mutable-context feature pin is `4e37697826c2ba4a28c92a93e22747df2bc7097e`;
 * `a46f27ae` added a replacement example, and `da0ba99a` makes the daemon validator
 * assert full response equality after substituting only generated values.
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

test("child.close sends the exact spawn edge and accepts only confirmed pane closure", async () => {
	const fixture = makeFixture((request) => {
		if (request.method === "ping") return reply(request, { protocol: 1, capabilities: ["agent_registry"] });
		assert.equal(request.method, "child.close");
		assert.deepEqual(request.params, {
			spawn_request_id: UUID_A,
			source: "herdsman-child",
			incarnation: UUID_B,
			intent: "complete",
		});
		return reply(request, { close: { outcome: "completed", intent: "complete", pane: "wA:p2" } });
	});
	try {
		await listen(fixture);
		assert.deepEqual(await fixture.client().childClose({
			request_id: UUID_B,
			spawn_request_id: UUID_A,
			source: "herdsman-child",
			incarnation: UUID_B,
			intent: "complete",
		}), { ok: true, value: { outcome: "completed", pane: "wA:p2" } });
	} finally { cleanup(fixture); }
});

test("child.close unknown outcome is preserved as failure", async () => {
	const fixture = makeFixture((request) => request.method === "ping"
		? reply(request, { protocol: 1, capabilities: ["agent_registry"] })
		: refuse(request, "backend_unavailable", "managed child close outcome is unknown"));
	try {
		await listen(fixture);
		const result = await fixture.client().childClose({
			request_id: UUID_B, spawn_request_id: UUID_A, source: "herdsman-child",
			incarnation: UUID_B, intent: "cancel",
		});
		assert.equal(result.ok, false);
		assert.equal(result.ok ? "" : result.code, "backend_unavailable");
	} finally { cleanup(fixture); }
});

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

test("the context channel carries only the session and keeps the returned binding", async () => {
	const fixture = makeFixture((request) =>
		request.method === "ping"
			? reply(request, { protocol: 1, capabilities: ["agent_registry"] })
			: reply(request, {
					writer: {
						handle: FIXTURE_WRITER,
						source: "herdsman-pi",
						incarnation: UUID_A,
						generation: 1,
						sequence: request.params.sequence,
					},
					context: { version: 1, agent_id: UUID_A },
					warning: null,
				}),
	);
	try {
		await listen(fixture);
		const client = fixture.client();
		const first = await client.context({
			agent_id: UUID_A,
			publisher: { source: "herdsman-pi", incarnation: UUID_A },
			sequence: 1,
			lease_ms: 30_000,
			context: { session: UUID_B },
		});
		assert.deepEqual(first, {
			ok: true,
			value: {
				writer: {
					handle: FIXTURE_WRITER,
					source: "herdsman-pi",
					incarnation: UUID_A,
					generation: 1,
					sequence: 1,
				},
			},
		});
		// A first publish omits both credentials the daemon would issue, and the
		// payload is the session alone.
		const sent = () =>
			fixture.requests.filter((request) => request.method === "agent.context");
		assert.equal("writer_handle" in sent()[0].params, false);
		assert.equal("replace" in sent()[0].params, false);
		assert.deepEqual(sent()[0].params.context, { session: UUID_B });

		// Once issued, the writer is presented again: a session switch is a newer
		// sequence under the same binding, never another subject.
		const second = await client.context({
			agent_id: UUID_A,
			publisher: { source: "herdsman-pi", incarnation: UUID_A },
			writer_handle: FIXTURE_WRITER,
			sequence: 2,
			context: { session: null },
		});
		assert.equal(sent()[1].params.writer_handle, FIXTURE_WRITER);
		assert.deepEqual(sent()[1].params.context, { session: null });
		assert.equal(second.ok, true);
	} finally {
		cleanup(fixture);
	}
});

test("the vendored daemon contract round-trips through this client", async () => {
	// The fixture answers one request shape twice — a session switch and its
	// identical replay — so each shape consumes its answers in the fixture's own
	// order rather than by method alone.
	const exchanges = fixtureExchanges().map((entry) => {
		const params = entry.request.params as {
			launch?: unknown;
		};
		// This client never sends the fixture's optional private launch
		// specification: it would put paths on the wire and advertises nothing this
		// client needs. Everything else is sent exactly as the fixture wrote it.
		const { launch, ...request } = materialise(params);
		return {
			method: entry.request.method,
			launch,
			key: `${entry.request.method}\u0000${JSON.stringify(request)}`,
			request,
			response: materialise(entry.response),
		};
	});
	const pending = new Map<string, typeof exchanges>();
	for (const exchange of exchanges)
		pending.set(exchange.key, [
			...(pending.get(exchange.key) ?? []),
			exchange,
		]);
	const byMethod = (method: string) =>
		exchanges.find((entry) => entry.method === method)!.request;
	const fixture = makeFixture((request) => {
		if (request.method === "ping")
			return reply(request, { protocol: 1, capabilities: ["agent_registry"] });
		const exchange = pending
			.get(`${request.method}\u0000${JSON.stringify(request.params)}`)
			?.shift();
		if (exchange === undefined)
			return refuse(
				request,
				"bad_params",
				`the fixture has no ${request.method} exchange for this request`,
			);
		return JSON.stringify({ ...exchange.response, id: request.id });
	});
	try {
		await listen(fixture);
		const client = fixture.client();

		// The fixture's registration exercises its optional private launch
		// specification, which this client omits.
		const registration = byMethod("agent.register");
		assert.ok(
			exchanges.find((entry) => entry.method === "agent.register")!.launch,
			"the fixture covers the optional launch specification",
		);
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

		// Every context exchange the fixture documents, in its own order: a first
		// publish, a switch, that switch's identical replay, an explicit null, and a
		// replacement of the retired or expired incumbent.
		const contextRequests = exchanges
			.filter((entry) => entry.method === "agent.context")
			.map((entry) => entry.request);
		const firstContext = contextRequests.find(
			(entry) => entry.writer_handle === undefined && entry.replace === undefined,
		)!;
		const switchedContext = contextRequests.find(
			(entry) => entry.writer_handle !== undefined && entry.context.session !== null,
		)!;
		const nullContext = contextRequests.find(
			(entry) => entry.context.session === null,
		)!;
		const replacementContext = contextRequests.find(
			(entry) => entry.replace !== undefined,
		)!;
		const incumbent = "1c2d3e4f-5678-4abc-9def-0123456789ab";
		assert.deepEqual(await client.context(firstContext), {
			ok: true,
			value: {
				writer: {
					handle: FIXTURE_WRITER,
					source: "herdsman",
					incarnation: incumbent,
					generation: 1,
					sequence: 1,
				},
			},
		});
		assert.deepEqual(await client.context(switchedContext), {
			ok: true,
			value: {
				writer: {
					handle: FIXTURE_WRITER,
					source: "herdsman",
					incarnation: incumbent,
					generation: 1,
					sequence: 2,
				},
			},
		});
		// The identical replay is answered, never refused, and renews no lease.
		assert.deepEqual(await client.context(switchedContext), {
			ok: true,
			value: {
				writer: {
					handle: FIXTURE_WRITER,
					source: "herdsman",
					incarnation: incumbent,
					generation: 1,
					sequence: 2,
				},
				warning: "<replay-warning>",
			},
		});
		// An explicit null is an accepted fact, not a missing one.
		assert.equal(
			(await client.context(nullContext)).ok,
			true,
			"an explicit null session is served",
		);
		// The replacement names the exact incumbent it observed and comes back as
		// the successor binding, one generation on.
		assert.deepEqual(await client.context(replacementContext), {
			ok: true,
			value: {
				writer: {
					handle: FIXTURE_SUCCESSOR,
					source: "herdsman",
					incarnation: "2c3d4e5f-6789-4abc-9def-0123456789ab",
					generation: 2,
					sequence: 1,
				},
			},
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
				[1, "agent.context", firstContext],
				[1, "agent.context", switchedContext],
				[1, "agent.context", switchedContext],
				[1, "agent.context", nullContext],
				[1, "agent.context", replacementContext],
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
