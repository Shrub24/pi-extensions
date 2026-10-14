import { describe, expect, test } from "bun:test";

import type { Nudge } from "../extensions/consumers.js";
import { deliverNudges } from "../extensions/nudges.js";

// Pi 1.2.0 runs idle triggerTurn deliveries through before_agent_start.
const nudge = (text: string): Nudge => ({ source: "test", role: "orchestrator", severity: "notice", measured: true, text });

function recorder() {
	const sent: Array<{ message: { content?: string }; options?: { deliverAs?: string; triggerTurn?: boolean } }> = [];
	const sendMessage = (message: unknown, options?: unknown) => {
		sent.push({ message: message as { content?: string }, options: options as { deliverAs?: string; triggerTurn?: boolean } });
	};
	return { sent, pi: { sendMessage } as never };
}

describe("deliverNudges", () => {
	test("an idle wake uses Pi's prepared triggerTurn path", () => {
		const rec = recorder();
		deliverNudges(rec.pi, [nudge("a"), nudge("b")], { mode: "followUp", triggerTurn: true });
		expect(rec.sent.map((entry) => entry.options)).toEqual([
			{ deliverAs: "followUp", triggerTurn: true },
			{ deliverAs: "followUp", triggerTurn: true },
		]);
	});

	test("an empty wake batch sends no messages", () => {
		const rec = recorder();
		deliverNudges(rec.pi, [], { mode: "followUp", triggerTurn: true });
		expect(rec.sent).toEqual([]);
	});
});
