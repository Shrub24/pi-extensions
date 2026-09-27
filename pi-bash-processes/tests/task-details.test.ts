import { expect, test } from "bun:test";

import { renderTaskDetails } from "../extensions/render.js";

// Factual theme: this suite asserts information, not styling.
const theme = {
	bold: (text: string) => text,
	fg: (_token: string, text: string) => text,
	inverse: (text: string) => text,
} as never;

function snapshot(overrides: Record<string, unknown> = {}) {
	return {
		command: "bun test",
		cwd: "/tmp",
		exitCode: 0,
		exitNotified: true,
		expiresAt: null,
		id: "bg-1",
		lastOutputAt: null,
		logFile: "/tmp/kendex-pi-bg/bg-1.log",
		notifyOnExit: true,
		notifyOnOutput: false,
		outputBytes: 0,
		pid: 4242,
		sessionId: "s",
		startedAt: 1_000_000,
		status: "completed",
		title: "bun test",
		updatedAt: 1_018_000,
		...overrides,
	};
}

test("task details report elapsed time and drop a title that repeats the command", () => {
	const lines = renderTaskDetails(snapshot() as never, theme).join("\n");
	expect(lines).toContain("completed");
	expect(lines).toContain("18s");
	expect(lines).toContain("Command: bun test");
	expect(lines, "a title identical to the command is noise").not.toContain("Title:");
});

test("task details keep an auto-background title, which names the claiming rule", () => {
	const lines = renderTaskDetails(snapshot({ title: "auto: bun test" }) as never, theme).join("\n");
	expect(lines).toContain("Title: auto: bun test");
	expect(lines).toContain("18s");
});
