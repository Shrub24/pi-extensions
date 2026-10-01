import { afterAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isCodemodeCall } from "../extensions/managed-bash.js";
import { startExtensionHost, type HostTool } from "./fixtures/extension-host.js";

// Bash a codemode script calls is not the model's bash. The script's result is
// the only thing that reaches the model, its deadline cancels whatever it
// awaited, and nothing else can deliver a wake while it holds the turn — so a
// managed task there could never report and a yielded command would be killed
// midway. These tests drive the events Pi emits for nested calls (`parentToolCallId`
// on `tool_call`, ids of the form `<parent id>/<n>`) and state that contract.
//
// One host per test file: the extension resolves its settings from the host
// environment, and a host started while another one's settings window is open
// would read the other host's file.
const host = await startExtensionHost({ settings: { foregroundYieldMs: 100 } });
afterAll(() => host.dispose());

const bash = (): HostTool => host.tools.get("bash")!;

/** The `tool_call` Pi emits for the model's own call of `toolName`. */
const modelCallsTool = async (toolCallId: string, toolName: string, input: Record<string, unknown>): Promise<unknown> =>
	(await host.dispatch("tool_call", { toolCallId, toolName, input }))[0];

/**
 * The `tool_call` Pi emits for a call a script made: `parentToolCallId` is the
 * id of the call that made it, and its own id is `<parent id>/<n>`.
 */
const scriptCallsTool = async (
	parentToolCallId: string,
	toolCallId: string,
	toolName: string,
	input: Record<string, unknown>,
): Promise<unknown> => (await host.dispatch("tool_call", { toolCallId, toolName, parentToolCallId, input }))[0];

/** A `bash` call a script made: Pi's nested `tool_call`, then the tool's execute. */
async function scriptRunsBash(
	parentToolCallId: string,
	ordinal: number,
	params: { command: string; timeout?: number },
	signal?: AbortSignal,
) {
	const toolCallId = `${parentToolCallId}/${ordinal}`;
	expect(await scriptCallsTool(parentToolCallId, toolCallId, "bash", params)).toBeUndefined();
	return bash().execute(toolCallId, params, signal, undefined, host.ctx);
}

/** Every file the extension wrote under the host's task directory. */
function taskDirFiles(dir: string = join(host.root, "logs")): string[] {
	const found: string[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...taskDirFiles(path));
		else found.push(path);
	}
	return found;
}

test("only a call attributable to a codemode script counts as one", () => {
	const known = new Set(["cm-1", "cm-1/1"]);
	// The script's call itself, and the chains a script's calls start.
	expect(isCodemodeCall(known, { toolCallId: "cm-1", toolName: "codemode" })).toBe(true);
	expect(isCodemodeCall(known, { toolCallId: "cm-1/1", toolName: "bash", parentToolCallId: "cm-1" })).toBe(true);
	expect(isCodemodeCall(known, { toolCallId: "cm-1/1/1", toolName: "bash", parentToolCallId: "cm-1/1" })).toBe(true);
	// A codemode call is one whoever made it, so a wrapper that ran one starts a
	// chain of its own.
	expect(isCodemodeCall(known, { toolCallId: "batch-1/1", toolName: "codemode", parentToolCallId: "batch-1" })).toBe(true);
	// A model-issued call, and a call a model-issued wrapper made, keep the
	// managed path: the model can receive a wake for those.
	expect(isCodemodeCall(known, { toolCallId: "top-1", toolName: "bash" })).toBe(false);
	expect(isCodemodeCall(known, { toolCallId: "batch-1/1", toolName: "bash", parentToolCallId: "batch-1" })).toBe(false);
});

test("a bash call a script made runs to completion, leaving no task, wake, or snapshot", async () => {
	await modelCallsTool("cm-complete", "codemode", { code: 'await tools.bash({ command: "sleep 0.4; echo done" })' });
	const entriesBefore = host.entries.length;
	const started = Date.now();
	const result = await scriptRunsBash("cm-complete", 1, { command: "sleep 0.4; echo done" });
	// Longer than the foreground window, yet the call returns the finished command
	// rather than a Running yield.
	expect(Date.now() - started).toBeGreaterThanOrEqual(400);
	expect(result.content[0]?.text).toBe("done\n");
	expect(result.structuredContent).toEqual({
		output: "done\n",
		truncated: false,
		exit_code: 0,
		wall_time_seconds: expect.any(Number),
	});
	expect(await host.listTasks()).toEqual([]);
	expect(taskDirFiles()).toEqual([]);
	expect(host.entries).toHaveLength(entriesBefore);
	expect(host.messages).toEqual([]);
});

test("an explicit bg_task spawn inside a script is refused before anything launches", async () => {
	await modelCallsTool("cm-block", "codemode", { code: 'await tools.bg_task({ action: "spawn", command: "sleep 30" })' });
	const blocked = (await scriptCallsTool("cm-block", "cm-block/1", "bg_task", { action: "spawn", command: "sleep 30" })) as {
		block?: boolean;
		reason?: string;
	};
	// Pi stops here: `emitToolCall` returns a blocking result before the tool
	// executes, and the script sees the reason as its call's error text.
	expect(blocked.block).toBe(true);
	expect(blocked.reason).toMatch(/not available inside codemode/);
	expect(blocked.reason).toMatch(/tools\.bash/);
	expect(await host.listTasks()).toEqual([]);
	expect(taskDirFiles()).toEqual([]);
	expect(host.messages).toEqual([]);
	// Inspection of what already runs stays available; only detached work the
	// script could not outlive is refused.
	expect(await scriptCallsTool("cm-block", "cm-block/2", "bg_task", { action: "list" })).toBeUndefined();
});

test("a wrapper a script called keeps the provenance for the calls it makes", async () => {
	// `tool_batch` stands in for any top-level wrapper that runs tools through
	// `ctx.executeTool`: the rule is about provenance, not the wrapper's name.
	await modelCallsTool("cm-chain", "codemode", { code: "await tools.tool_batch({ calls: [] })" });
	expect(await scriptCallsTool("cm-chain", "cm-chain/1", "tool_batch", { calls: [] })).toBeUndefined();
	const result = await scriptRunsBash("cm-chain/1", 1, { command: "sleep 0.4; echo chained" });
	expect(result.content[0]?.text).toBe("chained\n");
	expect(await host.listTasks()).toEqual([]);
});

test("a bash call a script made honors Pi's abort and timeout", async () => {
	await modelCallsTool("cm-signals", "codemode", { code: 'await tools.bash({ command: "sleep 30" })' });
	const timeoutStarted = Date.now();
	await expect(scriptRunsBash("cm-signals", 1, { command: "echo before; sleep 30", timeout: 1 })).rejects.toThrow(
		/Command timed out after 1 seconds/,
	);
	// The `timeout` is the hard process runtime, not a soft window.
	expect(Date.now() - timeoutStarted).toBeLessThan(10_000);

	const controller = new AbortController();
	const aborted = scriptRunsBash("cm-signals", 2, { command: "echo before; sleep 30" }, controller.signal);
	setTimeout(() => controller.abort(), 200);
	await expect(aborted).rejects.toThrow(/Command aborted/);

	// Neither call was left behind as a task or a log.
	expect(await host.listTasks()).toEqual([]);
	expect(taskDirFiles()).toEqual([]);
	expect(host.messages).toEqual([]);
});

test("top-level bash keeps the managed yield, in a wrapper too", async () => {
	const direct = await bash().execute("top-1", { command: "sleep 0.4; echo late" }, undefined, undefined, host.ctx);
	expect(direct.content[0]?.text).toMatch(/^Running bg-\d+ \(pid \d+\) after /);
	// A yielded task is not a finished command, so it has no structured result.
	expect(direct.structuredContent).toBeUndefined();

	expect(await modelCallsTool("batch-1", "tool_batch", { calls: [] })).toBeUndefined();
	expect(await scriptCallsTool("batch-1", "batch-1/1", "bash", { command: "sleep 0.4; echo late" })).toBeUndefined();
	const batched = await bash().execute("batch-1/1", { command: "sleep 0.4; echo late" }, undefined, undefined, host.ctx);
	expect(batched.content[0]?.text).toMatch(/^Running bg-\d+ \(pid \d+\) after /);

	expect((await host.listTasks()).filter((task) => task.status === "running")).toHaveLength(2);
	await host.tools.get("bg_task")!.execute("top-stop", { action: "stop", id: "all" });
});
