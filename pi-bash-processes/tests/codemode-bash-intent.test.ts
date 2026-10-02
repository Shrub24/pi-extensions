import { afterAll, expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { startExtensionHost, type HostTool } from "./fixtures/extension-host.js";

// The intent argument with `intentMode: "required"`.
//
// The schema carries `intent` as an optional property for every caller: a call a
// codemode script makes is composed by the script, so a required JSON-schema
// property would fail it before any hook could decide. The required policy is
// enforced per call instead, by `installIntentGuard`: a model-issued call that
// omits the intent is refused with guidance, and a call another tool made
// (`parentToolCallId` — a script's bash, a wrapper's item) is exempt.
//
// The host carries the tool renderer's own package config because that is where
// `intentMode` is read, and the schema is built when the extension registers its
// tools. One host per test file, as the fixture requires.
const host = await startExtensionHost({
	packageConfig: { "@vanillagreen/pi-tool-renderer": { intentMode: "required" } },
});
afterAll(() => host.dispose());

const bash = (): HostTool => host.tools.get("bash")!;

/** The `tool_call` Pi emits for a call a codemode script made. */
const scriptCallsTool = async (toolCallId: string, toolName: string, input: Record<string, unknown>): Promise<unknown> =>
	(await host.dispatch("tool_call", { toolCallId, toolName, parentToolCallId: toolCallId.split("/")[0], input }))[0];

/** The `tool_call` Pi emits for the model's own call of `toolName`. */
const modelCallsTool = async (toolCallId: string, toolName: string, input: Record<string, unknown>): Promise<unknown> =>
	(await host.dispatch("tool_call", { toolCallId, toolName, input }))[0];

/** The refusal among one `tool_call` dispatch's handler results, if any. */
async function refusalFor(event: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined> {
	const results = (await host.dispatch("tool_call", event)) as ({ block?: boolean; reason?: string } | undefined)[];
	return results.find((result) => result?.block === true);
}

/**
 * Pi's own validation of one call, the step the agent loop runs before it emits
 * `tool_call` (see `validateToolArguments` in `@earendil-works/pi-ai`).
 */
function validate(tool: HostTool, args: Record<string, unknown>): unknown {
	return validateToolArguments(
		{ name: tool.name, parameters: tool.parameters } as never,
		{ id: "validate", name: tool.name, arguments: args } as never,
	);
}

test("required intent is an optional schema property, so a nested call still validates", () => {
	const parameters = bash().parameters as { required: string[]; properties: Record<string, unknown> };
	expect(parameters.required).not.toContain("intent");
	expect(Object.keys(parameters.properties)).toContain("intent");

	// What a codemode script composes reaches Pi's validation: it passes without
	// an intent, because the script — not the model — wrote these arguments.
	expect(validate(bash(), { command: "echo hi" })).toMatchObject({ command: "echo hi" });
	// The intent the model writes is still accepted, and still reaches the tool
	// only as far as `intentPrepare` strips it.
	expect(validate(bash(), { command: "echo hi", intent: "check the build" })).toMatchObject({ command: "echo hi", intent: "check the build" });
});

test("a model-issued bash call without its required intent is refused with guidance", async () => {
	const refused = await refusalFor({ toolCallId: "top-missing", toolName: "bash", input: { command: "echo hi" } });
	expect(refused?.block).toBe(true);
	// The refusal names the argument to add and the exemption, and the command
	// never ran: no task, log, or wake exists.
	expect(refused?.reason).toMatch(/missing its required "intent"/);
	expect(refused?.reason).toMatch(/\{ "intent": /);
	expect(refused?.reason).toMatch(/another tool makes are exempt/);
	expect(await host.listTasks()).toEqual([]);
});

test("a model-issued bash call that supplies the intent passes the guard", async () => {
	const refused = await refusalFor({ toolCallId: "top-intent", toolName: "bash", input: { command: "echo hi", intent: "check the build" } });
	expect(refused).toBeUndefined();
});

test("a script's bash call needs no intent and keeps the codemode foreground path", async () => {
	await modelCallsTool("cm-plain", "codemode", { code: 'await tools.bash({ command: "sleep 0.3; echo scripted" })' });
	// The call Pi validated, args as the nested runner hands them to the tool.
	const args = { command: "sleep 0.3; echo scripted" };
	expect(validate(bash(), args)).toMatchObject(args);
	expect(await scriptCallsTool("cm-plain/1", "bash", args)).toBeUndefined();
	const result = await bash().execute("cm-plain/1", args, undefined, undefined, host.ctx);
	// Nothing was refused and nothing was managed: the script got the finished
	// command's own structured result.
	expect(result.content[0]?.text).toBe("scripted\n");
	expect(result.structuredContent).toEqual({
		output: "scripted\n",
		truncated: false,
		exit_code: 0,
		wall_time_seconds: expect.any(Number),
	});
	expect(await host.listTasks()).toEqual([]);
	expect(host.messages).toEqual([]);
});

test("a wrapper a script called keeps the exemption for the calls it makes", async () => {
	// `tool_batch` stands in for any tool that runs tools: its own call was made
	// by the script, and the bash it runs carries `parentToolCallId` in turn.
	await modelCallsTool("cm-chain", "codemode", { code: "await tools.tool_batch({ calls: [] })" });
	expect(await scriptCallsTool("cm-chain/1", "tool_batch", { calls: [] })).toBeUndefined();
	const args = { command: "sleep 0.3; echo chained" };
	expect(await refusalFor({ toolCallId: "cm-chain/1/1", toolName: "bash", parentToolCallId: "cm-chain/1", input: args })).toBeUndefined();
	const result = await bash().execute("cm-chain/1/1", args, undefined, undefined, host.ctx);
	expect(result.content[0]?.text).toBe("chained\n");
	expect(await host.listTasks()).toEqual([]);
});

test("the refused spawn is a managed-task refusal, and names the intent when required", async () => {
	// The spawn validates: the refusal below is the extension's, not Pi's.
	expect(validate(host.tools.get("bg_task")!, { action: "spawn", command: "sleep 30", intent: "start a long job" })).toMatchObject({ action: "spawn" });
	await host.dispatch("tool_call", { toolCallId: "cm-block-intent", toolName: "codemode", input: { code: "await tools.bg_task({...})" } });
	const blocked = (await scriptCallsTool("cm-block-intent/1", "bg_task", {
		action: "spawn",
		command: "sleep 30",
		intent: "start a long job",
	})) as { block?: boolean; reason?: string };
	expect(blocked.block).toBe(true);
	// What is refused is the managed task (no wake, no stop handle), not shell
	// syntax, and the alternative is foreground bash with its intent.
	expect(blocked.reason).toMatch(/one managed task, not shell syntax/);
	expect(blocked.reason).toMatch(/`await tools\.bash\(\{ command \}\)`/);
	expect(blocked.reason).toMatch(/`intent`/);
	expect(await host.listTasks()).toEqual([]);
});
