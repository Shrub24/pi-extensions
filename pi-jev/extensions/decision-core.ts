/*
 * The decision core: question batching across independent consumers.
 *
 * The unit of work is a SUBJECT — one call, one child, one session state — and
 * the core does five things:
 *
 *   1. Collect. Consumers register interest in questions; a trigger announces a
 *      subject and the interested questions are queued, or a consumer asks for a
 *      specific set on the spot.
 *   2. Build. Every question names the context blocks it reads (`ask`,
 *      `tool_history`, `plan`, …). A flush builds each needed block once, at fire
 *      time, and assembles one state object out of them under their names. A
 *      block is built once per flush however many questions read it.
 *   3. Ask. One request per flush, carrying the whole merged state. Questions are
 *      chunked only when pi-typesafe's 32-question cap forces it, and a
 *      consumer's set is never split across chunks: a consumer is answered from
 *      one request or reported failed.
 *   4. Remember. Answers are cached per subject and per question, and concurrent
 *      requests for the same question set share one in-flight promise. This is
 *      what makes "ask them all at once" work inside Pi's sequential hooks: the
 *      first consumer's flush pays the latency, and one that arrives afterwards
 *      with questions already asked pays nothing.
 *   5. Hand back. Every answer reaches the consumer that asked for it. The core
 *      has no opinion about what an answer means: weighting, thresholds,
 *      verdicts, nudge text and timeout decisions all live in consumers.
 *
 * Subjects are the batching key, not the session. A child's pending check-in and
 * a permission ask about that child's call are different subjects, so they flush
 * at their own moments and their nudges never stack; two consumers asking about
 * the same call share one request.
 *
 * No Pi import, no network, no clock beyond an injected one: the core is a pure
 * function of its registry and its judge, so a test drives it with a fake.
 */

import type { JevAnswer, JevQuestion, JevQuestions, JevUsage } from "./types.js";

/**
 * What a request's state was assembled from.
 *
 * Recorded per request, because "why was the judge asked this?" has to stay
 * answerable from the log alone: the block names say which context sections were
 * in front of it, the hashes say whether that context had changed, and the
 * truncations say what was cut to fit.
 */
export interface BlockProvenance {
	id: string;
	/** Hash of the block's built state; equal hashes mean identical context. */
	hash: string;
	chars: number;
	truncated: readonly string[];
}

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
	 * per subject. A reading under one wording must not satisfy a later ask whose
	 * wording differs; `dropStaleWording` clears such readings before they are
	 * reused.
	 */
	wording?: string;
	/** The reader's own per-question detail, verbatim (a choice question's pick). */
	detail?: Record<string, unknown>;
}

/** One request's outcome, as the core reports it. */
export interface CoreRequest {
	id: string;
	subjectKey: string;
	/** The blocks this request's state was made of, in build order. */
	blocks: readonly BlockProvenance[];
	/** Total characters of state sent; the sum of the block sizes. */
	chars: number;
	/**
	 * The state this request sent, kept for the record sink so an objection can be
	 * read back against what the judge actually saw. Nothing else reads it: the
	 * questions were worded and answered against it already.
	 */
	state?: unknown;
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

/** Everything one subject's flush produced. */
export interface DecisionResult {
	subjectKey: string;
	requests: readonly CoreRequest[];
	/** Questions this flush answered from an earlier request instead of asking again. */
	reused: readonly string[];
	/** True when every request that ran succeeded. */
	ok: boolean;
	/** Readings merged across the requests, keyed by question id. */
	readings: Record<string, Reading>;
	elapsedMs: number;
}

/**
 * The work being judged. `kind` is free-form — "call", "child", "session" — and
 * exists so a record can say what sort of thing an answer was about.
 */
export interface Subject {
	/** The batching identity: one call, one child, one session. */
	key: string;
	kind: string;
	/**
	 * The host's own id for this work, when it has one — a permission request id,
	 * say. Records carry it as `requestId`, which is what the decision channel
	 * joins on; the key is for batching and is free to be coarser.
	 */
	correlationId?: string;
}

/**
 * `queueDecisions` adds work for later. A consumer that only wants a question
 * answered eventually — the next nudge, the next report — queues it and moves on;
 * nothing is asked, nothing is charged.
 */
export interface QueueRequest<A = unknown> {
	subject: Subject;
	/**
	 * The subject's own material: the facts that exist only at trigger time (the
	 * command, the notice line, the policy match). Blocks that need point-in-time
	 * state read it from here; blocks that want the live session read the input's
	 * conversation, which callers that queue long-lived work supply as a thunk.
	 */
	input: A;
	/** The consumer queuing; its own questions stay its own for delivery. */
	consumer: string;
	/** Question ids to queue. Mutually exclusive with `block`. */
	questions?: readonly string[];
	/** Every question reading one context block, in registration order. */
	block?: string;
}

/**
 * `sendDecisions` is the immediate call: it takes everything already queued for
 * this subject — what other consumers queued, and what every active consumer
 * registered a standing interest in — adds the caller's own questions, builds
 * one state from the blocks they read, and asks the whole set in one pass, then
 * hands each consumer its own readings back.
 */
export interface SendRequest<A = unknown> extends QueueRequest<A> {
	/** Opaque per-band detail for the log; the core never reads it. */
	/**
	 * How this consumer's own answers read, for a flush it did not start — a
	 * boundary flush of its queued work. The input is the subject's stored one,
	 * so a reader can see the facts the call carried.
	 */
	interpret?: (readings: readonly Reading[], input?: A) => unknown;
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

/** A named context block: one section of the state, built on demand. */
export interface StateBlock<A = unknown> {
	id: string;
	buildState(input: A): BuiltState;
}

/** One question, owned by a consumer, reading named context blocks. */
export interface QuestionEntry<A = unknown> {
	id: string;
	/** The blocks this question reads; each must name a registered block. */
	blocks: readonly string[];
	owner: string;
	/** Interpretation metadata (role, edge, measured); opaque to the core. */
	meta?: Record<string, unknown>;
	/** False means this subject gives the question nothing to read. */
	applies?(input: A): boolean;
	question(input: A): JevQuestion;
	/** Normalizes and validates an answer. Undefined means unusable. */
	read(answer: JevAnswer | undefined): { probability?: number; level?: number; detail?: Record<string, unknown> } | undefined;
}

/** A consumer's standing interest: what to queue whenever a subject happens. */
export interface ConsumerSubscription<A = unknown> {
	id: string;
	/** Question ids this consumer wants; `applies` narrows by subject. */
	questions: readonly string[];
	applies?(input: A): boolean;
	/** Called after a flush with the readings for this consumer's questions. */
	onAnswers?(delivery: ConsumerDelivery): void;
	/**
	 * How this consumer's own answers read, for a flush it did not start — a
	 * boundary flush of its queued work. The input is the subject's stored one,
	 * so a reader can see the facts the call carried.
	 */
	interpret?: (readings: readonly Reading[], input?: A) => unknown;
}

export interface ConsumerDelivery<A = unknown> {
	subjectKey: string;
	subject: Subject;
	consumer: string;
	result: DecisionResult;
	/** Only this consumer's questions, in registration order. */
	readings: readonly Reading[];
	/** True when every request carrying this consumer's questions succeeded. */
	ok: boolean;
	/** The input the flush judged — the stored one, which motivated the queue. */
	input: A;
}

export interface CoreRecordContext {
	request: CoreRequest;
	subjectKey: string;
	subject: Subject;
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
	 * idle is not a queue: asking then would spend on a subject that is finished
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
	 * A timer flush is always late — the subject it was queued for has moved on —
	 * so it can nudge and it can log, but it cannot gate. Hosts that need a gate
	 * must send before the action runs.
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
	/** How many subjects keep their answers cached. Oldest are dropped first. */
	maxRememberedSubjects?: number;
	now?: () => number;
}

export interface DecisionCore<A = unknown> {
	registerBlock(block: StateBlock<A>): () => void;
	registerQuestions(entries: readonly QuestionEntry<A>[]): () => void;
	registerConsumer(subscription: ConsumerSubscription<A>): () => void;
	/** Add questions to a subject's queue. Nothing is asked. Returns what was newly queued. */
	queueDecisions(request: QueueRequest<A>): readonly string[];
	/**
	 * Ask now: the subject's whole queue plus this caller's questions, in one pass.
	 * Answers already known for the subject are reused rather than asked again.
	 */
	sendDecisions(request: SendRequest<A>): Promise<DecisionResult>;
	/** Ask everything queued for every subject, as a boundary would. */
	flushPending(): Promise<readonly DecisionResult[]>;
	/** Drop one subject's answers, and cancel its idle flush. Called at a boundary. */
	forget(subjectKey: string): void;
	/** What is queued for a subject, for tests and diagnostics. */
	queued(subjectKey: string): readonly { question: string; consumer: string }[];
	/** The registered question ids, in registration order. */
	questionIds(): readonly string[];
	/** The registered block ids, in registration order. */
	blockIds(): readonly string[];
}

interface QueuedQuestion {
	question: string;
	consumer: string;
}

const DEFAULT_MAX_QUESTIONS = 32;
const DEFAULT_MAX_SUBJECTS = 64;

export function createDecisionCore<A = unknown>(options: DecisionCoreOptions<A>): DecisionCore<A> {
	const maxQuestions = options.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS;
	const maxSubjects = options.maxRememberedSubjects ?? DEFAULT_MAX_SUBJECTS;
	const now = options.now ?? (() => Date.now());
	const schedule = options.schedule;
	const gapMs = options.flushGapMs ?? 0;

	const blocks = new Map<string, StateBlock<A>>();
	const entries = new Map<string, QuestionEntry<A>>();
	const subscriptions = new Map<string, ConsumerSubscription<A>>();

	/** Per subject: the queued questions, the answered readings, and the in-flight promises. */
	interface SubjectState {
		subject: Subject | undefined;
		/** The input as it was announced; a timer flush has no other source for it. */
		input: A | undefined;
		queue: QueuedQuestion[];
		readings: Map<string, Reading>;
		/** A question set's promise, so a concurrent flush waits instead of re-asking. */
		inFlight: Map<string, Promise<CoreRequest[]>>;
		/** Cancels this subject's idle flush. */
		timer?: () => void;
	}
	const subjects = new Map<string, SubjectState>();

	function subjectState(subjectKey: string): SubjectState {
		const existing = subjects.get(subjectKey);
		if (existing) {
			// Refresh insertion order so the LRU eviction drops the least recently used.
			subjects.delete(subjectKey);
			subjects.set(subjectKey, existing);
			return existing;
		}
		const created: SubjectState = { subject: undefined, input: undefined, queue: [], readings: new Map(), inFlight: new Map() };
		subjects.set(subjectKey, created);
		while (subjects.size > maxSubjects) {
			const oldest = subjects.keys().next();
			if (oldest.done) break;
			if (oldest.value === subjectKey) break;
			subjects.delete(oldest.value);
		}
		return created;
	}

	function known(state: SubjectState, question: string): boolean {
		return state.readings.has(question);
	}

	/**
	 * Records for the requests that just ran, each carrying the same interpretation.
	 *
	 * One interpretation is computed for the whole ask — bands and a verdict are
	 * statements about all the answers together, and a per-request reading of them
	 * would be a partial picture — and then attached to every request record. Each
	 * record is therefore self-contained: the readings it carried, the blocks it
	 * sent, and what the asking consumer made of the whole set.
	 */
	function writeRecords(
		state: SubjectState,
		subjectKey: string,
		requests: readonly CoreRequest[],
		interpret?: (readings: readonly Reading[], input?: A) => unknown,
	): void {
		if (!options.record || requests.length === 0) return;
		let interpreted: unknown;
		if (interpret) {
			try {
				// The subject's own input rides along: a reader that needs the facts a
				// call carried (which tool the policy named, say) reads them here.
				interpreted = interpret([...state.readings.values()], state.input);
			} catch {
				// A caller's interpreter is opaque to the core; a defect in it cannot
				// fail a request that already produced answers.
			}
		}
		for (const request of requests) {
			try {
				options.record({ request, subjectKey, subject: state.subject ?? { key: subjectKey, kind: "unknown" }, interpreted });
			} catch {
				// Observability never fails a decision.
			}
		}
	}

	/**
	 * Drop readings whose question has since been worded differently. A choice
	 * question names its alternatives, so `tool.choice` for one subject is not
	 * `tool.choice` for another; without this, the second subject would be served
	 * the first one's answer under the same id.
	 */
	function dropStaleWording(input: A, state: SubjectState, wanted: readonly string[]): void {
		for (const id of wanted) {
			const entry = entries.get(id);
			if (!entry) continue;
			const question = entry.question(input);
			const stored = state.readings.get(id);
			if (!stored) continue;
			if (stored.wording === undefined) continue;
			const current = question === undefined ? undefined : hashKey(question);
			if (stored.wording !== current) state.readings.delete(id);
		}
	}

	/** Readings for the questions this consumer asked, in the order it asked them. */
	function readingsFor(state: SubjectState, questions: readonly string[]): Reading[] {
		const found: Reading[] = [];
		for (const question of questions) {
			const reading = state.readings.get(question);
			if (reading) found.push(reading);
		}
		return found;
	}

	/**
	 * The state one flush sends: every block its questions read, built once, under
	 * its own name.
	 *
	 * Build-once is not an optimization here — it is what keeps one flush's
	 * requests describing the same instant. Two blocks built at different moments
	 * could disagree about the session, and the questions reading them would be
	 * answered from different worlds.
	 *
	 * A question naming a block nobody registered gets a provenance entry with no
	 * state: the gap is recorded rather than thrown, because a consumer asking for
	 * context nobody supplies is a defect in the caller, not in the subject.
	 */
	function buildState(input: A, pending: readonly QuestionEntry<A>[]): { state: Record<string, unknown>; provenance: BlockProvenance[]; chars: number } {
		const state: Record<string, unknown> = {};
		const provenance: BlockProvenance[] = [];
		const built = new Map<string, BuiltState>();
		let chars = 0;
		for (const entry of pending) {
			for (const id of entry.blocks) {
				if (state[id] !== undefined || built.has(id)) continue;
				const block = blocks.get(id);
				const result = block ? block.buildState(input) : { state: undefined, stateHash: "", chars: 0, truncated: [] as readonly string[] };
				built.set(id, result);
				provenance.push({ id, hash: result.stateHash, chars: result.chars, truncated: result.truncated });
				if (result.state !== undefined) state[id] = result.state;
				chars += result.chars;
			}
		}
		return { state, provenance, chars };
	}

	async function ensure(
		input: A,
		subjectKey: string,
		wanted: readonly string[],
		signal?: AbortSignal,
	): Promise<{ requests: CoreRequest[]; reused: string[] }> {
		const state = subjectState(subjectKey);
		// The stored input is authoritative: it is the context the queued questions
		// were motivated by (a tool call carrying its policy match), and a later
		// sender's input can be narrower. When nothing is stored — a send with no
		// queue behind it — the caller's input is recorded.
		const effective = state.input ?? input;
		if (state.input === undefined) state.input = input;
		dropStaleWording(effective, state, wanted);
		const missing = wanted.filter((question) => !known(state, question));
		const reused = wanted.filter((question) => known(state, question));
		if (missing.length === 0) return { requests: [], reused };

		// Which questions will actually be asked, and by which consumer.
		const pending: QuestionEntry<A>[] = [];
		const byOwner = new Map<string, QuestionEntry<A>[]>();
		for (const id of missing) {
			const entry = entries.get(id);
			if (!entry) {
				// An unregistered question is answered with a missing reading rather
				// than a throw: a consumer asking for something nobody owns is a
				// defect in the caller, not in the subject.
				state.readings.set(id, { question: id, owner: "unregistered", probability: null, level: null, ok: false });
				continue;
			}
			if (entry.applies && !entry.applies(effective)) {
				state.readings.set(id, { question: id, owner: entry.owner, probability: null, level: null, ok: false });
				continue;
			}
			pending.push(entry);
			byOwner.set(entry.owner, [...(byOwner.get(entry.owner) ?? []), entry]);
		}
		if (pending.length === 0) return { requests: [], reused };

		const key = `${subjectKey}::${[...wanted].sort().join(",")}`;
		const running = state.inFlight.get(key);
		if (running) {
			// A concurrent flush for the same question set: wait on it rather than
			// asking the same questions twice, and count these questions as reused —
			// this caller issued no request of its own.
			const shared = await running;
			for (const request of shared) for (const reading of request.readings) state.readings.set(reading.question, reading);
			return { requests: [], reused: [...new Set([...reused, ...wanted])] };
		}

		const work = (async (): Promise<CoreRequest[]> => {
			const built = buildState(effective, pending);
			const chunks = packChunks(byOwner, maxQuestions);
			return Promise.all(
				chunks.map((chunk, index) =>
					runChunk({
						input: effective,
						subjectKey,
						requestId: `${subjectKey}:${index}`,
						built,
						chunk,
						...(signal ? { signal } : {}),
					}),
				),
			);
		})();
		state.inFlight.set(key, work);
		void work.then(() => state.inFlight.delete(key)).catch(() => state.inFlight.delete(key));

		const requests = await work;
		for (const request of requests) for (const reading of request.readings) state.readings.set(reading.question, reading);
		return { requests, reused: [...new Set(reused)] };
	}

	/**
	 * Chunk a flush into requests, keeping each consumer's set whole.
	 *
	 * Chunking exists only because pi-typesafe caps a request at 32 questions. A
	 * consumer larger than one request cannot keep its atomicity; it becomes one
	 * oversized chunk the admission layer rejects, so the failure is attributed
	 * rather than silently split.
	 */
	function packChunks(byOwner: Map<string, QuestionEntry<A>[]>, limit: number): QuestionEntry<A>[][] {
		const chunks: QuestionEntry<A>[][] = [];
		let current: QuestionEntry<A>[] = [];
		for (const set of byOwner.values()) {
			if (set.length > limit) {
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
		input: A;
		subjectKey: string;
		requestId: string;
		built: { state: Record<string, unknown>; provenance: BlockProvenance[]; chars: number };
		chunk: QuestionEntry<A>[];
		signal?: AbortSignal;
	}): Promise<CoreRequest> {
		const questions: JevQuestions = {};
		for (const entry of input.chunk) {
			const question = entry.question(input.input);
			if (question) questions[entry.id] = question;
		}
		const ids = input.chunk.map((entry) => entry.id);
		const startedAt = now();
		const outcome = await options.ask(input.built.state, questions, input.signal ? { signal: input.signal } : {});
		const latencyMs = now() - startedAt;

		const readings: Reading[] = [];
		const request: CoreRequest = {
			id: input.requestId,
			subjectKey: input.subjectKey,
			blocks: input.built.provenance,
			chars: input.built.chars,
			state: input.built.state,
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
					...(read?.detail ? { detail: read.detail } : {}),
					...(questions[entry.id] === undefined ? {} : { wording: hashKey(questions[entry.id]) }),
				});
			}
		}

		return request;
	}

	function summarize(subjectKey: string, requests: readonly CoreRequest[], reused: readonly string[], elapsedMs: number): DecisionResult {
		const state = subjectState(subjectKey);
		const readings: Record<string, Reading> = {};
		for (const [id, reading] of state.readings) readings[id] = reading;
		return {
			subjectKey,
			requests,
			reused,
			ok: requests.every((request) => request.ok),
			readings,
			elapsedMs,
		};
	}

	/** Questions a request names: explicit ids, or everything reading one block. */
	function resolveQuestions(request: QueueRequest<A>): string[] {
		if (request.questions) return [...request.questions];
		if (request.block === undefined) return [];
		return [...entries.values()].filter((entry) => entry.blocks.includes(request.block as string)).map((entry) => entry.id);
	}

	/**
	 * Everything a send should cover: explicitly queued questions, the caller's
	 * own, and the standing interest of every consumer the subject matches. Active
	 * consumers are what makes a single send carry the whole set.
	 */
	function sendSet(input: A, subjectKey: string, request: QueueRequest<A>): Map<string, string[]> {
		const state = subjectState(subjectKey);
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
			if (subscription.applies && !subscription.applies(input)) continue;
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

	/** The idle flush: ask a queued subject anyway, once nothing has sent for it. */
	function armIdleFlush(subjectKey: string): void {
		if (!gapMs || !schedule) return;
		if (options.isRunning && !options.isRunning()) return;
		const state = subjects.get(subjectKey);
		if (!state || state.timer) return;
		state.timer = schedule(() => {
			const pending = subjects.get(subjectKey);
			if (!pending) return;
			pending.timer = undefined;
			// The turn can end between arming and firing; a timer that wakes into
			// an idle session is the one thing this must not do.
			if (options.isRunning && !options.isRunning()) return;
			void flushSubject(subjectKey).catch(() => {
				// A timed flush is best-effort: its failures are already recorded.
			});
		}, gapMs);
	}

	/** Ask whatever is queued for one subject, and deliver it. Used by the timer. */
	async function flushSubject(subjectKey: string): Promise<DecisionResult | undefined> {
		const state = subjects.get(subjectKey);
		if (!state || state.input === undefined || state.queue.length === 0) return undefined;
		const consumer = state.queue[0]?.consumer ?? "unknown";
		const wanted = [...new Set(state.queue.map((item) => item.question))];
		// A boundary flush has no caller to interpret it, so the consumer that
		// queued supplies the reading — but only when its questions are the whole
		// flush, because one interpretation describes one ask.
		const owners = new Set(state.queue.map((entry) => entry.consumer));
		const interpret = owners.size === 1 ? subscriptions.get([...owners][0] as string)?.interpret : undefined;
		return core.sendDecisions({ subject: state.subject ?? { key: subjectKey, kind: "unknown" }, input: state.input, consumer, questions: wanted, ...(interpret ? { interpret } : {}) });
	}

	/**
	 * Readings are stored per question **wording**, not per id: a choice question
	 * names its alternatives, so the same id can be a different question for a
	 * different subject, and the second wording must not be served the first
	 * wording's answer. The wording is hashed from the wire question itself.
	 */
	function hashKey(value: unknown): string {
		const text = JSON.stringify(value) ?? "";
		let hash = 0;
		for (let index = 0; index < text.length; index += 1) {
			hash = (hash * 31 + text.charCodeAt(index)) | 0;
		}
		return (hash >>> 0).toString(36);
	}

	const core: DecisionCore<A> = {
		registerBlock(block) {
			blocks.set(block.id, block);
			return () => {
				if (blocks.get(block.id) === block) blocks.delete(block.id);
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
			const state = subjectState(request.subject.key);
			if (state.input === undefined) {
				state.input = request.input;
				state.subject = request.subject;
			}
			const wanted = resolveQuestions(request);
			const queued: string[] = [];
			for (const question of wanted) {
				const already = state.queue.some((item) => item.question === question && item.consumer === request.consumer);
				if (already) continue;
				state.queue.push({ question, consumer: request.consumer });
				queued.push(question);
			}
			if (queued.length > 0) armIdleFlush(request.subject.key);
			return queued;
		},
		queued(subjectKey) {
			return subjects.get(subjectKey)?.queue ?? [];
		},
		questionIds() {
			return [...entries.keys()];
		},
		blockIds() {
			return [...blocks.keys()];
		},
		async sendDecisions(request) {
			const subjectKey = request.subject.key;
			const state = subjectState(subjectKey);
			if (state.subject === undefined) state.subject = request.subject;
			// A send is the flush: an idle flush already scheduled for this subject
			// would ask the same questions twice. The first input recorded for the
			// key stays: a queue entry was stored with the context that motivated it
			// (a tool call carrying its policy match), and a later sender's input can
			// be narrower than that.
			state.timer?.();
			state.timer = undefined;

			const byConsumer = sendSet(state.input ?? request.input, subjectKey, request);
			const wanted = [...new Set([...byConsumer.values()].flat())];
			const started = now();
			const bounded = bound(request.timeoutMs, request.signal);

			let requests: readonly CoreRequest[] = [];
			let result: DecisionResult;
			try {
				const outcome = await ensure(request.input, subjectKey, wanted, bounded.signal);
				requests = outcome.requests;
				writeRecords(state, subjectKey, outcome.requests, request.interpret);
				result = summarize(subjectKey, outcome.requests, outcome.reused, now() - started);
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
					subscription.onAnswers({
						subjectKey,
						subject: state.subject ?? request.subject,
						consumer: consumerId,
						result,
						readings,
						ok,
						input: (state.input ?? request.input) as A,
					});
				} catch {
					// A consumer that throws on delivery does not corrupt the result
					// other consumers already received.
				}
			}
			return result;
		},
		async flushPending() {
			// Draining is also the disarm: a timer for a subject about to be asked
			// would only ask it a second time.
			for (const state of subjects.values()) {
				state.timer?.();
				state.timer = undefined;
			}
			const pending = [...subjects.keys()].filter((key) => (subjects.get(key)?.queue.length ?? 0) > 0);
			const results = await Promise.all(pending.map((key) => flushSubject(key).catch(() => undefined)));
			return results.filter((result): result is DecisionResult => result !== undefined);
		},
		forget(subjectKey) {
			subjects.get(subjectKey)?.timer?.();
			subjects.delete(subjectKey);
		},
	};

	return core;
}
