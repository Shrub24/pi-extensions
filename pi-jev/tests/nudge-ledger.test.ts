/*
 * The ledger's contract: a finding is counted, and the count decides the
 * sentence. These tests are the behaviour the nudge audit asked for — five scope
 * nudges in 56 seconds become one sentence, and a finding the agent ignored comes
 * back with the calls that produced it.
 */

import { expect, test } from "bun:test";

import { accumulatedText, createNudgeLedger, DEFAULT_MAX_REFS, findingKey, ledgerFor, ordinal } from "../extensions/nudge-ledger.js";
import type { LedgerEntry } from "../extensions/nudge-ledger.js";
import type { Nudge } from "../extensions/consumers.js";

function nudge(source: string, text = `pi-jev: ${source} — keep it in step.`, extra: Partial<Nudge> = {}): Nudge {
	return { source, role: "advisory", severity: "warn", measured: true, text, ...extra };
}

test("the first occurrence is delivered as written", () => {
	const ledger = createNudgeLedger({ now: () => 0 });
	const admitted = ledger.admit([nudge("scope.supports_active_task")], "call-1");
	expect(admitted).toHaveLength(1);
	expect(admitted[0]?.text).toBe("pi-jev: scope.supports_active_task — keep it in step.");
	expect(ledger.entry({ source: "scope.supports_active_task" })).toMatchObject({ count: 1, delivered: 1, refs: ["call-1"] });
});

test("a repeat inside the cooldown is counted and stays quiet", () => {
	let now = 0;
	const ledger = createNudgeLedger({ now: () => now, cooldownMs: 60_000 });
	expect(ledger.admit([nudge("scope.supports_active_task")], "call-1")).toHaveLength(1);
	now = 10_000;
	expect(ledger.admit([nudge("scope.supports_active_task")], "call-2")).toHaveLength(0);
	now = 40_000;
	expect(ledger.admit([nudge("scope.supports_active_task")], "call-3")).toHaveLength(0);
	// Four calls in under a minute, one sentence: this is the 5-in-56s burst.
	expect(ledger.entry({ source: "scope.supports_active_task" })?.count).toBe(3);
	expect(ledger.entry({ source: "scope.supports_active_task" })?.delivered).toBe(1);
});

test("a repeat after the cooldown comes back as an accumulated reminder with its refs", () => {
	let now = 0;
	const ledger = createNudgeLedger({ now: () => now, cooldownMs: 60_000 });
	ledger.admit([nudge("tool.fit", "pi-jev: your policy prefers grep.", { finding: "policy.avoid" })], "call-a");
	now = 20_000;
	ledger.admit([nudge("tool.fit", "pi-jev: your policy prefers grep.", { finding: "policy.avoid" })], "call-b");
	now = 70_000;
	const [reminder] = ledger.admit([nudge("tool.fit", "pi-jev: your policy prefers grep.", { finding: "policy.avoid" })], "call-c");

	expect(reminder?.text).toContain("3rd time this session");
	// The sentence the judge wrote is kept whole behind the count: the reminder
	// says what to do, not merely that something happened again.
	expect(reminder?.text).toContain("your policy prefers grep");
	// The refs are the calls being counted, so the count is checkable.
	expect(reminder?.text).toContain("call-a");
	expect(reminder?.text).toContain("call-b");
	// The current call is the sentence's subject, not one of its "earlier" refs.
	expect(reminder?.text).not.toContain("call-c");
	expect(ledger.entry({ source: "tool.fit", finding: "policy.avoid" })).toMatchObject({ count: 3, delivered: 2 });
});

test("the cooldown doubles per delivery, so an ignored finding gets rarer", () => {
	let now = 0;
	const ledger = createNudgeLedger({ now: () => now, cooldownMs: 1_000, maxCooldownMs: 2_000 });
	expect(ledger.admit([nudge("tool.fit")], "c1")).toHaveLength(1);
	now = 1_000;
	expect(ledger.admit([nudge("tool.fit")], "c2")).toHaveLength(1);
	expect(ledger.entry({ source: "tool.fit" })?.cooldownMs).toBe(2_000);
	now = 2_500;
	// The third delivery's window is 2s and the cap holds it there.
	expect(ledger.admit([nudge("tool.fit")], "c3")).toHaveLength(0);
	now = 3_000;
	expect(ledger.admit([nudge("tool.fit")], "c4")).toHaveLength(1);
	expect(ledger.entry({ source: "tool.fit" })?.cooldownMs).toBe(2_000);
});

test("one question can raise two findings, and they are counted apart", () => {
	const ledger = createNudgeLedger({ now: () => 0 });
	const admitted = ledger.admit(
		[
			nudge("tool.fit", "pi-jev: the tool suits the purpose."),
			nudge("tool.fit", "pi-jev: your policy warns against this call.", { finding: "policy.avoid" }),
		],
		"call-1",
	);
	// Both sentences are about this call and both are delivered: the pack's
	// verdict and the policy's warning are different complaints.
	expect(admitted.map((entry) => entry.text)).toEqual(["pi-jev: the tool suits the purpose.", "pi-jev: your policy warns against this call."]);
	expect(ledger.entry({ source: "tool.fit" })?.count).toBe(1);
	expect(ledger.entry({ source: "tool.fit", finding: "policy.avoid" })?.count).toBe(1);
	expect(findingKey({ source: "tool.fit" })).not.toBe(findingKey({ source: "tool.fit", finding: "policy.avoid" }));
});

test("finding to a cap, the newest refs are the ones kept", () => {
	const ledger = createNudgeLedger({ now: () => 0 });
	for (let index = 1; index <= DEFAULT_MAX_REFS + 2; index++) ledger.admit([nudge("tool.fit")], `c${index}`);
	expect(ledger.entry({ source: "tool.fit" })?.refs).toHaveLength(DEFAULT_MAX_REFS);
	expect(ledger.entry({ source: "tool.fit" })?.refs).toEqual(["c3", "c4", "c5"]);
});

test("a cooldown of zero delivers every occurrence as written", () => {
	const ledger = createNudgeLedger({ now: () => 0, cooldownMs: 0 });
	expect(ledger.admit([nudge("tool.fit")], "c1")).toHaveLength(1);
	expect(ledger.admit([nudge("tool.fit")], "c2")).toHaveLength(1);
	expect(ledger.entry({ source: "tool.fit" })).toBeUndefined();
});

test("the accumulated text keeps the judge's sentence and bounds itself", () => {
	const long = `pi-jev: ${"x".repeat(900)}`;
	const text = accumulatedText(long, 4, ["a", "b"], 120);
	expect(text.length).toBe(120);
	expect(text).toStartWith("pi-jev: 4th time this session.");
	expect(accumulatedText("no prefix here", 2, [])).toBe("pi-jev: 2nd time this session. no prefix here");
	expect(accumulatedText("pi-jev: careful.", 11, ["a"])).toBe("pi-jev: 11th time this session. careful. Earlier this session: a.");
	expect(accumulatedText("pi-jev: careful.", 13, [])).toBe("pi-jev: 13th time this session. careful.");
});

test("ordinals read as English, including the teens", () => {
	expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st"]);
});

test("a delivery with no session counts nothing and passes everything through", () => {
	expect(ledgerFor(undefined).admit([nudge("tool.fit")])).toHaveLength(1);
	expect(ledgerFor(undefined).entry({ source: "tool.fit" })).toBeUndefined();
});

test("one ledger per scope, and separate scopes count separately", () => {
	const first = {};
	const second = {};
	ledgerFor(first).admit([nudge("tool.fit")], "a");
	ledgerFor(first).admit([nudge("tool.fit")], "b");
	expect(ledgerFor(first).entry({ source: "tool.fit" })?.count).toBe(2);
	// A second session's ledger starts empty: counts are per session, never global.
	expect(ledgerFor(second).entry({ source: "tool.fit" })).toBeUndefined();
	expect(ledgerFor(second)).not.toBe(ledgerFor(first));
});

test("entries are readable for diagnostics", () => {
	const ledger = createNudgeLedger({ now: () => 5 });
	ledger.admit([nudge("tool.choice")], "call-1");
	const entry: LedgerEntry | undefined = ledger.entry({ source: "tool.choice" });
	expect(entry).toEqual({ count: 1, delivered: 1, lastAt: 5, cooldownMs: 60_000, refs: ["call-1"] });
});
