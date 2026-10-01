import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { declaredCliEnv } from "../extensions/settings.js";
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
 * The inferred-read channel is retired, so no consume log exists to race over.
 *
 * The defect these tests existed for was real: reading a task's log through the
 * managed-bash read shims appended the path it opened to a consume log drained
 * before a wake was handed over, and with one shared file per task directory a
 * second session's flush could swallow the record — the read was lost and the
 * agent was woken for a result it had already read. C removed the premise rather
 * than the symptom: no shim reports a read, nothing drains a consume log, and a
 * plain read of a log file changes no notification state at all, so the race
 * cannot exist. This asserts the surface is closed, not merely unused.
 */
test("no inferred-read consume log exists to race over any more", () => {
	const settings = readFileSync(new URL("../extensions/settings.ts", import.meta.url), "utf8");
	const extension = readFileSync(new URL("../extensions/background-tasks.ts", import.meta.url), "utf8");
	const cli = readFileSync(new URL("../extensions/pi-bg.ts", import.meta.url), "utf8");
	// The names may still appear in the prose that explains the retirement; what
	// must be gone is every place that *exports*, assigns or drains them.
	expect(settings, "no consume-log export survives").not.toContain("export function consumeLogPath");
	expect(extension, "nothing drains a consume log").not.toContain("drainConsumedLogPaths");
	expect(settings, "no live-log env export survives").not.toMatch(/PI_BG_CONSUME_LOG:|PI_BG_LOG_DIR:|PI_BG_LOG_GLOB:|PI_BG_REAL_PATH:/);
	expect(cli, "the CLI no longer reports a read to a consume log").not.toMatch(/PI_BG_CONSUME_LOG|PI_BG_REAL_PATH/);
	const exported = Object.keys(declaredCliEnv({ sessionId: "s", socketPath: "/tmp/s.sock" }));
	expect(exported, "the managed-shell env names the endpoint and the PATH only").toStrictEqual(["PI_BG_SOCKET", "PI_BG_SESSION", "PATH"]);
	expect(existsSync(join(tmpdir(), "kendex-pi-bg", "consumed.log")), "no legacy shared consume file is written").toBe(false);
});

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
