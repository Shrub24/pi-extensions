/*
 * The decision core: per-action question batching across independent consumers.
 *
 * The unit of work is an ACTION (one tool call, one delegation tick — whatever a
 * trigger announces), and the core does five things:
 *
 *   1. Collect. Consumers register interest in questions; a trigger announces an
 *      action and the interested questions are queued, or a consumer asks for a
 *      specific set on the spot.
 *   2. Group. Queued questions are grouped by the state they read, never merged
 *      across states. pi-heed measured what merging costs: the same go-ahead
 *      question caught 8 of 9 intended lifts with its own minimal state and 5 of
 *      9 inside a larger shared one, same model. So one state group is one
 *      request, and two groups are two requests in parallel.
 *   3. Ask. Whole consumer question sets are packed into requests, never split
 *      across them: a consumer is answered from one request or reported failed,
 *      and a chunk that fails cannot leave it holding half a set. Requests for
 *      one group go out together.
 *   4. Remember. Answers are cached per action and per question, and concurrent
 *      requests for the same group share one in-flight promise. This is what
 *      makes "ask them all at once" work inside Pi's sequential hooks: the first
 *      consumer's flush pays the latency, and a consumer that arrives afterwards
 *      with questions that were already asked pays nothing at all.
 *   5. Hand back. Every answer reaches the consumer that asked for it, as
 *      normalized readings plus the raw answers. The core has no opinion about
 *      what an answer means: weighting, thresholds, verdicts, nudge text and
 *      timeout decisions all live in consumers.
 *
 * No Pi import, no network, no clock beyond an injected one: the core is a pure
 * function of its registry and its judge, so a test drives it with a fake.
 */

import type { JevAnswer, JevQuestion, JevQuestions, JevUsage } from "./types.js";

/** Normalized reading of one answer; the consumer decides what it means. */
export interface Reading {
	question: string;
	owner: string;
	/** The answer's own value: a probability for a noul, a level for a score. */
	probability: number | null;
	level: number | null;
	/** False when the answer was absent or failed validation. */
	ok: boolean;
	/**
	 * Hash of the wire question this reading answers, when the question is worded
	 * per action. A reading under one wording must not satisfy a later ask whose
	 * wording differs; `dropStaleWording` clears such readings before they are
	 * reused.
	 */
	wording?: string;
	/** The reader's own per-question detail, verbatim (a choice question's pick). */
	detail?: Record<string, unknown>;
}

/** One request's outcome, as the core reports it. */
export interface GroupRequest {
	id: string;
	stateProvider: string;
	owner: string;
	questions: readonly string[];
	ok: boolean;
	readings: readonly Reading[];
	/** Raw answers as the backend returned them, for consumers that want more. */
	answers: Record<string, JevAnswer>;
	model: string | null;
	usage: JevUsage | null;
	latencyMs: number;
	error: { code: string; message: string } | null;
}

/** Everything one action's flush produced. */
export interface DecisionResult {
	actionKey: string;
	requests: readonly GroupRequest[];
	/** Questions this flush answered from an earlier request instead of asking again. */
	reused: readonly string[];
	/** True when every request that ran succeeded. */
	ok: boolean;
	/** Readings merged across the requests, keyed by question id. */
	readings: Record<string, Reading>;
	elapsedMs: number;
}

/**
 * `queueDecisions` adds work for later. A consumer that only wants a question
 * answered eventually — the next nudge, the next report — queues it and moves on;
 * nothing is asked, nothing is charged.
 */
export interface QueueRequest<A = unknown> {
	action: A;
	/** Identity of the action, shared by every consumer and trigger for it. */
	actionKey: string;
	/** The consumer queuing; its own questions stay its own for delivery. */
	consumer: string;
	/** Question ids to queue. Mutually exclusive with `bundle`. */
	questions?: readonly string[];
	/** A state group's worth of questions, in registration order. */
	bundle?: string;
}

/**
 * `sendDecisions` is the immediate call: it takes everything already queued for
 * this action — what other consumers queued, and what every active consumer
 * registered a standing interest in — adds the caller's own questions, and asks
 * the whole set in one pass, grouped by state, then hands each consumer its own
 * readings back.
 */
export interface SendRequest<A = unknown> extends QueueRequest<A> {
	/** Opaque per-band detail for the log; the core never reads it. */
	interpret?: (readings: readonly Reading[]) => unknown;
	signal?: AbortSignal;
	/**
	 * Ceiling for this batch, in milliseconds. When it passes, the requests still
	 * in flight are aborted, which the core reports as failed requests: a caller
	 * gets a bounded wait and its consumers get their failure policy, rather than a
	 * gate that hangs.
	 */
	timeoutMs?: number;
}

export interface BuiltState {
	state: unknown;
	stateHash: string;
	chars: number;
	truncated: readonly string[];
}

/** A state provider: how one group's questions read an action. */
export interface StateBundle<A = unknown> {
	id: string;
	buildState(action: A): BuiltState;
}

/** One question, owned by a consumer, reading one state group. */
export interface QuestionEntry<A = unknown> {
	id: string;
	/** The state group it reads; must name a registered bundle. */
	stateProvider: string;
	owner: string;
	/** Interpretation metadata (role, edge, measured); opaque to the core. */
	meta?: Record<string, unknown>;
	/** False means this action gives the question nothing to read. */
	applies?(action: A): boolean;
	question(action: A): JevQuestion;
	/** Normalizes and validates an answer. Undefined means unusable. */
	read(answer: JevAnswer | undefined): { probability?: number; level?: number } | undefined;
}

/** A consumer's standing interest: what to queue whenever an action happens. */
export interface ConsumerSubscription<A = unknown> {
	id: string;
	/** Question ids this consumer wants; `applies` narrows by action. */
	questions: readonly string[];
	applies?(action: A): boolean;
	/** Called after a flush with the readings for this consumer's questions. */
	onAnswers?(delivery: ConsumerDelivery): void;
	interpret?: (readings: readonly Reading[]) => unknown;
}

export interface ConsumerDelivery<A = unknown> {
	actionKey: string;
	consumer: string;
	result: DecisionResult;
	/** Only this consumer's questions, in registration order. */
	readings: readonly Reading[];
	/** True when every request carrying this consumer's questions succeeded. */
	ok: boolean;
	/** The action the flush judged — the stored one, which motivated the queue. */
	action: A;
}

export interface CoreRecordContext {
	request: GroupRequest;
	actionKey: string;
	stateProvider: string;
	stateHash: string;
	chars: number;
	truncated: readonly string[];
	interpreted: unknown;
}

export interface DecisionCoreOptions<A = unknown> {
		/**
	 * Schedules the idle flush. Injected so tests drive it by hand: a decision
	 * core that owns real timers cannot be tested deterministically, and a host
	 * may want to drive the boundary itself instead.
	 */
	schedule?(run: () => void, ms: number): () => void;
	/**
	 * Whether the host is in a turn right now.
	 *
	 * The idle flush exists for a queue that nothing sends, and a session sitting
	 * idle is not a queue: asking then would spend on an action that is finished
	 * and deliver a nudge into a conversation nobody is having. With this
	 * predicate the timer only ever runs mid-turn; the turn boundary drains what
	 * is left for free.
	 */
	isRunning?(): boolean;
	/**
	 * How long a queued question may wait with no send before the core asks it
	 * anyway, in milliseconds. 0 disables the timer, which is the default: a queued
	 * question is normally answered by the next send, and a timer is for hosts
	 * where nothing may send at all.
	 *
	 * A timer flush is always late — the action it was queued for is over — so it
	 * can nudge and it can log, but it cannot gate. Hosts that need a gate must
	 * send before the action runs.
	 */
	flushGapMs?: number;
	/** One evaluation. Never throws: failures arrive as `{ ok: false }`. */
	ask(state: unknown, questions: JevQuestions, options: { signal?: AbortSignal }): Promise<
		| { ok: true; answers: Record<string, JevAnswer>; model: string; usage: JevUsage; elapsedMs: number }
		| { ok: false; error: string; errorCode?: string }
	>;
	/** One record per request, written by the host's log. Never throws out. */
	record?(context: CoreRecordContext): void;
	/** Questions one request may carry; pi-typesafe's cap is 32. */
	maxQuestionsPerRequest?: number;
	/** How many actions keep their answers cached. Oldest are dropped first. */
	maxRememberedActions?: number;
	now?: () => number;
}

export interface DecisionCore<A = unknown> {
	registerBundle(bundle: StateBundle<A>): () => void;
	registerQuestions(entries: readonly QuestionEntry<A>[]): () => void;
	registerConsumer(subscription: ConsumerSubscription<A>): () => void;
	/** Add questions to an action's queue. Nothing is asked. Returns what was newly queued. */
	queueDecisions(request: QueueRequest<A>): readonly string[];
	/**
	 * Ask now: the action's whole queue plus this caller's questions, in one pass.
	 * Answers already known for the action are reused rather than asked again.
	 */
	sendDecisions(request: SendRequest<A>): Promise<DecisionResult>;
	/** Ask everything queued for every action, as a boundary would. */
	flushPending(): Promise<readonly DecisionResult[]>;
	/** Drop one action's answers, and cancel its idle flush. Called at a boundary. */
	forget(actionKey: string): void;
	/** What is queued for an action, for tests and diagnostics. */
	queued(actionKey: string): readonly { question: string; consumer: string }[];
	/** The registered question ids, in registration order. */
	questionIds(): readonly string[];
}

interface QueuedQuestion {
	question: string;
	consumer: string;
}

const DEFAULT_MAX_QUESTIONS = 32;
const DEFAULT_MAX_ACTIONS = 64;

export function createDecisionCore<A = unknown>(options: DecisionCoreOptions<A>): DecisionCore<A> {
	const maxQuestions = options.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS;
	const maxActions = options.maxRememberedActions ?? DEFAULT_MAX_ACTIONS;
	const now = options.now ?? (() => Date.now());
	const schedule = options.schedule;
	const gapMs = options.flushGapMs ?? 0;

	const bundles = new Map<string, StateBundle<A>>();
	const entries = new Map<string, QuestionEntry<A>>();
	const subscriptions = new Map<string, ConsumerSubscription<A>>();

	/** Per action: the queued questions, the answered readings, and the in-flight promises. */
	interface ActionState {
		/** The action as it was announced; a timer flush has no other source for it. */
		action: A | undefined;
		queue: QueuedQuestion[];
		readings: Map<string, Reading>;
		/** Group key → the promise of its requests. */
		inFlight: Map<string, Promise<GroupRequest[]>>;
		/** Cancels this action's idle flush. */
		timer?: () => void;
	}
	const actions = new Map<string, ActionState>();
	/** Provenance of each group's built state, for the records written after a flush. */
	const stateHashes = new Map<string, string>();
	const stateChars = new Map<string, number>();
	const stateTruncated = new Map<string, readonly string[]>();

	function actionState(actionKey: string): ActionState {
		const existing = actions.get(actionKey);
		if (existing) {
			// Refresh insertion order so the LRU eviction drops the least recently used.
			actions.delete(actionKey);
			actions.set(actionKey, existing);
			return existing;
		}
		const created: ActionState = { action: undefined, queue: [], readings: new Map(), inFlight: new Map() };
		actions.set(actionKey, created);
		while (actions.size > maxActions) {
			const oldest = actions.keys().next();
			if (oldest.done) break;
			if (oldest.value === actionKey) break;
			actions.delete(oldest.value);
		}
		return created;
	}

	function known(state: ActionState, question: string): boolean {
		return state.readings.has(question);
	}

	/**
	 * Records for the requests that just ran, each carrying the same interpretation.
	 *
	 * One interpretation is computed for the whole ask — bands and a verdict are
	 * statements about all the answers together, and a per-request reading of them
	 * would be a partial picture (a group's own chunk sees neither the other
	 * group's answers nor their absence) — and then attached to every request
	 * record. Each record is therefore self-contained: the readings it carried and
	 * what the asking consumer made of the whole set.
	 */
	function writeRecords(actionKey: string, requests: readonly GroupRequest[], interpret?: (readings: readonly Reading[]) => unknown): void {
		if (!options.record || requests.length === 0) return;
		const state = actionState(actionKey);
		let interpreted: unknown;
		if (interpret) {
			try {
				interpreted = interpret([...state.readings.values()]);
			} catch {
				// A caller's interpreter is opaque to the core; a defect in it cannot
				// fail a request that already produced answers.
			}
		}
		for (const request of requests) {
			try {
				options.record({
					request,
					actionKey,
					stateProvider: request.stateProvider,
					stateHash: stateHashes.get(`${actionKey}::${request.stateProvider}`) ?? "",
					chars: stateChars.get(`${actionKey}::${request.stateProvider}`) ?? 0,
					truncated: stateTruncated.get(`${actionKey}::${request.stateProvider}`) ?? [],
					interpreted,
				});
			} catch {
				// Observability never fails a decision.
			}
		}
	}

	/**
	 * Drop readings whose question has since been worded differently. A choice
	 * question names its alternatives, so `tool.choice` for one call is not
	 * `tool.choice` for another; without this, the second call would be served
	 * the first call's answer under the same id.
	 */
	function dropStaleWording(action: A, state: ActionState, wanted: readonly string[]): void {
		for (const id of wanted) {
			const entry = entries.get(id);
			if (!entry) continue;
			const question = entry.question(action);
			const stored = state.readings.get(id);
			if (!stored) continue;
			if (stored.wording === undefined) continue;
			const current = question === undefined ? undefined : hashKey(question);
			if (stored.wording !== current) state.readings.delete(id);
		}
	}

	/** Readings for the questions this consumer asked, in the order it asked them. */
	function readingsFor(state: ActionState, questions: readonly string[]): Reading[] {
		const found: Reading[] = [];
		for (const question of questions) {
			const reading = state.readings.get(question);
			if (reading) found.push(reading);
		}
		return found;
	}

	/** Ask what is not already known, grouped by state provider, and remember it. */
	async function ensure(
		action: A,
		actionKey: string,
		wanted: readonly string[],
		signal?: AbortSignal,
	): Promise<{ requests: GroupRequest[]; reused: string[] }> {
		const state = actionState(actionKey);
		// The stored action is authoritative: it is the context the queued
		// questions were motivated by (a tool call carrying its policy match), and
		// a later sender's context can be narrower. When nothing is stored — a send
		// with no queue behind it — the caller's context is recorded.
		const effective = state.action ?? action;
		if (state.action === undefined) state.action = action;
		dropStaleWording(effective, state, wanted);
		const missing = wanted.filter((question) => !known(state, question));
		const reused = wanted.filter((question) => known(state, question));
		if (missing.length === 0) return { requests: [], reused };

		// Group the missing questions by state provider, then by owner: a whole
		// consumer set never splits across two requests.
		const groups = new Map<string, Map<string, QuestionEntry<A>[]>>();
		for (const id of missing) {
			const entry = entries.get(id);
			if (!entry) {
				// An unregistered question is answered with a missing reading rather
				// than a throw: a consumer asking for something nobody owns is a
				// defect in the caller, not in the action.
				state.readings.set(id, { question: id, owner: "unregistered", probability: null, level: null, ok: false });
				continue;
			}
			if (entry.applies && !entry.applies(effective)) {
				state.readings.set(id, { question: id, owner: entry.owner, probability: null, level: null, ok: false });
				continue;
			}
			const byOwner = groups.get(entry.stateProvider) ?? new Map<string, QuestionEntry<A>[]>();
			byOwner.set(entry.owner, [...(byOwner.get(entry.owner) ?? []), entry]);
			groups.set(entry.stateProvider, byOwner);
		}

		const work: Promise<GroupRequest[]>[] = [];
		const shared: Promise<GroupRequest[]>[] = [];
		for (const [stateProvider, byOwner] of groups) {
			const questionIds = [...byOwner.values()].flat().map((entry) => entry.id);
			const key = `${actionKey}::${stateProvider}::${[...questionIds].sort().join(",")}`;
			const running = state.inFlight.get(key);
			if (running) {
				// A concurrent request for the same group and question set: wait on it
				// rather than asking the same questions twice, and count these
				// questions as reused — this caller issued no request of its own.
				shared.push(running);
				reused.push(...questionIds);
				continue;
			}
			const bundle = bundles.get(stateProvider);
			const built = bundle ? bundle.buildState(effective) : { state: {}, stateHash: "", chars: 0, truncated: [] as readonly string[] };
			const provenanceKey = `${actionKey}::${stateProvider}`;
			stateHashes.set(provenanceKey, built.stateHash);
			stateChars.set(provenanceKey, built.chars);
			stateTruncated.set(provenanceKey, built.truncated);
			const chunks = packChunks(byOwner, maxQuestions);
			const groupWork = Promise.all(
				chunks.map((chunk, index) =>
					runChunk({
						action: effective,
						actionKey,
						requestId: `${actionKey}:${stateProvider}:${index}`,
						stateProvider,
						built,
						chunk,
						...(signal ? { signal } : {}),
					}),
				),
			);
			state.inFlight.set(key, groupWork);
			void groupWork.then(() => state.inFlight.delete(key)).catch(() => state.inFlight.delete(key));
			work.push(groupWork);
		}

		const perGroup = await Promise.all([...work, ...shared]);
		const settled = perGroup.flat();
		for (const request of settled) for (const reading of request.readings) state.readings.set(reading.question, reading);
		// Only the requests this caller's own work produced are reported as its own.
		const mine = (await Promise.all(work)).flat();
		return { requests: mine, reused: [...new Set(reused)] };
	}

	function packChunks(byOwner: Map<string, QuestionEntry<A>[]>, limit: number): QuestionEntry<A>[][] {
		const chunks: QuestionEntry<A>[][] = [];
		let current: QuestionEntry<A>[] = [];
		for (const set of byOwner.values()) {
			if (set.length > limit) {
				// A single consumer set larger than one request cannot keep its
				// atomicity; it becomes one oversized chunk the admission layer
				// rejects, so the failure is attributed rather than silently split.
				if (current.length > 0) chunks.push(current);
				current = [];
				chunks.push(set);
				continue;
			}
			if (current.length + set.length > limit) {
				chunks.push(current);
				current = [];
			}
			current.push(...set);
		}
		if (current.length > 0) chunks.push(current);
		return chunks;
	}

	async function runChunk(input: {
		action: A;
		actionKey: string;
		requestId: string;
		stateProvider: string;
		built: BuiltState;
		chunk: QuestionEntry<A>[];
		signal?: AbortSignal;
	}): Promise<GroupRequest> {
		const questions: JevQuestions = {};
		for (const entry of input.chunk) {
			const question = entry.question(input.action);
			if (question) questions[entry.id] = question;
		}
		const ids = input.chunk.map((entry) => entry.id);
		// Questions may be worded per action — a choice question names the
		// alternatives it is choosing between — so the same id can be a different
		// question for a different call. The cache key carries that wording,
		// otherwise the second wording would be served the first wording's answer.
		const wordingKey = stableKey(questions);
		const startedAt = now();
		const outcome = await options.ask(input.built.state, questions, input.signal ? { signal: input.signal } : {});
		const latencyMs = now() - startedAt;

		const readings: Reading[] = [];
		const request: GroupRequest = {
			id: input.requestId,
			stateProvider: input.stateProvider,
			owner: input.chunk[0]?.owner ?? "unknown",
			questions: ids,
			ok: outcome.ok,
			readings,
			answers: {},
			model: null,
			usage: null,
			latencyMs,
			error: null,
		};

		if (!outcome.ok) {
			for (const entry of input.chunk) readings.push({ question: entry.id, owner: entry.owner, probability: null, level: null, ok: false });
			request.error = { code: outcome.errorCode ?? "unknown", message: outcome.error };
		} else {
			request.answers = outcome.answers;
			request.model = outcome.model;
			request.usage = outcome.usage;
			for (const entry of input.chunk) {
				const read = entry.read(outcome.answers[entry.id]);
				readings.push({
					question: entry.id,
					owner: entry.owner,
					probability: read?.probability ?? null,
					level: read?.level ?? null,
					ok: read !== undefined,
					// A reader may attach its own per-question detail (a choice
					// question's pick and margin); it rides the reading verbatim.
					...(read && typeof read === "object" && "detail" in read && read.detail !== null && typeof read.detail === "object" ? { detail: read.detail } : {}),
					...(questions[entry.id] === undefined ? {} : { wording: hashKey(questions[entry.id]) }),
				});
			}
		}

		return request;
	}

	function summarize(actionKey: string, requests: readonly GroupRequest[], reused: readonly string[], elapsedMs: number): DecisionResult {
		const state = actionState(actionKey);
		const readings: Record<string, Reading> = {};
		for (const [id, reading] of state.readings) readings[id] = reading;
		return {
			actionKey,
			requests,
			reused,
			ok: requests.every((request) => request.ok),
			readings,
			elapsedMs,
		};
	}

	/** Questions a request names: explicit ids, or everything reading one group. */
	function resolveQuestions(request: QueueRequest<A>): string[] {
		if (request.questions) return [...request.questions];
		if (request.bundle === undefined) return [];
		return [...entries.values()].filter((entry) => entry.stateProvider === request.bundle).map((entry) => entry.id);
	}

	/**
	 * Everything a send should cover: explicitly queued questions, the caller's
	 * own, and the standing interest of every consumer the action matches. Active
	 * consumers are what makes a single send carry the whole set.
	 */
	function sendSet(action: A, actionKey: string, request: QueueRequest<A>): Map<string, string[]> {
		const state = actionState(actionKey);
		const byConsumer = new Map<string, string[]>();
		const add = (consumer: string, question: string): void => {
			const current = byConsumer.get(consumer) ?? [];
			// A consumer's question can arrive three ways — an explicit queue, its own
			// send, and its standing interest — and it is one question either way.
			if (current.includes(question)) return;
			byConsumer.set(consumer, [...current, question]);
		};
		for (const item of state.queue) add(item.consumer, item.question);
		for (const question of resolveQuestions(request)) add(request.consumer, question);
		for (const subscription of subscriptions.values()) {
			if (subscription.applies && !subscription.applies(action)) continue;
			for (const question of subscription.questions) add(subscription.id, question);
		}
		// This send consumes the explicit queue. Standing interest is not stored in
		// it — it is re-derived from the registered consumers on every send — so
		// clearing the queue loses nothing.
		state.queue = [];
		return byConsumer;
	}

	/**
	 * A send's ceiling. `setTimeout` here only aborts the in-flight requests; the
	 * judge seam reports the abort, which keeps one failure shape for timeouts.
	 */
	function bound(timeoutMs: number | undefined, signal: AbortSignal | undefined): { signal?: AbortSignal; dispose(): void } {
		if (timeoutMs === undefined || timeoutMs <= 0 || !schedule) {
			return signal ? { signal, dispose: () => {} } : { dispose: () => {} };
		}
		const controller = new AbortController();
		const cancel = schedule(() => controller.abort(), timeoutMs);
		const onAbort = (): void => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		return {
			signal: controller.signal,
			dispose: () => {
				cancel();
				signal?.removeEventListener("abort", onAbort);
			},
		};
	}

	/** The idle flush: ask a queued action anyway, once nothing has sent for it. */
	function armIdleFlush(actionKey: string): void {
		if (!gapMs || !schedule) return;
		if (options.isRunning && !options.isRunning()) return;
		const state = actions.get(actionKey);
		if (!state || state.timer) return;
		state.timer = schedule(() => {
			const pending = actions.get(actionKey);
			if (!pending) return;
			pending.timer = undefined;
			// The turn can end between arming and firing; a timer that wakes into
			// an idle session is the one thing this must not do.
			if (options.isRunning && !options.isRunning()) return;
			void flushAction(actionKey).catch(() => {
				// A timed flush is best-effort: its failures are already recorded.
			});
		}, gapMs);
	}

	/** Ask whatever is queued for one action, and deliver it. Used by the timer. */
	async function flushAction(actionKey: string): Promise<DecisionResult | undefined> {
		const state = actions.get(actionKey);
		if (!state || state.action === undefined || state.queue.length === 0) return undefined;
		const consumer = state.queue[0]?.consumer ?? "unknown";
		const wanted = [...new Set(state.queue.map((item) => item.question))];
		// A boundary flush has no caller to interpret it, so the consumer that
		// queued supplies the reading — but only when its questions are the whole
		// flush, because one interpretation describes one ask.
		const owners = new Set(state.queue.map((entry) => entry.consumer));
		const interpret = owners.size === 1 ? subscriptions.get([...owners][0] as string)?.interpret : undefined;
		return core.sendDecisions({ action: state.action, actionKey, consumer, questions: wanted, ...(interpret ? { interpret } : {}) });
	}

	/** A stable string for a question set, wording included. */
	function stableKey(questions: JevQuestions): string {
		return JSON.stringify(Object.keys(questions).sort().flatMap((id) => [id, questions[id]]));
	}

	/**
	 * Readings are stored per question **wording**, not per id: a choice question
	 * names its alternatives, so the same id can be a different question for a
	 * different call, and the second wording must not be served the first
	 * wording's answer. The wording is hashed from the wire question itself.
	 */
	function readingKey(id: string, question: JevQuestion | undefined): string {
		return question === undefined ? id : `${id}#${hashKey(question)}`;
	}

	function hashKey(value: unknown): string {
		const text = JSON.stringify(value) ?? "";
		let hash = 0;
		for (let index = 0; index < text.length; index += 1) {
			hash = (hash * 31 + text.charCodeAt(index)) | 0;
		}
		return (hash >>> 0).toString(36);
	}

	const core: DecisionCore<A> = {
		registerBundle(bundle) {
			bundles.set(bundle.id, bundle);
			return () => {
				if (bundles.get(bundle.id) === bundle) bundles.delete(bundle.id);
			};
		},
		registerQuestions(additions) {
			for (const entry of additions) entries.set(entry.id, entry);
			return () => {
				for (const entry of additions) if (entries.get(entry.id) === entry) entries.delete(entry.id);
			};
		},
		registerConsumer(subscription) {
			subscriptions.set(subscription.id, subscription);
			return () => {
				if (subscriptions.get(subscription.id) === subscription) subscriptions.delete(subscription.id);
			};
		},
		queueDecisions(request) {
			const state = actionState(request.actionKey);
			if (state.action === undefined) state.action = request.action;
			const wanted = resolveQuestions(request);
			const queued: string[] = [];
			for (const question of wanted) {
				const already = state.queue.some((item) => item.question === question && item.consumer === request.consumer);
				if (already) continue;
				state.queue.push({ question, consumer: request.consumer });
				queued.push(question);
			}
			if (queued.length > 0) armIdleFlush(request.actionKey);
			return queued;
		},
		queued(actionKey) {
			return actions.get(actionKey)?.queue ?? [];
		},
		questionIds() {
			return [...entries.keys()];
		},
		async sendDecisions(request) {
			const state = actionState(request.actionKey);
			// A send is the flush: an idle flush already scheduled for this action
			// would ask the same questions twice. The first action recorded for the
			// key stays: a queue entry was stored with the context that motivated it
			// (a tool call carrying its policy match), and a later sender's context
			// can be narrower than that.
			state.timer?.();
			state.timer = undefined;

			const byConsumer = sendSet(request.action, request.actionKey, request);
			const wanted = [...new Set([...byConsumer.values()].flat())];
			const started = now();
			const bounded = bound(request.timeoutMs, request.signal);

			let requests: readonly GroupRequest[] = [];
			let result: DecisionResult;
			try {
				const outcome = await ensure(request.action, request.actionKey, wanted, bounded.signal);
				requests = outcome.requests;
				writeRecords(request.actionKey, outcome.requests, request.interpret);
				result = summarize(request.actionKey, outcome.requests, outcome.reused, now() - started);
			} finally {
				bounded.dispose();
			}

			for (const [consumerId, questions] of byConsumer) {
				const subscription = subscriptions.get(consumerId);
				if (!subscription?.onAnswers) continue;
				const readings = readingsFor(state, questions);
				const carried = requests.filter((entry) => entry.questions.some((question) => questions.includes(question)));
				// A consumer whose whole set went out reports success or failure for the
				// set: nobody is handed half an answer.
				const ok = readings.length === questions.length && carried.every((entry) => entry.ok);
				try {
					subscription.onAnswers({ actionKey: request.actionKey, consumer: consumerId, result, readings, ok, action: state.action as A });
				} catch {
					// A consumer that throws on delivery does not corrupt the result
					// other consumers already received.
				}
			}
			return result;
		},
		async flushPending() {
			// Draining is also the disarm: a timer for an action about to be asked
			// would only ask it a second time.
			for (const state of actions.values()) {
				state.timer?.();
				state.timer = undefined;
			}
			const pending = [...actions.keys()].filter((key) => (actions.get(key)?.queue.length ?? 0) > 0);
			const results = await Promise.all(pending.map((key) => flushAction(key).catch(() => undefined)));
			return results.filter((result): result is DecisionResult => result !== undefined);
		},
		forget(actionKey) {
			actions.get(actionKey)?.timer?.();
			actions.delete(actionKey);
		},
	};

	return core;
}
