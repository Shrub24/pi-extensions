import { afterEach, expect, test } from "bun:test";

import { blinkStoreStats, blinkingPrefix, clearBlink, resetBlinkStore } from "../tool-renderer/text.js";

afterEach(() => resetBlinkStore());

const theme = { fg: (_token: string, text: string) => text } as never;

test("a session boundary drops pending rows and stops the blink timer", () => {
	const context: any = { toolCallId: "call-1", invalidate() {} };
	blinkingPrefix(theme, context);
	blinkingPrefix(theme, { ...context, toolCallId: "call-2" });
	expect(blinkStoreStats()).toEqual({ entries: 2, timerRunning: true });

	resetBlinkStore();
	expect(blinkStoreStats()).toEqual({ entries: 0, timerRunning: false });
});

test("clearing a finished row leaves no entry and stops the timer", () => {
	const context: any = { toolCallId: "call-3", invalidate() {} };
	blinkingPrefix(theme, context);
	clearBlink(context);
	expect(blinkStoreStats()).toEqual({ entries: 0, timerRunning: false });
});

test("a row without an id is not tracked, since it could never be cleared", () => {
	blinkingPrefix(theme, { invalidate() {} });
	expect(blinkStoreStats()).toEqual({ entries: 0, timerRunning: false });
});

test("an abandoned pending row is dropped at the next tick instead of being held", async () => {
	let context: any = { toolCallId: "call-4", invalidate() {} };
	blinkingPrefix(theme, context);
	expect(blinkStoreStats().entries).toBe(1);

	context = undefined;
	Bun.gc(true);
	// One blink interval: the sweep is what notices the row is gone.
	await Bun.sleep(520);
	expect(blinkStoreStats()).toEqual({ entries: 0, timerRunning: false });
});
