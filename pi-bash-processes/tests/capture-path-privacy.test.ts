import { afterAll, expect, test } from "bun:test";

import { startExtensionHost, type HostTool } from "./fixtures/extension-host.js";

// The capture file is an operator detail. Every surface the model reads — a
// spawn/list/get/log/stop result, the task-surface guidance, and each wake — must
// describe the result without naming a filesystem location the model has no
// sanctioned way to open. This asserts against the assembled texts rather than
// the source, so a path can only reappear by actually reaching a model-facing
// string.
const host = await startExtensionHost({ settings: { exitWakeBatchMs: 0 } });
afterAll(() => host.dispose());

const bgTask = (): HostTool => host.tools.get("bg_task")!;

const textOf = (result: { content: { type: string; text?: string }[] }): string =>
	result.content.map((part) => part.text ?? "").join("\n");

const wakeTexts = (): string[] =>
	host.messages
		.map((call) => (call[0] as { content?: unknown }).content)
		.filter((content): content is string => typeof content === "string");

test("no model-facing task surface names a capture path", async () => {
	const spawned = await bgTask().execute(
		"privacy-spawn",
		{ action: "spawn", command: "echo captured-output; sleep 30" },
		undefined,
		undefined,
		host.ctx,
	);
	const task = spawned.details.task as { id: string; logFile: string };
	const laneDir = task.logFile.slice(0, task.logFile.lastIndexOf("/"));

	const surfaces: Record<string, string> = {
		spawn: textOf(spawned),
		list: textOf(await bgTask().execute("privacy-list", { action: "list" }, undefined, undefined, host.ctx)),
		// A running read, so the surface that carries a live capture is included.
		log: textOf(await bgTask().execute("privacy-log", { action: "log", id: task.id }, undefined, undefined, host.ctx)),
		get: textOf(await bgTask().execute("privacy-get", { action: "get", id: task.id }, undefined, undefined, host.ctx)),
		stop: textOf(await bgTask().execute("privacy-stop", { action: "stop", id: task.id }, undefined, undefined, host.ctx)),
		guidance: [bgTask().description, bgTask().promptSnippet, ...(bgTask().promptGuidelines ?? [])].join("\n"),
	};

	for (const [surface, text] of Object.entries(surfaces)) {
		expect(text, `${surface} does not name the capture file`).not.toContain(task.logFile);
		expect(text, `${surface} does not name the capture directory`).not.toContain(laneDir);
	}
});

test("a completion wake reports the result without naming its capture", async () => {
	const spawned = await bgTask().execute(
		"privacy-wake",
		{ action: "spawn", command: "echo wake-captured" },
		undefined,
		undefined,
		host.ctx,
	);
	const task = spawned.details.task as { id: string; logFile: string };
	await host.settledTask(task.id, 30_000);

	const wakes = wakeTexts().filter((content) => content.includes(task.id));
	expect(wakes.length, "the completion wake reached the agent").toBeGreaterThan(0);
	for (const content of wakes) {
		expect(content, "the wake does not name the capture file").not.toContain(task.logFile);
		expect(content, "the wake reports the task's outcome").toContain(task.id);
	}
});
