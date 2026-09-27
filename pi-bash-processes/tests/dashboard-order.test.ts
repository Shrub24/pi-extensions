import { expect, test } from "bun:test";
import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

/**
 * The viewer is the only place a long-running task's output can be read, so its
 * ordering and size are behavior, not cosmetics: a running task that scrolls
 * out of view under finished rows is effectively invisible.
 */
test("the dashboard lists running tasks first and fills most of the terminal", () => {
	const result = runSpawnFixture("dashboard-order.ts", {}) as {
		runningFirst: boolean;
		finishedNewBeforeOld: boolean;
		renderedRows: number;
		headerHasCounts: boolean;
	};
	expect(result.runningFirst, "a running task leads even when finished tasks are newer").toBe(true);
	expect(result.finishedNewBeforeOld, "finished stay newest-first").toBe(true);
	expect(result.headerHasCounts, "the header still reports running/finished counts").toBe(true);
	// 92% of a 40-row terminal is 36 rows, minus the two frame edges: the old
	// 72% fraction topped out near 27.
	expect(result.renderedRows, "the frame uses most of the viewport").toBeGreaterThan(30);
}, SPAWN_FIXTURE_TIMEOUT_MS);
