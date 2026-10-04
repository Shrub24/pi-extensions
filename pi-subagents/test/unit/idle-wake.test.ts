import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDLE_WAKE_PROMPT, sendIdleWake } from "../../src/runs/shared/idle-wake.ts";

const message = { customType: "test-wake", content: "notice", display: true };

function recorder() {
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const userMessages: string[] = [];
	return {
		sent,
		userMessages,
		sender: {
			sendMessage(sentMessage: unknown, options: unknown) {
				sent.push({ message: sentMessage, options });
			},
			sendUserMessage(content: string) {
				userMessages.push(content);
			},
		},
	};
}

describe("sendIdleWake", () => {
	it("appends the message untriggered and starts the run through the prompt lifecycle when idle", () => {
		const rec = recorder();
		sendIdleWake(rec.sender as never, { isIdle: () => true } as never, message, { triggerTurn: true });
		assert.deepEqual(rec.sent, [{ message, options: {} }]);
		assert.deepEqual(rec.userMessages, [IDLE_WAKE_PROMPT]);
	});

	it("keeps the busy trigger and deliverAs options with no prompt when streaming", () => {
		const rec = recorder();
		sendIdleWake(rec.sender as never, { isIdle: () => false } as never, message, { triggerTurn: true, deliverAs: "steer" });
		assert.deepEqual(rec.sent, [{ message, options: { triggerTurn: true, deliverAs: "steer" } }]);
		assert.deepEqual(rec.userMessages, []);
	});

	it("falls back to the busy path when the sender has no prompt seam", () => {
		const sent: Array<{ options: unknown }> = [];
		sendIdleWake(
			{ sendMessage: (_message: unknown, options: unknown) => { sent.push({ options }); } } as never,
			{ isIdle: () => true } as never,
			message,
			{ triggerTurn: true },
		);
		assert.deepEqual(sent, [{ options: { triggerTurn: true } }]);
	});

	it("treats a replaced or stale context as busy instead of throwing", () => {
		const rec = recorder();
		const stale = { isIdle() { throw new Error("This extension ctx is stale after session replacement or reload."); } };
		sendIdleWake(rec.sender as never, stale as never, message, { triggerTurn: true });
		assert.deepEqual(rec.sent, [{ message, options: { triggerTurn: true } }]);
		assert.deepEqual(rec.userMessages, []);
	});
});
