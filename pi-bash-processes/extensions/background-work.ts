// Public background settlement seam: how a background-work provider (the sole
// owner of managed task state) exposes assignment binding, current settlement
// snapshots and change notifications to consumers such as a settlement guard.
//
// Constraints this module keeps (openspec/changes/herdsman-background-handoffs/
// design.md D1/D2):
// - One registration slot per supplied session-local bus. No global provider
//   singleton, task map, process handle, timer or persisted registry lives
//   here; the bus-attached symbol slot below is only the duplicate/stale-
//   registration guard, shared by every helper module instance on that bus.
// - Queries resolve inside the bus `emit` call. Pi's EventBus invokes
//   listeners synchronously through a rejecting-safe async trampoline
//   (pi-coding-agent dist/core/event-bus.js), so a provider answers
//   immediately from its own state. Asynchronous, late, duplicate or
//   malformed replies are rejected, never awaited: there is deliberately no
//   polling or timer protocol in this module.
// - Absence (`absent`) is not reconciling, not error and not a zero-task
//   snapshot. A query that expects a known provider reports `missing` when it
//   stops answering, so a disappeared provider can never read as success.
// - This module owns only the dependency-light session-local contract and
//   registry. `background-tasks.ts` registers the concrete provider, while
//   consumers use this interface without importing task machinery.

import { randomUUID } from "node:crypto";

/** Protocol identifier stamped on every envelope on the channels below. */
export const BACKGROUND_WORK_PROTOCOL = "background-work/v1";

/** Carries `snapshot-query` envelopes; the registered provider replies on the reply channel. */
export const BACKGROUND_WORK_SNAPSHOT_QUERY_CHANNEL = "pi-background-work:v1:snapshot-query";
/** Carries `bind` envelopes; the registered provider replies on the reply channel. */
export const BACKGROUND_WORK_BIND_CHANNEL = "pi-background-work:v1:bind";
/** Carries `protect` envelopes: mandatory-wake marking for a bound assignment. */
export const BACKGROUND_WORK_PROTECT_CHANNEL = "pi-background-work:v1:protect";
/** Carries `reply` envelopes. Listeners exist only inside one query's synchronous emit window. */
export const BACKGROUND_WORK_REPLY_CHANNEL = "pi-background-work:v1:reply";
/** Carries `changed` metadata: identity/revision scope only, never task data. */
export const BACKGROUND_WORK_CHANGED_CHANNEL = "pi-background-work:v1:changed";

/** Upper bound for provider-supplied reason/message strings carried through results. */
export const BACKGROUND_WORK_MAX_REASON_CHARS = 512;
/** Upper bound on the outstanding-task list in one snapshot; beyond it the snapshot is rejected, never truncated. */
export const BACKGROUND_WORK_MAX_OUTSTANDING = 128;
/** Upper bound for any identity string (provider/session/request/task/query/registration ids); beyond it the value is rejected, never truncated. */
export const BACKGROUND_WORK_MAX_ID_CHARS = 256;
/** Upper bound on raw replies collected inside one query's emit window; beyond it the query fails closed as ambiguous. */
export const BACKGROUND_WORK_MAX_REPLIES = 8;

/**
 * The part of Pi's public extension event bus (`pi.events`) this seam needs:
 * `emit` returns void, `on` returns an unsubscribe closure.
 */
export interface BackgroundWorkEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/**
 * The assignment a query or bind is about. `expectedProviderId` is caller-side
 * expectation only: it is checked by the helper and never forwarded to the
 * provider, which does not decide who is asking.
 */
export interface BackgroundWorkScope {
	sessionId: string;
	requestId: string;
	expectedProviderId?: string;
}

/** How one outstanding task is currently outstanding. */
export type BackgroundWorkTaskState = "running" | "flushing" | "awaiting-result-review";

/** One task the provider still counts against assignment settlement. */
export interface BackgroundWorkOutstandingTask {
	taskId: string;
	state: BackgroundWorkTaskState;
	/** Why the task is outstanding; bounded to BACKGROUND_WORK_MAX_REASON_CHARS. */
	reason: string;
}

/**
 * Whether the snapshot is authoritative yet. `error` carries an actionable
 * reason: a registered-but-broken provider must block, never look idle.
 */
export type BackgroundWorkReconciliation =
	| { state: "ready" }
	| { state: "reconciling"; reason?: string }
	| { state: "error"; reason: string };

/**
 * The bounded settlement view a provider serves. Fixed field set by
 * construction: the helper rebuilds what it validates, so provider extras,
 * log text and task details never leak through.
 */
export interface BackgroundWorkSnapshot {
	provider: { id: string; version: number };
	sessionId: string;
	requestId: string;
	/** Provider-owned monotonic revision; scopes change metadata. */
	revision: number;
	reconciliation: BackgroundWorkReconciliation;
	outstanding: readonly BackgroundWorkOutstandingTask[];
}

/** Fail-closed conditions a query or bind can report. */
export type BackgroundWorkErrorCode =
	/** More than one reply claimed this query; nothing was chosen. */
	| "ambiguous-reply"
	/** A reply on the bus was not a well-formed background-work envelope. */
	| "malformed-reply"
	/** No current registration matches the replying registrationId (stale or disposed). */
	| "stale-reply"
	/** The provider's method threw; the message is the exception's text. */
	| "provider-exception"
	/** The provider answered, but its payload violates the provider contract (including async replies). */
	| "provider-malformed"
	/** Session/request/provider identities do not match the query or the registration. */
	| "identity-mismatch"
	/** The provider itself reports reconciliation error; message is its reason. */
	| "provider-error";

export interface BackgroundWorkError {
	code: BackgroundWorkErrorCode;
	message: string;
}

/**
 * Result of a snapshot query. Discriminated on `state`:
 * - `absent` — no registration on this bus and none expected.
 * - `missing` — a registration or `expectedProviderId` existed, but nothing
 *   current answered; never reinterpreted as an empty successful snapshot.
 * - `ready` / `reconciling` — validated snapshot from the registered provider.
 * - `error` — fail-closed condition above; `snapshot` is attached only when
 *   the provider reported its own reconciliation error.
 */
export type BackgroundWorkQueryResult =
	| { state: "absent" }
	| { state: "missing"; expectedProviderId?: string }
	| { state: "ready"; snapshot: BackgroundWorkSnapshot }
	| { state: "reconciling"; snapshot: BackgroundWorkSnapshot }
	| { state: "error"; error: BackgroundWorkError; snapshot?: BackgroundWorkSnapshot };

/** What a provider returns from `bind`; refusal is an outcome, not an error. */
export type BackgroundWorkBindReply = { ok: true } | { ok: false; reason: string };

/**
 * Result of a bind query. `bound` and `refused` (with the provider's reason)
 * are delegated answers; `absent`/`missing`/`error` match snapshot-query
 * semantics.
 */
export type BackgroundWorkBindResult =
	| { state: "absent" }
	| { state: "missing"; expectedProviderId?: string }
	| { state: "bound" }
	| { state: "refused"; reason: string }
	| { state: "error"; error: BackgroundWorkError };

/**
 * The registered provider. It owns all task state; both methods must answer
 * synchronously from that state and may throw (reported as
 * `provider-exception`). Returning a promise is a contract violation
 * (`provider-malformed`) and is never awaited.
 */
export interface BackgroundWorkProvider {
	/** Stable provider identity, e.g. "pi-bash-processes". */
	readonly id: string;
	/** Provider implementation revision: a non-negative integer. */
	readonly version: number;
	snapshot(scope: BackgroundWorkScope): BackgroundWorkSnapshot;
	bind(scope: BackgroundWorkScope): BackgroundWorkBindReply;
	/**
	 * Mark (or unmark) the bound assignment as settlement-waiting: its tasks'
	 * exit wakes become mandatory even under `notifyOnExit: false`
	 * (openspec `herdsman-background-handoffs` tasks 2.4). Optional so a
	 * snapshot/bind-only provider still registers; the protect query then
	 * answers `provider-malformed`.
	 */
	protect?(scope: BackgroundWorkScope, protect: boolean): BackgroundWorkBindReply;
}

/** Handle for one registration on one bus. */
export interface BackgroundWorkRegistration {
	readonly providerId: string;
	readonly providerVersion: number;
	/**
	 * Emit scoped change metadata for the provider's current snapshot.
	 * Returns false — emitting nothing — when disposed, when the provider
	 * throws, or when its snapshot no longer matches `scope` or the
	 * registration identity.
	 */
	notifyChange(scope: BackgroundWorkScope): boolean;
	/** Idempotent. Never disturbs a later registration on the same bus. */
	dispose(): void;
}

/** Change metadata: same identity/revision scope as a snapshot, no task data. */
export interface BackgroundWorkChange {
	provider: { id: string; version: number };
	registrationId: string;
	sessionId: string;
	requestId: string;
	revision: number;
}

/**
 * Duplicate, stale and disposal guard: one registration slot per bus. The
 * slot lives ON the bus under a process-wide symbol, so every helper module
 * instance sharing that bus — provider side, consumer side, independently
 * loaded copies — sees the same registration. No module-private WeakMap can
 * do that: separately imported copies of this file would each see absence.
 */
interface RegistrationSlot {
	registrationId: string;
	providerId: string;
	providerVersion: number;
	/** Set on dispose; hides the slot when a frozen bus keeps the property. */
	disposed?: boolean;
}

const REGISTRATION_SLOT = Symbol.for("pi-background-work:v1.registration");

function slotCarrier(bus: BackgroundWorkEventBus): { [key: symbol]: unknown } {
	return bus as unknown as { [key: symbol]: unknown };
}

function isRegistrationSlot(value: unknown): value is RegistrationSlot {
	return isRecord(value) && isNonEmptyString(value.registrationId) && isNonEmptyString(value.providerId) && isProviderVersion(value.providerVersion);
}

/**
 * The live registration slot attached to `bus`, or null when nothing (or a
 * disposed slot) is attached. Invalid metadata reads as no live slot: callers
 * then fail closed (missing/stale), never as an empty successful snapshot.
 */
function readSlot(bus: BackgroundWorkEventBus): RegistrationSlot | null {
	const value = slotCarrier(bus)[REGISTRATION_SLOT];
	if (value === undefined) return null;
	if (!isRegistrationSlot(value)) return null;
	return value.disposed ? null : value;
}

const BACKGROUND_WORK_ERROR_CODES: readonly BackgroundWorkErrorCode[] = [
	"ambiguous-reply",
	"malformed-reply",
	"stale-reply",
	"provider-exception",
	"provider-malformed",
	"identity-mismatch",
	"provider-error",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string): string {
	return value.length > BACKGROUND_WORK_MAX_REASON_CHARS ? `${value.slice(0, BACKGROUND_WORK_MAX_REASON_CHARS - 1)}…` : value;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	return typeof error === "string" ? error : String(error);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** An identity string: non-empty and within the identity bound. */
function isBoundedId(value: unknown): value is string {
	return isNonEmptyString(value) && value.length <= BACKGROUND_WORK_MAX_ID_CHARS;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function";
}

/** Consumes a rejected async provider answer: never awaited, never unhandled. */
function consumeRejection(value: PromiseLike<unknown>): void {
	void Promise.resolve(value).catch(() => {});
}

function isProviderVersion(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function requireBus(bus: BackgroundWorkEventBus): void {
	if (!isRecord(bus) || typeof bus.emit !== "function" || typeof bus.on !== "function") {
		throw new TypeError("background-work: an event bus with emit/on is required");
	}
}

function requireScope(scope: BackgroundWorkScope): void {
	if (!isNonEmptyString(scope?.sessionId)) throw new TypeError("background-work: scope.sessionId must be a non-empty string");
	if (!isNonEmptyString(scope.requestId)) throw new TypeError("background-work: scope.requestId must be a non-empty string");
	if (scope.sessionId.length > BACKGROUND_WORK_MAX_ID_CHARS) throw new TypeError(`background-work: scope.sessionId exceeds ${BACKGROUND_WORK_MAX_ID_CHARS} characters`);
	if (scope.requestId.length > BACKGROUND_WORK_MAX_ID_CHARS) throw new TypeError(`background-work: scope.requestId exceeds ${BACKGROUND_WORK_MAX_ID_CHARS} characters`);
	if (scope.expectedProviderId !== undefined && !isNonEmptyString(scope.expectedProviderId)) {
		throw new TypeError("background-work: scope.expectedProviderId must be a non-empty string when set");
	}
	if (scope.expectedProviderId !== undefined && scope.expectedProviderId.length > BACKGROUND_WORK_MAX_ID_CHARS) {
		throw new TypeError(`background-work: scope.expectedProviderId exceeds ${BACKGROUND_WORK_MAX_ID_CHARS} characters`);
	}
}

function requireProvider(provider: BackgroundWorkProvider): void {
	if (!isRecord(provider) || !isNonEmptyString(provider.id) || provider.id.trim().length === 0) {
		throw new TypeError("background-work: provider.id must be a non-empty string");
	}
	if (provider.id.length > BACKGROUND_WORK_MAX_ID_CHARS) {
		throw new TypeError(`background-work: provider.id exceeds ${BACKGROUND_WORK_MAX_ID_CHARS} characters`);
	}
	if (!isProviderVersion(provider.version)) {
		throw new TypeError("background-work: provider.version must be a non-negative integer");
	}
	if (typeof provider.snapshot !== "function") throw new TypeError("background-work: provider.snapshot must be a function");
	if (typeof provider.bind !== "function") throw new TypeError("background-work: provider.bind must be a function");
}

function errorResult(code: BackgroundWorkErrorCode, message: string): { state: "error"; error: BackgroundWorkError } {
	return { state: "error", error: { code, message: boundedText(message) } };
}

/** Shared shape for the query channels. */
interface ParsedQuery {
	queryId: string;
	sessionId: string;
	requestId: string;
	/** Present only on a `protect` envelope, where a boolean is required. */
	protect?: boolean;
}

function parseQueryEnvelope(raw: unknown, kind: "snapshot-query" | "bind" | "protect"): ParsedQuery | null {
	if (!isRecord(raw)) return null;
	if (raw.protocol !== BACKGROUND_WORK_PROTOCOL || raw.kind !== kind) return null;
	if (!isBoundedId(raw.queryId)) return null;
	if (!isRecord(raw.scope)) return null;
	const scope = raw.scope;
	if (!isBoundedId(scope.sessionId) || !isBoundedId(scope.requestId)) return null;
	if (kind === "protect") {
		if (typeof raw.protect !== "boolean") return null;
		return { queryId: raw.queryId, sessionId: scope.sessionId, requestId: scope.requestId, protect: raw.protect };
	}
	return { queryId: raw.queryId, sessionId: scope.sessionId, requestId: scope.requestId };
}

interface ParsedReply {
	queryId: string;
	registrationId: string;
	outcome: "ok" | "refused" | "error";
	hasSnapshot: boolean;
	snapshot: unknown;
	reason: string;
	error: { code: BackgroundWorkErrorCode; message: string } | null;
}

function parseReplyEnvelope(raw: unknown): ParsedReply | null {
	if (!isRecord(raw)) return null;
	if (raw.protocol !== BACKGROUND_WORK_PROTOCOL || raw.kind !== "reply") return null;
	if (!isBoundedId(raw.queryId)) return null;
	if (!isBoundedId(raw.registrationId)) return null;
	const base = { queryId: raw.queryId, registrationId: raw.registrationId };
	const hasSnapshot = "snapshot" in raw;
	if (raw.outcome === "ok") return { ...base, outcome: "ok", hasSnapshot, snapshot: raw.snapshot, reason: "", error: null };
	if (raw.outcome === "refused") {
		if (!isNonEmptyString(raw.reason) || raw.reason.trim().length === 0) return null;
		return { ...base, outcome: "refused", hasSnapshot, snapshot: undefined, reason: raw.reason, error: null };
	}
	if (raw.outcome === "error") {
		if (!isRecord(raw.error)) return null;
		const code = raw.error.code;
		if (!isNonEmptyString(code) || !(BACKGROUND_WORK_ERROR_CODES as readonly string[]).includes(code)) return null;
		if (typeof raw.error.message !== "string") return null;
		return { ...base, outcome: "error", hasSnapshot, snapshot: undefined, reason: "", error: { code: code as BackgroundWorkErrorCode, message: raw.error.message } };
	}
	return null;
}

function parseReconciliation(raw: unknown): BackgroundWorkReconciliation | null {
	if (!isRecord(raw)) return null;
	if (raw.state === "ready") return { state: "ready" };
	if (raw.state === "reconciling") {
		if (raw.reason === undefined) return { state: "reconciling" };
		if (!isNonEmptyString(raw.reason) || raw.reason.trim().length === 0) return null;
		return { state: "reconciling", reason: boundedText(raw.reason) };
	}
	if (raw.state === "error") {
		if (!isNonEmptyString(raw.reason) || raw.reason.trim().length === 0) return null;
		return { state: "error", reason: boundedText(raw.reason) };
	}
	return null;
}

/**
 * Validates provider output and rebuilds a bounded snapshot. Returns the
 * snapshot or a reason it was rejected: identities and the outstanding list
 * beyond their bounds are rejected outright, never truncated into a result.
 */
type ParsedSnapshot = { snapshot: BackgroundWorkSnapshot } | { reason: string };

function parseSnapshot(raw: unknown): ParsedSnapshot {
	if (!isRecord(raw)) return { reason: "snapshot is not an object" };
	if (!isRecord(raw.provider)) return { reason: "snapshot is missing its provider identity" };
	const provider = raw.provider;
	if (!isBoundedId(provider.id) || provider.id.trim().length === 0) return { reason: "snapshot provider id is empty or oversized" };
	if (!isProviderVersion(provider.version)) return { reason: "snapshot provider version is not a non-negative integer" };
	if (!isBoundedId(raw.sessionId) || !isBoundedId(raw.requestId)) return { reason: "snapshot session/request identity is empty or oversized" };
	if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 0) return { reason: "snapshot revision is not a non-negative integer" };
	const reconciliation = parseReconciliation(raw.reconciliation);
	if (!reconciliation) return { reason: "snapshot reconciliation state is malformed" };
	if (!Array.isArray(raw.outstanding)) return { reason: "snapshot outstanding is not an array" };
	if (raw.outstanding.length > BACKGROUND_WORK_MAX_OUTSTANDING) {
		return { reason: `snapshot outstanding exceeds the ${BACKGROUND_WORK_MAX_OUTSTANDING}-task bound` };
	}
	const outstanding: BackgroundWorkOutstandingTask[] = [];
	for (const entry of raw.outstanding) {
		if (!isRecord(entry)) return { reason: "snapshot outstanding entry is not an object" };
		if (!isBoundedId(entry.taskId) || entry.taskId.trim().length === 0) return { reason: "snapshot task id is empty or oversized" };
		if (entry.state !== "running" && entry.state !== "flushing" && entry.state !== "awaiting-result-review") return { reason: "snapshot task state is unknown" };
		if (!isNonEmptyString(entry.reason) || entry.reason.trim().length === 0) return { reason: "snapshot task reason is empty" };
		outstanding.push({ taskId: entry.taskId, state: entry.state, reason: boundedText(entry.reason) });
	}
	return {
		snapshot: {
			provider: { id: provider.id, version: provider.version },
			sessionId: raw.sessionId,
			requestId: raw.requestId,
			revision: raw.revision,
			reconciliation,
			outstanding,
		},
	};
}

function parseBindReply(raw: unknown): BackgroundWorkBindReply | null {
	if (!isRecord(raw)) return null;
	if (raw.ok === true) return { ok: true };
	if (raw.ok === false && isNonEmptyString(raw.reason) && raw.reason.trim().length > 0) return { ok: false, reason: raw.reason };
	return null;
}

function parseChange(raw: unknown): BackgroundWorkChange | null {
	if (!isRecord(raw)) return null;
	if (raw.protocol !== BACKGROUND_WORK_PROTOCOL || raw.kind !== "changed") return null;
	if (!isBoundedId(raw.registrationId)) return null;
	if (!isRecord(raw.provider)) return null;
	if (!isBoundedId(raw.provider.id) || !isProviderVersion(raw.provider.version)) return null;
	if (!isBoundedId(raw.sessionId) || !isBoundedId(raw.requestId)) return null;
	if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 0) return null;
	return {
		provider: { id: raw.provider.id, version: raw.provider.version },
		registrationId: raw.registrationId,
		sessionId: raw.sessionId,
		requestId: raw.requestId,
		revision: raw.revision,
	};
}

/**
 * Emits one query and collects replies inside that single synchronous emit
 * window. Replies correlating to other query ids (a nested query, for
 * example) are ignored; anything unparseable on the reply channel during the
 * window fails the query closed, as does reply traffic beyond
 * BACKGROUND_WORK_MAX_REPLIES: collection is bounded, and overflow fails
 * closed as ambiguity rather than growing unbounded.
 */
function collectReplies(
	bus: BackgroundWorkEventBus,
	queryChannel: string,
	envelope: Record<string, unknown>,
	queryId: string,
): { malformed: boolean; overflow: boolean; replies: ParsedReply[] } {
	const raws: unknown[] = [];
	let overflow = false;
	const unsubscribe = bus.on(BACKGROUND_WORK_REPLY_CHANNEL, (data) => {
		if (raws.length >= BACKGROUND_WORK_MAX_REPLIES) overflow = true;
		else raws.push(data);
	});
	try {
		bus.emit(queryChannel, envelope);
	} finally {
		unsubscribe();
	}
	let malformed = false;
	const replies: ParsedReply[] = [];
	for (const raw of raws) {
		const parsed = parseReplyEnvelope(raw);
		if (!parsed) {
			malformed = true;
			continue;
		}
		if (parsed.queryId === queryId) replies.push(parsed);
	}
	return { malformed, overflow, replies };
}

/** No correlated reply: absence only when nothing is known to be registered. */
function absenceOrMissing(
	bus: BackgroundWorkEventBus,
	scope: BackgroundWorkScope,
): { state: "absent" } | { state: "missing"; expectedProviderId?: string } {
	if (scope.expectedProviderId !== undefined) return { state: "missing", expectedProviderId: scope.expectedProviderId };
	// Anything attached at the slot address — live, disposed-but-undeletable or
	// foreign — blocks an `absent` answer: absence means nothing is known.
	if (slotCarrier(bus)[REGISTRATION_SLOT] !== undefined) return { state: "missing" };
	return { state: "absent" };
}

function currentRegistration(bus: BackgroundWorkEventBus, reply: ParsedReply): RegistrationSlot | null {
	const slot = readSlot(bus);
	if (!slot || slot.registrationId !== reply.registrationId) return null;
	return slot;
}

/**
 * Registers the provider's responders on a supplied session-local bus.
 *
 * Fails closed: at most one live registration per bus (a duplicate throws),
 * and every reply carries the registration's id so stale or foreign replies
 * can be rejected. Disposal unsubscribes the responders and clears the slot;
 * it never disturbs a later registration.
 */
export function registerBackgroundWorkProvider(bus: BackgroundWorkEventBus, provider: BackgroundWorkProvider): BackgroundWorkRegistration {
	requireBus(bus);
	requireProvider(provider);
	const carrier = slotCarrier(bus);
	const existingRaw = carrier[REGISTRATION_SLOT];
	if (existingRaw !== undefined) {
		if (!isRegistrationSlot(existingRaw)) throw new TypeError("background-work: event bus carries invalid registration metadata");
		if (!existingRaw.disposed) throw new Error(`background-work: a provider is already registered on this event bus (provider "${existingRaw.providerId}")`);
	}

	const registrationId = randomUUID();
	const providerId = provider.id;
	const providerVersion = provider.version;
	const reply = (queryId: string, payload: Record<string, unknown>): void => {
		bus.emit(BACKGROUND_WORK_REPLY_CHANNEL, {
			protocol: BACKGROUND_WORK_PROTOCOL,
			kind: "reply",
			queryId,
			registrationId,
			...payload,
		});
	};
	const scopeFrom = (query: ParsedQuery): BackgroundWorkScope => ({ sessionId: query.sessionId, requestId: query.requestId });
	const exceptionReply = (queryId: string, error: unknown): void => {
		reply(queryId, { outcome: "error", error: { code: "provider-exception", message: boundedText(errorMessage(error)) } });
	};

	// First subscription outside the try: if it throws, nothing to unwind.
	const offQuery = bus.on(BACKGROUND_WORK_SNAPSHOT_QUERY_CHANNEL, (raw) => {
		const query = parseQueryEnvelope(raw, "snapshot-query");
		if (!query) return; // junk has no trustworthy correlation id to answer
		try {
			const value: unknown = provider.snapshot(scopeFrom(query));
			if (isThenable(value)) {
				consumeRejection(value); // async answers are violations: never awaited, never unhandled
				reply(query.queryId, { outcome: "error", error: { code: "provider-malformed", message: "provider snapshot must answer synchronously" } });
				return;
			}
			reply(query.queryId, { outcome: "ok", snapshot: value });
		} catch (error) {
			exceptionReply(query.queryId, error);
		}
	});
	let offBind: () => void;
	try {
		offBind = bus.on(BACKGROUND_WORK_BIND_CHANNEL, (raw) => {
			const query = parseQueryEnvelope(raw, "bind");
			if (!query) return;
			let bindReply: unknown;
			try {
				bindReply = provider.bind(scopeFrom(query));
			} catch (error) {
				exceptionReply(query.queryId, error);
				return;
			}
			if (isThenable(bindReply)) {
				consumeRejection(bindReply); // async answers are violations: never awaited, never unhandled
				reply(query.queryId, { outcome: "error", error: { code: "provider-malformed", message: "provider bind must answer synchronously" } });
				return;
			}
			const parsed = parseBindReply(bindReply);
			if (!parsed) {
				reply(query.queryId, { outcome: "error", error: { code: "provider-malformed", message: "provider returned a malformed bind reply" } });
				return;
			}
			if (parsed.ok) reply(query.queryId, { outcome: "ok" });
			else reply(query.queryId, { outcome: "refused", reason: boundedText(parsed.reason) });
		});
	} catch (error) {
		offQuery();
		throw error;
	}
	let offProtect: () => void;
	try {
		offProtect = bus.on(BACKGROUND_WORK_PROTECT_CHANNEL, (raw) => {
			const query = parseQueryEnvelope(raw, "protect");
			if (!query) return;
			if (typeof provider.protect !== "function") {
				reply(query.queryId, { outcome: "error", error: { code: "provider-malformed", message: "provider does not implement protect" } });
				return;
			}
			let protectReply: unknown;
			try {
				protectReply = provider.protect(scopeFrom(query), query.protect ?? false);
			} catch (error) {
				exceptionReply(query.queryId, error);
				return;
			}
			if (isThenable(protectReply)) {
				consumeRejection(protectReply); // async answers are violations: never awaited, never unhandled
				reply(query.queryId, { outcome: "error", error: { code: "provider-malformed", message: "provider protect must answer synchronously" } });
				return;
			}
			const parsed = parseBindReply(protectReply);
			if (!parsed) {
				reply(query.queryId, { outcome: "error", error: { code: "provider-malformed", message: "provider returned a malformed protect reply" } });
				return;
			}
			if (parsed.ok) reply(query.queryId, { outcome: "ok" });
			else reply(query.queryId, { outcome: "refused", reason: boundedText(parsed.reason) });
		});
	} catch (error) {
		offQuery();
		offBind();
		throw error;
	}
	const slot: RegistrationSlot = { registrationId, providerId, providerVersion };
	try {
		carrier[REGISTRATION_SLOT] = slot;
	} catch (error) {
		offQuery();
		offBind();
		offProtect();
		throw new TypeError(`background-work: event bus does not accept registration metadata (${errorMessage(error)})`);
	}

	let disposed = false;
	return {
		providerId,
		providerVersion,
		notifyChange(scope: BackgroundWorkScope): boolean {
			requireScope(scope);
			if (disposed) return false;
			const slot = readSlot(bus);
			if (!slot || slot.registrationId !== registrationId) return false;
			let rawSnapshot: unknown;
			try {
				rawSnapshot = provider.snapshot({ sessionId: scope.sessionId, requestId: scope.requestId });
			} catch {
				return false;
			}
			if (isThenable(rawSnapshot)) {
				consumeRejection(rawSnapshot);
				return false;
			}
			const parsed = parseSnapshot(rawSnapshot);
			if ("reason" in parsed) return false;
			const snapshot = parsed.snapshot;
			if (snapshot.sessionId !== scope.sessionId || snapshot.requestId !== scope.requestId) return false;
			if (snapshot.provider.id !== providerId || snapshot.provider.version !== providerVersion) return false;
			bus.emit(BACKGROUND_WORK_CHANGED_CHANNEL, {
				protocol: BACKGROUND_WORK_PROTOCOL,
				kind: "changed",
				registrationId,
				provider: { id: providerId, version: providerVersion },
				sessionId: snapshot.sessionId,
				requestId: snapshot.requestId,
				revision: snapshot.revision,
			});
			return true;
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			offQuery();
			offBind();
			offProtect();
			slot.disposed = true;
			try {
				if (carrier[REGISTRATION_SLOT] === slot) delete carrier[REGISTRATION_SLOT];
			} catch {
				// Frozen bus keeps the property, but `disposed` hides the slot from every reader.
			}
		},
	};
}

/**
 * Queries the registered provider's current settlement snapshot for `scope`.
 * Synchronous: the result reflects exactly what answered inside the emit
 * window, and every non-answer is an explicit fail-closed state.
 */
export function queryBackgroundWorkSnapshot(bus: BackgroundWorkEventBus, scope: BackgroundWorkScope): BackgroundWorkQueryResult {
	requireScope(scope);
	const queryId = randomUUID();
	const envelope = {
		protocol: BACKGROUND_WORK_PROTOCOL,
		kind: "snapshot-query",
		queryId,
		scope: { sessionId: scope.sessionId, requestId: scope.requestId },
	};
	const collected = collectReplies(bus, BACKGROUND_WORK_SNAPSHOT_QUERY_CHANNEL, envelope, queryId);
	if (collected.malformed) return errorResult("malformed-reply", "a reply on the bus was not a well-formed background-work reply");
	if (collected.overflow) return errorResult("ambiguous-reply", `more than ${BACKGROUND_WORK_MAX_REPLIES} replies on the bus during query ${queryId}`);
	const { replies } = collected;
	const reply = replies.length === 1 ? replies[0] : undefined;
	if (!reply) {
		if (replies.length > 1) return errorResult("ambiguous-reply", `expected one reply for query ${queryId}, received ${replies.length}`);
		return absenceOrMissing(bus, scope);
	}
	const slot = currentRegistration(bus, reply);
	if (!slot) return errorResult("stale-reply", "reply does not match a current registration");
	if (reply.outcome === "refused") return errorResult("malformed-reply", "a snapshot query cannot be refused");
	if (reply.outcome === "error" && reply.error) return errorResult(reply.error.code, reply.error.message);
	if (reply.outcome !== "ok" || !reply.hasSnapshot) return errorResult("provider-malformed", "provider did not return a snapshot");
	const parsedSnapshot = parseSnapshot(reply.snapshot);
	if ("reason" in parsedSnapshot) return errorResult("provider-malformed", parsedSnapshot.reason);
	const snapshot = parsedSnapshot.snapshot;
	if (snapshot.sessionId !== scope.sessionId || snapshot.requestId !== scope.requestId) {
		return errorResult("identity-mismatch", "snapshot session/request does not match the query");
	}
	if (snapshot.provider.id !== slot.providerId || snapshot.provider.version !== slot.providerVersion) {
		return errorResult("identity-mismatch", "snapshot provider identity does not match its registration");
	}
	if (scope.expectedProviderId !== undefined && snapshot.provider.id !== scope.expectedProviderId) {
		return errorResult("identity-mismatch", `expected provider "${scope.expectedProviderId}" but "${snapshot.provider.id}" answered`);
	}
	switch (snapshot.reconciliation.state) {
		case "ready":
			return { state: "ready", snapshot };
		case "reconciling":
			return { state: "reconciling", snapshot };
		default:
			return { state: "error", error: { code: "provider-error", message: snapshot.reconciliation.reason }, snapshot };
	}
}

/**
 * Delegates an assignment bind to the registered provider. The provider
 * decides ownership: `refused` carries its reason, and helpers never inspect
 * task state themselves.
 */
export function bindBackgroundWorkAssignment(bus: BackgroundWorkEventBus, scope: BackgroundWorkScope): BackgroundWorkBindResult {
	requireScope(scope);
	// Expected identity is checked against the registered slot BEFORE the bind
	// reaches the provider: a mismatched bind must never invoke provider.bind.
	if (scope.expectedProviderId !== undefined) {
		const registered = readSlot(bus);
		if (registered && registered.providerId !== scope.expectedProviderId) {
			return errorResult("identity-mismatch", `expected provider "${scope.expectedProviderId}" but "${registered.providerId}" is registered`);
		}
	}
	const queryId = randomUUID();
	const envelope = {
		protocol: BACKGROUND_WORK_PROTOCOL,
		kind: "bind",
		queryId,
		scope: { sessionId: scope.sessionId, requestId: scope.requestId },
	};
	const collected = collectReplies(bus, BACKGROUND_WORK_BIND_CHANNEL, envelope, queryId);
	if (collected.malformed) return errorResult("malformed-reply", "a reply on the bus was not a well-formed background-work reply");
	if (collected.overflow) return errorResult("ambiguous-reply", `more than ${BACKGROUND_WORK_MAX_REPLIES} replies on the bus during query ${queryId}`);
	const { replies } = collected;
	const reply = replies.length === 1 ? replies[0] : undefined;
	if (!reply) {
		if (replies.length > 1) return errorResult("ambiguous-reply", `expected one reply for query ${queryId}, received ${replies.length}`);
		return absenceOrMissing(bus, scope);
	}
	const slot = currentRegistration(bus, reply);
	if (!slot) return errorResult("stale-reply", "reply does not match a current registration");
	if (reply.outcome === "error" && reply.error) return errorResult(reply.error.code, reply.error.message);
	if (reply.outcome === "refused") return { state: "refused", reason: boundedText(reply.reason) };
	if (reply.outcome !== "ok") return errorResult("provider-malformed", "provider returned a malformed bind reply");
	return { state: "bound" };
}

/**
 * Marks (or unmarks) the bound assignment as settlement-waiting, so its
 * tasks' exit wakes are mandatory even under `notifyOnExit: false`
 * (openspec `herdsman-background-handoffs` tasks 2.4). Same fail-closed
 * discipline as `bindBackgroundWorkAssignment`: the expected provider is
 * checked against the registered slot before the query reaches the provider,
 * and `bound` here means the protection was applied.
 */
export function protectBackgroundWorkAssignment(bus: BackgroundWorkEventBus, scope: BackgroundWorkScope, protect: boolean): BackgroundWorkBindResult {
	requireScope(scope);
	if (scope.expectedProviderId !== undefined) {
		const registered = readSlot(bus);
		if (registered && registered.providerId !== scope.expectedProviderId) {
			return errorResult("identity-mismatch", `expected provider "${scope.expectedProviderId}" but "${registered.providerId}" is registered`);
		}
	}
	const queryId = randomUUID();
	const envelope = {
		protocol: BACKGROUND_WORK_PROTOCOL,
		kind: "protect",
		queryId,
		scope: { sessionId: scope.sessionId, requestId: scope.requestId },
		protect,
	};
	const collected = collectReplies(bus, BACKGROUND_WORK_PROTECT_CHANNEL, envelope, queryId);
	if (collected.malformed) return errorResult("malformed-reply", "a reply on the bus was not a well-formed background-work reply");
	if (collected.overflow) return errorResult("ambiguous-reply", `more than ${BACKGROUND_WORK_MAX_REPLIES} replies on the bus during query ${queryId}`);
	const { replies } = collected;
	const reply = replies.length === 1 ? replies[0] : undefined;
	if (!reply) {
		if (replies.length > 1) return errorResult("ambiguous-reply", `expected one reply for query ${queryId}, received ${replies.length}`);
		return absenceOrMissing(bus, scope);
	}
	const slot = currentRegistration(bus, reply);
	if (!slot) return errorResult("stale-reply", "reply does not match a current registration");
	if (reply.outcome === "error" && reply.error) return errorResult(reply.error.code, reply.error.message);
	if (reply.outcome === "refused") return { state: "refused", reason: boundedText(reply.reason) };
	if (reply.outcome !== "ok") return errorResult("provider-malformed", "provider returned a malformed protect reply");
	return { state: "bound" };
}

/**
 * Subscribes to change metadata scoped to one assignment. Only well-formed
 * changes from the current registration for exactly `scope` reach `listener`:
 * malformed, stale/disposed, unexpected-provider and other-assignment metadata is dropped without
 * delivery. A change is a hint to re-query, never an authoritative snapshot
 * or a model-wake delivery path. Returns the unsubscribe closure.
 */
export function subscribeBackgroundWorkChanges(
	bus: BackgroundWorkEventBus,
	scope: BackgroundWorkScope,
	listener: (change: BackgroundWorkChange) => void,
): () => void {
	requireScope(scope);
	return bus.on(BACKGROUND_WORK_CHANGED_CHANNEL, (raw) => {
		const change = parseChange(raw);
		if (!change) return;
		const slot = readSlot(bus);
		if (!slot || slot.registrationId !== change.registrationId) return;
		if (change.provider.id !== slot.providerId || change.provider.version !== slot.providerVersion) return;
		if (scope.expectedProviderId !== undefined && change.provider.id !== scope.expectedProviderId) return;
		if (change.sessionId !== scope.sessionId || change.requestId !== scope.requestId) return;
		listener(change);
	});
}
