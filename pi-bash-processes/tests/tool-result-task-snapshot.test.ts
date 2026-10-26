import { expect, test } from "bun:test";

import { taskDisplayName } from "../extensions/format.js";
import type { BackgroundTaskSnapshot } from "../extensions/types.js";
import { toolResultTaskSnapshot } from "../extensions/wake-events.js";

function snapshot(overrides: Partial<BackgroundTaskSnapshot>): BackgroundTaskSnapshot {
	return {
		command: "npm run build",
		cwd: "/work/app",
		exitCode: null,
		id: "bg-1",
		logFile: "/tmp/kendex-pi-bg/bg-1.log",
		pid: 4321,
		sessionId: "session-a",
		startedAt: 1_000,
		status: "running",
		title: "npm run build",
		updatedAt: 2_000,
		...overrides,
	} as BackgroundTaskSnapshot;
}

test("a title that repeats the command is stored empty and still displays the command", () => {
	const stored = toolResultTaskSnapshot(snapshot({ title: "npm run build" }));
	expect(stored.title).toBe("");
	expect(taskDisplayName(stored)).toBe("npm run build");
});

test("a distinct title, such as an auto-background rule name, is kept", () => {
	const stored = toolResultTaskSnapshot(snapshot({ title: "auto: npm run build" }));
	expect(stored.title).toBe("auto: npm run build");
	expect(taskDisplayName(stored)).toBe("auto: npm run build");
});

test("the stored snapshot keeps the fields restore and the expanded views read", () => {
	const stored = toolResultTaskSnapshot(snapshot({}));
	expect(stored).toMatchObject({ command: "npm run build", id: "bg-1", logFile: "/tmp/kendex-pi-bg/bg-1.log", cwd: "/work/app", pid: 4321, sessionId: "session-a", startedAt: 1_000, updatedAt: 2_000 });
	expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(snapshot({})).length);
});
