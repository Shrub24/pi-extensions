import { expect, test } from "bun:test";
import { antiPollLine, bashBackgroundAckText } from "../extensions/auto-background.js";
import { BG_TASK_ACTIONS } from "../extensions/tool-surface.js";
import { WAKE_MANIFEST_FIELD_MAX_CHARS as cap } from "../extensions/wake-events.js";
import { fakeSnapshot } from "./fixtures/lifecycle.js";

const rows = [
	{ name: "huge acknowledgement fields retain bounded prefixes", huge: true },
	{ name: "small acknowledgement fields are unchanged", huge: false },
];

test("background acknowledgement rows", () => {
	expect.assertions(rows.length + 1);
	expect(rows.length, "acknowledgement table must contain cases").toBeGreaterThan(0);
	for (const row of rows) {
		const task = fakeSnapshot({
			id: "bg-log-1", pid: 4242, command: row.huge ? "C".repeat(200_000) : "echo log",
			cwd: row.huge ? "/path/" + "P".repeat(5_000) : "/path/work",
			logFile: row.huge ? "/tmp/" + "L".repeat(5_000) : "/tmp/log",
			notifyOnOutput: true, notifyPattern: row.huge ? "R".repeat(5_000) : "ready",
			dedupeKey: row.huge ? "D".repeat(5_000) : "monitor",
		});
		const text = bashBackgroundAckText(task, { forced: false, notifyOnExit: true, notifyOnOutput: true, reason: "test", title: "test" });
		const expected = [
			"Started bg-log-1 (pid 4242) in the background.", "Reason: test.",
			`Command: ${row.huge ? "C".repeat(cap - 1) + "…" : "echo log"}`,
			`Cwd: ${row.huge ? "/path/" + "P".repeat(cap - 7) + "…" : "/path/work"}`,
			`Wakeups: exit=yes, output=${row.huge ? "R".repeat(cap - 1) + "…" : "ready"}, mode=always, dedupeKey=${row.huge ? "D".repeat(cap - 1) + "…" : "monitor"}`,
			antiPollLine(),
		].join("\n");
		expect({ text, bounded: Buffer.byteLength(text, "utf8") < 4_096, excluded: ["C", "P", "L", "R", "D"].filter((char) => text.includes(char.repeat(cap + 1))) }, row.name).toStrictEqual({ text: expected, bounded: true, excluded: [] });
	}
});

/**
 * The acknowledgement is read by the same model that owns the tool, so it may
 * name only the operations the declared surface has: no bounded wait, and no
 * wording from the retired compatibility surface.
 */
test("the acknowledgement names only operations the tool declares", () => {
	const task = fakeSnapshot({ id: "bg-log-2", pid: 4243, command: "echo log", cwd: "/path/work", logFile: "/tmp/log" });
	const decision = { forced: false, notifyOnExit: true, notifyOnOutput: true, reason: "test", title: "test" };

	const text = bashBackgroundAckText(task, decision);
	expect(text).toContain("Started bg-log-2");
	expect(text, "the ack offers no bounded wait").not.toContain('action:"wait"');
	expect(text, "the ack forbids polling").toContain("no repeated get calls");
	expect(text).toContain("end the turn");

	// The anti-poll line is the one the ack carries verbatim.
	expect(text).toContain(antiPollLine());
	const declared = new Set<string>(BG_TASK_ACTIONS);
	for (const [, action] of text.matchAll(/bg_task action:"([a-z]+)"/g)) {
		expect(declared.has(action!), `the ack names an action the tool does not declare: ${action}`).toBe(true);
	}
});
