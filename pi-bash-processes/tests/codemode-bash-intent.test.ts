import { afterAll, expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { startExtensionHost, type HostTool } from "./fixtures/extension-host.js";

// The intent argument with `intentMode: "required"`: the model must state an
// intent on every bash call, and Pi enforces that in the schema before any
// `tool_call` handler runs. A codemode script is a caller like any other — it
// has to supply the intent too, which is why this contract is covered here
// rather than by relaxing the required mode for programmatic callers.
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

test("required intent mode is enforced by the schema Pi validates against", () => {
	const parameters = bash().parameters as { required: string[]; properties: Record<string, unknown> };
	expect(parameters.required).toContain("intent");
	expect(Object.keys(parameters.properties)).toContain("intent");

	// A nested bash call without an intent never reaches the extension: Pi
	// rejects it first, exactly as it does for a model-issued call.
	expect(() => validate(bash(), { command: "echo hi" })).toThrow(/Validation failed for tool "bash"/);
	expect(validate(bash(), { command: "echo hi", intent: "check the build" })).toMatchObject({ command: "echo hi" });
});

test("a script's bash call with an intent keeps the codemode foreground path", async () => {
	await host.dispatch("tool_call", { toolCallId: "cm-intent", toolName: "codemode", input: { code: "await tools.bash({...})" } });
	// The call Pi validated, args as the nested runner hands them to the tool.
	const args = { command: "sleep 0.3; echo scripted", intent: "run the scripted command" };
	expect(await scriptCallsTool("cm-intent/1", "bash", args)).toBeUndefined();
	const result = await bash().execute("cm-intent/1", args, undefined, undefined, host.ctx);
	// The intent is stripped before execution: it reached no shell and no log.
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
