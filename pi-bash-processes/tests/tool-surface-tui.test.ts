import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { startExtensionHost } from "./fixtures/extension-host.js";

// Task 4.1 through the real extension: the mode the host reports on `ctx.mode`
// decides the surface the extension actually registers, read back out of the
// registry the host model exposes. `tests/tool-surface.test.ts` covers every
// mode and the allow/exclude cases against the same model; this file proves the
// extension takes that branch end to end, from `session_start` onward.
const host = await startExtensionHost({ mode: "tui", settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0 } });
afterAll(() => host.dispose());

/** Bounded harness wait; never part of the product surface. */
async function until(predicate: () => boolean, budgetMs = 15_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
}

const exitWakesFor = (id: string) =>
	host.messages.filter(([message]) => {
		const details = (message as { details?: { eventType?: string; task?: { id?: string } } })?.details;
		return details?.eventType === "exit" && details?.task?.id === id;
	});
const taskById = async (id: string) => (await host.listTasks()).find((task) => task.id === id);

test("a TUI session declares bg_task with exactly four actions and never declares bg_status", () => {
	const tools = host.allTools();
	expect(tools.map((tool) => tool.name), "bg_status is absent from the TUI registry, not inactive").not.toContain("bg_status");
	const bgTask = tools.find((tool) => tool.name === "bg_task");
	expect(bgTask?.actionEnum, "the declared action enum is the four-action surface").toStrictEqual(["spawn", "get", "stop", "list"]);
	expect(host.activeTools(), "the declared surface is what the model is given").toContain("bg_task");
	expect(host.activeTools(), "no status tool is declared to the model either").not.toContain("bg_status");
});

test("the assembled TUI prompt recommends ending the turn and names neither bg_status nor the bounded wait", () => {
	const prompt = host.systemPromptSurface();
	const text = [...prompt.availableTools, ...prompt.guidelines].join("\n");
	expect(text, "the guidance the model actually receives is non-empty").not.toBe("");
	expect(text).not.toContain("bg_status");
	expect(text).not.toContain('action:"wait"');
	expect(text, "the TUI guidance recommends the end-of-turn wake").toContain("finish the turn");
});

test("a plain read of a live capture changes no notification state", async () => {
	// Task 4.3: the retired read shims made an ordinary `cat`/`tail` an
	// acknowledgment of the completion. With them gone, reading the bytes off disk
	// while the task is STILL RUNNING must change nothing: the completion
	// obligation is still owed, and still delivered afterwards.
	const spawned = await host.tools.get("bg_task")!.execute(
		"raw-read-spawn",
		{ action: "spawn", command: "printf 'retained bytes\\n'; sleep 1" },
		undefined,
		undefined,
		host.ctx,
	);
	const id = (spawned.details.task as { id: string }).id;
	const logFile = (spawned.details.task as { logFile: string }).logFile;
	await until(() => readFileSync(logFile, "utf8").includes("retained bytes"), 10_000);

	// Read the live capture the way any shell command would, while it is live.
	expect(readFileSync(logFile, "utf8"), "the read sees the flushed bytes").toContain("retained bytes");
	expect((await taskById(id))?.status, "the task is still running when the read happens").toBe("running");

	// The read was not an acknowledgment: the completion is still owed and the
	// exit wake is still delivered, exactly once, with its result certified.
	await host.settledTask(id);
	await until(() => exitWakesFor(id).length > 0);
	expect(exitWakesFor(id), "a raw read must not consume the exit wake").toHaveLength(1);
	// Re-read AFTER the wake: the record is the one the delivered notification
	// wrote, not the earlier certified snapshot.
	const settled = await taskById(id);
	expect(
		{ status: settled?.status, exitCode: settled?.exitCode, resultReady: settled?.resultReady, exitNotified: settled?.exitNotified },
		"the terminal record still carries its one host notification",
	).toStrictEqual({ status: "completed", exitCode: 0, resultReady: true, exitNotified: true });
});
