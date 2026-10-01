// Session-private control bridge for the declared CLI.
//
// The generated `pi-bg` helper is a shell process, so it cannot read the live
// task map: it needs to *ask*. The old channel was one-directional (a read
// receipt file the extension drained), which cannot answer `list`, cannot
// report readiness, and cannot confirm a stop. This module is the inbound half:
// one Unix socket per session lane, a minimal allowlisted request/response
// protocol, and the identity checks that keep one session from touching
// another's tasks.
//
// Boundaries chosen deliberately:
//
//   * No global daemon and no new dependency. The socket lives inside the
//     session's own lane directory, which is created 0700, so the endpoint is
//     as private as the task logs beside it. Omission from another process's
//     environment is behavioural scoping, not a security boundary.
//   * The bridge owns framing, protocol version, the operation allowlist, and
//     session identity. It owns no task semantics: the handler decides whether
//     a task exists, whether the caller's generation token is stale, and what a
//     prepared result contains. That keeps this module testable without an
//     extension host and keeps the lifecycle rules in one place.
//   * One request per connection, then close. A bounded line cap and a bounded
//     response cap mean a confused or hostile client cannot make the manager
//     buffer without limit, and no client can hold a long-lived subscription
//     open. Large output never travels in this channel: a full read hands off a
//     snapshot *descriptor* for the CLI to stream itself.
//   * Every failure is a value, not a throw. The client reports an unavailable
//     endpoint, a malformed request, and a foreign session the same way, which
//     is what lets the CLI keep completion unacknowledged rather than guess.

import { dirname } from "node:path";
import { mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";

export const BRIDGE_PROTOCOL_VERSION = 1;
/** Suffix every control socket shares, so a prune can recognise one without
 *  knowing which session owns it. */
export const BRIDGE_SOCKET_SUFFIX = ".sock";
/** Largest request line accepted, in bytes. A request is a few hundred. */
export const BRIDGE_MAX_REQUEST_BYTES = 64 * 1024;
/** Largest response line accepted by the client, in bytes. */
export const BRIDGE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** How long the server waits for a request line before closing the socket. */
export const BRIDGE_REQUEST_TIMEOUT_MS = 5_000;
/** How long the client waits for a connection and then for the response. */
export const BRIDGE_CLIENT_TIMEOUT_MS = 5_000;

/** The allowlisted operations. Adding one is a protocol change. */
export const BRIDGE_OPS = ["get", "list", "stop", "receipt"] as const;
export type BridgeOp = (typeof BRIDGE_OPS)[number];

export interface BridgeRequest {
	v: number;
	op: BridgeOp;
	/** Task id for `get` and `stop`. */
	id?: string;
	/** `full` asks for an immutable snapshot descriptor instead of a preview. */
	output?: "preview" | "full";
	/** Session token the client believes owns this endpoint. */
	session?: string;
	/** Task generation the client resolved earlier; a mismatch is stale. */
	generation?: string;
	/** For `receipt`: the prepared-result token, sent only after the output
	 *  handoff finished. */
	token?: string;
}

/** Why a request could not be served. Every one of these is a client outcome. */
export type BridgeErrorCode =
	| "malformed"
	| "unsupported-version"
	| "unsupported-op"
	| "foreign-session"
	| "unknown-task"
	| "stale-generation"
	| "expired"
	| "unconfirmed-stop"
	| "capture-incomplete"
	/**
	 * The session's receipt store is saturated with handoffs that cannot be
	 * retired, so a read could be served but never acknowledged. Distinct from
	 * `unavailable`: the endpoint answered, and the answer is that this read
	 * cannot be made settleable.
	 */
	| "capacity"
	| "unavailable"
	| "receipt-unaccepted"
	| "internal";

export interface BridgeFailure {
	code: BridgeErrorCode;
	message: string;
}

/** One task, as the CLI needs to report it. No live log path: the CLI is told
 *  what it may hand off, never where the mutable log lives. */
export interface BridgeTaskSummary {
	id: string;
	/** Opaque identity for this task *incarnation*; a replaced task with a
	 *  reused short id has a different one, which is what makes a stale
	 *  generation detectable. */
	generation: string;
	command: string;
	status: string;
	readiness: string;
	pid: number;
	startedAt: number;
	updatedAt: number;
	outputBytes: number;
	/** False when the capture is short or was never certified. */
	outputComplete: boolean;
}

/** The output half of a prepared result. */
export type BridgeOutputHandoff =
	| { kind: "preview"; text: string; truncated: boolean; partial: boolean }
	| { kind: "snapshot"; path: string; bytes: number; partial: boolean; complete: boolean };

export interface BridgeResultPayload {
	tasks?: BridgeTaskSummary[];
	task?: BridgeTaskSummary;
	output?: BridgeOutputHandoff;
	/** Set when the capture could not be certified: partial bytes are still
	 *  described above, this says they are not the complete output. */
	captureError?: string;
	/** Opaque token the client returns after a successful handoff. */
	receipt?: string;
	/** The receipt's answer: what the successful handoff committed, or that an
	 *  already-accepted token was replayed. */
	ack?: BridgeAck;
}

/**
 * The committed outcome of a successful output handoff. `committed` is what
 * this receipt settled, so a caller can tell an actual acknowledgment from a
 * review-only handoff and from an idempotent replay of either.
 */
export interface BridgeAck {
	acknowledged: boolean;
	reviewed: boolean;
	/** `terminal` committed the completion; `review` only reset the review
	 *  clock; `replayed` repeats an earlier accepted outcome; `none` settled
	 *  nothing (the prepared job could not be committed). */
	committed: "terminal" | "review" | "replayed" | "none";
	/** Where the record now stands, when the receipt settled it. */
	task?: BridgeTaskSummary;
}

export type BridgeHandlerResult =
	| { ok: true; result: BridgeResultPayload }
	| { ok: false; error: BridgeFailure };

export type BridgeHandler = (request: BridgeRequest) => Promise<BridgeHandlerResult>;

/** The wire response. `op` and `session` are echoed so a client cannot confuse
 *  one operation's payload with another's. */
export type BridgeWireResponse =
	| { v: number; ok: true; op: BridgeOp; session: string; result: BridgeResultPayload }
	| { v: number; ok: false; error: BridgeFailure };

export type BridgeClientOutcome =
	| { ok: true; response: BridgeWireResponse }
	| { ok: false; error: BridgeFailure };

export interface BridgeLogger {
	(error: unknown): void;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Task incarnation identity: the id plus the run it names. */
export function taskGeneration(task: { id: string; startedAt: number }): string {
	return `${task.id}@${task.startedAt}`;
}

/** Parse a request line. Returns the reason rather than throwing, so a
 *  malformed frame is an answerable outcome instead of a connection reset. */
export function parseBridgeRequest(line: string): { ok: true; request: BridgeRequest } | { ok: false; error: BridgeFailure } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { ok: false, error: { code: "malformed", message: "request is not JSON" } };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: { code: "malformed", message: "request must be a JSON object" } };
	}
	const record = parsed as Record<string, unknown>;
	if (record.v !== BRIDGE_PROTOCOL_VERSION) {
		return { ok: false, error: { code: "unsupported-version", message: `request protocol version ${String(record.v)} is not ${BRIDGE_PROTOCOL_VERSION}` } };
	}
	const op = record.op;
	if (typeof op !== "string" || !(BRIDGE_OPS as readonly string[]).includes(op)) {
		return { ok: false, error: { code: "unsupported-op", message: `op ${typeof op === "string" ? op : "(missing)"} is not one of ${BRIDGE_OPS.join(", ")}` } };
	}
	if ((op === "get" || op === "stop") && (typeof record.id !== "string" || record.id.trim() === "")) {
		return { ok: false, error: { code: "malformed", message: `op ${op} requires an id` } };
	}
	if (op === "receipt" && (typeof record.token !== "string" || record.token.trim() === "")) {
		return { ok: false, error: { code: "malformed", message: "op receipt requires a token" } };
	}
	if (op === "receipt" && record.output !== undefined) {
		return { ok: false, error: { code: "malformed", message: "op receipt does not take an output selection" } };
	}
	if (record.output !== undefined && record.output !== "preview" && record.output !== "full") {
		return { ok: false, error: { code: "malformed", message: "output must be \"preview\" or \"full\"" } };
	}
	if (record.session !== undefined && typeof record.session !== "string") {
		return { ok: false, error: { code: "malformed", message: "session must be a string" } };
	}
	if (record.generation !== undefined && typeof record.generation !== "string") {
		return { ok: false, error: { code: "malformed", message: "generation must be a string" } };
	}
	return {
		ok: true,
		request: {
			v: BRIDGE_PROTOCOL_VERSION,
			op: op as BridgeOp,
			id: typeof record.id === "string" ? record.id : undefined,
			output: record.output as "preview" | "full" | undefined,
			session: typeof record.session === "string" ? record.session : undefined,
			generation: typeof record.generation === "string" ? record.generation : undefined,
			token: typeof record.token === "string" ? record.token : undefined,
		},
	};
}

/** Validate a response line on the client side. */
export function parseBridgeResponse(line: string): BridgeClientOutcome {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { ok: false, error: { code: "malformed", message: "endpoint response is not JSON" } };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: { code: "malformed", message: "endpoint response must be a JSON object" } };
	}
	const record = parsed as Record<string, unknown>;
	if (record.v !== BRIDGE_PROTOCOL_VERSION) {
		return { ok: false, error: { code: "unsupported-version", message: `endpoint speaks protocol version ${String(record.v)}` } };
	}
	if (record.ok === false) {
		const error = record.error;
		const failure = error !== null && typeof error === "object" ? (error as { code?: unknown; message?: unknown }) : {};
		return {
			ok: false,
			error: {
				code: typeof failure.code === "string" ? (failure.code as BridgeErrorCode) : "internal",
				message: typeof failure.message === "string" ? failure.message : "unspecified failure",
			},
		};
	}
	if (record.ok !== true) {
		return { ok: false, error: { code: "malformed", message: "endpoint response has no ok flag" } };
	}
	return { ok: true, response: parsed as BridgeWireResponse };
}

export interface BridgeServer {
	socketPath: string;
	session: string;
	/** Resolve once the endpoint is listening (or once start failed, with the
	 *  reason) — a caller that does not check this must not assume serving. */
	start(): Promise<{ listening: boolean; reason?: string }>;
	stop(): Promise<void>;
}

export interface BridgeServerDeps {
	socketPath: string;
	session: string;
	handle: BridgeHandler;
	/** Keep the process from staying alive for the endpoint. Default true: the
	 *  manager has other reasons to live, and a CLI client must never be the
	 *  thing that keeps Pi up. */
	unref?: boolean;
	onError?: BridgeLogger;
}

/**
 * Session-private endpoint. A stale socket file from a dead process is
 * replaced; a *live* endpoint on the same path is left alone and reported,
 * because taking it over would silently drop the clients already talking to
 * it (same session id on two live processes is not a state we may resolve by
 * force).
 */
export function createBridgeServer(deps: BridgeServerDeps): BridgeServer {
	const handle = deps.handle;
	const connections = new Set<Socket>();
	const logError = deps.onError ?? (() => {});
	let server: Server | null = null;
	let serving = false;
	// Live connections, so stopping is bounded. A client that connects and then
	// lingers must never be able to hold shutdown open: session shutdown awaits
	// this stop, and an endpoint whose listener is closed but whose sockets are
	// not is not stopped.

	function writeResponse(socket: Socket, response: BridgeWireResponse): void {
		const line = `${JSON.stringify(response)}\n`;
		if (line.length > BRIDGE_MAX_RESPONSE_BYTES) {
			const oversized: BridgeWireResponse = {
				v: BRIDGE_PROTOCOL_VERSION,
				ok: false,
				error: { code: "internal", message: "response exceeds the bridge line cap; use a full snapshot handoff" },
			};
			socket.end(`${JSON.stringify(oversized)}\n`);
			return;
		}
		socket.end(line);
	}

	async function answer(socket: Socket, line: string): Promise<void> {
		const parsed = parseBridgeRequest(line);
		if (!parsed.ok) {
			writeResponse(socket, { v: BRIDGE_PROTOCOL_VERSION, ok: false, error: parsed.error });
			return;
		}
		const request = parsed.request;
		if (request.session !== undefined && request.session !== deps.session) {
			writeResponse(socket, {
				v: BRIDGE_PROTOCOL_VERSION,
				ok: false,
				error: {
					code: "foreign-session",
					message: `this endpoint serves session ${deps.session}; the request named ${request.session}`,
				},
			});
			return;
		}
		const outcome = await handle(request);
		if (outcome.ok) {
			writeResponse(socket, {
				v: BRIDGE_PROTOCOL_VERSION,
				ok: true,
				op: request.op,
				session: deps.session,
				result: outcome.result,
			});
			return;
		}
		writeResponse(socket, { v: BRIDGE_PROTOCOL_VERSION, ok: false, error: outcome.error });
	}

	function onConnection(socket: Socket): void {
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
		let buffer = "";
		let answered = false;
		socket.setEncoding("utf8");
		socket.setTimeout(BRIDGE_REQUEST_TIMEOUT_MS, () => {
			writeResponse(socket, {
				v: BRIDGE_PROTOCOL_VERSION,
				ok: false,
				error: { code: "malformed", message: "request line was not sent within the bridge timeout" },
			});
		});
		socket.on("error", (error) => {
			// A client that hangs up mid-request is not the manager's failure.
			logError(error);
		});
		socket.on("data", (chunk: string) => {
			if (answered) return;
			buffer += chunk;
			if (buffer.length > BRIDGE_MAX_REQUEST_BYTES) {
				answered = true;
				writeResponse(socket, {
					v: BRIDGE_PROTOCOL_VERSION,
					ok: false,
					error: { code: "malformed", message: "request exceeds the bridge line cap" },
				});
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			answered = true;
			const line = buffer.slice(0, newline);
			void answer(socket, line).catch((error: unknown) => {
				writeResponse(socket, {
					v: BRIDGE_PROTOCOL_VERSION,
					ok: false,
					error: { code: "internal", message: message(error) },
				});
			});
		});
	}

	return {
		session: deps.session,
		socketPath: deps.socketPath,
		async start() {
			if (serving) return { listening: true };
			const live = await probeBridge(deps.socketPath, { timeoutMs: 250 });
			if (live.ok) {
				return { listening: false, reason: `another endpoint is already serving ${deps.socketPath}` };
			}
			try {
				mkdirSync(dirname(deps.socketPath), { recursive: true, mode: 0o700 });
			} catch (error) {
				return { listening: false, reason: `socket directory unavailable: ${message(error)}` };
			}
			try {
				// A socket file left by a dead manager has no listener; only a
				// stale file reaches here, so replacing it is safe.
				unlinkSync(deps.socketPath);
			} catch {
				// Nothing stale to replace.
			}
			const created = createServer(onConnection);
			created.on("error", (error) => {
				serving = false;
				logError(error);
			});
			const started = await new Promise<{ listening: boolean; reason?: string }>((resolve) => {
				created.once("error", (error: NodeJS.ErrnoException) => resolve({ listening: false, reason: `endpoint unavailable: ${message(error)}` }));
				created.listen(deps.socketPath, () => resolve({ listening: true }));
			});
			if (!started.listening) {
				created.close();
				return started;
			}
			server = created;
			serving = true;
			if (deps.unref !== false) server.unref?.();
			return { listening: true };
		},
		async stop() {
			const active = server;
			server = null;
			serving = false;
			// Tear the live connections down *before* waiting on the listener: a
			// socket whose client is still attached keeps `close` pending, and
			// stopping happens on the session-shutdown path, which must not wait on a
			// client that may never hang up.
			for (const socket of [...connections]) socket.destroy();
			connections.clear();
			if (active) await new Promise<void>((resolve) => active.close(() => resolve()));
			try {
				unlinkSync(deps.socketPath);
			} catch {
				// Already gone: stopping is idempotent.
			}
		},
	};
}

export interface BridgeClientDeps {
	socketPath: string;
	session?: string;
	timeoutMs?: number;
}

/**
 * One request, one response, then close. Never rejects: an unreachable or
 * silent endpoint is an outcome the CLI must report, not an exception to
 * interpret, and it is what keeps a failed handoff from looking like success.
 */
export function requestBridge(deps: BridgeClientDeps, request: Omit<BridgeRequest, "v" | "session">): Promise<BridgeClientOutcome> {
	const timeoutMs = deps.timeoutMs ?? BRIDGE_CLIENT_TIMEOUT_MS;
	const line = `${JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, session: deps.session, ...request })}\n`;
	return new Promise<BridgeClientOutcome>((resolve) => {
		let settled = false;
		let buffer = "";
		const socket = connect(deps.socketPath);
		const finish = (outcome: BridgeClientOutcome): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(outcome);
		};
		// A socket-level deadline rather than a global timer: the bound belongs to
		// this connection, and a manager that starts an endpoint must not leave
		// stray loop timers behind for it (the session-start probe is one connect).
		socket.setTimeout(timeoutMs, () => {
			finish({ ok: false, error: { code: "unavailable", message: `endpoint did not answer within ${timeoutMs}ms` } });
		});
		socket.setEncoding("utf8");
		socket.on("error", (error: NodeJS.ErrnoException) => {
			finish({
				ok: false,
				error: {
					code: error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "unavailable" : "internal",
					message: `endpoint ${deps.socketPath} unavailable: ${message(error)}`,
				},
			});
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > BRIDGE_MAX_RESPONSE_BYTES) {
				finish({ ok: false, error: { code: "malformed", message: "endpoint response exceeds the bridge line cap" } });
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			finish(parseBridgeResponse(buffer.slice(0, newline)));
		});
		socket.on("close", () => {
			finish({ ok: false, error: { code: "malformed", message: "endpoint closed without a response" } });
		});
		socket.on("connect", () => socket.write(line));
	});
}

/** Whether a live endpoint is serving this path (used to avoid replacing one). */
export function probeBridge(socketPath: string, options: { timeoutMs?: number } = {}): Promise<BridgeClientOutcome> {
	return requestBridge({ socketPath, timeoutMs: options.timeoutMs ?? 250 }, { op: "list" });
}
