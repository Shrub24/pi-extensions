import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { type PaneFactTask, type TaskPhase, taskPhase, unresolvedTasks } from "./pane-facts.js";
import type { BackgroundTaskSnapshot } from "./types.js";

/**
 * Publisher half of Agent Radar's local bus (agent-radar `docs/radar-bus.md`,
 * v1). Per-task detail that does not fit in Herdr's pane tokens goes to Radar
 * over a private unix socket.
 *
 * Passive and best-effort: it reads task state and never changes it, it never
 * reads what Radar sends, and nothing here can fail or delay a turn, a task, a
 * wake or a result. `command` and `cwd` are sent bounded, for an operator-only
 * surface that already shows the same thing in the task dashboard; a log path
 * is never sent.
 */
export const BUS_VERSION = 1;
export const THROTTLE_MS = 1_000;
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

export type BusTask = {
	id: string;
	state: TaskPhase;
	command?: string;
	cwd?: string;
	pid?: number;
	started_at: number;
	last_output_at?: number;
	output_bytes: number;
	exit_code?: number;
};

export type BusSourceTask = PaneFactTask &
	Pick<BackgroundTaskSnapshot, "command" | "cwd" | "pid" | "lastOutputAt" | "outputBytes" | "exitCode">;

/** Radar's obligation 6: `command` and `cwd` are bounded, being the only sensitive fields sent. */
export const MAX_CONTENT_CHARS = 256;

/**
 * The unresolved tasks, in the bus's field names; absent fields are omitted,
 * never null. A `tasks` message is the complete list, so this never truncates.
 */
export function busTasks(tasks: readonly BusSourceTask[]): BusTask[] {
	return unresolvedTasks(tasks).map((task) => {
		const state = taskPhase(task);
		return {
			id: task.id,
			state,
			// The row's only human-useful content. Bounded per Radar's obligation 6.
			...(task.command ? { command: task.command.slice(0, MAX_CONTENT_CHARS) } : {}),
			...(task.cwd ? { cwd: task.cwd.slice(0, MAX_CONTENT_CHARS) } : {}),
			// A pid is only meaningful while the process is alive.
			...(state === "running" && task.pid > 0 ? { pid: task.pid } : {}),
			started_at: task.startedAt,
			...(task.lastOutputAt === null ? {} : { last_output_at: task.lastOutputAt }),
			output_bytes: task.outputBytes,
			...(task.exitCode === null ? {} : { exit_code: task.exitCode }),
		};
	});
}

export function helloLine(session: string, pane: string | undefined): string {
	return `${JSON.stringify({ type: "hello", v: BUS_VERSION, session, ...(pane ? { pane } : {}), ops: [] })}\n`;
}

export function tasksLine(tasks: readonly BusTask[]): string {
	return `${JSON.stringify({ type: "tasks", tasks })}\n`;
}

/** Radar's binding order: explicit override, then the runtime directory, then a per-uid /tmp directory. */
export function radarSocketPath(env: NodeJS.ProcessEnv, uid: number): { path: string; trusted: boolean } {
	const override = env.RADAR_SOCKET?.trim();
	if (override) return { path: override, trusted: true };
	const runtime = env.XDG_RUNTIME_DIR?.trim();
	const dir = runtime ? join(runtime, "agent-radar") : `/tmp/agent-radar-${uid}`;
	return { path: join(dir, "radar.sock"), trusted: false };
}

/** Owned by this user, mode 0700, not a symlink: anything else could be a squatter that would receive our data. */
export function directoryIsTrusted(dir: string, uid: number): boolean {
	try {
		const stat = lstatSync(dir);
		return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o777) === 0o700;
	} catch {
		return false;
	}
}

export type BusSocket = {
	write(line: string): boolean;
	end(): void;
	destroy(): void;
	on(event: "connect" | "close" | "error" | "drain", listener: () => void): unknown;
	/** Absent on sockets whose peer cannot apply back-pressure. */
	writableNeedDrain?: boolean;
};

export type RadarBusOptions = {
	env?: NodeJS.ProcessEnv;
	uid?: number;
	dial?: (path: string) => BusSocket;
	trustedDirectory?: (dir: string, uid: number) => boolean;
	throttleMs?: number;
	reconnectMinMs?: number;
	reconnectMaxMs?: number;
};

/** The ids and phase words: a change to either is one Radar has to see at once. */
const sameShape = (a: readonly BusTask[], b: readonly BusTask[]): boolean =>
	a.length === b.length && a.every((task, index) => task.id === b[index]!.id && task.state === b[index]!.state);

/** Every published field equal: the list already on the wire says exactly this. */
const sameList = (a: readonly BusTask[], b: readonly BusTask[]): boolean =>
	sameShape(a, b) &&
	a.every(
		(task, index) =>
			task.command === b[index]!.command &&
			task.cwd === b[index]!.cwd &&
			task.pid === b[index]!.pid &&
			task.started_at === b[index]!.started_at &&
			task.last_output_at === b[index]!.last_output_at &&
			task.output_bytes === b[index]!.output_bytes &&
			task.exit_code === b[index]!.exit_code,
	);

/**
 * One connection per Pi session and one writer on it. Only the latest complete
 * list is kept: each `tasks` message replaces the previous, so a superseded
 * list never needs to be sent, and memory stays bounded however slow Radar is.
 */
export function createRadarBusPublisher(options: RadarBusOptions = {}) {
	const env = options.env ?? process.env;
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const dial = options.dial ?? ((path: string): BusSocket => createConnection(path) as unknown as BusSocket);
	const trustedDirectory = options.trustedDirectory ?? directoryIsTrusted;
	const throttleMs = options.throttleMs ?? THROTTLE_MS;
	const reconnectMin = options.reconnectMinMs ?? RECONNECT_MIN_MS;
	const reconnectMax = options.reconnectMaxMs ?? RECONNECT_MAX_MS;

	let session: string | undefined;
	let pane: string | undefined;
	let latest: BusTask[] = [];
	let socket: BusSocket | undefined;
	let connected = false;
	let helloSent = false;
	let lastSent: BusTask[] | undefined;
	let lastSentAt = 0;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let backoff = reconnectMin;
	let closed = false;

	const clearTimers = (): void => {
		if (flushTimer !== undefined) clearTimeout(flushTimer);
		if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
		flushTimer = undefined;
		reconnectTimer = undefined;
	};

	const drop = (): void => {
		const current = socket;
		socket = undefined;
		connected = false;
		helloSent = false;
		lastSent = undefined;
		try {
			current?.destroy();
		} catch {
			// A socket that will not close is already unusable.
		}
	};

	const send = (): void => {
		if (!socket || !connected || !session) return;
		if (socket.writableNeedDrain) return;
		try {
			if (!helloSent) {
				socket.write(helloLine(session, pane));
				helloSent = true;
			}
			socket.write(tasksLine(latest));
			lastSent = latest;
			lastSentAt = Date.now();
		} catch {
			drop();
			scheduleReconnect();
		}
	};

	/** Set or state changes go out at once; counter-only churn waits for the throttle window. */
	const sendWhenDue = (): void => {
		// The wire already carries exactly this list, counters included.
		if (lastSent !== undefined && sameList(lastSent, latest)) return;
		const promptly = lastSent === undefined || !sameShape(lastSent, latest);
		if (flushTimer !== undefined) {
			// A set or state change is never held behind a pending counter window.
			if (!promptly) return;
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		const wait = promptly ? 0 : Math.max(0, throttleMs - (Date.now() - lastSentAt));
		if (wait === 0) return send();
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			send();
		}, wait);
		flushTimer.unref?.();
	};

	const scheduleReconnect = (): void => {
		// Nothing outstanding means nothing to say; Radar already cleared the rows when the connection closed.
		if (closed || reconnectTimer !== undefined || latest.length === 0) return;
		const delay = backoff;
		backoff = Math.min(backoff * 2, reconnectMax);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			connect();
		}, delay);
		reconnectTimer.unref?.();
	};

	const connect = (): void => {
		if (closed || socket || !session || latest.length === 0) return;
		const target = radarSocketPath(env, uid);
		// A directory that fails the trust check is not a target to retry in the
		// background: it is not dialled, it holds no timer, and the next update
		// re-resolves the path — which is how a Radar started later is picked up.
		if (!target.trusted && !trustedDirectory(join(target.path, ".."), uid)) return;
		try {
			const dialled = dial(target.path);
			socket = dialled;
			dialled.on("connect", () => {
				if (socket !== dialled) return;
				connected = true;
				backoff = reconnectMin;
				send();
			});
			dialled.on("drain", () => {
				if (socket === dialled) send();
			});
			const gone = (): void => {
				if (socket !== dialled) return;
				drop();
				scheduleReconnect();
			};
			dialled.on("close", gone);
			dialled.on("error", gone);
		} catch {
			drop();
			scheduleReconnect();
		}
	};

	return {
		/** Publish the session's current unresolved tasks; never throws, never blocks. */
		update(sessionId: string, paneId: string | undefined, tasks: readonly BusTask[]): void {
			if (closed) return;
			if (session !== undefined && session !== sessionId) {
				// A new session id (`/new`, `/resume`) is a new connection with its own hello.
				clearTimers();
				drop();
			}
			session = sessionId;
			pane = paneId;
			latest = [...tasks];
			// A session that has never had a task opens no connection.
			if (!socket && latest.length === 0) return;
			if (!socket) return connect();
			sendWhenDue();
		},
		close(): void {
			closed = true;
			clearTimers();
			try {
				socket?.end();
			} catch {
				// Closing is best-effort.
			}
			drop();
		},
	};
}
