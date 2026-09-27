import { expect, test } from "bun:test";

import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

/**
 * A task that exits while a turn is in flight must not emit a visible wake: the
 * agent is still working and can read the result itself. Reading it via
 * bg_task log drops the wake; otherwise it flushes when the turn ends.
 */
test("mid-turn exit defers the wake, and reading the log drops it", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "deferred",
		command: "sleep 30 && echo done",
	}) as { deferred: { afterExit: unknown[]; afterLog: unknown[]; afterTurnEnd: unknown[] } };
	expect(result.deferred.afterExit).toHaveLength(0);
	expect(result.deferred.afterLog).toHaveLength(0);
	expect(result.deferred.afterTurnEnd).toHaveLength(0);
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * Regression: agent_end closes one low-level run — retries, overflow recovery,
 * compaction retry and follow-up work all continue after it. Releasing the hold
 * on agent_end let a wake slip out before a later read could consume it, which
 * is how "the wake arrives already consumed" happens. The wake must stay held
 * across agent_end and flush only at agent_settled.
 */
test("a mid-run exit stays held across agent_end and flushes only at agent_settled", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "deferred-settle-hold", command: "sleep 5 && echo held" }) as {
		deferred: { afterExit: unknown[]; afterLog: unknown[]; afterTurnEnd: unknown[] };
	};
	expect(result.deferred.afterExit, "nothing is sent while the run is live").toHaveLength(0);
	expect(result.deferred.afterLog, "agent_end alone releases nothing").toHaveLength(0);
	expect(result.deferred.afterTurnEnd, "agent_settled releases the held wake").toHaveLength(1);
}, SPAWN_FIXTURE_TIMEOUT_MS);

test("an unobserved mid-turn exit flushes at run end", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "deferred-unobserved",
		command: "sleep 30 && echo done",
	}) as { deferred: { afterExit: unknown[]; afterTurnEnd: unknown[] } };
	expect(result.deferred.afterExit).toHaveLength(0);
	expect(result.deferred.afterTurnEnd.length).toBeGreaterThan(0);
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * Regression (2026-09-21 three-wake report): Pi emits turn_end after every
 * assistant turn, so an exit wake flushed there fires mid-run and each one
 * becomes its own follow-up turn. Three tasks finishing at different points in
 * ONE run must arrive as a single grouped wake at the run boundary, naming all
 * three completions.
 */
test("three staggered mid-run exits produce one grouped wake", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "staggered-exits",
	}) as { staggered: { listAfterRun: string; wakeTexts: string[]; wakes: number; grouped: boolean } };
	expect(result.staggered.wakes, "one wake per run, not one per task").toBe(1);
	expect(result.staggered.grouped, "the wake names the completions").toBe(true);
	for (const id of ["bg-2", "bg-3", "bg-4"]) {
		expect(result.staggered.wakeTexts.join("\n"), `${id} is reported by the single wake`).toContain(id);
	}
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * Reading a finished task's log through a managed-bash read tool (`cat`, `tail`,
 * `head`, `grep`, `less`, or `pi-bg read`) is the same consumption as
 * `bg_task log`, so it must drop the pending wake — otherwise the agent is
 * woken for output it already read. The read shims report the exact path they
 * opened; nothing here guesses at command text.
 */
test("a read reported by the log shims consumes the pending wake", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "deferred-raw-read",
		command: "sleep 30 && echo done",
	}) as { deferred: { afterExit: unknown[]; afterLog: unknown[]; afterTurnEnd: unknown[] } };
	expect(result.deferred.afterExit).toHaveLength(0);
	expect(result.deferred.afterTurnEnd, "the bash read already delivered this exit").toHaveLength(0);
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * Regression (bg-424): the exit is already deferred when a bounded wait attaches
 * and returns the terminal result. That tool result IS the delivery, so the turn
 * end must not flush a second, visible wake for work the agent just received.
 */
test("a wait on an already-terminal task consumes the deferred wake", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "deferred-wait",
		command: "sleep 30 && echo done",
	}) as { deferred: { afterExit: unknown[]; afterLog: unknown[]; afterTurnEnd: unknown[] } };
	expect(result.deferred.afterExit).toHaveLength(0);
	expect(result.deferred.afterLog).toHaveLength(0);
	expect(result.deferred.afterTurnEnd, "the wait result already delivered this exit").toHaveLength(0);
}, SPAWN_FIXTURE_TIMEOUT_MS);
