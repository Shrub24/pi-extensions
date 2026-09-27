import { expect, test } from "bun:test";

import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

test("two mid-turn completions flush as one grouped wake", () => {
	const result = runSpawnFixture("spawn-extension.ts", {
		mode: "deferred-group",
	}) as { deferredGroup: { count: number; grouped: boolean } };
	expect(result.deferredGroup.count, "single grouped message, not one per task").toBe(1);
	expect(result.deferredGroup.grouped).toBe(true);
}, SPAWN_FIXTURE_TIMEOUT_MS);
