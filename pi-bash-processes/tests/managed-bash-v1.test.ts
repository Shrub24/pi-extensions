import { expect, test } from "bun:test";
import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

interface FixtureResult {
	scenario: string;
	managedBashPublished: boolean;
	callRenderable: boolean;
	resultRenderable: boolean;
	widgetDuringForeground: string;
	widgetAfterSettle: string;
	partialTexts: string[];
	managedBashCleared: boolean;
	spawns: number;
	spawnsAfterExecute: number;
	signalsBeforeSettle: unknown[];
	signals: { pid: number; signal: unknown }[];
	resultText: string;
	resultAction: string;
	resultTask?: Record<string, unknown>;
	resultError?: string;
	finalTasks: Record<string, unknown>[];
	exitWakeCount: number;
	env: Record<string, unknown>;
	unexpected: unknown[];
}

function runScenario(input: Record<string, unknown>): FixtureResult {
	return runSpawnFixture("managed-bash-fixture.ts", input) as FixtureResult;
}

test("managed bash v1: fast exit returns truthful output and no async wake", () => {
	const result = runScenario({ mode: "spawn", scenario: "fast", showWidget: true });
	expect(result.managedBashPublished).toBe(true);
	expect(result.callRenderable, "renderCall returns a renderable component without the renderer package").toBe(true);
	expect(result.resultRenderable, "renderResult returns a renderable component without the renderer package").toBe(true);
	expect(result.managedBashCleared).toBe(true);
	expect(result.spawns, "exactly one spawn").toBe(1);
	expect(result.spawnsAfterExecute, "spawn happens inside execute").toBe(1);
	expect(result.signalsBeforeSettle, "soft wait never signals").toEqual([]);
	expect(result.resultAction).toBe("bash");
	// Indistinguishable from the built-in bash tool: plain stdout, no footer.
	expect(result.resultText).toBe("fast-output\n");
	expect(result.resultError).toBeUndefined();
	expect(result.resultTask?.status).toBe("completed");
	expect(result.widgetDuringForeground, "a foreground bash claim is not a background task").not.toContain("bg-1");
	expect(result.widgetAfterSettle, "a bash that exited in its foreground window never becomes a background task").not.toContain("bg-1");
	expect(result.resultTask?.exitCode).toBe(0);
	expect(result.exitWakeCount, "exit delivered by tool result, no async wake").toBe(0);
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("managed bash v1: slow command yields Running, same process wakes once on exit", () => {
	const result = runScenario({ mode: "spawn", scenario: "slow", showWidget: true });
	expect(result.spawns, "still exactly one spawn after yield").toBe(1);
	expect(result.resultAction).toBe("bash");
	expect(result.resultText).toContain("Running bg-1");
	expect(result.resultText).toContain("Do not poll it (no sleep/tail loops, no repeated list/log calls)");
	expect(result.resultText).toContain('bg_task action:"wait" blocks once, bounded');
	expect(result.resultText).toContain("the exit wake arrives with an output tail");
	expect(result.resultText).not.toMatch(/success|completed/i);
	expect(result.resultTask?.status).toBe("running");
	expect(result.exitWakeCount, "one completion wake for the yielded task").toBe(1);
	expect(result.finalTasks[0]?.status).toBe("completed");
	expect(result.finalTasks[0]?.exitNotified).toBe(true);
	expect(result.widgetDuringForeground, "a bash still inside its foreground window is not claimed by the widget").not.toContain("bg-1");
	expect(result.widgetAfterSettle, "a task that actually yielded is claimed by the widget").toContain("bg-1");
	expect(
		result.partialTexts.some((text) => text.includes("streamed-line")),
		"output produced inside the foreground window streams through onUpdate",
	).toBe(true);
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("managed bash v1: abort stops the process and preserves the completion wake", () => {
	const result = runScenario({ mode: "spawn", scenario: "abort" });
	expect(result.spawns).toBe(1);
	expect(result.resultError).toBe("Operation aborted");
	expect(result.signals).toContainEqual({ pid: -4242, signal: "SIGTERM" });
	expect(result.exitWakeCount, "aborted tool result owns delivery; an agent-initiated stop never wakes").toBe(0);
	expect(result.finalTasks[0]?.status).toBe("stopped");
	expect(result.finalTasks[0]?.exitNotified, "agent-initiated stop delivers via the tool result and records it, so no wake and no restart replay").toBe(true);
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("managed bash v1: input timeout is hard runtime, PI env mirrors built-in contract", () => {
	const result = runScenario({ mode: "spawn", scenario: "timeout", timeout: 0.05 });
	expect(result.spawns).toBe(1);
	expect(result.resultError).toContain("Command timed out after 0.05 seconds");
	expect(result.finalTasks[0]?.status).toBe("timed_out");
	expect(result.exitWakeCount, "timeout exit wake fires on a later close; the bounded result already carries the truth").toBe(0);
	expect(result.env.PI_SESSION_ID).toBe("managed-bash-session");
	expect(typeof result.env.PI_SESSION_FILE).toBe("string");
	expect("PI_PROVIDER" in result.env).toBe(false);
	expect(result.env.PI_MODEL).not.toBe("stale-model");
	expect("PI_MODEL" in result.env).toBe(false);
	expect(result.env.PATH).toBe(true);
	expect(result.unexpected).toEqual([]);
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * `sleep N && tail <managed log>` is the hand-written poll the anti-poll
 * contract bans. The gate replaces it with a bounded wait on the task and
 * labels the substitution; the sleep bash never spawns.
 */
test("managed bash v1: sleep+log-read is intercepted into a bounded wait with a label", () => {
	const result = runScenario({ mode: "spawn", scenario: "sleep-intercept", command: "sleep 60 && tail -n 5 /tmp/placeholder/bg-1-1700000000000.log" });
	expect(result.resultText).toContain("intercepted sleep 60");
	expect(result.resultText).toContain("bg_task action:\"wait\"");
	expect(result.resultText).not.toContain("still executing");
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * A terminal `| tail -N` runs to completion (real exit code, live log) and the
 * truncation is applied afterwards, with a disclosure footer.
 */
test("managed bash v1: terminal tail is stripped, emulated and disclosed", () => {
	const result = runScenario({ mode: "spawn", scenario: "fast", command: "echo batch | tail -1" });
	expect(result.resultText).toContain("two\n");
	expect(result.resultText).toContain("kendex: `tail -n 1` was applied to the completed output");
	expect(result.resultText).not.toContain("one\n");
}, SPAWN_FIXTURE_TIMEOUT_MS);
