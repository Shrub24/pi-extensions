import { expect, test } from "bun:test";
import type { BackgroundTaskSnapshot, WakeDiagnostic } from "../extensions/types.js";
import { sendOutputWakeBudgetExhaustedNotice, WAKE_MANIFEST_FIELD_MAX_CHARS } from "../extensions/wake-events.js";
import { fakeTask } from "./fixtures/lifecycle.js";
import { sendDeps } from "./fixtures/wake.js";

test("budget exhaustion notice content and once-only delivery", () => {
	const cap = WAKE_MANIFEST_FIELD_MAX_CHARS;
	const rows = [
		{ name: "short log notice", command: "printf ready", title: "task", log: "/private/log", expectedCommand: "printf ready", expectedTitle: "task" },
		{ name: "bounded log notice", command: "Q".repeat(200_000), title: "T".repeat(5_000), log: "/tmp/" + "B".repeat(5_000), expectedCommand: "Q".repeat(cap - 1) + "…", expectedTitle: "T".repeat(cap - 1) + "…" },
	];
	expect.assertions(rows.length + 1);
	expect(rows.length).toBeGreaterThan(0);
	for (const row of rows) {
		const task = fakeTask({ id: "bg-budget", pid: 4243, command: row.command, title: row.title, logFile: row.log,
			outputWakeBudget: { wakes: 20, bytes: 0, exhausted: false, announcedAt: null } });
		const diagnostics: WakeDiagnostic[] = [];
		const { deps, messages } = sendDeps("ready\n", diagnostics);
		const first = sendOutputWakeBudgetExhaustedNotice(deps, task, { maxWakes: 20, maxBytes: 20_000 });
		const second = sendOutputWakeBudgetExhaustedNotice(deps, task, { maxWakes: 20, maxBytes: 20_000 });
		const d = messages[0]!.message.details as { eventType: string; task: BackgroundTaskSnapshot };
		const content = messages[0]!.message.content as string;
		expect({ first, second, count: messages.length, event: d.eventType, command: d.task.command, title: d.task.title,
			contentNamesTaskGet: content.includes(`bg_task action:"get" id: bg-budget`),
			// The live log path is not a retrieval route in any mode: neither the
			// notice text nor its details may offer one.
			detailsCarryLiveLog: "logFile" in d,
			contentAdvertisesLiveLog: content.includes("/private/log") || content.includes("on disk at") || content.includes(row.log),
			budget: task.outputWakeBudget, reasons: diagnostics.map((d) => d.reason),
		}, row.name).toStrictEqual({ first: true, second: false, count: 1, event: "output-budget-exhausted",
			command: row.expectedCommand, title: row.expectedTitle,
			contentNamesTaskGet: true, detailsCarryLiveLog: false, contentAdvertisesLiveLog: false,
			budget: { wakes: 20, bytes: 0, exhausted: true, announcedAt: 2_000 }, reasons: ["wake-budget-exhausted"] });
	}
});

test("bounded exhaustion notice stays below the payload byte cap", () => {
	const task = fakeTask({ id: "bg-budget", command: "Q".repeat(200_000), title: "T".repeat(5_000), logFile: "/tmp/" + "B".repeat(5_000) });
	const { deps, messages } = sendDeps();
	sendOutputWakeBudgetExhaustedNotice(deps, task, { maxWakes: 20, maxBytes: 20_000 });
	const message = messages[0]!.message;
	expect(Buffer.byteLength(JSON.stringify({ content: message.content, details: message.details }), "utf8")).toBeLessThan(4_096);
});
