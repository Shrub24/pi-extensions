/*
 * The intent consumer, wired the way a session wires it: two entries, one host.
 *
 * The point of these tests is the seam between the entries. The permission link
 * and the intent nudge are separate extension entries — separate files, separate
 * registrations, either one loadable without the other — and the property that
 * matters is that they still ask one question set per action, once, with the first
 * one to arrive paying for it.
 */

import { beforeEach, expect, test } from "bun:test";

import { fakeDetails, fakeJevClient, fakeLog, fakeQuery, noul, testConfig } from "./fixtures/fakes.js";
import { branchWith, fakeHost, fakeService, locatorFor } from "./fixtures/host.js";
import { wireIntentConsumer } from "../extensions/intent.js";
import { callValue, toolCallFacts } from "../extensions/intent.js";
import { resetRegistry } from "../extensions/registry.js";
import { wirePermissionAuthorizer } from "../extensions/wiring.js";
import { WAKE_CONSUMER_CLAIM, WAKE_CONSUMER_OFFER, WAKE_CONSUMER_PROTOCOL, type WakeConsumerClaim, type WakeConsumerEventBus } from "../extensions/wake-protocol.js";

beforeEach(() => resetRegistry());

test("the loaded intent entry claims background soft reminders through Jev", async () => {
	const host = fakeHost();
	const command = "python worker.py --resume";
	const client = fakeJevClient({ "wake.attention": noul(0.1) });
	wireIntentConsumer(host.pi, { config: testConfig({ mode: "advisory", advisoryThreshold: 0.75 }), jev: client, log: fakeLog() });
	await host.sessionStart("session-wake");

	let claim: WakeConsumerClaim | undefined;
	const bus = (host.pi as unknown as { events: WakeConsumerEventBus }).events;
	bus.on(WAKE_CONSUMER_CLAIM, (raw) => { claim = raw as WakeConsumerClaim; });
	// The consumer's claim is delivered synchronously while the producer emits the offer.
	host.emit(WAKE_CONSUMER_OFFER, {
		protocol: WAKE_CONSUMER_PROTOCOL,
		source: "pi-background-tasks",
		kind: "soft-timeout",
		id: "bg-1",
		sessionId: "session-wake",
		token: "offer-1",
		deadlineMs: 5_000,
		metadata: { sequence: 1 },
		command,
	});
	expect(claim).toBeDefined();
	const decision = await new Promise((resolve) => claim!.answer(resolve));
	expect(decision).toBe("skip");
	expect(client.requests).toHaveLength(1);
	expect(JSON.stringify(client.requests[0]?.state)).toContain(command);
	await host.shutdown();
	expect(host.listenerCount(WAKE_CONSUMER_OFFER)).toBe(0);
});

/** Both entries on one host, as a real session has them. */
function session(options: { answers: Parameters<typeof fakeJevClient>[0]; deliverIntentNudges?: boolean }) {
	const service = fakeService();
	const host = fakeHost({
		branch: branchWith({
			instruction: "clean the build directory then run the tests",
			plan: "I will remove the stale build directory.",
		}),
		tools: [{ name: "bash", description: "Run a shell command." }],
	});
	const config = testConfig({ mode: "shadow", deliverIntentNudges: options.deliverIntentNudges ?? true });
	const permissionJev = fakeJevClient(options.answers);
	const intentJev = fakeJevClient(options.answers);
	const permissionLog = fakeLog();
	const intentLog = fakeLog();

	wirePermissionAuthorizer(host.pi, {
		config,
		log: permissionLog,
		jev: permissionJev as never,
		locator: locatorFor(new Map([["s1", service.service]])),
		now: () => new Date("2026-09-19T00:00:00.000Z"),
	});
	wireIntentConsumer(host.pi, {
		config,
		log: intentLog,
		jev: intentJev as never,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
	});

	return {
		host,
		service,
		config,
		permissionJev,
		intentJev,
		logs: { permission: permissionLog, intent: intentLog },
		settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
		gate: async () => {
			await host.sessionStart("s1");
			host.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
			await new Promise((resolve) => setTimeout(resolve, 0));
			const authorize = service.registered.get("pi-jev") as (
				details: unknown,
				query: unknown,
				log: unknown,
			) => Promise<{ kind: string }>;
			return authorize(fakeDetails(), fakeQuery(), { review: () => {}, debug: () => {} });
		},
	};
}

test("a call queues, and the gate's ask carries it in the same flush", async () => {
	const wired = session({
		// The plan question is the intent consumer's; the action questions are the
		// gate's. One table answers both, because one core asks both.
		answers: {
			"intent.matches_plan": noul(0.02),
			"scope.supports_active_task": noul(0.96),
			"intent.authorized_by_user": noul(0.97),
			"safety.no_material_harm": noul(0.98),
			"tool.fit": noul(0.95),
		},
	});
	await wired.host.sessionStart("s1");
	wired.host.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await wired.settle();
	await wired.host.fire("turn_start");
	await wired.host.fire("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "rm -rf build" } });

	// Queued, not asked: a queue entry costs nothing, and the questions wait for
	// the next flush.
	expect(wired.permissionJev.requests).toHaveLength(0);
	expect(wired.intentJev.requests).toHaveLength(0);
	expect(wired.host.sent).toHaveLength(0);

	const authorize = wired.service.registered.get("pi-jev") as (d: unknown, q: unknown, l: unknown) => Promise<{ kind: string }>;
	// The ask names the same tool call the hook above saw: that id is the subject
	// both triggers share, which is what puts them in one flush.
	const verdict = await authorize(fakeDetails({ toolCallId: "t1" }), fakeQuery(), { review: () => {}, debug: () => {} });

	// Shadow mode: the gate still defers to the human, whatever the judge said.
	expect(verdict).toEqual({ kind: "defer" });

	// One subject, one request: the queued intent questions and the gate's own
	// questions were asked together, and the second entry's judge never ran.
	const asked = wired.permissionJev.requests.map((request) => Object.keys(request.questions).sort());
	expect(asked).toHaveLength(1);
	expect(asked[0]).toContain("intent.matches_plan");
	expect(asked[0]).toContain("safety.no_material_harm");
	expect(wired.intentJev.requests).toHaveLength(0);
	// The queue is consumed by that flush rather than left for the boundary.
	expect(wired.core?.queued("call:t1") ?? []).toEqual([]);

	// The nudge came from the same flush, with no second request behind it.
	expect(wired.host.sent).toHaveLength(1);
	expect(wired.host.sent[0]?.options).toEqual({ deliverAs: "steer" });
	expect((wired.host.sent[0]?.message as { details?: { source?: string } }).details?.source).toBe("intent.matches_plan");
});

test("a call nothing gated is read at the turn boundary, once", async () => {
	const wired = session({
		answers: { "intent.matches_plan": noul(0.03), "scope.supports_active_task": noul(0.97) },
	});
	await wired.host.sessionStart("s1");
	await wired.host.fire("turn_start");
	await wired.host.fire("tool_call", { toolName: "read", toolCallId: "t1", input: { path: "src/x.ts" } });
	await wired.host.fire("tool_call", { toolName: "read", toolCallId: "t2", input: { path: "src/y.ts" } });
	expect(wired.permissionJev.requests).toHaveLength(0);

	await wired.host.fire("turn_end");
	await wired.settle();

	// Two queued actions, one question set each: both go out at the boundary, and
	// the reading is recorded for both because the consumer that queued them
	// supplies the interpretation.
	expect(wired.permissionJev.requests).toHaveLength(2);
	// Both calls are judged and both readings are recorded; one sentence is
	// delivered. The same finding about two calls in one boundary is one thing to
	// say, and the ledger keeps the second as a count rather than a repeat.
	expect(wired.host.sent).toHaveLength(1);
	expect(wired.host.sent.map((sent) => (sent.message as { details?: { source?: string } }).details?.source)).toEqual([
		"intent.matches_plan",
	]);
});

test("a call with no stated plan queues nothing", async () => {
	const wired = session({ answers: { "intent.matches_plan": noul(0.02) } });
	wired.host.setBranch(branchWith({ instruction: "clean the build directory" }));
	await wired.host.sessionStart("s1");
	await wired.host.fire("turn_start");
	await wired.host.fire("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "rm -rf build" } });
	await wired.host.fire("turn_end");
	await wired.settle();

	// The plan question cannot be answered without a plan, so it is not asked.
	expect(wired.permissionJev.requests).toHaveLength(0);
	expect(wired.host.sent).toHaveLength(0);
});

test("nudges stay off unless this consumer is switched on", async () => {
	const wired = session({ answers: { "intent.matches_plan": noul(0.02), "scope.supports_active_task": noul(0.96) }, deliverIntentNudges: false });
	await wired.host.sessionStart("s1");
	await wired.host.fire("turn_start");
	await wired.host.fire("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "rm -rf build" } });
	await wired.host.fire("turn_end");
	await wired.settle();

	// The question was still asked and recorded; only the sentence was withheld.
	expect(wired.permissionJev.requests).toHaveLength(1);
	expect(wired.host.sent).toHaveLength(0);
});

test("a call's decision-relevant argument is what the questions read", () => {
	expect(callValue({ command: "rm -rf build", timeout: 5 })).toBe("rm -rf build");
	expect(callValue({ path: "src/x.ts", offset: 10 })).toBe("src/x.ts");
	expect(callValue("plain string")).toBe("plain string");
	expect(callValue({ server: "cbm" })).toBe('{"server":"cbm"}');
	expect(callValue(undefined)).toBe("");

	const facts = toolCallFacts({ toolName: "read", toolCallId: "t9", input: { path: "src/x.ts" } }, "call-1");
	expect(facts).toMatchObject({
		requestId: "t9",
		surface: "tool_call",
		toolName: "read",
		value: "src/x.ts",
		path: "src/x.ts",
		// An ungated call is not a policy allow, and says so.
		policy: { surfaceState: "ungated", toolState: null },
	});
	expect(toolCallFacts({ toolName: "bash", input: {} }, "call-3").requestId).toBe("call-3");
});

test("a call's decision-relevant argument is what the questions read", () => {
	expect(callValue({ command: "rm -rf build", timeout: 5 })).toBe("rm -rf build");
	expect(callValue({ path: "src/x.ts", offset: 10 })).toBe("src/x.ts");
	expect(callValue("plain string")).toBe("plain string");
	expect(callValue({ server: "cbm" })).toBe('{"server":"cbm"}');
	expect(callValue(undefined)).toBe("");

	const facts = toolCallFacts({ toolName: "read", toolCallId: "t9", input: { path: "src/x.ts" } }, "call-1");
	expect(facts).toMatchObject({
		requestId: "t9",
		surface: "tool_call",
		toolName: "read",
		value: "src/x.ts",
		path: "src/x.ts",
		// An ungated call is not a policy allow, and says so.
		policy: { surfaceState: "ungated", toolState: null },
	});
	expect(toolCallFacts({ toolName: "bash", input: {} }, "call-3").requestId).toBe("call-3");
});

test("the call's own intent line reaches the facts, and an absent one stays null", () => {
	const facts = toolCallFacts(
		{ toolName: "bash", toolCallId: "t10", input: { command: 'rg -n "apiKey" src/', intent: "Find real consumers of each API key" } },
		"call-1",
	);
	expect(facts.intent).toBe("Find real consumers of each API key");
	expect(toolCallFacts({ toolName: "bash", input: {} }, "call-2").intent).toBeNull();
});

test("a policy preference queues a choice question, and the nudge names the reason", async () => {
	const service = fakeService();
	const host = fakeHost({
		branch: branchWith({ instruction: "find where the retry logic lives", plan: "I will search the retry logic." }),
		tools: [{ name: "bash", description: "Run a shell command." }, { name: "grep", description: "Search file contents with a pattern." }],
	});
	const config = testConfig({ mode: "shadow", deliverIntentNudges: true });
	// One core, one judge: whichever entry creates it answers everything, so the
	// permission entry's table carries the choice answer too. The intent entry's
	// client would only be used if it created the core first.
	const permissionJev = fakeJevClient({
		"intent.authorized_by_user": noul(0.97),
		"safety.no_material_harm": noul(0.98),
		"tool.choice": { type: "choice", choice: "grep", probabilities: { grep: 0.9, bash: 0.4 }, confidence: 0.9 },
	});
	const intentJev = fakeJevClient({});
	wirePermissionAuthorizer(host.pi, { config, log: fakeLog(), jev: permissionJev as never, locator: locatorFor(new Map([["s1", service.service]])), now: () => new Date("2026-09-19T00:00:00.000Z") });
	wireIntentConsumer(host.pi, {
		config,
		log: fakeLog(),
		jev: intentJev as never,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		policy: { preferences: [{ tool: "grep", match: "rg ", reason: "ripgrep is faster for content search" }], margin: 0.2 },
	});
	await host.sessionStart("s1");
	host.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await new Promise((resolve) => setTimeout(resolve, 0));
	await host.fire("turn_start");
	// The tool call that the gate will be asked about carries the same id the
	// permission system uses — that id is the action key both consumers meet on.
	await host.fire("tool_call", { toolName: "bash", toolCallId: "req-1", input: { command: "rg 'retry' src/" } });

	// The gate's ask is the flush: the choice question rides it, and the second
	// call (no preference match) queues nothing for the choice consumer.
	const authorize = service.registered.get("pi-jev") as (d: unknown, q: unknown, l: unknown) => Promise<{ kind: string }>;
	await authorize(fakeDetails(), fakeQuery(), { review: () => {}, debug: () => {} });

	// One core, one judge: whichever entry created it answers every question,
	// including the choice question this consumer queued. What the second entry
	// contributes is the question and the reading — not a second request path.
	const asked = permissionJev.requests.flatMap((request) => Object.keys(request.questions));
	expect(asked).toContain("tool.choice");
	expect(asked.filter((id) => id === "tool.choice")).toHaveLength(1);
	expect(intentJev.requests).toHaveLength(0);

	// The nudge quotes the policy's reason, which is the part that teaches.
	const texts = host.sent.map((sent) => (sent.message as { content?: string }).content ?? "");
	expect(texts.some((text) => text.includes("grep") && text.includes("ripgrep is faster for content search"))).toBe(true);
});

test("an unclear margin stays quiet", async () => {
	const service = fakeService();
	const host = fakeHost({ branch: branchWith({ instruction: "search" }), tools: [{ name: "grep", description: "Search." }] });
	const intentJev = fakeJevClient({ "tool.choice": { type: "choice", choice: "grep", probabilities: { grep: 0.55, bash: 0.5 }, confidence: 0.5 } });
	wireIntentConsumer(host.pi, {
		config: testConfig({ mode: "shadow", deliverIntentNudges: true }),
		log: fakeLog(),
		jev: intentJev as never,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		policy: { preferences: [{ tool: "grep", match: "rg ", reason: "ripgrep is faster" }], margin: 0.2 },
	});
	await host.sessionStart("s1");
	await host.fire("turn_start");
	await host.fire("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "rg 'retry' src/" } });
	await host.fire("turn_end");
	await new Promise((resolve) => setTimeout(resolve, 0));

	// Asked and recorded, but a pick without a clear margin does not spend a sentence.
	expect(intentJev.requests).toHaveLength(1);
	expect(host.sent).toHaveLength(0);
});

test("no policy file means no choice question", async () => {
	const service = fakeService();
	const host = fakeHost({ branch: branchWith({ instruction: "search" }), tools: [{ name: "grep", description: "Search." }] });
	const intentJev = fakeJevClient({});
	wireIntentConsumer(host.pi, {
		config: testConfig({ mode: "shadow", deliverIntentNudges: true }),
		log: fakeLog(),
		jev: intentJev as never,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		policy: { preferences: [], margin: 0.2 },
	});
	await host.sessionStart("s1");
	await host.fire("turn_start");
	await host.fire("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "rg 'retry' src/" } });
	await host.fire("turn_end");
	await new Promise((resolve) => setTimeout(resolve, 0));

	// With no preferences there is no alternative to name, so nothing is asked.
	expect(intentJev.requests).toHaveLength(0);
	expect(host.sent).toHaveLength(0);
});

test("a long-running notice is checked in on, and the finding wakes the orchestrator", async () => {
	// The interval is long enough that only the settled event drives the scan —
	// the timer path is the same code, and a real timer in a test is a race.
	const service = fakeService();
	const host = fakeHost({ branch: branchWith({ instruction: "fix the parser" }) });
	const jev = fakeJevClient({
		"orchestrator.intent_alignment": noul(0.05),
		"agent.role_adherence": noul(0.05),
	});
	wireIntentConsumer(host.pi, {
		config: testConfig({ mode: "shadow", deliverSubagentNudges: true, orchestratorCheckInMs: 3_600_000 }),
		log: fakeLog(),
		jev: jev as never,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		policy: { preferences: [], margin: 0.2 },
	});
	await host.sessionStart("s1");
	// The child's own control notice from pi-subagents' watchdog.
	host.setBranch([
		...branchWith({ instruction: "fix the parser" }),
		{
			type: "custom_message",
			customType: "subagent_control_notice",
			id: "n1",
			content: "Subagent active but long-running: reviewer\nRun: bg-1 step 1\nSignal: reviewer is still active but long-running",
		},
	]);
	await host.fire("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));

	// The check-in asked the drift questions about the child the notice names.
	expect(jev.requests).toHaveLength(1);
	expect(Object.keys(jev.requests[0]?.questions ?? {}).sort()).toEqual(["agent.role_adherence", "orchestrator.intent_alignment"]);
	// The state is the blocks the check-in's questions read, under their names:
	// the notice as the ask, the child's name and work, the instruction served.
	const state = jev.requests[0]?.state as { ask?: { value?: string }; child_work?: { agent?: string; role?: { name?: string } } };
	expect(state.ask?.value).toContain("Subagent active but long-running");
	expect(state.child_work?.agent).toBe("reviewer");
	expect(state.child_work?.role?.name).toBe("reviewer");

	// The finding is delivered as a wake, not a steer: an idle orchestrator has
	// no tool batch for a steer to land after. The nudge is appended without a
	// trigger and a short user prompt starts the run, so the wake goes through
	// the prompt lifecycle (`before_agent_start`) instead of `triggerTurn`,
	// which would start an unprepared run (pi#5581, #10267).
	expect(host.sent).toHaveLength(1);
	const sent = host.sent[0] as { message?: { content?: string }; options?: { deliverAs?: string; triggerTurn?: boolean } };
	expect(sent.options).toBeUndefined();
	expect(host.userSent).toHaveLength(1);
	expect((host.userSent[0] as { message?: unknown }).message).toContain("nudge above");
	expect(sent.message?.content).toContain("orchestrator.intent_alignment");
});

test("a busy orchestrator is steered, not woken through a user prompt", async () => {
	// The mirror of the wake above: the same finding while a turn runs must keep
	// its steer, since a `sendUserMessage` there would queue a second turn and
	// the running run already carries prepared system-prompt options.
	const host = fakeHost({ branch: branchWith({ instruction: "fix the parser" }), isIdle: () => false });
	const jev = fakeJevClient({
		"orchestrator.intent_alignment": noul(0.05),
		"agent.role_adherence": noul(0.05),
	});
	wireIntentConsumer(host.pi, {
		config: testConfig({ mode: "shadow", deliverSubagentNudges: true, orchestratorCheckInMs: 3_600_000 }),
		log: fakeLog(),
		jev: jev as never,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		policy: { preferences: [], margin: 0.2 },
	});
	await host.sessionStart("s1");
	host.setBranch([
		...branchWith({ instruction: "fix the parser" }),
		{
			type: "custom_message",
			customType: "subagent_control_notice",
			id: "n1",
			content: "Subagent active but long-running: reviewer\nRun: bg-1 step 1\nSignal: reviewer is still active but long-running",
		},
	]);
	await host.fire("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(host.sent).toHaveLength(1);
	const sent = host.sent[0] as { options?: { deliverAs?: string; triggerTurn?: boolean } };
	expect(sent.options?.deliverAs).toBe("followUp");
	expect(sent.options?.triggerTurn).toBe(true);
	expect(host.userSent).toHaveLength(0);
});

test("a notice is checked in on once, and a clean reading wakes nobody", async () => {
	const service = fakeService();
	const host = fakeHost({ branch: branchWith({ instruction: "fix the parser" }) });
	const jev = fakeJevClient({
		"orchestrator.intent_alignment": noul(0.97),
		"agent.role_adherence": noul(0.96),
	});
	wireIntentConsumer(host.pi, {
		config: testConfig({ mode: "shadow", deliverSubagentNudges: true, orchestratorCheckInMs: 3_600_000 }),
		log: fakeLog(),
		jev: jev as never,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		policy: { preferences: [], margin: 0.2 },
	});
	await host.sessionStart("s1");
	host.setBranch([
		...branchWith({ instruction: "fix the parser" }),
		{ type: "custom_message", customType: "subagent_control_notice", id: "n1", content: "Subagent active but long-running: reviewer" },
	]);
	await host.fire("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(jev.requests).toHaveLength(1);
	// Clean bands: the check-in spent one request and said nothing.
	expect(host.sent).toHaveLength(0);

	// A second settled event reads no new notice, so it spends nothing.
	await host.fire("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(jev.requests).toHaveLength(1);
});

test("a check-in without steers switched on records without waking", async () => {
	const service = fakeService();
	const host = fakeHost({ branch: branchWith({ instruction: "fix the parser" }) });
	const jev = fakeJevClient({ "orchestrator.intent_alignment": noul(0.05), "agent.role_adherence": noul(0.05) });
	const log = fakeLog();
	wireIntentConsumer(host.pi, {
		config: testConfig({ mode: "shadow", orchestratorCheckInMs: 3_600_000 }),
		log,
		jev: jev as never,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		policy: { preferences: [], margin: 0.2 },
	});
	await host.sessionStart("s1");
	host.setBranch([
		...branchWith({ instruction: "fix the parser" }),
		{ type: "custom_message", customType: "subagent_control_notice", id: "n1", content: "Subagent needs attention: fixer-2" },
	]);
	await host.fire("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 0));

	// The finding is in the log — that is how the threshold gets chosen — and
	// the agent was not woken for it.
	expect(log.records.some((record) => record.record !== "event")).toBe(true);
	expect(host.sent).toHaveLength(0);
});

test("a precedence rule words an N-option choice question and the nudge keeps the rank", async () => {
	const service = fakeService();
	const host = fakeHost({
		branch: branchWith({ instruction: "fix the failing test", plan: "I will edit the failing test." }),
		tools: [
			{ name: "bash", description: "Run a shell command." },
			{ name: "edit", description: "Edit file ranges." },
			{ name: "grep", description: "Search file contents." },
		],
	});
	const config = testConfig({ mode: "shadow", deliverIntentNudges: true });
	const permissionJev = fakeJevClient({
		"intent.authorized_by_user": noul(0.97),
		"safety.no_material_harm": noul(0.98),
		"tool.choice": { type: "choice", choice: "edit", probabilities: { edit: 0.9, bash: 0.3, grep: 0.2 }, confidence: 0.9 },
	});
	const intentJev = fakeJevClient({});
	wirePermissionAuthorizer(host.pi, { config, log: fakeLog(), jev: permissionJev as never, locator: locatorFor(new Map([["s1", service.service]])), now: () => new Date("2026-09-19T00:00:00.000Z") });
	wireIntentConsumer(host.pi, {
		config,
		log: fakeLog(),
		jev: intentJev as never,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		policy: {
			preferences: [],
			precedence: [{ intent: "edit code", order: ["edit", "grep", "bash"], reason: "surgical edits beat rewrites and shell wrangling" }],
			margin: 0.2,
		},
	});
	await host.sessionStart("s1");
	host.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await new Promise((resolve) => setTimeout(resolve, 0));
	await host.fire("turn_start");
	await host.fire("tool_call", { toolName: "bash", toolCallId: "req-9", input: { command: "sed -i 's/old/new/' src/a.ts" } });

	const authorize = service.registered.get("pi-jev") as (d: unknown, q: unknown, l: unknown) => Promise<{ kind: string }>;
	// The choice question named all three ranked tools as options, current tool included.
	// The gate's ask carries the same command the tool_call fired with — the
	// permission system passes the call's value through to the link.
	const gateAsk = fakeDetails({ requestId: "req-9", toolName: "bash", payload: { kind: "bash", request: { requester: { agentName: "pi", forwarded: false, sessionId: null }, surface: "bash", toolName: "bash", invokedToolName: null, value: "sed -i 's/old/new/' src/a.ts", matchedPattern: null, commandContext: null, executedUnit: null }, evidence: [], annotations: [] } as never });
	await authorize(gateAsk, fakeQuery(), { review: () => {}, debug: () => {} });
	const choiceRequest = permissionJev.requests.find((request) => Object.keys(request.questions).includes("tool.choice"));
	const criteria = Object.keys(choiceRequest?.questions["tool.choice"].criteria ?? {});
	expect(criteria).toContain("bash");
	expect(criteria).toContain("edit");
	expect(criteria).toContain("grep");
	// The intent clause rode the instructions, verbatim from the policy.
	expect(choiceRequest?.questions["tool.choice"].instructions).toContain("edit code");
	// The judge picked the top-ranked alternative with a clear margin: nudge,
	// quoting the policy's reason.
	const texts = host.sent.map((sent) => (sent.message as { content?: string }).content ?? "");
	expect(texts.some((text) => text.includes("edit") && text.includes("surgical edits beat rewrites"))).toBe(true);
	expect(intentJev.requests).toHaveLength(0);
});

test("an avoid pair stands the fit question up and the nudge quotes the warning", async () => {
	const service = fakeService();
	const host = fakeHost({
		branch: branchWith({ instruction: "read the config", plan: "I will read the config file." }),
		tools: [{ name: "bash", description: "Run a shell command." }, { name: "read", description: "Read a file." }],
	});
	const config = testConfig({ mode: "shadow", deliverIntentNudges: true });
	const permissionJev = fakeJevClient({
		"intent.authorized_by_user": noul(0.97),
		"safety.no_material_harm": noul(0.98),
		"tool.fit": noul(0.1),
	});
	const intentJev = fakeJevClient({});
	wirePermissionAuthorizer(host.pi, { config, log: fakeLog(), jev: permissionJev as never, locator: locatorFor(new Map([["s1", service.service]])), now: () => new Date("2026-09-19T00:00:00.000Z") });
	wireIntentConsumer(host.pi, {
		config,
		log: fakeLog(),
		jev: intentJev as never,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		policy: {
			preferences: [],
			avoid: [{ tool: "bash", when: "cat ", reason: "reading files through the shell skips the read tool's guards" }],
			margin: 0.2,
			avoidMargin: 0.3,
		},
	});
	await host.sessionStart("s1");
	host.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await new Promise((resolve) => setTimeout(resolve, 0));
	await host.fire("turn_start");
	await host.fire("tool_call", { toolName: "bash", toolCallId: "req-10", input: { command: "cat /etc/hosts" } });

	const authorize = service.registered.get("pi-jev") as (d: unknown, q: unknown, l: unknown) => Promise<{ kind: string }>;
	const gateAsk = fakeDetails({ requestId: "req-10", toolName: "bash", payload: { kind: "bash", request: { requester: { agentName: "pi", forwarded: false, sessionId: null }, surface: "bash", toolName: "bash", invokedToolName: null, value: "cat /etc/hosts", matchedPattern: null, commandContext: null, executedUnit: null }, evidence: [], annotations: [] } as never });
	await authorize(gateAsk, fakeQuery(), { review: () => {}, debug: () => {} });

	// The fit question fired even though no alternative was named, and carried
	// the policy's warning verbatim in its instructions.
	const asked = permissionJev.requests.flatMap((request) => Object.keys(request.questions));
	expect(asked).toContain("tool.fit");
	const fitRequest = permissionJev.requests.find((request) => Object.keys(request.questions).includes("tool.fit"));
	expect(fitRequest?.questions["tool.fit"].instructions).toContain("skips the read tool's guards");
	// The nudge is the avoid warning, not a preference endorsement.
	const texts = host.sent.map((sent) => (sent.message as { content?: string }).content ?? "");
	expect(texts.some((text) => text.includes("warns against") && text.includes("skips the read tool's guards"))).toBe(true);
	// No choice question: the policy named no alternative for this call.
	expect(asked).not.toContain("tool.choice");
	expect(intentJev.requests).toHaveLength(0);
});

test("a rule that names a skill loads it once, and only when the load switch is on", async () => {
	const policy = {
		preferences: [],
		margin: 0.2,
		precedence: [
			{
				intent: "locate where a concept lives in a codebase",
				order: ["semble_search", "grep"],
				reason: "semble finds the concept; grep finds the string",
				skill: "codebase-explore",
				skillReason: "it teaches the discovery order",
			},
		],
	};
	const answers = {
		"tool.choice": { type: "choice", choice: "semble_search", margin: 0.6, probabilities: { semble_search: 0.8, grep: 0.2 }, confidence: 1 },
	} as unknown as Record<string, JevAnswer>;

	for (const [loadSkills, expected] of [[true, 1], [false, 0]] as const) {
		const host = fakeHost();
		wireIntentConsumer(host.pi, { config: testConfig({ deliverIntentNudges: true, loadSkills }), policy, jev: fakeJevClient(answers), log: fakeLog() });
		// One session id per pass: the registry (and with it the nudge ledger) is
		// per session, so reusing one id across two hosts would carry the first
		// pass's delivered finding into the second.
		await host.sessionStart(loadSkills ? "s-skill-on" : "s-skill-off");
		await host.fire("turn_start");
		await host.fire("tool_call", { toolName: "grep", toolCallId: "call-1", input: { pattern: "retryBackoff" } });
		await host.fire("turn_end");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(host.userSent).toHaveLength(expected);
		if (expected === 1) {
			expect(host.userSent[0]?.message).toBe("/skill:codebase-explore");
			expect((host.userSent[0]?.options as { expandPromptTemplates?: boolean } | undefined)?.expandPromptTemplates).toBe(true);
		}
		// The sentence about the skill rides the nudge either way: knowing why the
		// skill matters is free, loading it is the switch.
		const texts = host.sent.map((entry) => JSON.stringify(entry.message));
		expect(texts.some((text) => text.includes("codebase-explore"))).toBe(true);
	}
});

test("an avoid match does not fire when the call does not match the context", async () => {
	const service = fakeService();
	const host = fakeHost({
		branch: branchWith({ instruction: "run the build", plan: "I will run the build." }),
		tools: [{ name: "bash", description: "Run a shell command." }],
	});
	const config = testConfig({ mode: "shadow", deliverIntentNudges: true });
	const permissionJev = fakeJevClient({
		"intent.authorized_by_user": noul(0.97),
		"safety.no_material_harm": noul(0.98),
	});
	wirePermissionAuthorizer(host.pi, { config, log: fakeLog(), jev: permissionJev as never, locator: locatorFor(new Map([["s1", service.service]])), now: () => new Date("2026-09-19T00:00:00.000Z") });
	wireIntentConsumer(host.pi, {
		config,
		log: fakeLog(),
		jev: fakeJevClient({}) as never,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		policy: {
			preferences: [],
			avoid: [{ tool: "bash", when: "cat ", reason: "reading files through the shell skips guards" }],
			margin: 0.2,
		},
	});
	await host.sessionStart("s1");
	host.emit("permissions:ready", { sessionId: "s1", adjudicatesLocally: true });
	await new Promise((resolve) => setTimeout(resolve, 0));
	await host.fire("turn_start");
	await host.fire("tool_call", { toolName: "bash", toolCallId: "req-11", input: { command: "cargo build --release" } });

	const authorize = service.registered.get("pi-jev") as (d: unknown, q: unknown, l: unknown) => Promise<{ kind: string }>;
	const gateAsk = fakeDetails({ requestId: "req-11", toolName: "bash", payload: { kind: "bash", request: { requester: { agentName: "pi", forwarded: false, sessionId: null }, surface: "bash", toolName: "bash", invokedToolName: null, value: "cargo build --release", matchedPattern: null, commandContext: null, executedUnit: null }, evidence: [], annotations: [] } as never });
	await authorize(gateAsk, fakeQuery(), { review: () => {}, debug: () => {} });
	// No avoid match: the generic fit question may still fire (it always has),
	// but no nudge quotes the policy, because the policy said nothing here.
	const texts = host.sent.map((sent) => (sent.message as { content?: string }).content ?? "");
	expect(texts.some((text) => text.includes("warns against"))).toBe(false);
	const choiceAsked = permissionJev.requests.flatMap((request) => Object.keys(request.questions));
	expect(choiceAsked).not.toContain("tool.choice");
	expect(host.sent).toHaveLength(0);
});
