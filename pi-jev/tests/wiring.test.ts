import { beforeEach, expect, test } from "bun:test";

import { joinRecords } from "../extensions/decision-record.js";
import type { DecisionRecord } from "../extensions/decision-record.js";
import type { JevConfig } from "../extensions/config.js";
import { wirePermissionAuthorizer } from "../extensions/wiring.js";
import { fakeDetails, fakeJevClient, fakeLog, fakeQuery, noul, score, testConfig } from "./fixtures/fakes.js";
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

test("a forwarded ask carries the subagent questions, and a violation nudges the orchestrator", async () => {
	// A clean action-pack plus a subagent pair that violates: the judge says the
	// call departed from the dispatch and from the reviewer role.
	const service = fakeService();
	const harnessed = harness({
		answers: {
			"safety.no_material_harm": noul(0.98),
			"intent.conflicts_with_user": noul(0.97),
			"intent.matches_plan": noul(0.97),
			"scope.supports_active_task": noul(0.97),
			"orchestrator.intent_alignment": noul(0.05),
			"agent.role_adherence": noul(0.05),
		},
		config: { deliverSubagentNudges: true },
		services: new Map([["s1", service.service]]),
	});
	await harnessed.sessionStart("s1");
	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await harnessed.settle();

	const authorize = service.registered.get("pi-jev") as (details: unknown, query: unknown, log: unknown) => Promise<{ kind: string }>;
	const forwarded = fakeDetails({
		agentName: "reviewer",
		payload: {
			kind: "bash",
			request: {
				requester: { agentName: "reviewer", forwarded: true, sessionId: "child-1" },
				surface: "bash",
				toolName: "bash",
				invokedToolName: null,
				value: "git push --force origin main",
				matchedPattern: null,
				commandContext: null,
				executedUnit: null,
			},
			evidence: [],
			annotations: [],
		},
	} as never);
	const verdict = await authorize(forwarded, fakeQuery(), { review: () => {}, debug: () => {} });

	// The gate's verdict is untouched by the subagent bands: they are advisory
	// and belong to the orchestrator's consumer.
	expect(verdict).toEqual({ kind: "defer" });

	// Three requests: the action group, the plan group, and the subagent group.
	const asks = harnessed.log.records.filter((record) => record.record === "ask");
	expect(new Set(asks.flatMap((ask) => (ask as { blocks?: { id: string }[] }).blocks?.map((entry) => entry.id) ?? []))).toEqual(
		new Set(["ask", "user_intent", "plan", "tool_history", "toolbox", "authority", "child_work"]),
	);

	// The nudges went to the agent, addressed to the orchestrator.
	const texts = harnessed.sent.map((sent) => (sent.message as { content?: string }).content ?? "");
	expect(texts.some((text) => text.includes("orchestrator.intent_alignment"))).toBe(true);
	expect(texts.some((text) => text.includes("agent.role_adherence"))).toBe(true);
});

test("a local ask never carries the subagent questions", async () => {
	const service = fakeService();
	const harnessed = harness({
		answers: {
			"safety.no_material_harm": noul(0.98),
			"intent.conflicts_with_user": noul(0.97),
			"intent.matches_plan": noul(0.97),
			"scope.supports_active_task": noul(0.97),
		},
		services: new Map([["s1", service.service]]),
	});
	await harnessed.sessionStart("s1");
	harnessed.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await harnessed.settle();

	const authorize = service.registered.get("pi-jev") as (details: unknown, query: unknown, log: unknown) => Promise<{ kind: string }>;
	await authorize(fakeDetails(), fakeQuery(), { review: () => {}, debug: () => {} });

	const asks = harnessed.log.records.filter((record) => record.record === "ask");
	expect(new Set(asks.flatMap((ask) => (ask as { blocks?: { id: string }[] }).blocks?.map((entry) => entry.id) ?? []))).toEqual(new Set(["ask", "user_intent", "plan", "tool_history", "toolbox", "authority"]));
	expect(harnessed.sent).toHaveLength(0);
});

test("a gate ask carries the tool questions and their band, and they cannot refuse", async () => {
	// The gate is where every call in a session passes, so it is where the tool
	// policy's reading piles up for analysis. Both tool questions are advisory:
	// a violated band is recorded and can nudge, but the verdict it composes into
	// is still an allow.
	const host = fakePi();
	const service = fakeService();
	const jev = fakeJevClient({
		"safety.no_material_harm": noul(0.99),
		"safety.reversibility": score(1),
		"intent.conflicts_with_user": noul(0.98),
		"tool.choice": { type: "choice", choice: "semble_search", probabilities: { semble_search: 0.9, grep: 0.1 }, confidence: 0.9 },
	});
	const log = fakeLog();
	wirePermissionAuthorizer(host.pi, {
		config: testConfig({ mode: "live" }),
		log,
		jev: jev as never,
		locator: locatorFor(new Map([["s1", service.service]])),
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		policy: {
			preferences: [],
			margin: 0.2,
			precedence: [{ intent: "locate a concept", order: ["semble_search", "grep"], reason: "semble first" }],
		},
	});
	await host.sessionStart("s1");
	host.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await new Promise((resolve) => setTimeout(resolve, 0));

	const authorizeLink = service.registered.get("pi-jev") as (details: unknown, query: unknown, log: unknown) => Promise<{ kind: string }>;
	const base = fakeDetails();
	const verdict = await authorizeLink(
		fakeDetails({
			toolName: "grep",
			payload: { ...base.payload, kind: "tool", request: { ...base.payload.request, surface: "grep", toolName: "grep", value: "retryBackoff" } },
		}),
		fakeQuery(),
		{ review: () => {}, debug: () => {} },
	);

	// Asked, and recorded: the ask carries the choice question, and the record's
	// bands state the policy's own reading of the call.
	const asked = jev.requests.flatMap((request) => Object.keys(request.questions));
	expect(asked).toContain("tool.choice");
	const record = log.records.find((entry) => entry.record === "ask" && (entry.questions ?? []).includes("tool.choice"));
	expect(record).toBeDefined();
	const choiceBand = (record as { bands?: { id: string; band: string }[] }).bands?.find((band) => band.id === "tool.choice");
	expect(choiceBand?.band).toBe("violated");

	// Advisory: the judge endorsing the policy's alternative does not refuse the call.
	expect(verdict.kind).toBe("allow");
});
