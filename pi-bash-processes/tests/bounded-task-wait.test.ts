import { expect, test } from "bun:test";
import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

interface FixtureResult {
	scenario: string;
	spawns: number;
	signalsBeforeSettle: { pid: number; signal: unknown }[];
	signals: { pid: number; signal: unknown }[];
	resultText?: string;
	resultAction?: string;
	resultTask?: Record<string, unknown>;
	resultError?: string;
	secondWaitError?: string;
	firstWaitText?: string;
	timersDuringWait: { kind: string; ms: number }[];
	timersAfterWait: { kind: string; ms: number }[];
	finalTasks: Record<string, unknown>[];
	exitWakeCount: number;
	unexpected: unknown[];
}

function runScenario(scenario: string, extra: Record<string, unknown> = {}): FixtureResult {
	return runSpawnFixture("task-wait-fixture.ts", { mode: "spawn", scenario, ...extra }) as FixtureResult;
}

// The orphan watcher registers a perpetual interval(30s) for every session;
// everything else in the table belongs to the wait under test.
const waitTimers = (timers: { kind: string; ms: number }[]) =>
	timers.filter((timer) => !(timer.kind === "interval" && timer.ms === 30_000));

test("bounded wait: already-terminal task returns its terminal result immediately", () => {
	const result = runScenario("terminal");
	expect(result.spawns).toBe(1);
	expect(result.resultAction).toBe("wait");
	expect(result.resultText).toContain("completed (exit 0)");
	expect(result.resultTask?.status).toBe("completed");
	expect(result.resultTask?.exitCode).toBe(0);
	expect(waitTimers(result.timersDuringWait), "terminal fast path attaches no waiter").toEqual([]);
	expect(result.exitWakeCount, "the pre-wait close already woke once; the wait adds no duplicate").toBe(1);
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("bounded wait: settlement before expiry returns terminal and suppresses the async exit wake", () => {
	const result = runScenario("settles");
	expect(result.spawns).toBe(1);
	expect(result.resultAction).toBe("wait");
	expect(result.resultText).toContain("completed (exit 0)");
	expect(result.resultTask?.status).toBe("completed");
	expect(result.timersDuringWait, "one bounded window and one pending-message poll").toContainEqual({ kind: "timeout", ms: 30_000 });
	expect(result.timersDuringWait).toContainEqual({ kind: "interval", ms: 100 });
	expect(waitTimers(result.timersAfterWait), "settlement clears both wait timers").toEqual([]);
	expect(result.exitWakeCount, "the wait result owns the terminal delivery").toBe(0);
	expect(result.finalTasks[0]?.exitNotified).toBe(true);
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("bounded wait: expiry returns truthful Running and keeps the later completion wake", () => {
	const result = runScenario("expiry");
	expect(result.spawns).toBe(1);
	expect(result.resultText).toContain("Still Running bg-1");
	expect(result.resultText).toContain("Running is not success");
	expect(result.resultText).toContain("Do not call wait again as the default");
	expect(result.resultText).toContain("never poll");
	expect(result.resultText).toContain("End the turn when nothing independent is left");
	expect(result.resultText).toContain("completion wakes you as a new turn");
	expect(result.resultText).toContain("wait window 30s");
	expect(result.resultTask?.status).toBe("running");
	expect(waitTimers(result.timersAfterWait), "expiry detaches the waiter").toEqual([]);
	expect(result.exitWakeCount, "completion after expiry still wakes once").toBe(1);
	expect(result.finalTasks[0]?.status).toBe("completed");
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("bounded wait: Running elapsed text measures wait attachment, not task age", () => {
	const result = runScenario("wait-elapsed");
	expect(result.resultText).toContain("after a 7.0s bounded wait");
	expect(result.resultText).not.toContain("after a 12s bounded wait");
	expect(result.resultTask?.status).toBe("running");
	expect(result.exitWakeCount, "expiry keeps the later completion wake").toBe(1);
	expect(result.finalTasks[0]?.status).toBe("completed");
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("bounded wait: terminal result keeps total task age", () => {
	const result = runScenario("terminal-elapsed");
	expect(result.resultText).toContain("completed (exit 0) in 7.0s");
	expect(result.resultText).not.toContain("in 0ms");
	expect(result.resultTask?.status).toBe("completed");
	expect(result.finalTasks[0]?.status).toBe("completed");
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("bounded wait: session shutdown aborts a pending wait and keeps the exit replay-eligible", () => {
	const result = runScenario("shutdown-wait");
	expect(result.resultError, "the pending wait rejects through the abort path").toBe("Operation aborted");
	expect(result.resultText, "shutdown delivers no terminal wait result").toBeUndefined();
	expect(result.signals.map((signal) => signal.signal), "shutdown terminates the task process group").toEqual(["SIGTERM", "SIGKILL"]);
	expect(waitTimers(result.timersAfterWait), "abort clears both wait timers").toEqual([]);
	expect(result.exitWakeCount, "shutdown delivers no exit wake").toBe(0);
	expect(result.finalTasks[0]?.status).toBe("stopped");
	expect(result.finalTasks[0]?.terminationReason).toBe("session-shutdown");
	expect(result.finalTasks[0]?.exitNotified, "the unsent exit stays replay-eligible").toBe(false);
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("bounded wait: queued steer releases the wait quickly and keeps the later wake", () => {
	const result = runScenario("pending");
	expect(result.spawns).toBe(1);
	expect(result.resultText).toContain("Still Running bg-1");
	expect(result.resultTask?.status).toBe("running");
	expect(result.timersAfterWait.filter((timer) => timer.kind === "interval" && timer.ms === 100), "poll stops with the wait").toEqual([]);
	expect(result.timersAfterWait.filter((timer) => timer.kind === "timeout"), "the full window is not left pending").toEqual([]);
	expect(result.exitWakeCount, "later completion wake remains enabled").toBe(1);
	expect(result.finalTasks[0]?.status).toBe("completed");
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("bounded wait: abort ends only the wait and does not kill the task", () => {
	const result = runScenario("abort");
	expect(result.spawns).toBe(1);
	expect(result.resultError).toBe("Operation aborted");
	expect(result.signalsBeforeSettle, "abort never signals the task process").toEqual([]);
	expect(waitTimers(result.timersAfterWait), "abort clears both wait timers").toEqual([]);
	expect(result.exitWakeCount, "later completion wake remains enabled").toBe(1);
	expect(result.finalTasks[0]?.status).toBe("completed");
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("bounded wait: a second concurrent wait for the same task is rejected", () => {
	const result = runScenario("second-wait");
	expect(result.secondWaitError).toContain("already active");
	expect(result.secondWaitError).toContain("await its result or the automatic completion wake");
	expect(result.secondWaitError, "the rejection must not steer the model back to log/list polling").not.toMatch(/\b(log|list)\b/);
	expect(result.firstWaitText).toContain("Still Running bg-1");
	expect(result.exitWakeCount, "later completion wake remains enabled").toBe(1);
	expect(result.finalTasks[0]?.status).toBe("completed");
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("bounded wait: configured default is capped by configured maximum", () => {
	const result = runScenario("configured-bounds", { taskWaitDefaultSeconds: 20, taskWaitMaxSeconds: 12 });
	expect(result.timersDuringWait.filter((timer) => timer.kind === "timeout")).toEqual([{ kind: "timeout", ms: 12_000 }]);
	expect(result.resultText).toContain("wait window 12s");
	expect(result.resultTask?.status).toBe("running");
	expect(result.exitWakeCount).toBe(1);
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("bounded wait: waitSeconds clamps high to 120s and low to an immediate expiry", () => {
	const high = runScenario("clamp-high");
	expect(high.timersDuringWait.filter((timer) => timer.kind === "timeout"), "999s becomes the 120s cap").toEqual([{ kind: "timeout", ms: 120_000 }]);
	expect(high.resultText).toContain("wait window 120s");
	expect(high.resultTask?.status).toBe("running");
	expect(high.exitWakeCount).toBe(1);
	expect(high.unexpected).toEqual([]);

	const low = runScenario("clamp-low");
	expect(low.timersDuringWait.filter((timer) => timer.kind === "timeout"), "negative becomes an immediate expiry").toEqual([{ kind: "timeout", ms: 0 }]);
	expect(low.resultText).toContain("wait window 0s");
	expect(low.resultTask?.status).toBe("running");
	expect(low.exitWakeCount).toBe(1);
	expect(low.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);
