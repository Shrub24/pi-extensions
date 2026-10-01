import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LOG_TAIL_MAX_CHARS as cap } from "../extensions/constants.js";
import type { BackgroundTaskSnapshot, BackgroundLogTruncation } from "../extensions/types.js";
import { WAKE_MANIFEST_FIELD_MAX_CHARS as fieldCap } from "../extensions/wake-events.js";
import { privateLogRoot } from "./fixtures/log-settings.js";
import { SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

const logFile = "/tmp/kendex-pi-bg/bg-log-1-1700000000000.log";
const marker = "retained log tail\n";
const tail = marker + "z".repeat(cap - marker.length - 1) + "!";
// `bg_task action:"log"` is the retained raw-tail read; `bg_status action:"log"` is
// the compatibility surface, which routes through the same shared get operation as
// `bg_task action:"get"`. Both are transcript-bounded, and neither may advertise the
// mutable live log path as the way to read a result.
const rows = [
	{ name: "bg_task huge log and metadata", tool: "bg_task", kind: "raw-log", output: "z".repeat(cap * 3) + tail, huge: true, path: logFile },
	{ name: "bg_task long log path", tool: "bg_task", kind: "raw-log", output: "z".repeat(cap * 3) + tail, huge: true, path: "/tmp/" + "L".repeat(5_000) },
	{ name: "bg_task small output", tool: "bg_task", kind: "raw-log", output: "all good\n", huge: false, path: logFile },
	{ name: "bg_task empty output", tool: "bg_task", kind: "raw-log", output: "", huge: false, path: logFile },
	{ name: "bg_status huge log and metadata", tool: "bg_status", kind: "shared-get", output: "z".repeat(cap * 3) + tail, huge: true, path: logFile },
	{ name: "bg_status long log path", tool: "bg_status", kind: "shared-get", output: "z".repeat(cap * 3) + tail, huge: true, path: "/tmp/" + "L".repeat(5_000) },
	{ name: "bg_status small output", tool: "bg_status", kind: "shared-get", output: "all good\n", huge: false, path: logFile },
	{ name: "bg_status empty output", tool: "bg_status", kind: "shared-get", output: "", huge: false, path: logFile },
] as const;

interface ChildResult {
	result: { content: { type: string; text: string }[]; details: { action: string; task: BackgroundTaskSnapshot; fullOutputPath?: string; truncation?: BackgroundLogTruncation } };
	calls: unknown[];
}

test("registered log tool result rows", () => {
	expect.assertions(rows.length + 1);
	expect(rows.length, "registered log table must contain cases").toBeGreaterThan(0);
	const root = privateLogRoot();
	try {
		const inputs = rows.map((row) => ({
			tool: row.tool, output: row.output,
			task: {
				id: "bg-log-1", pid: 4242, logFile: row.path,
				command: row.huge ? "Q".repeat(200_000) : "echo log",
				title: row.huge ? "T".repeat(5_000) : "log",
				cwd: row.huge ? "/" + "C".repeat(5_000) : "/path/work",
				procIdent: { pid: 4242, startToken: "private-start", comm: "private-command" },
			},
		}));
		const child = spawnSync(process.execPath, [join(import.meta.dir, "fixtures", "registered-log.ts")], {
			cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_BG_TASK_DIR: join(root, "logs") },
			input: JSON.stringify(inputs), encoding: "utf8", timeout: SPAWN_FIXTURE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 2_000_000,
		});
		if (child.error) throw new Error(`registered log child spawn failed: ${child.error.message}`);
		if (child.status !== 0) throw new Error(`registered log child exited ${child.status ?? child.signal}: ${child.stderr}`);
		const results: ChildResult[] = JSON.parse(child.stdout);
		if (results.length !== rows.length) throw new Error(`registered log child returned ${results.length} rows; expected ${rows.length}`);
		for (const [index, row] of rows.entries()) {
			const { result, calls } = results[index]!;
			const task = result.details.task;
			const safePath = row.path.length <= fieldCap ? row.path : "/tmp/" + "L".repeat(fieldCap - 6) + "…";
			if (row.kind === "raw-log") {
				const text = row.huge
					? `[...truncated]\n${tail}\n\n[Background log truncated. Showing last ${cap} of ${row.output.length} character(s). The complete captured snapshot is available with bg_task action:"get" output:"full".]`
					: row.output || "(empty)";
				expect({
					content: result.content, action: result.details.action,
					task: { id: task.id, pid: task.pid, command: task.command, title: task.title, cwd: task.cwd, logFile: task.logFile },
					truncation: result.details.truncation, advertisesLiveLogPath: text.includes(row.path),
					bounded: Buffer.byteLength(JSON.stringify(result), "utf8") < 16_384,
					internalIdentity: task.procIdent, calls,
				}, row.name).toStrictEqual({
					content: [{ type: "text", text }], action: "log",
					task: { id: "bg-log-1", pid: 4242, command: row.huge ? "Q".repeat(fieldCap - 1) + "…" : "echo log", title: row.huge ? "T".repeat(fieldCap - 1) + "…" : "log", cwd: row.huge ? "/" + "C".repeat(fieldCap - 2) + "…" : "/path/work", logFile: safePath },
					advertisesLiveLogPath: false,
					truncation: row.huge ? { direction: "tail", truncated: true, shownChars: cap, totalChars: row.output.length } : undefined,
					bounded: true, internalIdentity: undefined,
					calls: [{ id: "bg-log-1", pid: null }, { outputSameTask: true }, { rememberSameTask: true }],
				});
				continue;
			}
			// The compatibility surface hands over the shared prepared result. Its
			// contract is the shared get's, so what matters here is that the raw live
			// log path is not advertised, the agent-controlled metadata stays bounded,
			// and the read is the shared acknowledgment path rather than a second one.
			const text = result.content[0]!.text;
			expect({
				action: result.details.action,
				mentionsTaskId: text.includes("bg-log-1"),
				// The rule is about model-facing prose: no text may invite a read of the
				// mutable live log. The structured task snapshot keeps `logFile` as bounded
				// machine metadata for the renderer and dashboard, which is not an
				// advertisement and is asserted separately below.
				advertisesLiveLogPath: text.includes(row.path),
				metadataLogPath: task.logFile,
				hasFullOutputPath: "fullOutputPath" in result.details,
				hasRawTailTruncation: "truncation" in result.details,
				bounded: Buffer.byteLength(JSON.stringify(result), "utf8") < 16_384,
				containsRawCommand: text.includes("Q".repeat(1_000)),
				containsRawTitle: text.includes("T".repeat(1_000)),
				containsRawCwd: text.includes("C".repeat(1_000)),
				nestedCalls: calls.filter((call) => {
					const entry = call as Record<string, unknown>;
					return entry.id != null || entry.pid != null || entry.outputSameTask != null || entry.readSameTask != null;
				}),
			}, row.name).toStrictEqual({
				action: "log",
				mentionsTaskId: true,
				advertisesLiveLogPath: false,
				metadataLogPath: safePath,
				hasFullOutputPath: false,
				hasRawTailTruncation: false,
				bounded: true,
				containsRawCommand: false,
				containsRawTitle: false,
				containsRawCwd: false,
				nestedCalls: [{ id: null, pid: 4242 }, { readSameTask: true }],
			});
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, SPAWN_FIXTURE_TIMEOUT_MS * 2);
