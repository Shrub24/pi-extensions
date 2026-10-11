import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	WAKE_CONSUMER_CLAIM,
	WAKE_CONSUMER_OFFER,
	WAKE_CONSUMER_PROTOCOL,
	type WakeConsumerClaim,
	type WakeConsumerEventBus,
	type WakeConsumerOffer,
} from "../extensions/wake-protocol.js";
import {
	WAKE_CONSUMER_CLAIM as PRODUCER_CLAIM,
	WAKE_CONSUMER_OFFER as PRODUCER_OFFER,
	WAKE_CONSUMER_PROTOCOL as PRODUCER_PROTOCOL,
} from "../../pi-bash-processes/extensions/wake-consumer.ts";
import { ADVISORY_WAKE_DEFAULT_GUIDANCE, ADVISORY_WAKE_PROMPT_VERSION, ADVISORY_WAKE_QUESTION, wireAdvisoryWakes } from "../extensions/advisory-wakes.js";
import { fakeJevClient, fakeLog, noul, testConfig } from "./fixtures/fakes.js";
import { logSink } from "../extensions/registry.js";

class EventBus implements WakeConsumerEventBus {
	private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

	emit(channel: string, data: unknown): void {
		for (const listener of this.listeners.get(channel) ?? []) listener(data);
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const listeners = this.listeners.get(channel) ?? new Set();
		listeners.add(handler);
		this.listeners.set(channel, listeners);
		return () => listeners.delete(handler);
	}
}

function offer(overrides: Partial<WakeConsumerOffer> = {}): WakeConsumerOffer {
	return {
		protocol: WAKE_CONSUMER_PROTOCOL,
		source: "pi-background-tasks",
		kind: "soft-timeout",
		id: "task-1",
		sessionId: "session-1",
		token: "token-1",
		deadlineMs: 5_000,
		metadata: { sequence: 2 },
		...overrides,
	};
}

function host(bus: EventBus): ExtensionAPI {
	return { events: bus } as unknown as ExtensionAPI;
}

function waitFor<T>(read: () => T | undefined): Promise<T> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 1_000;
		const check = () => {
			const value = read();
			if (value !== undefined) return resolve(value);
			if (Date.now() >= deadline) return reject(new Error("timed out waiting for Jev decision"));
			setTimeout(check, 0);
		};
		check();
	});
}

test("keeps the local wire contract aligned with the background producer", () => {
	expect(WAKE_CONSUMER_PROTOCOL).toBe(PRODUCER_PROTOCOL);
	expect(WAKE_CONSUMER_OFFER).toBe(PRODUCER_OFFER);
	expect(WAKE_CONSUMER_CLAIM).toBe(PRODUCER_CLAIM);
});

test("claims soft reminders and sends the full command plus default and dispatch guidance to Jev", async () => {
	const bus = new EventBus();
	const command = "python worker.py --input 'a long unabridged command'";
	const client = fakeJevClient({ [ADVISORY_WAKE_QUESTION]: noul(0.1) });
	const claims: WakeConsumerClaim[] = [];
	const log = fakeLog();
	bus.on(WAKE_CONSUMER_CLAIM, (raw) => claims.push(raw as WakeConsumerClaim));
	const dispose = wireAdvisoryWakes(host(bus), {
		client,
		config: testConfig({ watcherMode: "advisory", advisoryThreshold: 0.75 }),
		sessionId: "session-1",
		record: logSink({ log, now: () => new Date("2026-10-10T00:00:00.000Z"), mode: "advisory", model: client.model }),
	});
	let decision: string | undefined;
	bus.emit(WAKE_CONSUMER_OFFER, offer({ command, dispatchGuidance: "Only wake me if this is blocked." }));
	expect(claims).toHaveLength(1);
	claims[0].answer((value) => { decision = value; });
	await waitFor(() => decision);

	expect(decision).toBe("skip");
	expect(client.requests).toHaveLength(1);
	const request = client.requests[0]!;
	const state = JSON.stringify(request.state);
	expect(state).toContain(command);
	expect(state).toContain(ADVISORY_WAKE_DEFAULT_GUIDANCE);
	expect(state).toContain("Only wake me if this is blocked.");
	expect(request.questions[ADVISORY_WAKE_QUESTION]?.type).toBe("noul");
	expect(log.records).toHaveLength(1);
	expect(log.records[0]).toMatchObject({ would: "skip", verdict: "skip", questions: [ADVISORY_WAKE_QUESTION] });
	expect(JSON.stringify(log.records)).not.toContain(command);
	dispose();
});

test("also claims Herdsman soft deadlines without fabricating a command", async () => {
	const bus = new EventBus();
	const client = fakeJevClient({ [ADVISORY_WAKE_QUESTION]: noul(0.1) });
	const claims: WakeConsumerClaim[] = [];
	bus.on(WAKE_CONSUMER_CLAIM, (raw) => claims.push(raw as WakeConsumerClaim));
	const dispose = wireAdvisoryWakes(host(bus), {
		client,
		config: testConfig({ watcherMode: "advisory" }),
		sessionId: "session-1",
	});
	let decision: string | undefined;
	bus.emit(WAKE_CONSUMER_OFFER, offer({ source: "pi-herdsman", kind: "soft-deadline", command: undefined }));
	claims[0]!.answer((value) => { decision = value; });
	await waitFor(() => decision);
	expect(decision).toBe("skip");
	const state = JSON.stringify(client.requests[0]?.state);
	expect(state).toContain("pi-herdsman");
	expect(state).toContain('"command":null');
	dispose();
});

test("releases uncertain or failed judgments and records the reading either way", async () => {
	// A failed request is not an absent record: the band says the reading was
	// missing, which is what a tuning pass has to be able to tell apart from a
	// reading that stayed between the edges.
	for (const [answers, expected] of [
		[{ [ADVISORY_WAKE_QUESTION]: noul(0.5) }, { band: "unclear", probability: 0.5 }],
		[{ ok: false as const, error: "classifier unavailable" }, { band: "missing", probability: null }],
	] as const) {
		const bus = new EventBus();
		const client = fakeJevClient(answers);
		const claims: WakeConsumerClaim[] = [];
		const log = fakeLog();
		bus.on(WAKE_CONSUMER_CLAIM, (raw) => claims.push(raw as WakeConsumerClaim));
		const dispose = wireAdvisoryWakes(host(bus), {
			client,
			config: testConfig({ watcherMode: "advisory", advisoryThreshold: 0.75 }),
			sessionId: "session-1",
			record: logSink({ log, now: () => new Date("2026-10-10T00:00:00.000Z"), mode: "advisory", model: client.model }),
		});
		let decision: string | undefined;
		bus.emit(WAKE_CONSUMER_OFFER, offer());
		claims[0]!.answer((value) => { decision = value; });
		await waitFor(() => decision);
		expect(decision).toBe("release");
		const record = await waitFor(() => log.records[0]);
		expect(record).toMatchObject({
			would: "release",
			verdict: "release",
			watcher: { source: "pi-background-tasks", kind: "soft-timeout", mode: "advisory", guidance: "default", promptVersion: ADVISORY_WAKE_PROMPT_VERSION },
			bands: [{ id: ADVISORY_WAKE_QUESTION, role: "advisory", edge: 0.75, measured: false, ...expected }],
		});
		dispose();
	}
});

test("an off watcher listens to nothing", () => {
	const bus = new EventBus();
	const client = fakeJevClient({ [ADVISORY_WAKE_QUESTION]: noul(0.1) });
	const claims: WakeConsumerClaim[] = [];
	bus.on(WAKE_CONSUMER_CLAIM, (raw) => claims.push(raw as WakeConsumerClaim));
	const log = fakeLog();
	const dispose = wireAdvisoryWakes(host(bus), {
		client,
		config: testConfig({ watcherMode: "off" }),
		sessionId: "session-1",
		record: logSink({ log, now: () => new Date("2026-10-10T00:00:00.000Z"), mode: "shadow", model: client.model }),
	});
	bus.emit(WAKE_CONSUMER_OFFER, offer());
	expect(claims).toHaveLength(0);
	expect(client.requests).toHaveLength(0);
	expect(log.records).toHaveLength(0);
	dispose();
});

test("shadow classifies and records without claiming the offer", async () => {
	const bus = new EventBus();
	const client = fakeJevClient({ [ADVISORY_WAKE_QUESTION]: noul(0.1) });
	const claims: WakeConsumerClaim[] = [];
	bus.on(WAKE_CONSUMER_CLAIM, (raw) => claims.push(raw as WakeConsumerClaim));
	const log = fakeLog();
	const guidance = "Only wake me if this is blocked.";
	const dispose = wireAdvisoryWakes(host(bus), {
		client,
		config: testConfig({ watcherMode: "shadow", advisoryThreshold: 0.75 }),
		sessionId: "session-1",
		record: logSink({ log, now: () => new Date("2026-10-10T00:00:00.000Z"), mode: "shadow", model: client.model }),
	});
	// The producer's decision is made by the time the offer returns: shadow put
	// nothing on that path.
	bus.emit(WAKE_CONSUMER_OFFER, offer({ dispatchGuidance: guidance }));
	expect(claims).toHaveLength(0);
	const record = await waitFor(() => log.records[0]);
	expect(record).toMatchObject({
		record: "ask",
		would: "skip",
		verdict: "skip",
		watcher: {
			source: "pi-background-tasks",
			kind: "soft-timeout",
			mode: "shadow",
			guidance: "dispatch",
			promptVersion: ADVISORY_WAKE_PROMPT_VERSION,
		},
		bands: [{ id: ADVISORY_WAKE_QUESTION, role: "advisory", band: "violated", probability: 0.1, edge: 0.75, measured: false }],
	});
	expect(JSON.stringify(record)).not.toContain(guidance);
	dispose();
});

test("does not claim an offer for another session", () => {
	const bus = new EventBus();
	const client = fakeJevClient({ [ADVISORY_WAKE_QUESTION]: noul(0.1) });
	const claims: WakeConsumerClaim[] = [];
	bus.on(WAKE_CONSUMER_CLAIM, (raw) => claims.push(raw as WakeConsumerClaim));
	const dispose = wireAdvisoryWakes(host(bus), {
		client,
		config: testConfig({ watcherMode: "advisory" }),
		sessionId: "session-1",
	});
	bus.emit(WAKE_CONSUMER_OFFER, offer({ sessionId: "session-2" }));
	expect(claims).toHaveLength(0);
	expect(client.requests).toHaveLength(0);
	dispose();
});
