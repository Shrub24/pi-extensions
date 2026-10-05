import { stripVTControlCharacters } from "node:util";
import { resultIsResolved, taskReadiness } from "./task-result.js";
import type { BackgroundTaskStatus } from "./types.js";

/**
 * Facts about this session's background tasks, published on its own Herdr pane
 * for a sidebar to render. They describe what is outstanding rather than what
 * the session is doing, so they are published while the session is working and
 * while it is waiting on the same tasks.
 *
 * Presence and identity only: never a command, output, prompt, working
 * directory or log path. Each key has exactly one publisher across the
 * ecosystem, which is why these are `pi_bg_*` rather than shared with
 * pi-herdsman's `pi_herdsman_*` keys.
 */
export const PANE_FACTS_SOURCE = "pi-bash-processes";
export const PANE_FACTS_TTL_MS = 30_000;
export const MAX_LISTED_TASKS = 6;
export const MAX_FACT_CHARS = 80;

export type PaneFactTask = {
	id: string;
	status: BackgroundTaskStatus;
	startedAt: number;
	resultResolution?: "delivered" | "error";
	resultReady?: boolean;
	restored?: boolean;
};

export type PaneFacts = {
	pi_bg_running: string | null;
	pi_bg_tasks: string | null;
	pi_bg_started: string | null;
};

export function emptyPaneFacts(): PaneFacts {
	return { pi_bg_running: null, pi_bg_tasks: null, pi_bg_started: null };
}

export function factsAreEmpty(facts: PaneFacts): boolean {
	return Object.values(facts).every((value) => value === null);
}

/**
 * Sanitising follows narumiruna/pi-extensions packages/pi-herdr (MIT) and
 * pi-herdsman's extension/pane-metadata.ts, so both publishers bound a value
 * the same way: no control characters, at most 80 code points, and nothing
 * rather than an empty string.
 */
export function factValue(value: string | null | undefined): string | null {
	if (!value) return null;
	const clean = stripVTControlCharacters(value)
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim();
	return clean ? [...clean].slice(0, MAX_FACT_CHARS).join("") : null;
}

export type TaskPhase = "running" | "flushing" | "review";

/** The unresolved tasks: the one set both the pane tokens and the Radar bus describe. */
export function unresolvedTasks<T extends PaneFactTask>(tasks: readonly T[]): T[] {
	return tasks.filter((task) => !resultIsResolved(task));
}

/** The three-word vocabulary shared by `pi_bg_tasks` and the Radar bus. */
export function taskPhase(task: PaneFactTask): TaskPhase {
	const readiness = taskReadiness(task);
	return readiness === "running" ? "running" : readiness === "finalizing" ? "flushing" : "review";
}

/** Outstanding task identities and phases, with the exact running count. */
export function paneFacts(tasks: readonly PaneFactTask[]): PaneFacts {
	const outstanding = unresolvedTasks(tasks);
	if (outstanding.length === 0) return emptyPaneFacts();
	const oldest = outstanding.reduce((earliest, task) => (task.startedAt < earliest.startedAt ? task : earliest));
	const entries: string[] = [];
	for (const task of outstanding.slice(0, MAX_LISTED_TASKS)) {
		const entry = `${task.id}:${taskPhase(task)}`;
		if ([...entries.concat(entry).join(",")].length > MAX_FACT_CHARS) break;
		entries.push(entry);
	}
	return {
		pi_bg_running: String(outstanding.filter((task) => task.status === "running").length),
		pi_bg_tasks: factValue(entries.join(",")),
		pi_bg_started: new Date(oldest.startedAt).toISOString(),
	};
}

export function factsArgs(
	paneId: string,
	facts: PaneFacts,
	options: { source?: string; ttlMs?: number } = {},
): string[] {
	const args = [
		"pane",
		"report-metadata",
		paneId,
		"--source",
		options.source ?? PANE_FACTS_SOURCE,
		"--ttl-ms",
		String(options.ttlMs ?? PANE_FACTS_TTL_MS),
	];
	for (const [key, value] of Object.entries(facts)) {
		const normalized = factValue(value);
		args.push(
			normalized === null ? "--clear-token" : "--token",
			normalized === null ? key : `${key}=${normalized}`,
		);
	}
	return args;
}

export type PaneFactsSend = (args: string[], signal: AbortSignal) => Promise<unknown>;

/**
 * One latest snapshot, re-published on the refresh interval and coalesced while
 * a call is in flight. Publication never fails the session: a failed call is
 * retried by the next update or refresh, and the TTL bounds the staleness.
 * An empty snapshot clears the keys and stops the refresh timer, so a session
 * with nothing running publishes nothing.
 */
export function createPaneFactsPublisher(options: {
	paneId: string;
	send: PaneFactsSend;
	source?: string;
	ttlMs?: number;
}) {
	const ttlMs = options.ttlMs ?? PANE_FACTS_TTL_MS;
	const controller = new AbortController();
	let desired: PaneFacts | undefined;
	let active: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let dirty = false;
	let closed = false;

	const stopTimer = (): void => {
		if (timer === undefined) return;
		clearInterval(timer);
		timer = undefined;
	};

	const flush = (): Promise<void> => {
		if (active) return active;
		active = (async () => {
			while (dirty && desired && !closed) {
				dirty = false;
				const attempted = desired;
				try {
					await options.send(
						factsArgs(options.paneId, attempted, {
							...(options.source === undefined ? {} : { source: options.source }),
							ttlMs,
						}),
						controller.signal,
					);
				} catch {
					// Publication cannot fail the session.
					if (attempted === desired) break;
				}
			}
		})().finally(() => {
			active = undefined;
			if (dirty && !closed) return flush();
		});
		return active;
	};

	return {
		update(facts: PaneFacts): Promise<void> {
			if (closed) return Promise.resolve();
			desired = { ...facts };
			if (factsAreEmpty(desired)) stopTimer();
			else if (timer === undefined) {
				timer = setInterval(() => {
					dirty = true;
					void flush();
				}, Math.max(1, Math.floor(ttlMs / 2)));
				timer.unref?.();
			}
			dirty = true;
			return flush();
		},
		/**
		 * Clear the keys, then stop. An in-flight snapshot write is aborted and
		 * awaited before the clear: a write that landed after it would re-advertise
		 * tasks that have already ended. A failed clear is left to the TTL.
		 */
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			stopTimer();
			controller.abort();
			await active?.catch(() => undefined);
			try {
				await options.send(
					factsArgs(options.paneId, emptyPaneFacts(), {
						...(options.source === undefined ? {} : { source: options.source }),
						ttlMs,
					}),
					new AbortController().signal,
				);
			} catch {
				// The keys expire with their TTL.
			}
		},
	};
}
