/*
 * A minimal MCP stdio client for the codebase-memory server.
 *
 * There is no MCP SDK here on purpose. The server speaks newline-delimited
 * JSON-RPC and the client needs exactly three methods: `initialize`,
 * `notifications/initialized`, and `tools/call`. A dependency would cost more
 * than the protocol does.
 *
 * Connecting is the point: the server's auto-index and watcher registration
 * happen on `initialize`, and that path only exists in server mode. One-shot
 * `cbm cli` calls never reach it.
 *
 * Transport failures are marked so the caller can retry once on a fresh child;
 * protocol errors (a bad argument, a missing project) are reported as they are.
 */

import { spawn, type ChildProcess } from "node:child_process";

export type ServerState = "stopped" | "connecting" | "ready" | "failed";

export interface ServerOptions {
	/** Executable name or path. */
	binary: string;
	/** Directory the server treats as the session root. */
	cwd: string;
	/** Per-call timeout in milliseconds; 0 disables it. */
	requestTimeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

export interface ToolResult {
	content?: Array<{ type: string; text?: string }>;
	structuredContent?: unknown;
	isError?: boolean;
	[key: string]: unknown;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/** True when the failure came from the transport, not from the tool. */
export class TransportError extends Error {
	readonly transport = true;
	constructor(message: string) {
		super(message);
		this.name = "TransportError";
	}
}

const PROTOCOL_VERSION = "2025-06-18";
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Lines of server stderr kept for the error message. */
const STDERR_TAIL_LINES = 20;

export class CbmServer {
	state: ServerState = "stopped";
	lastError: string | undefined;
	pid: number | undefined;
	connectedAt: number | undefined;

	private child: ChildProcess | null = null;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private stderrTail: string[] = [];
	private connectPromise: Promise<void> | null = null;
	private stopped = false;
	private stdoutBuffer = "";
	/**
	 * True while the child is being torn down. Stream errors are then expected
	 * (the pipe is gone) and must not be re-reported or, worse, left without a
	 * listener — an unhandled 'error' event would take the host process down.
	 */
	private tearingDown = false;

	constructor(private readonly options: ServerOptions) {}

	/** Spawn the child and complete the MCP handshake. Idempotent. */
	connect(): Promise<void> {
		if (this.stopped) return Promise.reject(new Error("cbm server is stopped"));
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = this.handshake().catch((error: Error) => {
			this.connectPromise = null;
			throw error;
		});
		return this.connectPromise;
	}

	/** Call one tool, reconnecting once if the child died mid-flight. */
	async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
		try {
			return await this.attempt(tool, args, signal);
		} catch (error) {
			const err = error as Error & { transport?: boolean };
			if (this.stopped || signal?.aborted || !err.transport) throw err;
			// The child is gone. A fresh one is cheap and preserves the call.
			this.teardown();
			await this.connect();
			return await this.attempt(tool, args, signal);
		}
	}

	/** Kill the child. Safe to call repeatedly. */
	stop(): void {
		this.stopped = true;
		this.teardown();
	}

	private async attempt(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
		if (this.stopped) throw new TransportError("cbm server is stopped");
		if (!this.child) await this.connect();
		if (signal?.aborted) throw new Error("aborted");

		const id = this.nextId++;
		const params = { name: tool, arguments: args };
		const result = await this.request<ToolResult>(id, "tools/call", params, signal);
		return result ?? {};
	}

	private async handshake(): Promise<void> {
		this.state = "connecting";
		this.spawnChild();
		try {
			await this.request(
				this.nextId++,
				"initialize",
				{
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "pi-cbmem", version: "0.1.0" },
				},
				undefined,
				HANDSHAKE_TIMEOUT_MS,
			);
			this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
			this.state = "ready";
			this.connectedAt = Date.now();
		} catch (error) {
			this.lastError = (error as Error).message;
			this.state = "failed";
			this.teardown();
			throw error;
		}
	}

	private spawnChild(): void {
		const child = spawn(this.options.binary, [], {
			cwd: this.options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			// The server logs to stderr; a quiet level keeps a healthy session silent.
			env: { ...(this.options.env ?? process.env), CBM_LOG_LEVEL: "error" },
		});
		this.child = child;
		this.pid = child.pid ?? undefined;

		child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
		child.stdout?.on("error", () => {
			/* the failure arrives through 'close' */
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail.push(chunk.toString());
			while (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
		});
		child.stderr?.on("error", () => {
			/* the failure arrives through 'close' */
		});
		// A write to a closed pipe arrives as an async 'error' event on the stream.
		// Without a listener it is an uncaught exception, so a shutdown that races
		// an in-flight request would take the whole host process down.
		child.stdin?.on("error", (error: Error) => {
			if (this.tearingDown) return;
			this.failPending(new TransportError(`${this.options.binary}: ${error.message}`));
		});
		child.on("error", (error: Error) => {
			this.lastError = `${this.options.binary}: ${error.message}`;
			this.state = "failed";
			this.failPending(new TransportError(this.lastError));
		});
		child.on("close", (code: number | null) => {
			const tail = this.stderrTail.join("").trim();
			const detail = `${this.options.binary} exited (code ${code ?? "signal"})${tail ? `: ${tail}` : ""}`;
			if (!this.stopped) {
				this.lastError = detail;
				this.state = "failed";
			}
			this.teardown();
			this.failPending(new TransportError(detail));
		});
	}

	private onStdout(chunk: Buffer): void {
		this.stdoutBuffer += chunk.toString();
		let index: number;
		while ((index = this.stdoutBuffer.indexOf("\n")) >= 0) {
			const line = this.stdoutBuffer.slice(0, index).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
			if (line) this.onLine(line);
		}
	}

	private onLine(line: string): void {
		let message: { id?: number | null; result?: unknown; error?: { message?: string } };
		try {
			message = JSON.parse(line);
		} catch {
			return; // not ours to interpret
		}
		if (message.id === undefined || message.id === null) return; // notification
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.clearPending(message.id);
		if (message.error) {
			pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
		} else {
			pending.resolve(message.result);
		}
	}

	private request<T>(
		id: number,
		method: string,
		params: unknown,
		signal?: AbortSignal,
		timeoutMs = this.options.requestTimeoutMs ?? 0,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				settle();
				this.cancelRemote(id, "cancelled");
				reject(new Error("aborted"));
			};
			// One cleanup path, so a settled request never leaves a timer or an
			// abort listener behind.
			const settle = () => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
			};
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					settle();
					this.cancelRemote(id, "timeout");
					reject(new Error(`${method} timed out after ${timeoutMs} ms`));
				}, timeoutMs);
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				resolve: (value) => {
					settle();
					resolve(value as T);
				},
				reject: (error) => {
					settle();
					reject(error);
				},
			});
			try {
				this.send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				settle();
				reject(new TransportError((error as Error).message));
			}
		});
	}

	private cancelRemote(id: number, reason: string): void {
		if (!this.child?.stdin?.writable) return;
		try {
			this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } });
		} catch {
			/* the child is already gone */
		}
	}

	private clearPending(id: number): void {
		this.pending.delete(id);
	}

	private failPending(error: Error): void {
		for (const [id, pending] of [...this.pending]) {
			this.pending.delete(id);
			pending.reject(error);
		}
	}

	private send(message: unknown): void {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			throw new TransportError(`${this.options.binary} is not running`);
		}
		stdin.write(`${JSON.stringify(message)}\n`);
	}

	private teardown(): void {
		const child = this.child;
		this.child = null;
		this.connectPromise = null;
		this.stdoutBuffer = "";
		this.stderrTail = [];
		this.pid = undefined;
		if (this.state !== "failed") this.state = "stopped";
		if (child) {
			try {
				// Stream listeners stay attached: ending stdin can still emit an
				// 'error', and a listener-less stream would crash the host. The
				// stdin error handler drops it because this teardown is deliberate.
				this.tearingDown = true;
				child.stdin?.end();
				child.kill();
			} catch {
				/* already gone */
			}
		}
		this.tearingDown = false;
	}
}
