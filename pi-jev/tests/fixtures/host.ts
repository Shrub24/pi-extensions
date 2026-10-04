/*
 * A fake Pi host, shared by every wiring test.
 *
 * Two entries now run in one process, so the host has to behave like Pi: more
 * than one extension may listen to the same event, each in registration order, and
 * a second `on` for one event must not displace the first. That is what makes it
 * possible to wire the permission link and the intent consumer into one host and
 * watch them share a session.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface HostOptions {
	withBus?: boolean;
	/** The conversation `sessionManager.getBranch()` returns. */
	branch?: readonly unknown[];
	/** Tools `getAllTools()` reports, for the toolbox line. */
	tools?: readonly { name: string; description?: string }[];
	/** What `ctx.isIdle()` answers. Default: idle, the orchestrator's usual state. */
	isIdle?: () => boolean;
}

export function fakeHost(options: HostOptions = {}) {
	const handlers = new Map<string, Set<(event: unknown, ctx: unknown) => unknown>>();
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const notices: { message: string; level?: string }[] = [];
	const sent: { message: unknown; options: unknown }[] = [];
	let branch: readonly unknown[] = options.branch ?? [];
	/** The session Pi is currently in, as `session_start` reported it. */
	let current: string | null = null;
	const userSent: { message: unknown; options: unknown }[] = [];

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
		},
		sendMessage(message: unknown, sendOptions?: unknown) {
			sent.push({ message, options: sendOptions });
		},
		sendUserMessage(message: unknown, sendOptions?: unknown) {
			userSent.push({ message, options: sendOptions });
			return Promise.resolve();
		},
		getAllTools: () => (options.tools ?? []).map((tool) => ({ ...tool })),
		events:
			options.withBus === false
				? undefined
				: {
						on(channel: string, handler: (payload: unknown) => void) {
							const set = listeners.get(channel) ?? new Set();
							set.add(handler);
							listeners.set(channel, set);
							return () => set.delete(handler);
						},
						emit(channel: string, payload: unknown) {
							for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
						},
					},
	};

	const context = (sessionId: string | null): ExtensionContext =>
		({
			sessionManager: {
				getSessionId: () => {
					if (sessionId === null) throw new Error("no session id");
					return sessionId;
				},
				getBranch: () => branch,
			},
			ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
			isIdle: options.isIdle ?? (() => true),
		}) as unknown as ExtensionContext;

	return {
		pi: pi as never,
		notices,
		sent,
		userSent,
		listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
		emit: (channel: string, payload: unknown) => {
			for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
		},
		/** Fire a lifecycle event at every listener, in registration order. */
		fire: async (event: string, payload: unknown = {}, sessionId: string | null = current) => {
			for (const handler of [...(handlers.get(event) ?? [])]) {
				try {
					await handler(payload, context(sessionId));
				} catch (error) {
					// Pi isolates handlers: one extension throwing does not stop the
					// others, and a host that swallowed the error would hide the very
					// defect these tests exist to catch.
					notices.push({ message: `handler for ${event} threw: ${error instanceof Error ? error.message : String(error)}`, level: "error" });
				}
			}
		},
		sessionStart: async (sessionId: string | null) => {
			current = sessionId;
			for (const handler of [...(handlers.get("session_start") ?? [])]) await handler({ reason: "startup" }, context(sessionId));
		},
		shutdown: async () => {
			for (const handler of [...(handlers.get("session_shutdown") ?? [])]) await handler({}, undefined);
		},
		setBranch: (entries: readonly unknown[]) => {
			branch = entries;
		},
	};
}

/** A permission system whose service registrations are observable. */
export function fakeService(name = "service-1") {
	const registered = new Map<string, unknown>();
	const disposals: string[] = [];
	return {
		name,
		registered,
		disposals,
		service: {
			registerAuthorizer(linkName: string, authorize: unknown) {
				if (registered.has(linkName)) throw new Error(`An authorizer named "${linkName}" is already registered.`);
				registered.set(linkName, authorize);
				return () => {
					disposals.push(linkName);
					registered.delete(linkName);
				};
			},
		},
	};
}

/** The seam locator a loaded permission system would answer with. */
export function locatorFor(services: Map<string, unknown>) {
	return {
		resolve: async () => ({
			getPermissionsService: (sessionId: string) => services.get(sessionId) as never,
			readyChannel: "permissions:ready",
			decisionChannel: "permissions:decision",
		}),
	};
}

/** The branch a decision reads: a user instruction, a stated plan, and a call. */
export function branchWith(input: { instruction?: string; plan?: string | null; calls?: readonly string[] }) {
	const entries: unknown[] = [];
	if (input.instruction !== undefined) entries.push({ type: "message", message: { role: "user", content: input.instruction } });
	if (input.plan) entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: input.plan }] } });
	for (const command of input.calls ?? []) {
		entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] } });
	}
	return entries;
}
