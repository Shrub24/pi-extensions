import { expect, test } from "bun:test";
import { MAX_FINISHED_TASKS } from "../extensions/constants.js";
import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

test("task logs follow the lane retention rule, and finished tasks are bounded and released", () => {
	const result = runSpawnFixture("retention-extension.ts", {}) as Record<string, unknown>;
	expect(result).toStrictEqual({
		// session_start removed the lane whose worktree is gone and the log past five days.
		// Folders the package did not make keep their old files.
		pruned: { goneLane: false, oldLane: [".lane-cwd", "bg-2-2.log"], foreign: [".lane-cwd", "old.txt"], unmarked: ["old.log"], victim: [".lane-cwd", "old.txt"] },
		spawned: MAX_FINISHED_TASKS + 5,
		listed: MAX_FINISHED_TASKS,
		logInLane: true,
		laneCwd: true,
		logsBeforeClear: MAX_FINISHED_TASKS,
		// A retained log that was removed reads as an explicit expiry error, never
		// as a successful empty result.
		newestLog: "explicit-expiry-error",
		// None of these tasks is assignment-owned, so a bulk clear removes them as
		// ordinary finished history; the bound is what caps the list. What a bulk
		// clear must never do is drop an owned result nobody received — see
		// `assignment-evidence-retention.test.ts`.
		logsAfterClear: 0,
		longLog: { tail: true, head: false },
		unloggedLog: "late-output",
		// session_shutdown releases the task map.
		listedAfterShutdown: "No background tasks.",
		// A forked session forgets the tasks it restored from this session's
		// branch, past the bound and on clear, and keeps their logs.
		fork: { taskSession: "retention-session", listed: MAX_FINISHED_TASKS, logsKept: MAX_FINISHED_TASKS + 1, listedAfterClear: "No background tasks." },
	});
}, SPAWN_FIXTURE_TIMEOUT_MS);
