import { afterAll, expect, test } from "bun:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { BASH_OUTPUT_SCHEMA, STRUCTURED_OUTPUT_MAX_BYTES, structuredOutputOmittedMarker } from "../extensions/managed-bash.js";
import { startExtensionHost, type HostTool } from "./fixtures/extension-host.js";

// The replacement bash tool's machine-readable result. Pi 0.99 hands
// `structuredContent` to programmatic callers (a codemode script, for example)
// in place of the text, so the declared `outputSchema` is a contract with those
// callers, and a completed command has to satisfy it. Commands here finish
// inside the production foreground window; the yield contract itself lives in
// codemode-bash.test.ts, which runs with a window a command can outlive.
const host = await startExtensionHost();
afterAll(() => host.dispose());

const bash = (): HostTool => host.tools.get("bash")!;

interface JsonSchema {
	type?: string;
	required?: string[];
	properties: Record<string, { type?: string }>;
}

/**
 * The declared schema, checked against a value the way a caller reads it:
 * every required field present, every present field the declared type, and
 * nothing the schema does not declare.
 */
function expectMatchesSchema(schema: JsonSchema, value: Record<string, unknown>): void {
	for (const key of schema.required ?? []) expect(key in value, `missing required field ${key}`).toBe(true);
	for (const [key, property] of Object.entries(schema.properties)) {
		if (!(key in value)) continue;
		const expected = property.type === "number" ? "number" : property.type === "boolean" ? "boolean" : "string";
		expect(typeof value[key], `${key} type`).toBe(expected);
	}
	for (const key of Object.keys(value)) expect(Object.keys(schema.properties), `undeclared field ${key}`).toContain(key);
}

test("bash declares Pi's built-in bash outputSchema", () => {
	const builtIn = JSON.parse(JSON.stringify(createBashToolDefinition(host.cwd).outputSchema)) as JsonSchema;
	expect(JSON.parse(JSON.stringify(BASH_OUTPUT_SCHEMA))).toEqual(builtIn);
	expect(JSON.parse(JSON.stringify(bash().outputSchema)), "the registered tool declares it").toEqual(builtIn);
});

test("a completed command returns the text the model reads and a matching structured result", async () => {
	const result = await bash().execute("structured-1", { command: "echo hi" }, undefined, undefined, host.ctx);
	expect(result.content[0]?.text).toBe("hi\n");
	expect(result.structuredContent).toEqual({
		output: "hi\n",
		truncated: false,
		exit_code: 0,
		wall_time_seconds: expect.any(Number),
	});
	expectMatchesSchema(BASH_OUTPUT_SCHEMA as unknown as JsonSchema, result.structuredContent!);

	// Field-for-field parity with what Pi's own bash tool reports for the same
	// command, so a caller written against either bash reads the same value.
	const builtIn = await createBashToolDefinition(host.cwd).execute("structured-pi", { command: "echo hi" }, undefined, undefined, host.ctx as never);
	const piStructured = builtIn.structuredContent as Record<string, unknown>;
	expect(result.structuredContent!.output).toBe(piStructured.output);
	expect(result.structuredContent!.truncated).toBe(piStructured.truncated);
	expect(result.structuredContent!.exit_code).toBe(piStructured.exit_code);
	expect(typeof piStructured.wall_time_seconds).toBe("number");
});

test("output past the structured cap keeps its head and tail around an omission marker", async () => {
	// Far more than the cap, and through no read shim: `head`/`tail` are wrapped
	// in a managed bash environment.
	const result = await bash().execute("structured-2", { command: "seq 1 400000" }, undefined, undefined, host.ctx);
	const structured = result.structuredContent!;
	expect(structured.truncated).toBe(true);
	expect(structured.exit_code).toBe(0);
	expectMatchesSchema(BASH_OUTPUT_SCHEMA as unknown as JsonSchema, structured);
	expect(structured.output.startsWith("1\n2\n3\n"), "head kept").toBe(true);
	expect(structured.output.endsWith("400000\n"), "tail kept").toBe(true);
	// The structured result names no file: `structuredContent` is model-facing (a
	// codemode script reads it in place of the text), and the only file holding
	// the complete output is the task capture. The capture path stays an operator
	// detail (`details.task.logFile`), and the complete output is reached through
	// the declared `bg_task` operations.
	expect(structured).not.toHaveProperty("full_output_path");
	const logFile = (result.details.task as { logFile: string }).logFile;
	expect(logFile, "the operator detail keeps the path").toBeString();
	const bytes = statSync(logFile).size;
	expect(bytes).toBeGreaterThan(STRUCTURED_OUTPUT_MAX_BYTES);
	for (const [surface, value] of Object.entries({
		structured: JSON.stringify(structured),
		text: result.content[0]?.text ?? "",
	})) {
		expect(value, `${surface} names no capture path`).not.toContain(logFile);
		expect(value, `${surface} names no lane directory`).not.toContain(logFile.slice(0, logFile.lastIndexOf("/")));
	}
	// The kept head and tail plus the marker are the whole cap.
	const marker = structuredOutputOmittedMarker(bytes - STRUCTURED_OUTPUT_MAX_BYTES);
	expect(structured.output).toContain(marker);
	expect(Buffer.byteLength(structured.output, "utf8")).toBe(STRUCTURED_OUTPUT_MAX_BYTES + Buffer.byteLength(marker));
	// Field-for-field parity with Pi's own bash on the same command, marker and
	// split included, so a caller sees the same `output` from either bash.
	const pi = (await createBashToolDefinition(host.cwd).execute("structured-pi-2", { command: "seq 1 400000" }, undefined, undefined, host.ctx as never)).structuredContent as {
		output: string;
		truncated: boolean;
	};
	expect(pi.truncated).toBe(true);
	expect(structured.output).toBe(pi.output);
	// The model-facing text is the bounded tail of the same output.
	expect(result.content[0]?.text).not.toContain("bytes omitted");
});

// A command that ended without an exit code is a termination failure, not a
// success with a code of zero.
test("a signal-killed command reports the termination failure and no structured result", async () => {
	await expect(bash().execute("structured-4", { command: "echo before; kill -9 $$" }, undefined, undefined, host.ctx)).rejects.toThrow(
		/before\n+Command terminated without an exit code/,
	);
	// Pi's own bash reports the same command as a failure too: its local shell
	// converts the signal death to 128+SIGKILL, which is why it never reaches the
	// missing-exit-code branch. Neither bash reports a signal death as success,
	// which is the property a programmatic caller depends on.
	const pi = await createBashToolDefinition(host.cwd).execute("structured-pi-4", { command: "echo before; kill -9 $$" }, undefined, undefined, host.ctx as never);
	expect(pi.isError).toBe(true);
	expect((pi.structuredContent as { exit_code: number }).exit_code).toBe(137);
});
