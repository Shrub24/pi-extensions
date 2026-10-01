import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";

// The real output-policy module, reached the way the host reaches it. The policy
// is the component that shortens what the model reads, so the artifact contract
// can only be checked against it for real: a stub would prove nothing about
// whether the handed-off output and its reference survive what actually runs.
import { processContent } from "../../pi-output-policy/extensions/output-policy.ts";
import { startExtensionHost, type HostTool } from "./fixtures/extension-host.js";

// Managed foreground completion must preserve the *complete* output before any
// inline bound applies, and the reference a caller follows must keep resolving
// to those complete bytes after output-policy has shortened the model-visible
// text. Losing the tail of the text is a bounded preview; losing the reference —
// or the bytes behind it — is losing the result.
const host = await startExtensionHost();
afterAll(() => host.dispose());

const bash = (): HostTool => host.tools.get("bash")!;
const bgTask = (): HostTool => host.tools.get("bg_task")!;

const FIRST = "FIRST-MARKER-KEPT-IN-THE-ARTIFACT";
const LAST = "LAST-MARKER-KEPT-IN-THE-ARTIFACT";
// Comfortably past the 1 MiB structured cap and the inline read bound, so both
// the bounded inline text and the full-output reference are exercised.
const BIG_COMMAND = `echo ${FIRST}; for i in $(seq 1 40000); do echo "line-$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; done; echo ${LAST}`;

const artifacts = new Set<string>();
afterAll(() => {
	for (const path of artifacts) rmSync(path, { force: true });
});

const runManaged = async (command: string) => bash().execute(`policy-${Math.random().toString(36).slice(2)}`, { command }, undefined, undefined, host.ctx);

test("a managed foreground completion preserves the complete output before any inline bound", async () => {
	const result = await runManaged(BIG_COMMAND);
	const inline = result.content[0]?.text ?? "";
	const logFile = (result.details.task as { logFile: string }).logFile;
	const structured = result.structuredContent as { output: string; truncated: boolean; full_output_path?: string; exit_code: number };

	// The complete output reached the task log before the inline text was bounded:
	// both ends of a capture far larger than the inline text are on disk.
	const captured = readFileSync(logFile, "utf8");
	expect(captured.length).toBeGreaterThan(1_000_000);
	expect(captured).toContain(FIRST);
	expect(captured).toContain(LAST);
	expect(statSync(logFile).size).toBe(Buffer.byteLength(captured, "utf8"));

	// The inline text is the bounded tail of that capture, not the whole of it.
	expect(inline.length).toBeLessThan(captured.length);
	expect(Buffer.byteLength(inline, "utf8")).toBeLessThanOrEqual(1_000_000);
	expect(inline, "the inline text keeps the end of the output").toContain(LAST);
	expect(inline, "the inline text is bounded, so it does not carry the whole capture").not.toContain(FIRST);

	// The structured result carries the head and the tail around an explicit
	// omission, and names where the complete output is.
	expect(structured.truncated).toBe(true);
	expect(structured.output).toContain(FIRST);
	expect(structured.output).toContain(LAST);
	expect(structured.exit_code).toBe(0);
	expect(structured.full_output_path).toBe(logFile);

	// Reading the reference yields every byte the command produced.
	expect(readFileSync(structured.full_output_path!, "utf8")).toBe(captured);
});

test("output-policy truncation leaves the handed-off artifact and its reference intact", async () => {
	const result = await runManaged(BIG_COMMAND);
	const logFile = (result.details.task as { logFile: string }).logFile;
	const structured = result.structuredContent as { full_output_path?: string };
	const captured = readFileSync(logFile, "utf8");

	// The policy truncates the model-visible text. What it must not do is touch
	// what the caller follows to reach the complete output.
	const processed = await processContent(
		{ input: { command: BIG_COMMAND }, toolName: "bash", toolCallId: "policy-artifact-1" },
		host.ctx,
		result.content as { type: "text"; text: string }[],
		{ enabled: true, inlineTailKb: 4, inlineTailLines: 40, maxLineCount: 40, maxTextBlockKb: 4, preserveFullOutput: true, spillThresholdKb: 4 },
	);
	expect(processed.changed, "the policy shortened the model-visible text").toBe(true);
	expect(Buffer.byteLength(processed.content[0]?.text ?? "", "utf8")).toBeLessThan(Buffer.byteLength(result.content[0]!.text!, "utf8"));
	expect(processed.content[0]?.text ?? "", "the text keeps the end of the output").toContain(LAST);

	// The truncation reports where the full text went, and the task's own
	// reference is untouched by the policy.
	const meta = processed.meta as { artifactPath?: string; truncated?: boolean };
	if (meta.artifactPath) artifacts.add(meta.artifactPath);
	expect(meta.truncated).toBe(true);
	expect(structured.full_output_path, "the tool's own reference survives policy processing").toBe(logFile);
	expect(readFileSync(logFile, "utf8"), "the artifact still holds every byte").toBe(captured);
	expect(captured).toContain(FIRST);
	expect(captured).toContain(LAST);
});

test("output-policy truncation leaves a full get's artifact reference intact", async () => {
	const spawned = await bgTask().execute("policy-spawn", { action: "spawn", command: BIG_COMMAND }, undefined, undefined, host.ctx);
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id, 30_000);

	const get = await bgTask().execute("policy-get", { action: "get", id, output: "full" }, undefined, undefined, host.ctx);
	const artifact = get.details.artifact as { bytes: number; path: string };
	const text = get.content[0]?.text ?? "";
	expect(text).toContain(artifact.path);
	expect(artifact.bytes).toBeGreaterThan(1_000_000);

	const processed = await processContent(
		{ toolName: "bg_task", toolCallId: "policy-artifact-2" },
		host.ctx,
		get.content as { type: "text"; text: string }[],
		{ enabled: true, inlineTailKb: 4, inlineTailLines: 40, maxLineCount: 40, maxTextBlockKb: 4, preserveFullOutput: true, spillThresholdKb: 4 },
	);
	expect(processed.changed, "the policy shortened the get result too").toBe(true);

	// The shortened text is no longer where the reference lives: the tool's own
	// details carry it, and the artifact behind it is still the complete capture.
	expect(get.details.fullOutputPath).toBe(artifact.path);
	expect(statSync(artifact.path).size).toBe(artifact.bytes);
	expect(readFileSync(artifact.path, "utf8")).toContain(LAST);

	await bgTask().execute("policy-clear", { action: "stop", id }, undefined, undefined, host.ctx);
});
