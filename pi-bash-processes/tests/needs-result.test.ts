// `needsResult:false` marks informational work: the completion is still
// reported, but nothing is owed, so the wake starts no turn, asks for no
// retrieval, and no idle review follows. Absent (the default) keeps the exit
// wake as the result signal.

import { afterAll, expect, test } from "bun:test";

import { startExtensionHost, type ExtensionHost } from "./fixtures/extension-host.js";

const host: ExtensionHost = await startExtensionHost({ settings: { exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const bgTask = () => host.tools.get("bg_task")!;
const details = (message: unknown) => (message as { details?: { eventType?: string; grouped?: boolean } }).details;
const exits = () => host.messages.filter(([message]) => details(message)?.eventType === "exit" || details(message)?.grouped === true);
const reviews = () => host.messages.filter(([message]) => details(message)?.eventType === "result-review");
const RETRIEVAL = 'bg_task action:\\"get\\"';

async function until(predicate: () => boolean, budgetMs = 5_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
}

async function finished(command: string, needsResult?: boolean): Promise<string> {
	const spawned = await bgTask().execute("spawn", {
		action: "spawn",
		command,
		...(needsResult === undefined ? {} : { needsResult }),
	});
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	return id;
}

test("an informational completion is reported without asking for the result or starting a turn", async () => {
	await host.settle();
	const before = exits().length;
	const id = await finished("printf 'smoke\\n'", false);
	await until(() => exits().length > before);

	const [message, options] = exits()[before]!;
	expect(JSON.stringify(message), "its completion is still reported").toContain(id);
	expect(JSON.stringify(message), "no retrieval is asked for").not.toContain(RETRIEVAL);
	expect(options, "it does not start a turn of its own").toMatchObject({ deliverAs: "steer", triggerTurn: false });
	await bgTask().execute("cleanup", { action: "get", id });
});

test("the default still delivers the result and can start a turn", async () => {
	await host.settle();
	const before = exits().length;
	const id = await finished("printf 'result\\n'");
	await until(() => exits().length > before);

	const [message, options] = exits()[before]!;
	expect(JSON.stringify(message), "the result is the point of the wake").toContain(RETRIEVAL);
	expect(options).toMatchObject({ deliverAs: "steer", triggerTurn: true });
	await bgTask().execute("cleanup", { action: "get", id });
});

test("an informational result never gets the idle review advisory", async () => {
	await host.settle();
	const id = await finished("printf 'tail\\n'", false);
	await Bun.sleep(300);
	const before = reviews().length;

	await host.dispatch("before_agent_start");
	await host.settle();
	expect(reviews().length, "nothing is owed, so nothing is reminded").toBe(before);
	await bgTask().execute("cleanup", { action: "get", id });
});

test("the flag persists, so a restart still knows the result is not owed", async () => {
	const id = await finished("printf 'restart\\n'", false);
	await host.dispatch("session_start");
	const task = (await host.listTasks()).find((candidate) => candidate.id === id);
	expect(task?.needsResult, "a restart cannot silently turn informational work into an owed result").toBe(false);
	await bgTask().execute("cleanup", { action: "get", id });
});
