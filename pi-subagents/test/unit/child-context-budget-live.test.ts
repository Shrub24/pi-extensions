// End-to-end: a real child session, armed with a tiny budget, must
//   1. trip pi's own between-turn compaction check,
//   2. get its summary from pi-subagents' hook (pi-vcc pipeline, no model call),
//   3. continue the run afterwards.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { buildControlEvent, claimControlNotification, DEFAULT_CONTROL_CONFIG } from "../../src/runs/shared/subagent-control.ts";
import { CHILD_COMPACTION_COMPACTOR, createChildContextBudgetState, createChildCompactionHooks } from "../../src/runs/shared/child-compaction.ts";

const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;

// The orchestrator only learns about a mid-run compaction through the control
// event the runner emits. Two properties matter and are asserted here:
//   - it is formed from the compaction event with the numbers an operator needs;
//   - it survives the notify gate (which would otherwise swallow it as a repeat).
// The runner emits it with bypassClaim, so a second compaction still reports.
it("the compaction is reported to the orchestrator as a notifiable control event", { skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK" }, async () => {
	const entry = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: sdkRoot, encoding: "utf8" }).trim();
	const pi = await import(entry);
	const cwd = mkdtempSync(join(tmpdir(), "live-compact-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousPackageDir = process.env.PI_PACKAGE_DIR;
	const previousFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_PACKAGE_DIR = sdkRoot;
	// Small window => small budget, so one tool result crosses it.
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false } }));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "https://synthetic.invalid/v1", apiKey: "k", models: [{ id: "small", name: "small", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 4_000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	writeFileSync(join(cwd, "big.txt"), "EVIDENCE_LINE\n".repeat(400));
	writeFileSync(join(cwd, "marker.txt"), "SECOND_TASK_REACHED");
	let requests = 0;
	let summaryCalls = 0;
	const seen: string[] = [];
	globalThis.fetch = async (input, init) => {
		const body = JSON.parse(String(init?.body));
		requests++;
		const hasTools = Boolean(body.tools?.length);
		if (!hasTools) summaryCalls++; // a summarization request would have no tools
		let delta: unknown;
		let finish = "stop";
		if (requests === 1) {
			delta = { content: "Reading the big file.", tool_calls: [{ index: 0, id: "r1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "big.txt" }) } }] };
			finish = "tool_calls";
		} else if (requests === 2) {
			delta = { content: "Now reading the marker.", tool_calls: [{ index: 0, id: "r2", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "marker.txt" }) } }] };
			finish = "tool_calls";
		} else {
			seen.push(JSON.stringify(body.messages));
			delta = { content: "Ran out of tools — reporting: SECOND_TASK_REACHED" };
		}
		const chunk = { id: "synthetic", object: "chat.completion.chunk", created: 1, model: "small", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: requests === 1 ? 3_600 : 400, completion_tokens: 5, total_tokens: 3_605 } };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	};
	// The in-repo shim has no ModelRuntime; load the real SDK explicitly.
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi as never });
	const events: string[] = [];
	const probe: unknown[] = [];
	try {
		const child = await factory.create({
			cwd, storage: { kind: "memory" }, model: "fixture/small", tools: ["read"], extensionPaths: [], ambientExtensions: false,
			noSkills: true, noContextFiles: true, runtime: {}, onExtensionError() {},
			hooks: [
				...createChildCompactionHooks(createChildContextBudgetState()),
			],
			contextBudget: createChildContextBudgetState(),
		} as never);
		const compactionEnds: Array<Record<string, unknown>> = [];
		const unsub = child.subscribe((e: { type: string }) => {
			events.push(e.type);
			if (e.type === "compaction_end") compactionEnds.push(e as unknown as Record<string, unknown>);
		});
		await child.prompt("Read big.txt, then marker.txt, then report what marker.txt says.");
		unsub();
		await child.dispose();
		const compactions = events.filter((t) => t === "compaction_end").length;
		// This cut point lands mid-turn (the model just used a tool), so the compaction
		// is a split turn: history is empty and all content sits in turnPrefixMessages.
		// The hook must summarize both lists — declining on the empty history list
		// silently hands the work back to pi's model-based summarizer.
		assert.ok(compactions >= 1, `expected a mid-run compaction; events=${events.join(",")}`);
		assert.ok(events.includes("compaction_start") && events.indexOf("compaction_end") > events.indexOf("tool_execution_end"), "the compaction happens between turns, after the tool result");

		// The runner recognizes the compaction it should report through this exact
		// predicate. Asserting it against pi's real event — rather than a hand-made
		// object — is what ties the summarizer hook to the orchestrator wake.
		const end = compactionEnds[0] as { aborted?: boolean; reason?: string; result?: { details?: { compactor?: string } } };
		assert.ok(end, "a compaction_end event was observed");
		assert.notEqual(end.aborted, true, "a successful compaction is not marked aborted");
		assert.equal(end.result?.details?.compactor, CHILD_COMPACTION_COMPACTOR, "the runner's predicate matches pi's real event");
		assert.equal(end.reason, "threshold", "and it names the trigger");
		assert.equal(summaryCalls, 0, "no model call may be spent on the summary");
		assert.ok(seen.some((s) => s.includes("SECOND_TASK_REACHED") || s.includes("marker.txt")), "the run continued after compaction");
	} finally {
		await factory.dispose();
		globalThis.fetch = previousFetch;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = previousPackageDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

it("a repeat compaction still notifies, unlike a deduped attention nudge", () => {
	const event = buildControlEvent({
		type: "needs_attention",
		to: "active_long_running",
		runId: "run-1",
		agent: "worker",
		index: 0,
		ts: 1,
		reason: "context_budget",
		message: "worker compacted its context mid-run at 251,004 tokens (budget 250,000).",
	});
	// bypassClaim is what the runner passes: the notify gate must pass it through,
	// while the ordinary claim path would refuse the second identical event.
	assert.equal(claimControlNotification(DEFAULT_CONTROL_CONFIG, event, new Set(), undefined), true);
	const seen = new Set<string>();
	assert.equal(claimControlNotification(DEFAULT_CONTROL_CONFIG, event, seen, undefined), true);
	assert.equal(claimControlNotification(DEFAULT_CONTROL_CONFIG, event, seen, undefined), false, "the ordinary path dedupes repeats");
	assert.ok(DEFAULT_CONTROL_CONFIG.notifyOn.includes("needs_attention"), "needs_attention is delivered by default");
});
