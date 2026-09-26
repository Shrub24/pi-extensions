import { expect, test } from "bun:test";

import { TREND_WINDOW, conversationFacts, declaredPlan, sessionSources, toolCallLine, toolTrend, userMessageText } from "../extensions/conversation.js";
import { askFactsFrom, userIntentBlock } from "../extensions/action-pack.js";
import { fakeDetails, fakeQuery } from "./fixtures/fakes.js";

type Entry = Record<string, unknown>;

const LIMITS = {
	maxUserMessages: 2,
	maxToolCalls: 5,
	maxCharsPerString: 1_000,
	maxPlanChars: 500,
	maxToolbox: 12,
	withToolbox: true,
};

/** A conversation source over a fixed entry list. */
function sourcesWith(entries: unknown, toolbox: string[] = []) {
	return { entries: () => entries as never, toolbox: () => toolbox };
}

function message(role: string, content: unknown): Entry {
	return { type: "message", message: { role, content } };
}

test("user message text reads both content shapes", () => {
	expect(userMessageText("do the thing")).toBe("do the thing");
	expect(userMessageText([{ type: "text", text: "first" }, { type: "image", data: "x" }, { type: "text", text: "second" }])).toBe("first\nsecond");
	expect(userMessageText(undefined)).toBe("");
	expect(userMessageText(42)).toBe("");
});

test("a tool call line names the tool and the argument it acts on", () => {
	expect(toolCallLine({ type: "toolCall", name: "bash", arguments: { command: "bun test\n  --watch" } })).toBe("bash bun test --watch");
	expect(toolCallLine({ type: "toolCall", name: "read", arguments: { path: "src/x.ts", offset: 10 } })).toBe("read src/x.ts");
	expect(toolCallLine({ type: "toolCall", name: "mcp_call", arguments: { server: "cbm" } })).toBe('mcp_call {"server":"cbm"}');
	expect(toolCallLine({ type: "toolCall", name: "bash", arguments: {} })).toBe("bash");
	expect(toolCallLine({ type: "toolCall", name: "bash", arguments: { command: "y".repeat(400) } }).length).toBeLessThanOrEqual(200);
});

test("the plan is the agent's most recent visible text, never its thinking", () => {
	const entries: Entry[] = [
		message("user", "clean the build dir"),
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "I should remove it" }] } },
		message("assistant", [{ type: "text", text: "Older plan." }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }]),
		message("assistant", [{ type: "thinking", thinking: "now" }, { type: "text", text: "I will remove the stale build directory." }]),
	];
	expect(declaredPlan(entries, 500)).toBe("I will remove the stale build directory.");
	expect(declaredPlan([message("assistant", [{ type: "thinking", thinking: "only thinking" }])], 500)).toBeNull();
	expect(declaredPlan([], 500)).toBeNull();
	expect(declaredPlan([message("user", "hi")], 500)).toBeNull();
	const long = declaredPlan([message("assistant", [{ type: "text", text: "z".repeat(900) }])], 100);
	expect(long).toHaveLength(100);
});

test("the walk keeps the newest entries and nothing else", () => {
	const facts = conversationFacts(
		sourcesWith(
			[
				message("user", "first instruction"),
				{ type: "custom", customType: "whatever" },
				message("assistant", [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }]),
				message("toolResult", [{ type: "text", text: "output that must not be collected" }]),
				message("user", [{ type: "text", text: "second instruction" }]),
				message("assistant", [
					{ type: "toolCall", name: "bash", arguments: { command: "bun test" } },
					{ type: "toolCall", name: "edit", arguments: { path: "b.ts" } },
				]),
			],
			["grep: search contents", "semble: semantic search"],
		),
		LIMITS,
	);
	expect(facts.userMessages).toEqual(["first instruction", "second instruction"]);
	expect(facts.recentToolCalls).toEqual(["read a.ts", "bash bun test", "edit b.ts"]);
	expect(facts.toolbox).toEqual(["grep: search contents", "semble: semantic search"]);
	expect(facts.declaredPlan).toBeNull();

	const trimmed = conversationFacts(
		sourcesWith([message("user", "old"), message("user", "new"), message("assistant", [{ type: "toolCall", name: "ls", arguments: { path: "." } }])]),
		{ ...LIMITS, maxUserMessages: 1, maxToolCalls: 0 },
	);
	expect(trimmed.userMessages).toEqual(["new"]);
	expect(trimmed.recentToolCalls).toEqual([]);
});

test("the trend counts what the recent calls add up to", () => {
	const call = (name: string, args: Record<string, unknown>) => message("assistant", [{ type: "toolCall", name, arguments: args }]);
	const entries = [
		message("user", "find the retry logic"),
		call("bash", { command: "rg retryBackoff src/" }),
		call("bash", { command: "grep -rn 'apiKey' src/extensions/" }),
		call("bash", { command: "rg TIMEOUT /nix/store/abc/lib" }),
		call("bash", { command: "git grep -n registry" }),
		call("bash", { command: "ls -la ~/.cache" }),
		call("grep", { pattern: "retry" }),
		call("edit", { path: "src/a.ts" }),
		call("read", { path: "src/b.ts" }),
	];
	const facts = conversationFacts(sourcesWith(entries), LIMITS);
	expect(facts.toolTrend).toEqual({
		window: 8,
		byTool: [
			{ name: "bash", count: 5 },
			{ name: "edit", count: 1 },
			{ name: "grep", count: 1 },
			{ name: "read", count: 1 },
		],
		shellSearches: 4,
		// The `/nix/store` search is the one that left the project.
		shellSearchesHere: 3,
		indexed: 1,
	});
	// `ls` is neither a search nor an indexed read.
	expect(facts.toolTrend?.window).toBe(8);
});

test("a trend needs more than a couple of calls, and reads only the newest window", () => {
	expect(toolTrend([])).toBeNull();
	expect(toolTrend([{ name: "bash", text: "rg x" }, { name: "bash", text: "rg y" }, { name: "bash", text: "rg z" }])).toBeNull();

	const call = (name: string, args: Record<string, unknown>) => message("assistant", [{ type: "toolCall", name, arguments: args }]);
	const many = [message("user", "go"), ...Array.from({ length: TREND_WINDOW + 5 }, (_, index) => call("bash", { command: `rg call${index}` }))];
	const facts = conversationFacts(sourcesWith(many), LIMITS);
	// The window is its own bound: the five rendered lines and the twenty counted
	// calls are different questions about the same session.
	expect(facts.recentToolCalls).toHaveLength(5);
	expect(facts.toolTrend?.window).toBe(TREND_WINDOW);
	expect(facts.toolTrend?.byTool).toEqual([{ name: "bash", count: TREND_WINDOW }]);
});

test("sources that are missing, throwing, or shapeless yield empty lists", () => {
	const empty = { userMessages: [], recentToolCalls: [], toolTrend: null, declaredPlan: null, toolbox: [], cwd: null };
	expect(conversationFacts(undefined, LIMITS)).toEqual(empty);
	expect(
		conversationFacts(
			{
				entries: () => {
					throw new Error("no branch");
				},
				toolbox: () => [],
			},
			LIMITS,
		),
	).toEqual(empty);
	expect(conversationFacts(sourcesWith("not an array"), LIMITS)).toEqual(empty);
	expect(conversationFacts(sourcesWith([{ type: "message", message: null }]), LIMITS)).toEqual(empty);
	expect(
		conversationFacts(
			{
				entries: () => [],
				toolbox: () => {
					throw new Error("no tool list");
				},
			},
			LIMITS,
		).toolbox,
	).toEqual([]);
});

test("the toolbox is skipped when the budget says so", () => {
	const facts = conversationFacts(sourcesWith([], ["grep: x"]), { ...LIMITS, withToolbox: false, maxToolbox: 0 });
	expect(facts.toolbox).toEqual([]);
});

test("blank user text is not an instruction", () => {
	const facts = conversationFacts(sourcesWith([message("user", "   "), message("user", [{ type: "image", data: "x" }])]), LIMITS);
	expect(facts.userMessages).toEqual([]);
});

test("a long message is capped at collection, and the builder still records the cut", () => {
	const facts = conversationFacts(
		sourcesWith([message("user", "p".repeat(5_000)), message("assistant", [{ type: "toolCall", name: "bash", arguments: { command: "q".repeat(5_000) } }])]),
		{ ...LIMITS, maxUserMessages: 1, maxToolCalls: 1, maxCharsPerString: 400 },
	);
	expect(facts.userMessages[0]?.length).toBe(400);
	// A tool call is one line, and its own bound is tighter than the string cap.
	expect(facts.recentToolCalls[0]?.length).toBe(200);

	// The intent block is the reader now, and its own truncation names the field.
	const built = userIntentBlock({ maxChars: 4_000, maxFieldChars: 200, maxUserMessages: 1, maxToolCalls: 1, maxPlanChars: 100, maxToolbox: 12 }).buildState({
		facts: askFactsFrom(fakeDetails(), fakeQuery()),
		conversation: facts,
	});
	const intent = built.state as { latest: string };
	expect(intent.latest.length).toBeLessThanOrEqual(200);
	expect(built.truncated.some((entry) => entry.startsWith("user_intent.latest"))).toBe(true);
});

test("the session sources read the branch and the tool list, and never throw", () => {
	const ctx = {
		sessionManager: {
			getBranch: () => [message("user", "hello")],
		},
	};
	const sources = sessionSources(ctx as never, {
		getActiveTools: () => ["bash", "grep"],
		getAllTools: () => [
			{ name: "bash", description: "Run a shell command. Second sentence is dropped." },
			{ name: "grep", description: "Search file contents." },
		],
	} as never);
	expect(sources?.entries()).toHaveLength(1);
	expect(sources?.toolbox(12)).toEqual(["bash: Run a shell command.", "grep: Search file contents."]);
	expect(sessionSources(undefined, undefined)).toBeUndefined();

	const broken = sessionSources(
		{
			sessionManager: {
				getBranch: () => {
					throw new Error("gone");
				},
			},
		} as never,
		{
			getActiveTools: () => {
				throw new Error("no tools");
			},
		} as never,
	);
	expect(broken?.entries()).toEqual([]);
	expect(broken?.toolbox(12)).toEqual([]);
});

test("a plan that predates the latest user message is not a plan", () => {
	const at = (role: string, content: unknown) => ({ type: "message", message: { role, content } });
	const text = (value: string) => [{ type: "text", text: value }];

	// The agent narrates, then works: the narration is still the plan.
	expect(
		declaredPlan(
			[
				at("user", text("run the benchmark")),
				at("assistant", text("I'll run the benchmark now.")),
				at("assistant", [{ type: "toolCall", name: "bash" }]),
				at("toolResult", [{ type: "text", text: "output" }]),
			],
			500,
		),
	).toBe("I'll run the benchmark now.");

	// The user speaks again and the agent works on without narrating: the old
	// narration is about the previous instruction, so there is no plan. This is
	// the live false alarm: a justification for a grep two instructions earlier
	// was handed to the plan question as the plan for a benchmark run.
	expect(
		declaredPlan(
			[
				at("user", text("check the vendored crate")),
				at("assistant", text("The grep was the sanctioned fallback there.")),
				at("user", text("stop checking that, just run the benchmarks")),
				at("assistant", [{ type: "toolCall", name: "bash" }]),
				at("toolResult", [{ type: "text", text: "output" }]),
			],
			500,
		),
	).toBeNull();
});
