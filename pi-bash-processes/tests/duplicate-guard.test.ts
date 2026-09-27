import { expect, test } from "bun:test";

import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

test("spawning an identical command while one runs warns with the existing id", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "duplicate",
		command: "sleep 30 && echo one",
		command2: "sleep 30 && echo one",
	}) as { duplicate: { first: string; second: string } };
	expect(result.duplicate.first, "first spawn has no warning").not.toContain("WARNING");
	expect(result.duplicate.second).toContain("WARNING: identical command already running: bg-1");
	expect(result.duplicate.second, "the new task itself is not listed as a duplicate").not.toContain("bg-2.");
	expect(result.duplicate.second).toContain("bg_task wait");
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("spawning a similar command notes the overlap without the warning", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "duplicate",
		command: "bun run test",
		command2: "bun run test 2>&1 | tail -5",
	}) as { duplicate: { first: string; second: string } };
	expect(result.duplicate.first).not.toContain("already running");
	expect(result.duplicate.second).toContain("Note: similar command already running: bg-1");
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("id-less wait attaches to the oldest running task", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "wait-any", command: "sleep 30" }) as {
		waitAny: { details: { task?: { id?: string } } };
	};
	expect(result.waitAny.details.task?.id).toBe("bg-1");
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * A chain of reruns is the wake storm: each dead build still wakes the agent
 * after the agent has moved to the next one. The older of two identical
 * commands is superseded, and its exit wake is dropped.
 */
test("an identical respawn supersedes the older task and drops its wake", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "supersede",
		command: "sleep 5 && echo one",
		command2: "sleep 5 && echo one",
		wakeDelayMs: 1200,
	}) as { supersede: { wakes: unknown[]; listText: string } };
	expect(result.supersede.wakes.length, "only the newer task wakes").toBe(1);
	expect(result.supersede.listText).toContain("superseded by bg-2");
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * A user-initiated cancel is not the agent's own stop: the stop tool result
 * never happened, so the agent must be woken with the cancellation — otherwise
 * a task it ended its turn waiting on kills the turn silently.
 */
test("a user-cancelled task wakes the agent with the cancellation", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "operator-stop", command: "sleep 30" }) as {
		operatorStop: { messages: string[] };
	};
	const wake = JSON.stringify(result.operatorStop.messages);
	expect(wake, "cancellation reaches the agent").toContain("cancelled by the user");
	expect(wake, "and is not reported as a completion").not.toContain("bg-1 finished");
}, SPAWN_FIXTURE_TIMEOUT_MS);
