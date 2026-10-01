import { expect, test } from "bun:test";
import { antiPollLine, bashBackgroundAckText } from "../extensions/auto-background.js";
import { taskSurfaceGuidance } from "../extensions/tool-surface.js";
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
 * The acknowledgement the model reads may only name operations the mode
 * declares: the same rows above are produced for the narrowed TUI surface, and
 * the anti-poll line there must not offer a bounded wait the tool does not have.
 */
test("the acknowledgement names only operations the mode declares", () => {
	const task = fakeSnapshot({ id: "bg-log-2", pid: 4243, command: "echo log", cwd: "/path/work", logFile: "/tmp/log" });
	const decision = { forced: false, notifyOnExit: true, notifyOnOutput: true, reason: "test", title: "test" };

	const tui = bashBackgroundAckText(task, decision, undefined, undefined, "tui");
	expect(tui).toContain("Started bg-log-2");
	expect(tui, "the TUI ack offers no bounded wait").not.toContain('action:"wait"');
	expect(tui, "the TUI ack forbids polling the narrowed surface").toContain("no repeated get calls");
	expect(tui).toContain("end the turn");

	const compat = bashBackgroundAckText(task, decision, undefined, undefined, "compat");
	expect(compat).toContain('bg_task action:"wait"');
	expect(compat).toContain("no repeated list/log calls");

	// The narrowed surface's own line is the one the TUI ack uses verbatim.
	expect(tui).toContain(antiPollLine("tui"));
	expect(compat).toContain(antiPollLine("compat"));
	expect(taskSurfaceGuidance("tui").runningAdvice).not.toContain("bg_task action");
});
