import { expect, test } from "bun:test";

import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

test("a sequential rerun of the same command notes the finished task", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "rerun",
		command: "bun run test",
	}) as { rerun: { first: string; second: string } };
	expect(result.rerun.first).not.toContain("finished recently");
	expect(result.rerun.second).toContain("finished recently in this cwd: bg-1");
	expect(result.rerun.second).toContain("Rerun only what changed");
}, SPAWN_FIXTURE_TIMEOUT_MS);
