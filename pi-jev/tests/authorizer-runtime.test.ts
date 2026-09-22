import { expect, test } from "bun:test";

import { actionBlocks, actionQuestionEntries, PACK_VERSION, stateBudget, STATE_VERSION } from "../extensions/action-pack.js";
import type { ActionContext } from "../extensions/action-pack.js";
import { createAuthorizerRuntime } from "../extensions/authorizer-runtime.js";
import { nudgesFrom } from "../extensions/consumers.js";
import type { Nudge } from "../extensions/consumers.js";
import { createDecisionCore } from "../extensions/decision-core.js";
import type { DecisionCore } from "../extensions/decision-core.js";
import { askRecordFromCore } from "../extensions/decision-record.js";
import type { AskRecord } from "../extensions/decision-record.js";
import { conversation, fakeDetails, fakeJevClient, fakeLog, fakeQuery, noul, score, testConfig } from "./fixtures/fakes.js";
import type { JevAnswer } from "../extensions/types.js";

/** A clean run: every question satisfied. */
const CLEAN: Record<string, JevAnswer> = {
	"safety.no_material_harm": noul(0.99),
	"safety.reversibility": score(1),
	"intent.conflicts_with_user": noul(0.98),
	"intent.matches_plan": noul(0.97),
	"scope.supports_active_task": noul(0.97),
	"tool.fit": noul(0.96),
};

function harness(options: {
	answers: Record<string, JevAnswer> | { ok: false; error: string; errorCode?: string };
	mode?: "shadow" | "advisory" | "live";
	stateRetention?: "hash" | "full";
	conversation?: ReturnType<typeof conversation>;
	deliver?: (nudges: readonly Nudge[]) => void;
}) {
	const log = fakeLog();
	const jev = fakeJevClient(options.answers);
	const config = testConfig({
		mode: options.mode ?? "shadow",
		stateRetention: options.stateRetention ?? "hash",
		defaultThreshold: 0.9,
		advisoryThreshold: 0.85,
	});
	const problems: string[] = [];
	const core: DecisionCore<ActionContext> = createDecisionCore<ActionContext>({
		ask: (state, questions, askOptions) => jev.ask(state, questions, askOptions),
		record: (context) =>
			log.write(askRecordFromCore(context, { ts: "2026-09-19T00:00:00.000Z", mode: config.mode, model: jev.model, packVersion: PACK_VERSION, stateVersion: STATE_VERSION })),
	});
	for (const block of actionBlocks(stateBudget(config))) core.registerBlock(block);
	core.registerQuestions(actionQuestionEntries<ActionContext>());

	const authorizerLogs: { event: string; details?: Record<string, unknown> }[] = [];
	const runtime = createAuthorizerRuntime({
		config,
		// The core arrives with the session, so the runtime reads it per ask.
		core: () => core,
		conversation: () => options.conversation ?? conversation({ userMessages: ["clean the build directory"], declaredPlan: "Remove the stale build directory." }),
		report: (problem) => problems.push(problem),
		...(options.deliver ? { deliver: options.deliver } : {}),
	});
	return {
		log,
		jev,
		core,
		problems,
		authorizerLogs,
		authorize: (details = fakeDetails()) =>
			runtime.authorize(details, fakeQuery(), {
				review: (event, detail) => authorizerLogs.push({ event, details: detail }),
				debug: (event, detail) => authorizerLogs.push({ event, details: detail }),
			}),
		asks: () => log.records.filter((record): record is AskRecord => record.record === "ask"),
	};
}

test("shadow mode records the would-be verdict and defers", async () => {
	const harnessed = harness({ answers: CLEAN });
	expect(await harnessed.authorize()).toEqual({ kind: "defer" });

	// One subject, one request: every block the pack's questions read rides it.
	const asks = harnessed.asks();
	expect(asks).toHaveLength(1);
	// The blocks the permission consumer's questions read, and only those: the
	// child block belongs to the subagent questions, which this ask did not carry.
	expect([...new Set(asks.flatMap((ask) => ask.blocks.map((entry) => entry.id)))].sort()).toEqual(["ask", "authority", "plan", "tool_history", "toolbox", "user_intent"]);
	const ask = asks[0];
	// The record joins on the permission request id, which is what the decision
	// channel reports back; the subject key adds its kind in front.
	expect(ask?.requestId).toBe("req-1");
	expect(ask?.subjectKind).toBe("call");
	expect(ask?.mode).toBe("shadow");
	expect(ask?.verdict).toBe("defer");
	expect(ask?.error).toBeNull();
	expect(ask?.would).toBe("allow");
	// Every question the consumer reads went in the one request.
	expect(ask?.questions).toEqual(["safety.no_material_harm", "safety.reversibility", "intent.conflicts_with_user", "intent.matches_plan", "scope.supports_active_task", "tool.fit"]);
	expect(ask?.bands.map((band) => `${band.id}[${band.role}]=${band.band}`)).toEqual([
		"safety.no_material_harm[veto]=satisfied",
		"safety.reversibility[advisory]=satisfied",
		"intent.conflicts_with_user[advisory]=satisfied",
		"intent.matches_plan[advisory]=satisfied",
		"scope.supports_active_task[advisory]=satisfied",
		"tool.fit[advisory]=satisfied",
	]);
	expect(ask?.bands.find((band) => band.id === "safety.reversibility")?.level).toBe(1);
	// Every block records its own hash and size, so a report can tell what the
	// judge could see and whether it had changed.
	for (const block of ask?.blocks ?? []) {
		expect(block.hash).toHaveLength(16);
		expect(block.chars).toBeGreaterThan(0);
	}
});

test("live mode allows a clean action", async () => {
	const harnessed = harness({ answers: CLEAN, mode: "live" });
	expect(await harnessed.authorize()).toEqual({ kind: "allow" });
	expect(harnessed.jev.requests).toHaveLength(1);
});

test("live mode refuses a measured veto violation and teaches why", async () => {
	const harm = harness({ answers: { ...CLEAN, "safety.no_material_harm": noul(0.03) }, mode: "live" });
	const verdict = await harm.authorize();
	expect(verdict.kind).toBe("deny");
	expect((verdict as { reason?: string }).reason ?? "").toContain("safety.no_material_harm");
	expect((verdict as { reason?: string }).reason ?? "").toContain("bash: rm -rf build");

	// Irreversibility is advisory: live mode records the signal, delivers it,
	// and lets the call proceed. Only material harm refuses.
	const delivered: Nudge[][] = [];
	const irreversible = harness({ answers: { ...CLEAN, "safety.reversibility": score(3) }, mode: "live", deliver: (nudges) => delivered.push([...nudges]) });
	expect(await irreversible.authorize()).toEqual({ kind: "allow" });
	expect(delivered[0]?.[0]).toMatchObject({ source: "safety.reversibility", role: "advisory", severity: "warn", measured: false });
});

test("an advisory violation allows and is recorded, without this consumer nudging", async () => {
	// The advisory bands belong to the consumer that rides on them; a gate that
	// also spoke for them would say the same thing twice about one action. And an
	// advisory has no authority to block: a violation is worth a sentence, never a
	// stalled call.
	for (const mode of ["shadow", "live"] as const) {
		const delivered: Nudge[][] = [];
		const harnessed = harness({ answers: { ...CLEAN, "intent.matches_plan": noul(0.02) }, mode, deliver: (nudges) => delivered.push([...nudges]) });
		expect(await harnessed.authorize()).toEqual({ kind: mode === "live" ? "allow" : "defer" });
		expect(delivered).toEqual([]);
		const signals = new Set(harnessed.asks().flatMap((ask) => ask.signals.map((signal) => signal.source)));
		expect([...signals]).toContain("intent.matches_plan");
	}
});

test("a nudge is recorded but not delivered when no seam is supplied", async () => {
	const harnessed = harness({ answers: { ...CLEAN, "tool.fit": noul(0.05) } });
	expect(await harnessed.authorize()).toEqual({ kind: "defer" });
	const surface = harnessed.asks()[0];
	expect(surface?.signals.map((signal) => signal.source)).toEqual(["tool.fit"]);
});

test("a delivery seam that throws cannot change the verdict", async () => {
	const harnessed = harness({
		answers: { ...CLEAN, "intent.matches_plan": noul(0.02) },
		deliver: () => {
			throw new Error("sendMessage exploded");
		},
		mode: "live",
	});
	expect(await harnessed.authorize()).toEqual({ kind: "allow" });
});

test("every signal is recorded, whatever the delivery bound is", async () => {
	const harnessed = harness({
		answers: { ...CLEAN, "intent.matches_plan": noul(0.02), "scope.supports_active_task": noul(0.02), "tool.fit": noul(0.02) },
	});
	await harnessed.authorize();
	// Every record carries the whole ask's reading, so one signal appears once per
	// request; the set is what the log has to offer, and nothing is dropped from it.
	const signals = [...new Set(harnessed.asks().flatMap((ask) => ask.signals.map((signal) => signal.source)))];
	expect(signals.sort()).toEqual(["intent.matches_plan", "scope.supports_active_task", "tool.fit"]);
	expect(nudgesFrom([...signals].map((source) => ({ source, role: "advisory", band: "violated" as const, probability: 0.02, level: null, purpose: source, confident: true, measured: true, severity: "warn" as const })))).toHaveLength(2);
});

test("an unclear band allows in live mode without nudging", async () => {
	// The judge has no opinion; the operator's own rules already allowed the call.
	const harnessed = harness({ answers: { ...CLEAN, "safety.no_material_harm": noul(0.5) }, mode: "live" });
	expect(await harnessed.authorize()).toEqual({ kind: "allow" });
	expect(harnessed.asks().flatMap((ask) => ask.signals)).toEqual([]);
});

test("a missing safety answer defers rather than allowing", async () => {
	const partial = { ...CLEAN } as Record<string, JevAnswer>;
	delete partial["safety.no_material_harm"];
	const harnessed = harness({ answers: partial, mode: "live" });
	expect(await harnessed.authorize()).toEqual({ kind: "defer" });
	const surface = harnessed.asks()[0];
	expect(surface?.bands.find((band) => band.id === "safety.no_material_harm")?.band).toBe("missing");

	// A missing advisory — reversibility included — does not stall the call.
	const advisoryMissing = { ...CLEAN } as Record<string, JevAnswer>;
	delete advisoryMissing["safety.reversibility"];
	expect(await harness({ answers: advisoryMissing, mode: "live" }).authorize()).toEqual({ kind: "allow" });
});

test("a judge failure defers and is recorded per request", async () => {
	const harnessed = harness({ answers: { ok: false, error: "TypeSafe request timed out.", errorCode: "timeout" } });
	expect(await harnessed.authorize()).toEqual({ kind: "defer" });

	const asks = harnessed.asks();
	expect(asks).toHaveLength(1);
	for (const ask of asks) {
		expect(ask.error).toEqual({ code: "timeout", message: "TypeSafe request timed out." });
		expect(ask.would).toBe("defer");
		// A failed request bands every question it carried as missing, which names
		// what never answered instead of leaving the record blank.
		expect(ask.bands.every((band) => band.band === "missing")).toBe(true);
		expect(ask.bands.length).toBeGreaterThan(0);
	}
	expect(harnessed.problems).toEqual([]);
});

test("an unusable judge configuration asks the human to fix it", async () => {
	const harnessed = harness({ answers: { ok: false, error: "No API key. Run /typesafe login in Pi.", errorCode: "configuration" } });
	expect(await harnessed.authorize()).toEqual({ kind: "defer" });
	expect(harnessed.problems.length).toBeGreaterThan(0);
	expect(harnessed.problems.join(" ")).toContain("no usable judge");
});

test("advisory mode allows a would-deny ask, records both, and still nudges", async () => {
	const delivered: Nudge[][] = [];
	const harnessed = harness({ answers: { ...CLEAN, "safety.no_material_harm": noul(0.03) }, mode: "advisory", deliver: (nudges) => delivered.push([...nudges]) });

	// The judge says refuse; the mode says steer. The call is allowed.
	expect(await harnessed.authorize()).toEqual({ kind: "allow" });

	const ask = harnessed.asks()[0];
	expect(ask?.mode).toBe("advisory");
	expect(ask?.would).toBe("deny");
	expect(ask?.verdict).toBe("allow");
	expect(ask?.bands.find((band) => band.id === "safety.no_material_harm")?.band).toBe("violated");

	// Delivery is a config seam, not a mode: the finding reaches the agent.
	expect(delivered[0]?.[0]).toMatchObject({ source: "safety.no_material_harm", severity: "warn" });

	// The review log keeps the pair too, so "what did it want?" stays answerable.
	const judged = harnessed.authorizerLogs.find((entry) => entry.event === "pi-jev.judged");
	expect(judged?.details).toMatchObject({ would: "deny", verdict: "allow", mode: "advisory" });
});

test("advisory mode allows a judge failure and keeps the record of why", async () => {
	const harnessed = harness({ answers: { ok: false, error: "TypeSafe request timed out.", errorCode: "timeout" }, mode: "advisory" });
	expect(await harnessed.authorize()).toEqual({ kind: "allow" });

	const ask = harnessed.asks()[0];
	expect(ask?.error).toEqual({ code: "timeout", message: "TypeSafe request timed out." });
	expect(ask?.would).toBe("defer");
	expect(ask?.verdict).toBe("allow");

	const judged = harnessed.authorizerLogs.find((entry) => entry.event === "pi-jev.judged");
	expect(judged?.details).toMatchObject({ would: "defer", verdict: "allow", mode: "advisory" });
});

test("advisory mode allows and reports when there is no core at all", async () => {
	const problems: string[] = [];
	const debugs: { event: string; details?: Record<string, unknown> }[] = [];
	const runtime = createAuthorizerRuntime({
		config: testConfig({ mode: "advisory" }),
		core: () => undefined,
		conversation: () => conversation(),
		report: (problem) => problems.push(problem),
	});

	const verdict = await runtime.authorize(fakeDetails(), fakeQuery(), {
		review: () => {},
		debug: (event, details) => debugs.push({ event, details }),
	});

	expect(verdict).toEqual({ kind: "allow" });
	expect(problems.join(" ")).toContain("allowed without judgment");
	expect(debugs.some((entry) => entry.event === "pi-jev.error" && entry.details?.message === "no decision core")).toBe(true);
});

test("shadow still defers and live still refuses, so advisory is the only fail-open mode", async () => {
	const harmful = { ...CLEAN, "safety.no_material_harm": noul(0.03) };
	// A live deny carries its reason; compare the kind it decided on.
	expect((await harness({ answers: harmful, mode: "shadow" }).authorize()).kind).toBe("defer");
	expect((await harness({ answers: harmful, mode: "live" }).authorize()).kind).toBe("deny");
	expect((await harness({ answers: harmful, mode: "advisory" }).authorize()).kind).toBe("allow");
});

test("full state retention stores the state each group was asked about", async () => {
	const harnessed = harness({ answers: CLEAN, stateRetention: "full" });
	await harnessed.authorize();
	// State retention is the host's record policy; here it is exercised through the
	// record builder, which stores the interpretation the consumer supplied.
	const surface = harnessed.asks()[0];
	expect(surface?.bands).toHaveLength(6);
	expect(surface?.stateChars).toBeGreaterThan(0);
});

test("the review log gets one durable entry per judged ask, naming roles and levels", async () => {
	const harnessed = harness({ answers: { ...CLEAN, "scope.supports_active_task": noul(0.02) }, mode: "live" });
	await harnessed.authorize();
	const judged = harnessed.authorizerLogs.find((entry) => entry.event === "pi-jev.judged");
	expect(judged).toBeDefined();
	expect(judged?.details?.consumer).toBe("permission");
	expect(judged?.details?.would).toBe("allow");
	const bands = String(judged?.details?.bands);
	expect(bands).toContain("safety.reversibility[advisory]=satisfied#1");
	expect(bands).toContain("scope.supports_active_task[advisory]=violated(0.02)");
});

test("a second consumer on the same action issues no new request", async () => {
	const harnessed = harness({ answers: CLEAN });
	await harnessed.authorize();
	expect(harnessed.jev.requests).toHaveLength(1);

	// A monitor asking for a question the permission ask already carried is served
	// from memory: that is what makes riding along free.
	const result = await harnessed.core.sendDecisions({
		input: { facts: { requestId: "req-1" } as never, conversation: conversation() },
		subject: { key: "call:req-1", kind: "call" },
		consumer: "monitor",
		questions: ["safety.no_material_harm"],
	});
	expect(harnessed.jev.requests).toHaveLength(1);
	expect(result?.requests).toHaveLength(0);
	expect(result?.reused).toEqual(["safety.no_material_harm"]);
	expect(result?.readings["safety.no_material_harm"]?.probability).toBe(0.99);
});
