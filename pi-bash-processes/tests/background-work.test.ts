// Interface-only tests for extensions/background-work.ts: registration,
// binding, snapshot queries, fail-closed reply handling and scoped change
// metadata over a fake bus that mirrors Pi's public EventBus semantics
// (listeners run through the same rejecting-safe async trampoline as
// pi-coding-agent dist/core/event-bus.js). These tests pin the helper
// contract only — registration, snapshot queries, bind and protect
// delegation, fail-closed reply handling and scoped change metadata — never
// that the background-tasks provider's answers are correct; that lives in
// background-work-provider.test.ts.

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import {
	BACKGROUND_WORK_CHANGED_CHANNEL,
	BACKGROUND_WORK_MAX_ID_CHARS,
	BACKGROUND_WORK_MAX_OUTSTANDING,
	BACKGROUND_WORK_MAX_REASON_CHARS,
	BACKGROUND_WORK_MAX_REPLIES,
	BACKGROUND_WORK_PROTOCOL,
	BACKGROUND_WORK_REPLY_CHANNEL,
	BACKGROUND_WORK_SNAPSHOT_QUERY_CHANNEL,
	bindBackgroundWorkAssignment,
	protectBackgroundWorkAssignment,
	queryBackgroundWorkSnapshot,
	registerBackgroundWorkProvider,
	subscribeBackgroundWorkChanges,
	type BackgroundWorkChange,
	type BackgroundWorkEventBus,
	type BackgroundWorkProvider,
	type BackgroundWorkScope,
	type BackgroundWorkSnapshot,
} from "../extensions/background-work.js";

const SCOPE: BackgroundWorkScope = { sessionId: "session-1", requestId: "request-1" };

/** Mirrors Pi's EventBus: same `emit`/`on` contract and safe async trampoline. */
function fakeEventBus(): BackgroundWorkEventBus & { clear(): void } {
	const emitter = new EventEmitter();
	return {
		emit: (channel: string, data: unknown) => {
			emitter.emit(channel, data);
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch {
					// Pi logs and swallows listener failures; the fake mirrors that.
				}
			};
			emitter.on(channel, safeHandler);
			return () => {
				emitter.off(channel, safeHandler);
			};
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}

function readySnapshot(overrides: Partial<BackgroundWorkSnapshot> = {}): BackgroundWorkSnapshot {
	return {
		provider: { id: "fake-provider", version: 1 },
		sessionId: "session-1",
		requestId: "request-1",
		revision: 7,
		reconciliation: { state: "ready" },
		outstanding: [
			{ taskId: "bg-1", state: "running", reason: "process still running" },
			{ taskId: "bg-2", state: "flushing", reason: "output capture flushing" },
			{ taskId: "bg-3", state: "awaiting-result-review", reason: "terminal result not handed over" },
		],
		...overrides,
	};
}

/** Default provider echoes the queried scope, as a real provider binding that assignment would. */
function fakeProvider(overrides: Partial<BackgroundWorkProvider> = {}): BackgroundWorkProvider {
	return {
		id: "fake-provider",
		version: 1,
		snapshot: (scope) => readySnapshot({ sessionId: scope.sessionId, requestId: scope.requestId }),
		bind: () => ({ ok: true }),
		...overrides,
	};
}

function rogueEchoOn(queryChannel: string): (bus: BackgroundWorkEventBus) => () => void {
	return (bus) =>
		bus.on(queryChannel, (raw) => {
			const queryId = (raw as { queryId?: unknown }).queryId;
			if (typeof queryId !== "string") return;
			bus.emit(BACKGROUND_WORK_REPLY_CHANNEL, {
				protocol: BACKGROUND_WORK_PROTOCOL,
				kind: "reply",
				queryId,
				registrationId: "rogue-registration",
				outcome: "ok",
				snapshot: readySnapshot(),
			});
		});
}

test("no registration: snapshot and bind report absent, not an empty snapshot", () => {
	const bus = fakeEventBus();
	expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toEqual({ state: "absent" });
	expect(bindBackgroundWorkAssignment(bus, SCOPE)).toEqual({ state: "absent" });
});

test("an expected provider that cannot answer reports missing, never absent or ready", () => {
	const bus = fakeEventBus();
	expect(queryBackgroundWorkSnapshot(bus, { ...SCOPE, expectedProviderId: "fake-provider" })).toEqual({
		state: "missing",
		expectedProviderId: "fake-provider",
	});
	const registration = registerBackgroundWorkProvider(bus, fakeProvider());
	expect(queryBackgroundWorkSnapshot(bus, SCOPE).state).toBe("ready");
	// A slot whose listeners are gone (bus cleared) is a known provider that
	// stopped answering: missing, not absence and not a zero-task snapshot.
	bus.clear();
	expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toEqual({ state: "missing" });
	registration.dispose();
	expect(queryBackgroundWorkSnapshot(bus, { ...SCOPE, expectedProviderId: "fake-provider" })).toEqual({
		state: "missing",
		expectedProviderId: "fake-provider",
	});
	expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toEqual({ state: "absent" });
});

test("ready snapshot passes provider/version, identity, revision, reconciliation and all task states through", () => {
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(bus, fakeProvider());
	expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toEqual({ state: "ready", snapshot: readySnapshot() });
});

test("reconciling snapshot reports reconciling state with its reason", () => {
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(
		bus,
		fakeProvider({
			snapshot: (scope) => readySnapshot({ sessionId: scope.sessionId, requestId: scope.requestId, reconciliation: { state: "reconciling", reason: "restoring task snapshots" } }),
		}),
	);
	expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toEqual({
		state: "reconciling",
		snapshot: readySnapshot({ reconciliation: { state: "reconciling", reason: "restoring task snapshots" } }),
	});
});

test("provider-reported reconciliation error is an actionable error carrying its snapshot", () => {
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(
		bus,
		fakeProvider({
			snapshot: (scope) => readySnapshot({ sessionId: scope.sessionId, requestId: scope.requestId, reconciliation: { state: "error", reason: "task store unreadable" } }),
		}),
	);
	const result = queryBackgroundWorkSnapshot(bus, SCOPE);
	expect(result).toMatchObject({
		state: "error",
		error: { code: "provider-error", message: "task store unreadable" },
	});
	if (result.state !== "error" || !result.snapshot) throw new Error("expected an error result carrying the provider snapshot");
	// Bun's toMatchObject compares arrays element-by-element including length,
	// so a one-task partial would demand a one-task received list. Assert the
	// full three-task list instead of weakening the snapshot behavior.
	expect(result.snapshot.outstanding.map((task) => task.taskId)).toEqual(["bg-1", "bg-2", "bg-3"]);
});

test("provider reason strings stay bounded in results", () => {
	const bus = fakeEventBus();
	const hugeReason = "x".repeat(10_000);
	registerBackgroundWorkProvider(
		bus,
		fakeProvider({
			snapshot: (scope) => readySnapshot({ sessionId: scope.sessionId, requestId: scope.requestId, reconciliation: { state: "error", reason: hugeReason } }),
		}),
	);
	const result = queryBackgroundWorkSnapshot(bus, SCOPE);
	expect(result.state).toBe("error");
	expect(result).toMatchObject({ error: { code: "provider-error" } });
	const message = result.state === "error" ? result.error.message : "";
	expect(message.length).toBeLessThanOrEqual(BACKGROUND_WORK_MAX_REASON_CHARS);
	expect(message.length).toBeLessThan(hugeReason.length);
});

test("wrong session or request in a snapshot is rejected as identity mismatch", () => {
	for (const wrong of ["session", "request"] as const) {
		const bus = fakeEventBus();
		registerBackgroundWorkProvider(
			bus,
			fakeProvider({
				snapshot: (scope) => readySnapshot(wrong === "session" ? { sessionId: "session-other" } : { requestId: "request-other", sessionId: scope.sessionId }),
			}),
		);
		expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toMatchObject({ state: "error", error: { code: "identity-mismatch" } });
	}
});

test("an answered query from an unexpected provider is a mismatch, not a snapshot", () => {
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(bus, fakeProvider());
	expect(queryBackgroundWorkSnapshot(bus, { ...SCOPE, expectedProviderId: "expected-provider" })).toMatchObject({
		state: "error",
		error: { code: "identity-mismatch" },
	});
});

test("duplicate replies fail closed as ambiguous instead of choosing the first", () => {
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(bus, fakeProvider());
	const stopRogue = rogueEchoOn(BACKGROUND_WORK_SNAPSHOT_QUERY_CHANNEL)(bus);
	const result = queryBackgroundWorkSnapshot(bus, SCOPE);
	stopRogue();
	expect(result).toMatchObject({ state: "error", error: { code: "ambiguous-reply" } });
	if (result.state !== "error") throw new Error("expected an error result");
	expect(result.error.message).toContain("received 2");
});

test("malformed reply envelopes are rejected, not treated as absence", () => {
	const bus = fakeEventBus();
	const stopRogue = bus.on(BACKGROUND_WORK_SNAPSHOT_QUERY_CHANNEL, (raw) => {
		const queryId = (raw as { queryId?: unknown }).queryId;
		if (typeof queryId !== "string") return;
		// Well-formed correlation id, missing registrationId and outcome.
		bus.emit(BACKGROUND_WORK_REPLY_CHANNEL, { protocol: BACKGROUND_WORK_PROTOCOL, kind: "reply", queryId });
	});
	const result = queryBackgroundWorkSnapshot(bus, SCOPE);
	stopRogue();
	expect(result).toMatchObject({ state: "error", error: { code: "malformed-reply" } });
});

test("provider exceptions surface as errors, never as absence", () => {
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(
		bus,
		fakeProvider({
			snapshot: () => {
				throw new Error("task store offline");
			},
			bind: () => {
				throw new Error("bind exploded");
			},
		}),
	);
	expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toEqual({
		state: "error",
		error: { code: "provider-exception", message: "task store offline" },
	});
	expect(bindBackgroundWorkAssignment(bus, SCOPE)).toEqual({
		state: "error",
		error: { code: "provider-exception", message: "bind exploded" },
	});
});

test("asynchronous provider replies are rejected, never awaited", () => {
	const bus = fakeEventBus();
	const asyncSnapshot = (() => Promise.resolve(readySnapshot())) as unknown as BackgroundWorkProvider["snapshot"];
	const asyncBind = (() => Promise.resolve({ ok: true })) as unknown as BackgroundWorkProvider["bind"];
	registerBackgroundWorkProvider(bus, fakeProvider({ snapshot: asyncSnapshot, bind: asyncBind }));
	expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toMatchObject({ state: "error", error: { code: "provider-malformed" } });
	expect(bindBackgroundWorkAssignment(bus, SCOPE)).toMatchObject({ state: "error", error: { code: "provider-malformed" } });
});

test("duplicate registration on the same bus is rejected", () => {
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(bus, fakeProvider());
	expect(() => registerBackgroundWorkProvider(bus, fakeProvider())).toThrow("already registered");
});

test("dispose unregisters; a stale handle cannot disturb a later registration", () => {
	const bus = fakeEventBus();
	const first = registerBackgroundWorkProvider(bus, fakeProvider());
	expect(queryBackgroundWorkSnapshot(bus, SCOPE).state).toBe("ready");
	first.dispose();
	first.dispose(); // idempotent
	expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toEqual({ state: "absent" });
	expect(first.notifyChange(SCOPE)).toBe(false);

	const second = registerBackgroundWorkProvider(
		bus,
		fakeProvider({
			id: "second-provider",
			version: 2,
			snapshot: (scope) => readySnapshot({ provider: { id: "second-provider", version: 2 }, sessionId: scope.sessionId, requestId: scope.requestId }),
		}),
	);
	first.dispose(); // stale handle: must not clear the current registration
	expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toEqual({
		state: "ready",
		snapshot: readySnapshot({ provider: { id: "second-provider", version: 2 } }),
	});
	expect(first.notifyChange(SCOPE)).toBe(false);
	expect(second.notifyChange(SCOPE)).toBe(true);
	second.dispose();
});

test("replies from a disposed registration's id are stale, not a snapshot", () => {
	const bus = fakeEventBus();
	let stolenRegistrationId = "";
	bus.on(BACKGROUND_WORK_REPLY_CHANNEL, (raw) => {
		const registrationId = (raw as { registrationId?: unknown }).registrationId;
		if (typeof registrationId === "string") stolenRegistrationId = registrationId;
	});
	const registration = registerBackgroundWorkProvider(bus, fakeProvider());
	expect(queryBackgroundWorkSnapshot(bus, SCOPE).state).toBe("ready");
	expect(stolenRegistrationId.length).toBeGreaterThan(0);
	registration.dispose();
	// Replay the stolen id after disposal: it must not answer for anyone.
	const stopRogue = bus.on(BACKGROUND_WORK_SNAPSHOT_QUERY_CHANNEL, (raw) => {
		const queryId = (raw as { queryId?: unknown }).queryId;
		if (typeof queryId !== "string") return;
		bus.emit(BACKGROUND_WORK_REPLY_CHANNEL, {
			protocol: BACKGROUND_WORK_PROTOCOL,
			kind: "reply",
			queryId,
			registrationId: stolenRegistrationId,
			outcome: "ok",
			snapshot: readySnapshot(),
		});
	});
	const result = queryBackgroundWorkSnapshot(bus, SCOPE);
	stopRogue();
	expect(result).toMatchObject({ state: "error", error: { code: "stale-reply" } });
});

test("bind delegates to the provider: bound, refused with reason, and absent", () => {
	const boundBus = fakeEventBus();
	registerBackgroundWorkProvider(boundBus, fakeProvider());
	expect(bindBackgroundWorkAssignment(boundBus, SCOPE)).toEqual({ state: "bound" });

	const refuseBus = fakeEventBus();
	registerBackgroundWorkProvider(refuseBus, fakeProvider({ bind: () => ({ ok: false, reason: "unresolved background work remains" }) }));
	expect(bindBackgroundWorkAssignment(refuseBus, SCOPE)).toEqual({ state: "refused", reason: "unresolved background work remains" });

	const absentBus = fakeEventBus();
	expect(bindBackgroundWorkAssignment(absentBus, SCOPE)).toEqual({ state: "absent" });
});

test("change notifications carry identity/revision scope and drop untrusted metadata", () => {
	const bus = fakeEventBus();
	const registration = registerBackgroundWorkProvider(bus, fakeProvider());
	const scoped: BackgroundWorkChange[] = [];
	const otherScope: BackgroundWorkChange[] = [];
	subscribeBackgroundWorkChanges(bus, SCOPE, (change) => scoped.push(change));
	subscribeBackgroundWorkChanges(bus, { sessionId: "session-1", requestId: "request-2" }, (change) => otherScope.push(change));

	expect(registration.notifyChange(SCOPE)).toBe(true);
	expect(scoped).toHaveLength(1);
	expect(scoped[0]).toMatchObject({ provider: { id: "fake-provider", version: 1 }, sessionId: "session-1", requestId: "request-1", revision: 7 });
	expect(typeof scoped[0]?.registrationId).toBe("string");
	expect(otherScope).toHaveLength(0);

	// Malformed and stale registrations metadata is dropped, never delivered.
	bus.emit(BACKGROUND_WORK_CHANGED_CHANNEL, { junk: true });
	bus.emit(BACKGROUND_WORK_CHANGED_CHANNEL, {
		protocol: BACKGROUND_WORK_PROTOCOL,
		kind: "changed",
		registrationId: "disposed-registration",
		provider: { id: "fake-provider", version: 1 },
		sessionId: "session-1",
		requestId: "request-1",
		revision: 8,
	});
	expect(scoped).toHaveLength(1);

	// A change for another assignment reaches only that assignment's subscriber.
	expect(registration.notifyChange({ sessionId: "session-1", requestId: "request-2" })).toBe(true);
	expect(scoped).toHaveLength(1);
	expect(otherScope).toHaveLength(1);

	registration.dispose();
	expect(registration.notifyChange(SCOPE)).toBe(false);
	expect(scoped).toHaveLength(1);
});

test("notifyChange refuses scopes the provider snapshot no longer matches", () => {
	const fixedBus = fakeEventBus();
	// Provider pinned to request-1: it cannot confirm a change about request-9.
	const fixed = registerBackgroundWorkProvider(fixedBus, fakeProvider({ snapshot: () => readySnapshot() }));
	expect(fixed.notifyChange({ sessionId: "session-1", requestId: "request-9" })).toBe(false);
	expect(fixed.notifyChange(SCOPE)).toBe(true);
	fixed.dispose();

	const throwBus = fakeEventBus();
	const throwing = registerBackgroundWorkProvider(
		throwBus,
		fakeProvider({
			snapshot: () => {
				throw new Error("revision unreadable");
			},
		}),
	);
	expect(throwing.notifyChange(SCOPE)).toBe(false);
	throwing.dispose();
});

test("registration is shared across independently loaded helper module instances", async () => {
	// The registration slot must live on the bus, not in module-private state:
	// two copies of this file (provider side and consumer side loaded as
	// separate modules) share one bus and must see one registration.
	const dir = mkdtempSync(join(tmpdir(), "background-work-"));
	try {
		const source = readFileSync(new URL("../extensions/background-work.ts", import.meta.url), "utf8");
		writeFileSync(join(dir, "background-work.ts"), source);
		const other = (await import(pathToFileURL(join(dir, "background-work.ts")).href)) as typeof import("../extensions/background-work.js");

		const bus = fakeEventBus();
		const otherReg = other.registerBackgroundWorkProvider(bus, fakeProvider());

		// This module instance queries the other instance's registration.
		expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toEqual({ state: "ready", snapshot: readySnapshot() });
		// Duplicate registration is rejected from either instance.
		expect(() => other.registerBackgroundWorkProvider(bus, fakeProvider())).toThrow("already registered");
		expect(() => registerBackgroundWorkProvider(bus, fakeProvider())).toThrow("already registered");

		// Changes published through the other instance reach this instance's subscriber.
		const changes: BackgroundWorkChange[] = [];
		subscribeBackgroundWorkChanges(bus, SCOPE, (change) => changes.push(change));
		expect(otherReg.notifyChange(SCOPE)).toBe(true);
		expect(changes).toHaveLength(1);

		// Disposal through the other instance is visible here too.
		otherReg.dispose();
		expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toEqual({ state: "absent" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("expected provider mismatch rejects bind before the provider mutates", () => {
	const bus = fakeEventBus();
	let bindCalls = 0;
	registerBackgroundWorkProvider(
		bus,
		fakeProvider({
			bind: () => {
				bindCalls++;
				return { ok: true };
			},
		}),
	);
	const result = bindBackgroundWorkAssignment(bus, { ...SCOPE, expectedProviderId: "different-provider" });
	expect(result).toMatchObject({ state: "error", error: { code: "identity-mismatch" } });
	expect(bindCalls).toBe(0);
});

test("change subscriptions honor expected provider identity", () => {
	const bus = fakeEventBus();
	const registration = registerBackgroundWorkProvider(bus, fakeProvider());
	const matched: BackgroundWorkChange[] = [];
	const mismatched: BackgroundWorkChange[] = [];
	subscribeBackgroundWorkChanges(bus, { ...SCOPE, expectedProviderId: "fake-provider" }, (change) => matched.push(change));
	subscribeBackgroundWorkChanges(bus, { ...SCOPE, expectedProviderId: "other-provider" }, (change) => mismatched.push(change));
	expect(registration.notifyChange(SCOPE)).toBe(true);
	expect(matched).toHaveLength(1);
	expect(mismatched).toHaveLength(0);
	registration.dispose();
});

test("outstanding task count beyond the bound is rejected, never truncated", () => {
	const tooMany = Array.from({ length: BACKGROUND_WORK_MAX_OUTSTANDING + 1 }, (_, i) => ({ taskId: `t${i}`, state: "running" as const, reason: "pending" }));
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(
		bus,
		fakeProvider({
			snapshot: (scope) => readySnapshot({ sessionId: scope.sessionId, requestId: scope.requestId, outstanding: tooMany }),
		}),
	);
	expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toMatchObject({
		state: "error",
		error: { code: "provider-malformed", message: expect.stringContaining(`exceeds the ${BACKGROUND_WORK_MAX_OUTSTANDING}-task bound`) },
	});
});

test("outstanding task count at the bound passes through in full", () => {
	const atBound = Array.from({ length: BACKGROUND_WORK_MAX_OUTSTANDING }, (_, i) => ({ taskId: `t${i}`, state: "running" as const, reason: "pending" }));
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(
		bus,
		fakeProvider({
			snapshot: (scope) => readySnapshot({ sessionId: scope.sessionId, requestId: scope.requestId, outstanding: atBound }),
		}),
	);
	const result = queryBackgroundWorkSnapshot(bus, SCOPE);
	expect(result.state).toBe("ready");
	if (result.state !== "ready") throw new Error("expected ready");
	expect(result.snapshot.outstanding).toHaveLength(BACKGROUND_WORK_MAX_OUTSTANDING);
});

test("oversized identities are rejected or refused, never truncated", () => {
	// Provider-side payload: an oversized task id makes the snapshot malformed.
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(
		bus,
		fakeProvider({
			snapshot: (scope) =>
				readySnapshot({
					sessionId: scope.sessionId,
					requestId: scope.requestId,
					outstanding: [{ taskId: "x".repeat(BACKGROUND_WORK_MAX_ID_CHARS + 1), state: "running", reason: "pending" }],
				}),
		}),
	);
	expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toMatchObject({
		state: "error",
		error: { code: "provider-malformed", message: expect.stringContaining("id is empty or oversized") },
	});

	// Caller-side scope: refused up front with an actionable TypeError.
	const other = fakeEventBus();
	registerBackgroundWorkProvider(other, fakeProvider());
	expect(() => queryBackgroundWorkSnapshot(other, { ...SCOPE, sessionId: "s".repeat(BACKGROUND_WORK_MAX_ID_CHARS + 1) })).toThrow(
		`exceeds ${BACKGROUND_WORK_MAX_ID_CHARS} characters`,
	);
});

test("oversized reply registration ids are rejected as malformed", () => {
	const rogueBus = fakeEventBus();
	registerBackgroundWorkProvider(rogueBus, fakeProvider());
	const stopRogue = rogueBus.on(BACKGROUND_WORK_SNAPSHOT_QUERY_CHANNEL, (raw) => {
		const queryId = (raw as { queryId?: unknown }).queryId;
		if (typeof queryId !== "string") return;
		rogueBus.emit(BACKGROUND_WORK_REPLY_CHANNEL, {
			protocol: BACKGROUND_WORK_PROTOCOL,
			kind: "reply",
			queryId,
			registrationId: "r".repeat(BACKGROUND_WORK_MAX_ID_CHARS + 1),
			outcome: "ok",
			snapshot: readySnapshot(),
		});
	});
	const result = queryBackgroundWorkSnapshot(rogueBus, SCOPE);
	stopRogue();
	expect(result).toMatchObject({ state: "error", error: { code: "malformed-reply" } });
});

test("reply traffic beyond the bound fails closed as ambiguous", () => {
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(bus, fakeProvider());
	const stopRogue = bus.on(BACKGROUND_WORK_SNAPSHOT_QUERY_CHANNEL, (raw) => {
		const queryId = (raw as { queryId?: unknown }).queryId;
		if (typeof queryId !== "string") return;
		for (let i = 0; i < BACKGROUND_WORK_MAX_REPLIES; i++) {
			bus.emit(BACKGROUND_WORK_REPLY_CHANNEL, {
				protocol: BACKGROUND_WORK_PROTOCOL,
				kind: "reply",
				queryId,
				registrationId: "rogue-registration",
				outcome: "ok",
				snapshot: readySnapshot(),
			});
		}
	});
	const result = queryBackgroundWorkSnapshot(bus, SCOPE);
	stopRogue();
	expect(result).toMatchObject({
		state: "error",
		error: { code: "ambiguous-reply", message: expect.stringContaining(`more than ${BACKGROUND_WORK_MAX_REPLIES} replies`) },
	});
});

test("async provider reply rejections are consumed, never unhandled", async () => {
	const rejections: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		rejections.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		const failing = Promise.reject(new Error("async provider failure"));
		const bus = fakeEventBus();
		const asyncProvider = (() => failing) as unknown as BackgroundWorkProvider["snapshot"];
		registerBackgroundWorkProvider(
			bus,
			fakeProvider({
				snapshot: asyncProvider,
				bind: (() => failing) as unknown as BackgroundWorkProvider["bind"],
			}),
		);
		expect(queryBackgroundWorkSnapshot(bus, SCOPE)).toMatchObject({ state: "error", error: { code: "provider-malformed" } });
		expect(bindBackgroundWorkAssignment(bus, SCOPE)).toMatchObject({ state: "error", error: { code: "provider-malformed" } });
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(rejections).toHaveLength(0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("protect delegates to the provider: applied, refused with reason, and absent", () => {
	const appliedBus = fakeEventBus();
	registerBackgroundWorkProvider(appliedBus, fakeProvider({ protect: () => ({ ok: true }) }));
	expect(protectBackgroundWorkAssignment(appliedBus, SCOPE, true)).toEqual({ state: "bound" });
	expect(protectBackgroundWorkAssignment(appliedBus, SCOPE, false)).toEqual({ state: "bound" });

	const refuseBus = fakeEventBus();
	registerBackgroundWorkProvider(refuseBus, fakeProvider({ protect: () => ({ ok: false, reason: "request is not the bound assignment" }) }));
	expect(protectBackgroundWorkAssignment(refuseBus, SCOPE, true)).toEqual({ state: "refused", reason: "request is not the bound assignment" });

	const absentBus = fakeEventBus();
	expect(protectBackgroundWorkAssignment(absentBus, SCOPE, true)).toEqual({ state: "absent" });
});

test("protect reaches the provider with the requested boolean", () => {
	const bus = fakeEventBus();
	const seen: boolean[] = [];
	registerBackgroundWorkProvider(bus, fakeProvider({ protect: (_scope, on) => { seen.push(on); return { ok: true }; } }));
	expect(protectBackgroundWorkAssignment(bus, SCOPE, true)).toEqual({ state: "bound" });
	expect(protectBackgroundWorkAssignment(bus, SCOPE, false)).toEqual({ state: "bound" });
	expect(seen).toEqual([true, false]);
});

test("a provider without protect answers provider-malformed, never silence", () => {
	const bus = fakeEventBus();
	registerBackgroundWorkProvider(bus, fakeProvider());
	expect(protectBackgroundWorkAssignment(bus, SCOPE, true)).toMatchObject({
		state: "error",
		error: { code: "provider-malformed", message: expect.stringContaining("does not implement protect") },
	});
});

test("expected provider mismatch rejects protect before the provider is invoked", () => {
	const bus = fakeEventBus();
	let protectCalls = 0;
	registerBackgroundWorkProvider(bus, fakeProvider({ protect: () => { protectCalls++; return { ok: true }; } }));
	const result = protectBackgroundWorkAssignment(bus, { ...SCOPE, expectedProviderId: "different-provider" }, true);
	expect(result).toMatchObject({ state: "error", error: { code: "identity-mismatch" } });
	expect(protectCalls).toBe(0);
});

test("dispose unregisters protect alongside snapshot and bind", () => {
	const bus = fakeEventBus();
	const registration = registerBackgroundWorkProvider(bus, fakeProvider({ protect: () => ({ ok: true }) }));
	expect(protectBackgroundWorkAssignment(bus, SCOPE, true)).toEqual({ state: "bound" });
	registration.dispose();
	expect(protectBackgroundWorkAssignment(bus, SCOPE, true)).toEqual({ state: "absent" });
});

test("an asynchronous protect reply is rejected as provider-malformed and its rejection consumed", async () => {
	const rejections: unknown[] = [];
	const onUnhandled = (reason: unknown) => { rejections.push(reason); };
	process.on("unhandledRejection", onUnhandled);
	try {
		const bus = fakeEventBus();
		registerBackgroundWorkProvider(bus, fakeProvider({ protect: (() => Promise.reject(new Error("async protect"))) as unknown as BackgroundWorkProvider["protect"] }));
		expect(protectBackgroundWorkAssignment(bus, SCOPE, true)).toMatchObject({ state: "error", error: { code: "provider-malformed" } });
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(rejections).toHaveLength(0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
