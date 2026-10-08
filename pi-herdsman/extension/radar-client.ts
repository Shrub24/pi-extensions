import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

/**
 * Transport for Radar's direct agent registry (agent-radar
 * `docs/agent-registration.md`, contract version 1).
 *
 * One connection per call, one canonical-UUID request, exactly one matching
 * reply, bounded on both sides. Nothing here is a mux client: only the registry
 * methods this port publishes through are implemented. Every call reports a
 * discriminated outcome instead of throwing, because the daemon is optional and
 * its absence must never reach a caller's control flow.
 */
export const RADAR_PROTOCOL_VERSION = 1;
export const RADAR_REGISTRY_CAPABILITY = "agent_registry";
/** The daemon's own line bound; nothing longer is sent or accepted. */
export const RADAR_MAX_LINE_BYTES = 1024 * 1024;
export const RADAR_CALL_TIMEOUT_MS = 2_000;

export type RadarChannel = "execution" | "assignment";

/**
 * `absent` is this process's trusted-socket check refusing to dial; `timeout`,
 * `transport`, `protocol` and `unsupported` are local outcomes. Every other
 * value is the daemon's own refusal code passed through unchanged, because a
 * publisher has to tell fencing (`refused`) from a daemon that lost the record
 * (`not_found`) and from one that is merely missing (`absent`).
 */
export type RadarErrorCode =
	| "absent"
	| "timeout"
	| "transport"
	| "protocol"
	| "unsupported"
	| "bad_version"
	| "bad_request"
	| "bad_params"
	| "unknown_method"
	| "refused"
	| "not_found"
	| "busy"
	| "backend_unavailable"
	| "internal";

/** The daemon's refusal codes (`control_plane::protocol::Code`). */
const DAEMON_ERROR_CODES: readonly RadarErrorCode[] = [
	"bad_version",
	"bad_request",
	"bad_params",
	"unknown_method",
	"refused",
	"not_found",
	"busy",
	"backend_unavailable",
	"internal",
];

export type RadarResult<T> =
	| { ok: true; value: T }
	| { ok: false; code: RadarErrorCode; message: string };

export type RadarLocation = {
	backend: string;
	instance?: string;
	workspace?: string;
	tab?: string;
	pane?: string;
};

export type RadarProcessClaim = {
	boot_id: string;
	pid: number;
	start_ticks: number;
};

/** The immutable registration request. Nothing mutable belongs here. */
export type RadarRegistration = {
	source: string;
	incarnation: string;
	session?: string;
	owner?: string;
	run?: string;
	label?: string;
	location?: RadarLocation;
	process?: RadarProcessClaim;
};

export type RadarPublisherIdentity = {
	source: string;
	incarnation: string;
	reporting_owner?: string;
};

/**
 * One complete published snapshot. `actions` is part of the wire but this port
 * advertises none: the plan's action decision is still open, and a truncated
 * list would advertise less capability than the subject has.
 */
export type RadarSnapshot = {
	activity: string;
	waiting_reason?: string;
	last_outcome?: { result: string; detail?: string };
};

export type RadarWriterBinding = {
	handle: string;
	source: string;
	incarnation: string;
	reporting_owner?: string;
	generation: number;
	sequence: number;
	retired_at?: string;
};

export type RadarCapabilities = {
	protocol: number;
	backend?: string;
	capabilities: string[];
};

export type RadarTimer = { unref?: () => void };
export type RadarScheduler = {
	setTimeout(handler: () => void, ms: number): RadarTimer;
	clearTimeout(timer: RadarTimer): void;
	setInterval(handler: () => void, ms: number): RadarTimer;
	clearInterval(timer: RadarTimer): void;
	now(): number;
};

export const systemScheduler: RadarScheduler = {
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
	setInterval: (handler, ms) => setInterval(handler, ms),
	clearInterval: (timer) =>
		clearInterval(timer as ReturnType<typeof setInterval>),
	now: () => Date.now(),
};

export type RadarSocket = {
	write(line: string): unknown;
	destroy(): void;
	on(
		event: "connect" | "error" | "close" | "data",
		listener: (value?: unknown) => void,
	): unknown;
};

export type RadarDial = (path: string) => RadarSocket;

/** `RADAR_CONTROL_SOCKET`, then the runtime directory, then the per-uid fallback. */
export function radarControlSocketPath(
	env: NodeJS.ProcessEnv,
	uid: number,
): { path: string; explicit: boolean } {
	const override = env.RADAR_CONTROL_SOCKET?.trim();
	if (override) return { path: override, explicit: true };
	const runtime = env.XDG_RUNTIME_DIR?.trim();
	const directory = runtime
		? join(runtime, "agent-radar")
		: `/tmp/agent-radar-${uid}`;
	return { path: join(directory, "control.sock"), explicit: false };
}

/**
 * Why this path may not be dialled, or `undefined` when it may.
 *
 * Filesystem trust is not authentication between same-uid processes, but a path
 * another process could have planted must not receive publication content. A
 * path that fails the check is simply not a target: nothing is dialled and no
 * timer is held for it.
 */
export function untrustedControlSocket(
	path: string,
	uid: number,
): string | undefined {
	const directory = dirname(path);
	try {
		const parent = lstatSync(directory);
		if (parent.isSymbolicLink() || !parent.isDirectory())
			return `${directory} is not a real directory`;
		if (parent.uid !== uid)
			return `${directory} is not owned by uid ${uid}`;
		if ((parent.mode & 0o777) !== 0o700)
			return `${directory} is not mode 0700`;
		const socket = lstatSync(path);
		if (socket.isSymbolicLink()) return `${path} is a symlink`;
		if (!socket.isSocket()) return `${path} is not a socket`;
		if (socket.uid !== uid) return `${path} is not owned by uid ${uid}`;
		return undefined;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code ?? "unavailable";
		return `${path} is unavailable (${code})`;
	}
}

function protocol(message: string): RadarResult<never> {
	return { ok: false, code: "protocol", message };
}

function bounded(text: string, bytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= bytes) return text;
	let end = text.length;
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > bytes)
		end -= 1;
	return text.slice(0, end);
}

function decodeReply(
	line: string,
	requestId: string,
): RadarResult<unknown> {
	if (Buffer.byteLength(line, "utf8") > RADAR_MAX_LINE_BYTES)
		return protocol("reply exceeds the control-plane line bound");
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return protocol("reply is not JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return protocol("reply is not an object");
	const answer = parsed as Record<string, unknown>;
	if (answer.id !== requestId)
		return protocol("reply does not match the request id");
	if (answer.error !== undefined) {
		const error = answer.error as Record<string, unknown> | undefined;
		const code = error?.code;
		const message = error?.message;
		return {
			ok: false,
			code:
				typeof code === "string" &&
				DAEMON_ERROR_CODES.includes(code as RadarErrorCode)
					? (code as RadarErrorCode)
					: "internal",
			message: `${typeof code === "string" ? code : "error"}: ${
				typeof message === "string" ? message : "no message"
			}`,
		};
	}
	if (!("result" in answer)) return protocol("reply carries no result");
	return { ok: true, value: answer.result };
}

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

function stringAt(value: unknown, field: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const found = (value as Record<string, unknown>)[field];
	return typeof found === "string" ? found : undefined;
}

function numberAt(value: unknown, field: string): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const found = (value as Record<string, unknown>)[field];
	return typeof found === "number" && Number.isFinite(found)
		? found
		: undefined;
}

export type RadarClient = {
	socketPath(): string;
	ping(): Promise<RadarResult<RadarCapabilities>>;
	register(
		registration: RadarRegistration,
	): Promise<RadarResult<{ agent_id: string }>>;
	acquire(request: {
		agent_id: string;
		channel: RadarChannel;
		publisher: RadarPublisherIdentity;
		replace?: { generation: number; handle: string };
	}): Promise<RadarResult<RadarWriterBinding>>;
	publish(request: {
		agent_id: string;
		channel: RadarChannel;
		writer_handle: string;
		sequence: number;
		lease_ms?: number;
		observed_at?: string;
		snapshot: RadarSnapshot;
	}): Promise<RadarResult<{ sequence: number }>>;
	retire(request: {
		agent_id: string;
		channel: RadarChannel;
		writer_handle: string;
	}): Promise<RadarResult<void>>;
};

export type RadarClientOptions = {
	env?: NodeJS.ProcessEnv;
	uid?: number;
	dial?: RadarDial;
	scheduler?: RadarScheduler;
	timeoutMs?: number;
};

export function createRadarClient(options: RadarClientOptions = {}): RadarClient {
	const env = options.env ?? process.env;
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const scheduler = options.scheduler ?? systemScheduler;
	const timeoutMs = options.timeoutMs ?? RADAR_CALL_TIMEOUT_MS;
	const dial =
		options.dial ?? ((path: string) => createConnection(path) as unknown as RadarSocket);

	const currentPath = (): string => radarControlSocketPath(env, uid).path;

	async function call(
		method: string,
		params: Record<string, unknown>,
	): Promise<RadarResult<unknown>> {
		const path = currentPath();
		const refused = untrustedControlSocket(path, uid);
		if (refused !== undefined)
			return { ok: false, code: "absent", message: refused };
		const id = randomUUID();
		const line = `${JSON.stringify({
			version: RADAR_PROTOCOL_VERSION,
			id,
			method,
			params,
		})}\n`;
		if (Buffer.byteLength(line, "utf8") - 1 > RADAR_MAX_LINE_BYTES)
			return {
				ok: false,
				code: "bad_params",
				message: "request exceeds the control-plane line bound",
			};
		return new Promise<RadarResult<unknown>>((resolve) => {
			let settled = false;
			let socket: RadarSocket | undefined;
			let timer: RadarTimer | undefined;
			let received = 0;
			const chunks: Buffer[] = [];
			const finish = (result: RadarResult<unknown>): void => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) scheduler.clearTimeout(timer);
				try {
					socket?.destroy();
				} catch {
					// A socket that will not close is already unusable.
				}
				resolve(result);
			};
			try {
				socket = dial(path);
			} catch (error) {
				finish({
					ok: false,
					code: "transport",
					message: String((error as Error)?.message ?? error),
				});
				return;
			}
			timer = scheduler.setTimeout(() => {
				finish({
					ok: false,
					code: "timeout",
					message: `${method} got no reply within ${timeoutMs}ms`,
				});
			}, timeoutMs);
			timer.unref?.();
			socket.on("error", (error) => {
				finish({
					ok: false,
					code: "transport",
					message: String((error as Error)?.message ?? error),
				});
			});
			socket.on("close", () => {
				finish({
					ok: false,
					code: "transport",
					message: `${method} connection closed without a reply`,
				});
			});
			socket.on("connect", () => {
				try {
					socket?.write(line);
				} catch (error) {
					finish({
						ok: false,
						code: "transport",
						message: String((error as Error)?.message ?? error),
					});
				}
			});
			socket.on("data", (value) => {
				const chunk = Buffer.isBuffer(value)
					? value
					: Buffer.from(String(value ?? ""), "utf8");
				received += chunk.length;
				if (received > RADAR_MAX_LINE_BYTES + 1) {
					finish(protocol("reply exceeds the control-plane line bound"));
					return;
				}
				chunks.push(chunk);
				const text = Buffer.concat(chunks).toString("utf8");
				const end = text.indexOf("\n");
				if (end < 0) return;
				finish(decodeReply(text.slice(0, end), id));
			});
		});
	}

	const socketPath = currentPath;

	let capabilities: Promise<RadarResult<RadarCapabilities>> | undefined;
	const ping = async (): Promise<RadarResult<RadarCapabilities>> => {
		const answer = await call("ping", {});
			if (!answer.ok) return answer;
			const protocolVersion = numberAt(answer.value, "protocol");
			if (protocolVersion !== RADAR_PROTOCOL_VERSION)
				return {
					ok: false,
					code: "unsupported",
					message: `the daemon at ${currentPath()} speaks protocol ${
						protocolVersion ?? "unknown"
					}, not ${RADAR_PROTOCOL_VERSION}`,
				};
			const capabilities = Array.isArray(
				(answer.value as { capabilities?: unknown }).capabilities,
			)
				? ((answer.value as { capabilities: unknown[] }).capabilities.filter(
						(name): name is string => typeof name === "string",
					) as string[])
				: [];
			if (!capabilities.includes(RADAR_REGISTRY_CAPABILITY))
				return {
					ok: false,
					code: "unsupported",
					message: `the daemon at ${currentPath()} does not provide \`${RADAR_REGISTRY_CAPABILITY}\``,
				};
		return {
			ok: true,
			value: {
				protocol: protocolVersion,
				...(stringAt(answer.value, "backend") !== undefined
					? { backend: stringAt(answer.value, "backend") }
					: {}),
				capabilities,
			},
		};
	};
	const negotiated = async (): Promise<RadarResult<void>> => {
		capabilities ??= ping();
		const attempt = capabilities;
		try {
			const result = await attempt;
			if (!result.ok && capabilities === attempt) capabilities = undefined;
			return result.ok ? { ok: true, value: undefined } : result;
		} catch (error) {
			if (capabilities === attempt) capabilities = undefined;
			throw error;
		}
	};
	const withRegistry = async <T>(
		operation: () => Promise<RadarResult<T>>,
	): Promise<RadarResult<T>> => {
		const ready = await negotiated();
		return ready.ok ? operation() : ready;
	};

	return {
		socketPath,
		ping,
		async register(registration) {
			return withRegistry(async () => {
				const answer = await call("agent.register", {
					source: registration.source,
					incarnation: registration.incarnation,
					...(registration.session !== undefined
						? { session: registration.session }
						: {}),
					...(registration.owner !== undefined ? { owner: registration.owner } : {}),
					...(registration.run !== undefined ? { run: registration.run } : {}),
					...(registration.label !== undefined ? { label: registration.label } : {}),
					...(registration.location !== undefined ? { location: registration.location } : {}),
					...(registration.process !== undefined ? { process: registration.process } : {}),
				});
				if (!answer.ok) return answer;
				const record = (answer.value as { registration?: unknown }).registration;
				const agentId = stringAt(record, "agent_id");
				if (!isUuid(agentId)) return protocol("registration reply carries no agent_id");
				return { ok: true, value: { agent_id: agentId } };
			});
		},
		async acquire(request) {
			return withRegistry(async () => {
				const answer = await call("agent.acquire", {
					agent_id: request.agent_id,
					channel: request.channel,
					publisher: request.publisher,
					...(request.replace !== undefined ? { replace: request.replace } : {}),
				});
				if (!answer.ok) return answer;
				const writer = (answer.value as { writer?: unknown }).writer;
				const handle = stringAt(writer, "handle");
				const generation = numberAt(writer, "generation");
				if (!isUuid(handle) || generation === undefined || numberAt(writer, "sequence") === undefined || stringAt(writer, "source") === undefined || stringAt(writer, "incarnation") === undefined)
					return protocol("acquire reply carries no writer binding");
				return { ok: true, value: {
					handle,
					source: stringAt(writer, "source") ?? "",
					incarnation: stringAt(writer, "incarnation") ?? "",
					...(stringAt(writer, "reporting_owner") !== undefined ? { reporting_owner: stringAt(writer, "reporting_owner") } : {}),
					generation,
					sequence: numberAt(writer, "sequence") ?? 0,
					...(stringAt(writer, "retired_at") !== undefined ? { retired_at: stringAt(writer, "retired_at") } : {}),
				} };
			});
		},
		async publish(request) {
			return withRegistry(async () => {
				const answer = await call("agent.publish", {
					agent_id: request.agent_id,
					channel: request.channel,
					writer_handle: request.writer_handle,
					sequence: request.sequence,
					...(request.lease_ms !== undefined ? { lease_ms: request.lease_ms } : {}),
					...(request.observed_at !== undefined ? { observed_at: request.observed_at } : {}),
					snapshot: request.snapshot,
				});
				if (!answer.ok) return answer;
				const channel = (answer.value as { channel?: unknown }).channel;
				const writer = (channel as { writer?: unknown } | undefined)?.writer;
				const sequence = numberAt(writer, "sequence");
				if (sequence === undefined) return protocol("publish reply carries no accepted sequence");
				return { ok: true, value: { sequence } };
			});
		},
		async retire(request) {
			return withRegistry(async () => {
				const answer = await call("agent.retire", request);
				return answer.ok ? { ok: true, value: undefined } : answer;
			});
		},
	};
}

export function boundedRadarSnapshot(snapshot: RadarSnapshot): RadarSnapshot {
	const text = (value: string): string => bounded(value, 1024);
	return {
		activity: text(snapshot.activity),
		...(snapshot.waiting_reason !== undefined
			? { waiting_reason: text(snapshot.waiting_reason) }
			: {}),
		...(snapshot.last_outcome !== undefined
			? {
					last_outcome: {
						result: text(snapshot.last_outcome.result),
						...(snapshot.last_outcome.detail !== undefined
							? { detail: text(snapshot.last_outcome.detail) }
							: {}),
					},
				}
			: {}),
	};
}
