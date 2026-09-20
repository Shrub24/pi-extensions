/*
 * The process-global registry: one core and one log per process.
 *
 * A session has several consumers, and each consumer is its own extension entry
 * — the permission link, the intent nudge, and whatever subscribes next. They
 * must share one core, because sharing is the whole point: the first consumer to
 * ask about an action pays for it and the rest read what it bought. Two cores
 * would mean two requests for one action and no batching at all.
 *
 * So the registry is keyed the way the rest of this ecosystem keys shared state:
 * `Symbol.for` on `globalThis`, one entry per session, resolved per use. The
 * permission system publishes its own service exactly this way, and a second Pi
 * extension in the same process reaches the same object.
 *
 * Two rules hold it together:
 *
 *   - A core belongs to a session and is created by the first lease. Later
 *     leases join it and the last one out drops it, so a finished session leaves
 *     nothing for the next to inherit answers from. Whichever entry leases first
 *     supplies the judge, because both read the same settings file and a second
 *     client would double pi-typesafe's per-client request cap rather than share
 *     it.
 *   - One log writer per core. Every record is derived from the same config, so a
 *     second writer would only append a duplicate of every line.
 */

import type { ActionContext } from "./action-pack.js";
import { PACK_VERSION, STATE_VERSION } from "./action-pack.js";
import type { CoreRecordContext, DecisionCore, DecisionCoreOptions } from "./decision-core.js";
import { createDecisionCore } from "./decision-core.js";
import { openDecisionLog } from "./decision-log.js";
import type { DecisionLog } from "./decision-log.js";
import { askRecordFromCore } from "./decision-record.js";

const REGISTRY = Symbol.for("pi-jev:registry");

/** The judge seam, as the core declares it. */
type Judge = DecisionCoreOptions<ActionContext>["ask"];
type Logger = (record: Parameters<DecisionLog["write"]>[0]) => void;

interface CoreEntry {
	core: DecisionCore<ActionContext>;
	refs: number;
	/** Read by the core's idle flush; only a turn may spend. */
	running: boolean;
	sink: ((context: CoreRecordContext) => void) | undefined;
}

interface LogEntry {
	log: DecisionLog;
	refs: number;
}

interface RegistryState {
	cores: Map<string, CoreEntry>;
	logs: Map<string, LogEntry>;
}

function state(): RegistryState {
	const holder = globalThis as unknown as Record<symbol, RegistryState | undefined>;
	const existing = holder[REGISTRY];
	if (existing) return existing;
	const fresh: RegistryState = { cores: new Map(), logs: new Map() };
	holder[REGISTRY] = fresh;
	return fresh;
}

export interface CoreLeaseOptions {
	ask: Judge;
	record?(context: CoreRecordContext): void;
	maxQuestionsPerRequest?: number;
	flushGapMs?: number;
	schedule?(run: () => void, ms: number): () => void;
}

export interface AcquireCoreInput {
	sessionId: string;
	options: CoreLeaseOptions;
	/** Runs once, at creation: state providers and the question catalog. */
	setup(core: DecisionCore<ActionContext>): void;
}

export interface CoreLease {
	readonly sessionId: string;
	readonly core: DecisionCore<ActionContext>;
	/**
	 * Whether this lease created the core, and with it the session's judge. The
	 * entry that supplied the judge is the one that reports on it, so a session with
	 * two entries says "the judge is unusable" once.
	 */
	readonly created: boolean;
	/** Both entries see the same turn boundaries, so either may report one. */
	setRunning(running: boolean): void;
	release(): void;
}

function createEntry(input: AcquireCoreInput): CoreEntry {
	// The running flag is read by the core's idle flush, so the entry has to exist
	// before the core that closes over it.
	const entry: CoreEntry = { core: undefined as unknown as DecisionCore<ActionContext>, refs: 0, running: false, sink: input.options.record };
	entry.core = createDecisionCore<ActionContext>({
		ask: input.options.ask,
		record: (context) => entry.sink?.(context),
		isRunning: () => entry.running,
		...(input.options.maxQuestionsPerRequest === undefined ? {} : { maxQuestionsPerRequest: input.options.maxQuestionsPerRequest }),
		...(input.options.flushGapMs === undefined ? {} : { flushGapMs: input.options.flushGapMs }),
		...(input.options.schedule === undefined ? {} : { schedule: input.options.schedule }),
	});
	input.setup(entry.core);
	return entry;
}

/** The core this session is using, creating it on the first lease. */
export function acquireCore(input: AcquireCoreInput): CoreLease {
	const registry = state();
	const existing = registry.cores.get(input.sessionId);
	const entry = existing ?? createEntry(input);
	registry.cores.set(input.sessionId, entry);
	entry.refs += 1;

	let released = false;
	return {
		sessionId: input.sessionId,
		core: entry.core,
		created: existing === undefined,
		setRunning(running: boolean): void {
			entry.running = running;
		},
		release(): void {
			// A wiring releases once, at shutdown; a second call is a no-op rather
			// than a way to drop a core another lease is still holding.
			if (released) return;
			released = true;
			entry.refs -= 1;
			if (entry.refs <= 0 && registry.cores.get(input.sessionId) === entry) registry.cores.delete(input.sessionId);
		},
	};
}

/** The one log for a path, shared by every entry that writes to it. */
export function acquireLog(path: string): { log: DecisionLog; release: () => void } {
	const registry = state();
	const entry = registry.logs.get(path) ?? { log: openDecisionLog({ path }), refs: 0 };
	registry.logs.set(path, entry);
	entry.refs += 1;

	let released = false;
	return {
		log: entry.log,
		release(): void {
			if (released) return;
			released = true;
			entry.refs -= 1;
			if (entry.refs <= 0 && registry.logs.get(path) === entry) registry.logs.delete(path);
		},
	};
}

/**
 * The standard record sink: one line per request, shaped by the config both
 * entries read.
 */
export function logSink(input: { log: DecisionLog; now: () => Date; mode: string; model: string }): (context: CoreRecordContext) => void {
	const write: Logger = (record) => input.log.write(record);
	return (context) => {
		try {
			write(
				askRecordFromCore(context, {
					ts: input.now().toISOString(),
					mode: input.mode,
					model: input.model,
					packVersion: PACK_VERSION,
					stateVersion: STATE_VERSION,
				}),
			);
		} catch {
			// Observability never fails a decision.
		}
	};
}

/** For tests and diagnostics: the core a session is using, if it has one. */
export function coreFor(sessionId: string): DecisionCore<ActionContext> | undefined {
	return state().cores.get(sessionId)?.core;
}

/** Drop every lease. Tests only: a real process releases through its sessions. */
export function resetRegistry(): void {
	state().cores.clear();
	state().logs.clear();
}
