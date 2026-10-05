import { afterAll, expect, test } from "bun:test";

import { startExtensionHost } from "./fixtures/extension-host.js";

// The pane-facts production path through the real extension: a TUI session in
// Herdr advertises its running background tasks on its own pane, independent of
// the session's own state, and clears the keys once the last task ends. The
// gate cases live in pane-facts-gating.test.ts.
const host = await startExtensionHost({ mode: "tui" });
afterAll(async () => {
	delete process.env.HERDR_PANE_ID;
	await host.dispose();
});

/** Bounded harness wait; never part of the product surface. Fails loudly so a
 * missed write reads as an assertion, not as a later dereference of undefined. */
async function until(predicate: () => boolean, budgetMs = 10_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
	expect(predicate()).toBe(true);
}

const spawn = async (command: string): Promise<string> => {
	const result = await host.tools.get("bg_task")!.execute("pane-facts-spawn", { action: "spawn", command });
	return (result.details.task as { id: string }).id;
};

const herdrWrites = () => host.execCalls.filter(({ command }) => command === "herdr");
const clearedKeys = ({ args }: { args: string[] }) =>
	args.flatMap((arg, index) => (arg === "--clear-token" ? [args[index + 1]] : []));

test("a TUI session without a Herdr pane id publishes nothing", async () => {
	delete process.env.HERDR_PANE_ID;
	const id = await spawn("printf 'nothing to advertise\\n'");
	await host.settledTask(id);
	expect(herdrWrites(), "no pane id means no pane write").toHaveLength(0);
	await host.tools.get("bg_task")!.execute("no-pane-get", { action: "get", id });
});

test("running tasks are advertised while the session is still working, and cleared once their results are read", async () => {
	process.env.HERDR_PANE_ID = "pane-facts-test";
	// The session is mid-turn: publication must not wait for it to stop.
	await host.dispatch("agent_start");
	const first = await spawn("sleep 30 # marker-command-secret");
	await until(() => herdrWrites().some(({ args }) => args.includes("pi_bg_running=1")));

	const write = herdrWrites().find(({ args }) => args.includes("pi_bg_running=1"))!;
	expect(write.args.slice(0, 7), "the pane, source and TTL are the contract").toStrictEqual([
		"pane",
		"report-metadata",
		"pane-facts-test",
		"--source",
		"pi-bash-processes",
		"--ttl-ms",
		"30000",
	]);
	expect(write.args, "the primary fact is the running count").toContain("pi_bg_running=1");
	expect(write.args, "the task's own id is listed").toContain(`pi_bg_tasks=${first}:running`);
	expect(write.args.some((arg) => arg.startsWith("pi_bg_started=")), "the oldest start is dated").toBe(true);
	expect(
			herdrWrites().flatMap(({ args }) => args).some((arg) => arg.includes("marker-command-secret")),
		"no command text ever reaches a published value",
	).toBe(false);
	expect(clearedKeys(write), "a live task publishes, never clears").toHaveLength(0);

	const second = await spawn("sleep 30");
	await until(() => herdrWrites().some(({ args }) => args.includes("pi_bg_running=2")));
	const both = herdrWrites().find(({ args }) => args.includes("pi_bg_running=2"))!;
	expect(both.args).toContain(`pi_bg_tasks=${first}:running,${second}:running`);

	await host.tools.get("bg_task")!.execute("pane-facts-stop", { action: "stop", id: "all" });
	// An exited task whose result has not been read is still outstanding: it
	// keeps its id as `flushing` and then `review`, and only the running count
	// drops. Clearing is the result being read, not the process ending.
	const bothReview = ({ args }: { args: string[] }) =>
		args.includes("pi_bg_running=0") && args.some((arg) => arg.includes(`${first}:review`)) && args.some((arg) => arg.includes(`${second}:review`));
	await until(() => herdrWrites().some(bothReview));
	expect(clearedKeys(herdrWrites().find(bothReview)!), "an unread result is advertised, never cleared").toHaveLength(0);

	await host.tools.get("bg_task")!.execute("pane-facts-get-first", { action: "get", id: first });
	await host.tools.get("bg_task")!.execute("pane-facts-get-second", { action: "get", id: second });
	await until(() => herdrWrites().some(({ args }) => clearedKeys({ args }).length === 3));
	const cleared = herdrWrites().filter(({ args }) => clearedKeys({ args }).length === 3).pop()!;
	expect(clearedKeys(cleared), "exactly the three owned keys are cleared, and nothing is left published").toStrictEqual([
		"pi_bg_running",
		"pi_bg_tasks",
		"pi_bg_started",
	]);
	expect(cleared.args, "a clear carries no value").not.toContain("--token");
});
