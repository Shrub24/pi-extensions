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

beforeEach(() => resetRegistry());

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
	const verdict = await authorize(fakeDetails(), fakeQuery(), { review: () => {}, debug: () => {} });

	// Shadow mode: the gate still defers to the human, whatever the judge said.
	expect(verdict).toEqual({ kind: "defer" });

	// One action, two state groups, two requests — and the second entry's judge
	// never ran, because it joined the first one's core instead of asking again.
	const asked = wired.permissionJev.requests.map((request) => Object.keys(request.questions).sort());
	expect(asked).toHaveLength(2);
	expect(asked.flat()).toContain("intent.matches_plan");
	expect(wired.intentJev.requests).toHaveLength(0);

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
	expect(wired.host.sent).toHaveLength(2);
	expect(wired.host.sent.map((sent) => (sent.message as { details?: { source?: string } }).details?.source)).toEqual([
		"intent.matches_plan",
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
