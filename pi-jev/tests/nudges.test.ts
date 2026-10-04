import { describe, expect, test } from "bun:test";

import type { Nudge } from "../extensions/consumers.js";
import { deliverNudges } from "../extensions/nudges.js";

// A wake that starts an idle run must go through the prompt lifecycle:
// `triggerTurn` starts the run without `before_agent_start` (earendil-works/pi#5581,
// #10267), so the run is never prepared with the contributed system-prompt options
// and its later requests drop them mid-run. An idle delivery is appended without a
// trigger and a short user prompt starts the run; a busy one keeps its steer.
const nudge = (text: string): Nudge => ({ source: "test", role: "orchestrator", severity: "notice", measured: true, text });

function recorder(sendUserMessage = true) {
	const sent: Array<{ message: { content?: string }; options?: { deliverAs?: string; triggerTurn?: boolean } }> = [];
	const userSent: unknown[] = [];
	const sendMessage = (message: unknown, options?: unknown) => {
		sent.push({ message: message as { content?: string }, options: options as { deliverAs?: string; triggerTurn?: boolean } });
	};
	const pi = sendUserMessage
		? { sendMessage, sendUserMessage: (content: unknown) => userSent.push(content) }
		: { sendMessage };
	return { sent, userSent, pi: pi as never };
}

describe("deliverNudges", () => {
	test("an idle wake appends without a trigger and starts the run with a user prompt", () => {
		const rec = recorder();
		deliverNudges(rec.pi, [nudge("a"), nudge("b")], { mode: "followUp", triggerTurn: true, isIdle: () => true });
		expect(rec.sent.map((entry) => entry.options)).toEqual([undefined, undefined]);
		expect(rec.userSent).toEqual(["New pi-jev nudge above."]);
	});

	test("a busy delivery keeps its steer and starts no user prompt", () => {
		const rec = recorder();
		deliverNudges(rec.pi, [nudge("a")], { mode: "followUp", triggerTurn: true, isIdle: () => false });
		expect(rec.sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(rec.userSent).toEqual([]);
	});

	test("a stale context reads as busy instead of throwing", () => {
		const rec = recorder();
		deliverNudges(rec.pi, [nudge("a")], {
			mode: "followUp",
			triggerTurn: true,
			isIdle: () => {
				throw new Error("stale context");
			},
		});
		expect(rec.sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(rec.userSent).toEqual([]);
	});

	test("an idle delivery with no host prompt seam keeps the trigger", () => {
		const rec = recorder(false);
		deliverNudges(rec.pi, [nudge("a")], { mode: "followUp", triggerTurn: true, isIdle: () => true });
		expect(rec.sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	test("an empty batch wakes nobody", () => {
		const rec = recorder();
		deliverNudges(rec.pi, [], { mode: "followUp", triggerTurn: true, isIdle: () => true });
		expect(rec.sent).toEqual([]);
		expect(rec.userSent).toEqual([]);
	});
});
