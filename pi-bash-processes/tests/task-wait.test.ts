import { expect, test } from "bun:test";
import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

import {
	clampTaskWaitSeconds,
	createTaskWaitWaiter,
	DEFAULT_TASK_WAIT_SECONDS,
	formatTaskWaitRunningText,
	MAX_TASK_WAIT_SECONDS,
	settleTaskWaitWaiter,
	TASK_WAIT_PENDING_POLL_MS,
} from "../extensions/task-wait.js";

// waitSeconds is a wait budget, not a task timeout: missing input takes the
// configured default, negative becomes an immediate expiry, and large input
// caps at the configured maximum.
test("waitSeconds defaults to 30 and clamps to 0..120", () => {
	expect(DEFAULT_TASK_WAIT_SECONDS).toBe(30);
	expect(MAX_TASK_WAIT_SECONDS).toBe(120);
	expect(TASK_WAIT_PENDING_POLL_MS).toBe(100);
	expect(clampTaskWaitSeconds(undefined)).toBe(30);
	expect(clampTaskWaitSeconds(Number.NaN)).toBe(30);
	expect(clampTaskWaitSeconds(Number.POSITIVE_INFINITY)).toBe(30);
	expect(clampTaskWaitSeconds("30")).toBe(30);
	expect(clampTaskWaitSeconds(-5)).toBe(0);
	expect(clampTaskWaitSeconds(0)).toBe(0);
	expect(clampTaskWaitSeconds(0.5)).toBe(0.5);
	expect(clampTaskWaitSeconds(45)).toBe(45);
	expect(clampTaskWaitSeconds(999)).toBe(120);
	expect(clampTaskWaitSeconds(undefined, 45, 60)).toBe(45);
	expect(clampTaskWaitSeconds(999, 45, 60)).toBe(60);
	expect(clampTaskWaitSeconds(undefined, 45, 20), "default is capped by max").toBe(20);
	expect(clampTaskWaitSeconds(undefined, Number.NaN, 20)).toBe(20);
	expect(clampTaskWaitSeconds(undefined, 10, Number.NaN)).toBe(10);
});

// A waiter starts attached. The first settle wins, detaches, clears both
// timers, and resolves; every later settle (late expiry, late queued-message
// poll, late abort) must not deliver anything.
test("task wait waiter has a single owner and clears its timers", async () => {
	const waiter = createTaskWaitWaiter();
	expect(waiter.attached).toBe(true);
	expect(waiter.settled).toBe(false);
	let expiryFired = false;
	let resolvedKind: string | null = null;
	const expiryTimer = setTimeout(() => {
		expiryFired = true;
		settleTaskWaitWaiter(waiter, { kind: "expired" });
	}, 5);
	const pollTimer = setInterval(() => {}, 5);
	waiter.expiryTimer = expiryTimer;
	waiter.pollTimer = pollTimer;
	waiter.resolve = (outcome) => { resolvedKind = outcome.kind; };

	expect(settleTaskWaitWaiter(waiter, { kind: "settled" })).toBe(true);
	expect(resolvedKind).toBe("settled");
	expect(waiter.outcome).toEqual({ kind: "settled" });
	expect(waiter.attached).toBe(false);
	expect(waiter.settled).toBe(true);
	expect(waiter.expiryTimer).toBeNull();
	expect(waiter.pollTimer).toBeNull();

	expect(settleTaskWaitWaiter(waiter, { kind: "aborted" })).toBe(false);
	expect(settleTaskWaitWaiter(waiter, { kind: "expired" })).toBe(false);
	await new Promise((resolve) => setTimeout(resolve, 15));
	expect(expiryFired).toBe(false);
	expect(resolvedKind).toBe("settled");
	expect(waiter.outcome).toEqual({ kind: "settled" });

	expect(settleTaskWaitWaiter(null, { kind: "expired" })).toBe(false);
	expect(settleTaskWaitWaiter(undefined, { kind: "expired" })).toBe(false);
});

// An expiry settle detaches and re-enables the completion wake: a later
// terminal settle attempt on the same waiter must lose.
test("expiry wins, late terminal settle loses", () => {
	const waiter = createTaskWaitWaiter();
	let resolvedKind: string | null = null;
	waiter.resolve = (outcome) => { resolvedKind = outcome.kind; };
	expect(settleTaskWaitWaiter(waiter, { kind: "expired" })).toBe(true);
	expect(resolvedKind).toBe("expired");
	expect(waiter.attached).toBe(false);
	expect(settleTaskWaitWaiter(waiter, { kind: "settled" })).toBe(false);
	expect(waiter.outcome).toEqual({ kind: "expired" });
});

// Slow path is Running, not success, and points at the one bounded re-wait.
test("running wait text is truthful and bounded", () => {
	const text = formatTaskWaitRunningText({
		elapsedText: "30s",
		id: "bg-3",
		logFile: "/tmp/bg-3.log",
		outputTail: "partial output",
		pid: 999,
		waitSeconds: 30,
	});
	expect(text).toContain("Still Running bg-3");
	expect(text).toContain("Running is not success");
	expect(text).toContain("Do not call wait again as the default");
	expect(text).toContain("never poll");
	expect(text).toContain("End the turn when nothing independent is left");
	expect(text).toContain("completion wakes you as a new turn");
	expect(text).toContain("never poll");
	expect(text).toContain("Output so far (bounded tail):\npartial output");
	expect(text).toContain("Full log: /tmp/bg-3.log");
	expect(text).not.toContain("completed (exit");
});

/**
 * Regression (bg-2088 / bg-3047 class): a bounded wait ATTACHED to a running
 * task is the delivery channel when the child finalizes during the wait. The
 * waiter-owns-exit claim must record the exit as delivered so the run boundary
 * emits no duplicate wake for the result the wait already handed over.
 */
test("a wait that settles with the exit records delivery and emits no wake", () => {
	const result = runSpawnFixture("task-wait-fixture.ts", { mode: "spawn", scenario: "settles-suppresses-wake" }) as {
		exitNotifiedAfterWait?: boolean; exitWakeCount: number; resultText?: string;
	};
	expect(result.resultText, "the wait delivered the terminal result").toContain("bg-1: completed");
	expect(result.exitNotifiedAfterWait, "the waiter-owns-exit claim recorded delivery").toBe(true);
	expect(result.exitWakeCount, "no wake for the delivered exit").toBe(0);
}, SPAWN_FIXTURE_TIMEOUT_MS);

