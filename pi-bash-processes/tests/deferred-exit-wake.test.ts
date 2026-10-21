import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { declaredCliEnv } from "../extensions/settings.js";
import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

/**
 * A completion wake is the result delivery: a task that exits while a run is in
 * flight is sent at once (queued as steer by Pi), not held for the end of the
 * run. Retrieval after that is a separate step and resolves the result.
 */
test("a mid-run exit is delivered at once; reading the live log does not resolve it", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "deferred",
		command: "sleep 30 && echo done",
	}) as { deferred: { afterExit: unknown[]; afterLog: unknown[]; afterTurnEnd: unknown[] } };
	expect(result.deferred.afterExit, "the wake does not wait for the run boundary").toHaveLength(1);
	expect(JSON.stringify(result.deferred.afterExit[0])).toContain('"deliverAs":"steer"');
	expect(result.deferred.afterLog).toHaveLength(0);
	expect(result.deferred.afterTurnEnd, "a log read is not a retrieval, so idle sends the one advisory").toHaveLength(1);
	expect(JSON.stringify(result.deferred.afterTurnEnd[0])).toContain('"eventType":"result-review"');
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * agent_end closes one low-level run and changes nothing. Idle (agent_settled)
 * sends the single advisory for a result still unretrieved, and only that.
 */
test("an unretrieved result is reminded once at agent_settled, never at agent_end", () => {
	const result = runSpawnFixture("spawn-extension.ts", { mode: "deferred-settle-hold", command: "sleep 5 && echo held" }) as {
		deferred: { afterExit: unknown[]; afterLog: unknown[]; afterTurnEnd: unknown[] };
	};
	expect(result.deferred.afterExit, "delivered while the run is live").toHaveLength(1);
	expect(result.deferred.afterLog, "agent_end alone sends nothing").toHaveLength(0);
	expect(result.deferred.afterTurnEnd, "agent_settled sends the advisory").toHaveLength(1);
	expect(JSON.stringify(result.deferred.afterTurnEnd[0])).toContain('"eventType":"result-review"');
	expect(JSON.stringify(result.deferred.afterTurnEnd[0]), "and it starts no turn").toContain('"triggerTurn":false');
}, SPAWN_FIXTURE_TIMEOUT_MS);

/**
 * Pi emits turn_end after every assistant turn, so tying delivery to it would
 * give each completion its own wake. Three tasks finishing at different points
 * of one run are three deliveries, each sent when it finished.
 */
test("three staggered mid-run exits are each delivered as they finish", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "staggered-exits",
	}) as { staggered: { listAfterRun: string; wakeTexts: string[]; wakes: number; grouped: boolean } };
	expect(result.staggered.wakes, "one wake per completion, none held to the run boundary").toBe(3);
	const text = result.staggered.wakeTexts.join("\n");
	for (const id of ["bg-2", "bg-3", "bg-4"]) {
		expect(text, `${id} names its outcome and the result it still owes`).toContain(`${id} · exit 0 · result unretrieved`);
	}
	expect(text, "the sibling still running is named").toContain("Tasks still running: bg-1");
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
 * Regression (bg-424): the exit has already been delivered when a bounded wait
 * attaches and returns the terminal result. That result is the retrieval, so
 * idle has no advisory to send for it.
 */
test("a wait on an already-delivered terminal task leaves nothing to remind", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "deferred-wait",
		command: "sleep 30 && echo done",
	}) as { deferred: { afterExit: unknown[]; afterLog: unknown[]; afterTurnEnd: unknown[] } };
	expect(result.deferred.afterExit).toHaveLength(1);
	expect(result.deferred.afterLog).toHaveLength(0);
	expect(result.deferred.afterTurnEnd, "the wait result was the retrieval").toHaveLength(0);
}, SPAWN_FIXTURE_TIMEOUT_MS);
