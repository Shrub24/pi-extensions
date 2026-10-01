import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { formatTaskResultText, summarizeTaskStatus } from "../extensions/format.js";
import { fakeTask } from "./fixtures/lifecycle.js";

// Task 3.6: the operation result text, the renderer text and the settings copy
// describe the stop/review model that actually exists. Three conflations are
// forbidden, each of which the older copy made in some surface:
//
//   signal submission  ==  confirmed stop
//   soft reminder      ==  termination
//   acknowledgment     ==  output deletion
//
// This is a prose audit over the assembled text, not over the code: it reads the
// same functions the transcript does, and it reads the settings/render sources
// for the sentences that have no runtime caller in a test.

const read = (relative: string) => readFileSync(new URL(`../extensions/${relative}`, import.meta.url), "utf8");

test("an unconfirmed stop is never reported as a stopped task", async () => {
	const source = read("registrations.ts");
	// The stop's own message is the only place a refusal is described, and it is
	// carried in details rather than in a success line.
	expect(source, "the stop's refusal is its own message").toContain("stoppedResult[1].stopMessage");
	expect(source, "a refusal is never rendered as a successful stop").not.toMatch(/`Stopped \$\{candidate\.id\}\.`[\s\S]{0,120}?ok\b/);

	const running = fakeTask({ id: "bg-stop", exitCode: null, status: "running", terminationReason: null });
	// A running task's own status line reports that it has not ended, never that a
	// signal was accepted as an outcome.
	const status = summarizeTaskStatus(running.status, running.exitCode, running.terminationReason);
	expect(status, "a running task is running").toBe("running");
	expect(status, "and is not described as stopped").not.toMatch(/stop/i);
});

test("a soft reminder is never described as a termination or a killed process", () => {
	for (const source of ["wake-events.ts", "format.ts", "registrations.ts", "settings.ts", "auto-background.ts"]) {
		const text = read(source);
		for (const forbidden of [/soft[^.\n]{0,40}\b(?:killed|kills|terminated|terminates the task)\b/i, /soft[^.\n]{0,40}\bprocess is stopped\b/i]) {
			expect(text, `${source} must not equate a soft reminder with a termination: ${forbidden}`).not.toMatch(forbidden);
		}
	}
	// The reminder's own text says what it does NOT do — in both surfaces, since
	// the choices a reminder offers are per-mode.
	const guidance = read("tool-surface.ts");
	expect((guidance.match(/Nothing was stopped; the exit wake is still armed/g) ?? []).length, "both surfaces state nothing was stopped").toBe(2);
	// The schema copy says the same.
	const schema = read("registrations.ts");
	expect(schema, "the soft window is described as advisory").toContain("Soft expiry never stops the process");
});

test("acknowledgment is never described as deleting or consuming output", () => {
	for (const source of ["format.ts", "registrations.ts", "wake-events.ts", "task-result.ts", "pi-bg.ts"]) {
		const text = read(source);
		for (const forbidden of [
			/acknowledg\w*[^.\n]{0,60}\b(?:deletes?|removes?|discards?|clears?)\b/i,
			/\b(?:deletes?|removes?|discards?|clears?)\b[^.\n]{0,40}\backnowledg/i,
		]) {
			expect(text, `${source} must not equate acknowledgment with deletion: ${forbidden}`).not.toMatch(forbidden);
		}
	}
	// The terminal read says both updates in one place: the completion is settled
	// and the bytes it captured stay reachable.
	const task = fakeTask({ id: "bg-ack", exitCode: 0, status: "completed" });
	const text = formatTaskResultText(
		{
			observation: {
				id: task.id,
				status: task.status,
				exitCode: task.exitCode,
				terminationReason: task.terminationReason ?? null,
				command: task.command,
				cwd: task.cwd,
				elapsedMs: 10,
				readiness: "terminal",
				outputBytes: 6,
				outputChanged: false,
				outputPreview: "alpha\n",
				outputPreviewTruncated: false,
			},
		},
		{ acknowledged: true, committed: "terminal" },
	);
	expect(text, "the read states the completion is settled").toContain("acknowledged: completion settled");
	expect(text, "and that the output is still there").toContain("final");
	expect(text, "with no claim that anything was deleted").not.toMatch(/delet|discard|removed/i);
});
