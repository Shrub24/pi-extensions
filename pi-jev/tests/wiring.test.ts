import { beforeEach, expect, test } from "bun:test";

import { joinRecords } from "../extensions/decision-record.js";
import type { DecisionRecord } from "../extensions/decision-record.js";
import type { JevConfig } from "../extensions/config.js";
import { wirePermissionAuthorizer } from "../extensions/wiring.js";
import { fakeDetails, fakeJevClient, fakeLog, fakeQuery, noul, testConfig } from "./fixtures/fakes.js";
import { resetRegistry } from "../extensions/registry.js";
import { fakeHost as fakePi, fakeService, locatorFor } from "./fixtures/host.js";

// The core registry is process-global, so each test starts with no session: one
// test's core would otherwise serve the next test's asks from its own answers.
beforeEach(() => resetRegistry());

function harness(options: {
	services?: Map<string, unknown>;
	config?: Partial<JevConfig>;
	answers?: Parameters<typeof fakeJevClient>[0];
	unavailable?: string;
	withBus?: boolean;
}) {
	const host = fakePi({ withBus: options.withBus });
	const log = fakeLog();
	const services = options.services ?? new Map<string, unknown>();
	wirePermissionAuthorizer(host.pi, {
		config: testConfig({ authorizerName: "pi-jev", ...options.config }),
		log,
		jev: fakeJevClient(options.answers ?? { "intent.authorized_by_user": noul(0.97), "safety.no_material_harm": noul(0.98) }, options.unavailable) as never,
		locator: locatorFor(services),
		now: () => new Date("2026-09-19T00:00:00.000Z"),
	});
	/** Resolve the pending `locator.resolve()` chain before asserting. */
	return { ...host, log, services, settle: () => new Promise((resolve) => setTimeout(resolve, 0)) };
}

test("a ready event for our session registers the link, once", async () => {
	const service = fakeService();
	const harnessed = harness({ services: new Map([["s1", service.service]]) });
	await harnessed.sessionStart("s1");

	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await harnessed.settle();
	expect(service.registered.has("pi-jev")).toBe(true);
	expect(service.disposals).toEqual([]);

	// The provider emits ready more than once per session; a second registration
	// under one name would throw, so the same service is not re-entered.
	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await harnessed.settle();
	expect(service.disposals).toEqual([]);
	expect(service.registered.size).toBe(1);
	expect(harnessed.notices).toEqual([]);
});

test("a new service object under the same session id is re-registered", async () => {
	const first = fakeService();
	const services = new Map<string, unknown>([["s1", first.service]]);
	const harnessed = harness({ services });
	await harnessed.sessionStart("s1");

	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await harnessed.settle();

	// A reload publishes a new object; the link must follow the object.
	const second = fakeService("service-2");
	services.set("s1", second.service);
	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await harnessed.settle();

	expect(first.disposals).toEqual(["pi-jev"]);
	expect(second.registered.has("pi-jev")).toBe(true);
});

test("another node's ready event is left alone", async () => {
	const mine = fakeService();
	const sibling = fakeService("sibling");
	const harnessed = harness({ services: new Map([["s1", mine.service], ["s2", sibling.service]]) });
	await harnessed.sessionStart("s1");

	harnessed.emit("permissions:ready", { sessionId: "s2", adjudicatesLocally: true });
	await harnessed.settle();
	expect(sibling.registered.size).toBe(0);
	expect(mine.registered.size).toBe(0);

	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: false });
	await harnessed.settle();
	expect(mine.registered.has("pi-jev")).toBe(true);
});

test("a duplicate link name is reported once, and the ask still reaches the human", async () => {
	const service = fakeService();
	service.registered.set("pi-jev", () => {});
	const harnessed = harness({ services: new Map([["s1", service.service]]) });
	await harnessed.sessionStart("s1");

	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await harnessed.settle();
	expect(harnessed.notices).toHaveLength(1);
	expect(harnessed.notices[0]?.message).toContain("already registered");
	expect(harnessed.notices[0]?.level).toBe("warning");
});

test("a host without an event bus says so at the first session", async () => {
	const harnessed = harness({ withBus: false });
	expect(harnessed.listenerCount("permissions:ready")).toBe(0);
	await harnessed.sessionStart("s1");
	expect(harnessed.notices.map((notice) => notice.message).join(" ")).toContain("no extension event bus");
});

test("a session without an id, and an unusable judge, are both reported", async () => {
	const harnessed = harness({ unavailable: "no usable judge (No API key. Run /typesafe login in Pi)." });
	await harnessed.sessionStart(null);
	await harnessed.settle();
	const messages = harnessed.notices.map((notice) => notice.message).join("\n");
	expect(messages).toContain("exposed no id");
	expect(messages).toContain("No API key");
});

test("an absent judge is not reported until an attempt has failed", async () => {
	const harnessed = harness({});
	await harnessed.sessionStart("s1");
	await harnessed.settle();
	expect(harnessed.notices).toEqual([]);
});

test("every permission decision is recorded for later labelling", async () => {
	const harnessed = harness({});
	await harnessed.sessionStart("s1");

	harnessed.emit("permissions:decision", {
		requestId: "req-9",
		surface: "bash",
		value: "rm -rf build",
		result: "deny",
		resolution: "user_denied",
		origin: "project",
		matchedPattern: "rm *",
		agentName: "pi",
		forwarding: null,
	});
	harnessed.emit("permissions:decision", { nonsense: true });

	const records = harnessed.log.records.filter((record): record is DecisionRecord => record.record === "decision");
	expect(records).toHaveLength(1);
	expect(records[0]).toEqual({
		record: "decision",
		version: 1,
		ts: "2026-09-19T00:00:00.000Z",
		requestId: "req-9",
		resolution: "user_denied",
		result: "deny",
		surface: "bash",
		value: "rm -rf build",
		origin: "project",
		matchedPattern: "rm *",
		agentName: "pi",
		forwarded: false,
	});
});

test("shutdown disposes the link and stops listening", async () => {
	const service = fakeService();
	const harnessed = harness({ services: new Map([["s1", service.service]]) });
	await harnessed.sessionStart("s1");
	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await harnessed.settle();

	harnessed.shutdown();
	expect(service.registered.size).toBe(0);
	expect(harnessed.listenerCount("permissions:ready")).toBe(0);
	expect(harnessed.listenerCount("permissions:decision")).toBe(0);
});

test("the registered link is the runtime's authorize function", async () => {
	const service = fakeService();
	const harnessed = harness({ services: new Map([["s1", service.service]]) });
	await harnessed.sessionStart("s1");
	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await harnessed.settle();

	const authorize = service.registered.get("pi-jev") as (
		details: unknown,
		query: unknown,
		log: unknown,
	) => Promise<{ kind: string }>;
	const verdict = await authorize(fakeDetails(), fakeQuery(), { review: () => {}, debug: () => {} });
	expect(verdict).toEqual({ kind: "defer" });
	// One record per request the core ran; the two state groups are two requests.
	const asks = harnessed.log.records.filter((record) => record.record === "ask");
	expect(asks.length).toBeGreaterThan(0);
	expect(new Set(asks.map((ask) => ask.requestId)).size).toBe(1);
});

test("registration and its removal are both recorded", async () => {
	const service = fakeService();
	const harnessed = harness({ services: new Map([["s1", service.service]]) });
	await harnessed.sessionStart("s1");
	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await harnessed.settle();

	const registered = harnessed.log.records.filter((record) => record.record === "event");
	expect(registered).toHaveLength(1);
	expect(registered[0]).toMatchObject({
		record: "event",
		version: 1,
		ts: "2026-09-19T00:00:00.000Z",
		event: "registered",
		detail: { link: "pi-jev", mode: "shadow", model: "jev-latest", unavailable: null, sessionId: "s1" },
	});

	harnessed.shutdown();
	const events = harnessed.log.records.filter((record) => record.record === "event");
	expect(events.map((record) => record.event)).toEqual(["registered", "unregistered"]);
});

test("lifecycle records do not reach the join", async () => {
	const service = fakeService();
	const harnessed = harness({ services: new Map([["s1", service.service]]) });
	await harnessed.sessionStart("s1");
	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await harnessed.settle();

	const records = harnessed.log.read();
	expect(records.filter((record) => record.record === "event")).toHaveLength(1);
	expect(joinRecords(records).joined).toEqual([]);
	expect(joinRecords(records).unmatchedAsks).toBe(0);
});
