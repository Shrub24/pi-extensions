import { afterAll, expect, test } from "bun:test";

import { startExtensionHost, type HostTool } from "./fixtures/extension-host.js";

// The declared CLI inside a real managed command. This is the feasibility gate
// for the phase: a managed command (and a managed task) has to be able to ask
// the owning session about its own background work, from a separate process,
// while the manager is still running that very command — no deadlock, no
// guessing at log paths, no contaminating the command's stdout.
const host = await startExtensionHost();
afterAll(() => host.dispose());

const bgTask = (): HostTool => host.tools.get("bg_task")!;
const bash = (): HostTool => host.tools.get("bash")!;

const bashRun = async (command: string) => {
	const run = bash().execute("managed-bash", { command }, undefined, undefined, host.ctx);
	try {
		const result = await run;
		return { exitCode: (result.structuredContent as { exit_code?: number } | undefined)?.exit_code, output: result.content[0]?.text ?? "" };
	} catch (error) {
		// Managed bash reports a failing command as a rejection carrying the
		// command's own text plus the exit code, which is what a programmatic
		// caller has to read: the failure is not a structuredContent success.
		const message = error instanceof Error ? error.message : String(error);
		const exitCode = Number(/Command exited with code (\d+)/.exec(message)?.[1] ?? NaN);
		return { exitCode, output: message };
	}
};

const spawned = (result: { details: Record<string, unknown> }) => result.details.task as { id: string };

test("a managed command can ask the session about its own task", async () => {
	const running = spawned(await bgTask().execute("managed-spawn", { action: "spawn", command: "sleep 30" }));
	const done = spawned(await bgTask().execute("managed-spawn-done", { action: "spawn", command: "printf 'alpha\\nbeta\\n'" }));
	await host.settledTask(done.id);

	// `list` names the task and its lifecycle position, and the manager answered
	// this from its own managed-bash call while both tasks were live.
	const list = await bashRun("pi-bg list");
	expect(list.exitCode).toBe(0);
	expect(list.output).toContain(`${running.id}\trunning\trunning`);
	expect(list.output).toContain(`${done.id}\tcompleted\tterminal`);

	// `get` hands over what the task produced, and nothing about where the log
	// lives: the mutable log is the manager's business, not the caller's.
	const get = await bashRun(`pi-bg get ${done.id}`);
	expect(get.exitCode).toBe(0);
	expect(get.output).toContain("alpha\nbeta\n");
	expect(get.output).not.toContain(".log");

	// The result split is real: stdout is the task's own bytes, so a managed
	// command can pipe or snapshot it without scraping `kendex:` metadata out.
	const stdoutOnly = await bashRun(`pi-bg get ${done.id} 2>/dev/null`);
	expect({ exitCode: stdoutOnly.exitCode, output: stdoutOnly.output }).toEqual({ exitCode: 0, output: "alpha\nbeta\n" });
	const stderrOnly = await bashRun(`pi-bg get ${done.id} 1>/dev/null`);
	expect(stderrOnly.exitCode).toBe(0);
	expect(stderrOnly.output).toContain(`kendex: task=${done.id}`);
	expect(stderrOnly.output).toContain("kendex: readiness=terminal");
	// Metadata is a one-line-per-field protocol: the command is echoed escaped,
	// so no field can inject a line into the caller's stderr stream.
	expect(stderrOnly.output).toContain("kendex: command=printf 'alpha\\nbeta\\n'");
	expect(stderrOnly.output, "no task output leaks into the metadata stream").not.toContain("alpha\nbeta\n");

	// An unknown id is an outcome, not an empty success.
	const missing = await bashRun("pi-bg get bg-does-not-exist");
	expect(missing.exitCode).toBe(1);
	expect(missing.output).toContain("code=unknown-task");

	const stop = await bgTask().execute("managed-stop", { action: "stop", id: running.id });
	expect(stop.details.task).toBeDefined();
});

test("a managed task can query the endpoint while it runs, and still complete", async () => {
	// The task's own command calls the CLI. If the manager could not answer
	// while holding the task, this command would block until its deadline and
	// come back as a failure instead of a result.
	const target = spawned(await bgTask().execute("managed-target", { action: "spawn", command: "printf 'gamma\\n'" }));
	await host.settledTask(target.id);

	const query = spawned(await bgTask().execute("managed-query", { action: "spawn", command: `pi-bg get ${target.id} && pi-bg list` }));
	const waited = await bgTask().execute("managed-wait", { action: "wait", id: query.id, waitSeconds: 20 }, undefined, undefined, host.ctx);
	const text = waited.content[0]?.text ?? "";
	expect(text, "the querying task finished instead of being cut off").toContain(query.id);
	const record = (await host.listTasks()).find((candidate) => candidate.id === query.id);
	expect({ status: record?.status, exitCode: record?.exitCode }).toEqual({ status: "completed", exitCode: 0 });

	const log = await bgTask().execute("managed-log", { action: "log", id: query.id });
	const logText = log.content[0]?.text ?? "";
	// The task read the target's bytes through the CLI, and listed itself.
	expect(logText).toContain("gamma\n");
	expect(logText).toContain(`kendex: task=${target.id}`);
	expect(logText).toContain(query.id);
});
