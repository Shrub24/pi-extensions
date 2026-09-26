/*
 * What the judge is told about the session so far: the user's instructions, the
 * agent's recent tool calls, the agent's own plan, and the toolbox.
 *
 * Two findings shape this module. pi-heed's real-session replay showed that a
 * judgment made against a broad shared state is worse than the same judgment
 * made against a minimal one — their go-ahead question caught 8 of 9 intended
 * lifts with a small state and 5 of 9 inside a larger one — so this collects
 * exactly the four things the pack names, and nothing else: no summary, no
 * transcript, no tool output. And "pasted material is not the user's voice" is a
 * distinction the judge has to make itself, so user messages are passed through
 * intact rather than pre-digested into something that would hide the difference.
 *
 * Reading is bounded by caller-supplied counts and the per-string cap, applied
 * during the walk, so the cost of one ask does not grow with the session.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ConversationFacts } from "./action-pack.js";

export interface ConversationLimits {
	maxUserMessages: number;
	maxToolCalls: number;
	/**
	 * Ceiling for one collected string, before the state builder applies its own
	 * smaller field bound.
	 *
	 * A permission ask runs synchronously ahead of the human's prompt, so the
	 * walk must not carry a pasted 200 KB message through another transform. The
	 * bound is deliberately several times the builder's, so the builder still
	 * sees an over-long string and records the cut it makes: trimming here is a
	 * work limit, not a silent provenance change.
	 */
	maxCharsPerString: number;
	/** How much of the agent's own plan reaches the state. */
	maxPlanChars: number;
	/** How many tools the toolbox lists, with their descriptions. */
	maxToolbox: number;
	/** Whether to collect the toolbox at all. */
	withToolbox: boolean;
}

/** Keys whose value identifies the call in one line, per tool. */
const PRIMARY_ARGUMENT: Record<string, string> = {
	bash: "command",
	read: "path",
	write: "path",
	edit: "path",
	grep: "pattern",
	find: "path",
	ls: "path",
	glob: "pattern",
	task: "description",
	spawn: "command",
};

/**
 * Tools that answer a question about the codebase without reading it by hand:
 * the indexed and graph tools, the semantic search, the docs and code gates. A
 * trend that counted only shell searches would miss the point — it is the ratio
 * between these and the shell that says whether the agent is exploring the
 * project or reading it a file at a time.
 */
const RETRIEVAL_TOOLS = new Set([
	"grep",
	"find",
	"glob",
	"search_code",
	"search_graph",
	"query_graph",
	"get_code_snippet",
	"get_file_outline",
	"get_architecture",
	"trace_path",
	"list_projects",
	"semble_search",
	"semble_find_related",
	"mcp",
	"mcp__docs_mcp_server",
]);

/**
 * A shell command that searches: the shapes the audit counted. `git grep` is
 * checked before the bare verbs so a repository-wide search is not read as a
 * plain `grep` argument.
 */
const SHELL_SEARCH = /(^|[\s|&;(])(git\s+grep|rg|grep|ag|ack|fd|find)\s/;

/**
 * A path argument that leaves the project: absolute, or home-relative. The
 * trend says "in this project" from this alone, so it is deliberately blunt —
 * a command naming `/nix/store`, `/tmp`, or `~/.cache` is about something other
 * than the code under the working directory, and a relative one is not.
 */
const OUTSIDE_PATH = /(^|\s)[~/]/;

/** How many recent calls the trend reads. Enough for a habit, small enough to bound the walk. */
export const TREND_WINDOW = 20;

export function toolTrend(sample: readonly { name: string; text: string }[]): ToolTrend | null {
	if (sample.length < 4) return null;
	const counts = new Map<string, number>();
	let shellSearches = 0;
	let shellSearchesHere = 0;
	let indexed = 0;
	for (const call of sample) {
		counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
		if (call.name === "bash" && SHELL_SEARCH.test(call.text)) {
			shellSearches += 1;
			if (!OUTSIDE_PATH.test(call.text)) shellSearchesHere += 1;
		}
		if (RETRIEVAL_TOOLS.has(call.name)) indexed += 1;
	}
	const byTool = [...counts]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
		.slice(0, 6);
	return { window: sample.length, byTool, shellSearches, shellSearchesHere, indexed };
}

interface ContentPart {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text of a user message, whichever of the two content shapes it uses. */
export function userMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content as ContentPart[]) {
		if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

/**
 * The agent's own words: the text of the most recent assistant message that has
 * any, which is what "the plan" means for a call made in the message after it.
 * Thinking blocks are deliberately excluded — a plan the user cannot see is not
 * the agent's stated intent.
 *
 * A user message ends the search. The agent narrates, the user replies, the agent
 * works on the new instruction without narrating again — and the old narration is
 * then not a plan for anything, which is what produced two false plan objections
 * in the live log (the text in front of the judge was a justification for a grep
 * two instructions earlier). Null means "no plan", and the plan question answers
 * true on null.
 */
export function declaredPlan(entries: readonly unknown[], max: number): string | null {
	if (!Array.isArray(entries)) return null;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message)) continue;
		// The user has spoken since the agent last did: whatever the agent said
		// before that was about an instruction that is no longer current.
		if (message.role === "user") return null;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = (message.content as ContentPart[])
			.filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string)
			.join("\n")
			.trim();
		if (text === "") continue;
		return cap(text, max);
	}
	return null;
}

/**
 * One line for a tool call: its name and the argument that says what it acts
 * on. An unknown tool falls back to a bounded JSON view of its arguments, so a
 * registered tool a reader has never heard of still reaches the judge.
 */
export function toolCallLine(part: ContentPart, max = 200): string {
	const name = callName(part);
	const flat = callArgument(part);
	// An empty argument view says nothing the tool name has not already said.
	if (flat === "" || flat === "{}" || flat === "[]") return name;
	const line = `${name} ${flat}`;
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** The tool's name as the call reported it, or "tool" when it reported none. */
function callName(part: ContentPart): string {
	return typeof part.name === "string" && part.name !== "" ? part.name : "tool";
}

/**
 * The argument that says what the call acts on, flattened to one line. The trend
 * reads the same string the judge's tool lines show, so a count and the lines it
 * counts can never disagree about what a call was.
 */
function callArgument(part: ContentPart): string {
	const args = isRecord(part.arguments) ? part.arguments : {};
	const key = PRIMARY_ARGUMENT[callName(part)];
	const value = key && typeof args[key] === "string" ? (args[key] as string) : JSON.stringify(args);
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function cap(text: string, max: number): string {
	if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
	return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** The tools the agent may use, as one line each. Best-effort: absence is fine. */
export function toolboxLines(pi: Pick<ExtensionAPIForTools, "getActiveTools">, getAll: () => unknown, limit: number): string[] {
	let names: string[] = [];
	try {
		names = pi.getActiveTools?.() ?? [];
	} catch {
		names = [];
	}
	if (!Array.isArray(names) || names.length === 0) return [];
	const descriptions = new Map<string, string>();
	try {
		const all = getAll();
		if (Array.isArray(all)) {
			for (const tool of all) {
				if (!isRecord(tool) || typeof tool.name !== "string") continue;
				const description = typeof tool.description === "string" ? tool.description : "";
				descriptions.set(tool.name, description);
			}
		}
	} catch {
		// Descriptions are a nicety; names still answer the question.
	}
	return names.slice(0, limit).map((name) => {
		const description = descriptions.get(name) ?? "";
		const first = description.split(/(?<=\.)\s/)[0] ?? "";
		return first === "" ? name : `${name}: ${cap(first, 90)}`;
	});
}

interface ExtensionAPIForTools {
	getActiveTools?: () => string[];
}

export interface ConversationSources {
	/** The active branch, as the session manager reports it. */
	entries: () => readonly unknown[];
	/** The live tool list, when the caller can reach it. */
	toolbox: (limit: number) => string[];
	/**
	 * The session's working directory. It is what makes "inside the project" a
	 * question the judge can answer: a search under it is repository exploration,
	 * and one under `/nix/store`, a dependency cache, or a scratch directory is
	 * not, whatever the command looks like.
	 */
	cwd: string | null;
}

/**
 * Walk the active branch once, collecting the four lists.
 *
 * `getBranch` is the current branch with compaction applied, which is what the
 * agent itself can see; entries from an abandoned branch are not facts about
 * what the user asked for. A missing or throwing source yields empty lists
 * rather than failing the ask: the judge then decides on the action alone.
 */
/**
 * Whether the session has already pulled a skill in, read from the branch.
 *
 * The evidence is one of two things in the transcript: the skill command the
 * loader expanded (`/skill:name`), or a tool call that touched the skill's own
 * file. Both are what "already loaded" looks like from the outside, and both are
 * cheap to check on a branch the caller already walks.
 */
export function skillLoaded(entries: readonly unknown[], skill: string): boolean {
	const command = `/skill:${skill}`.toLowerCase();
	const path = `${skill.toLowerCase()}/skill.md`;
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message)) continue;
		if (message.role === "user" && userMessageText(message.content).toLowerCase().includes(command)) return true;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content as ContentPart[]) {
			if (part && typeof part === "object" && part.type === "toolCall" && JSON.stringify(part).toLowerCase().includes(path)) return true;
		}
	}
	return false;
}

export function conversationFacts(sources: ConversationSources | undefined, limits: ConversationLimits): ConversationFacts {
	const userMessages: string[] = [];
	const recentToolCalls: string[] = [];
	// The trend's own window, independent of how many calls are rendered: the
	// lines are capped at five for the judge's attention, and a habit needs more
	// calls than that to be a habit at all.
	const sample: { name: string; text: string }[] = [];
	const empty: ConversationFacts = { userMessages, recentToolCalls, toolTrend: null, declaredPlan: null, toolbox: [], cwd: null };
	if (!sources) return empty;

	let entries: readonly unknown[] = [];
	try {
		entries = sources.entries() ?? [];
	} catch {
		return empty;
	}
	if (!Array.isArray(entries)) return empty;

	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message)) continue;
		if (message.role === "user") {
			const text = userMessageText(message.content).trim();
			if (text !== "") userMessages.push(cap(text, limits.maxCharsPerString));
			continue;
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content as ContentPart[]) {
			if (part && typeof part === "object" && part.type === "toolCall") {
				recentToolCalls.push(cap(toolCallLine(part), limits.maxCharsPerString));
				sample.push({ name: callName(part), text: callArgument(part) });
				if (sample.length > TREND_WINDOW) sample.shift();
			}
		}
	}

	let toolbox: string[] = [];
	if (limits.withToolbox) {
		try {
			toolbox = sources.toolbox(limits.maxToolbox);
		} catch {
			toolbox = [];
		}
	}

	return {
		userMessages: limits.maxUserMessages > 0 ? userMessages.slice(-limits.maxUserMessages) : [],
		recentToolCalls: limits.maxToolCalls > 0 ? recentToolCalls.slice(-limits.maxToolCalls) : [],
		toolTrend: toolTrend(sample),
		declaredPlan: limits.maxPlanChars > 0 ? declaredPlan(entries, limits.maxPlanChars) : null,
		toolbox,
		cwd: typeof sources.cwd === "string" && sources.cwd !== "" ? sources.cwd : null,
	};
}

/** The session's own sources, or a stub when the context exposes none. */
export function sessionSources(ctx: Pick<ExtensionContext, "sessionManager" | "cwd"> | undefined, pi: ExtensionAPIForTools | undefined): ConversationSources | undefined {
	if (!ctx?.sessionManager && !pi) return undefined;
	return {
		cwd: typeof ctx?.cwd === "string" ? ctx.cwd : null,
		entries: () => {
			try {
				return (ctx?.sessionManager?.getBranch() ?? []) as readonly unknown[];
			} catch {
				return [];
			}
		},
		toolbox: (limit) => (pi ? toolboxLines(pi, () => pi.getAllTools?.() ?? [], limit) : []),
	};
}

/**
 * The conversation a decision reads, bounded by one config.
 *
 * Both entries ask this way, and the bounds live in one place: a second copy of
 * this list is how two consumers end up reading different conversations and
 * disagreeing about the same action.
 */
export function configConversation(sources: unknown, config: JevConfig): ConversationFacts {
	return conversationFacts(sources as never, {
		maxUserMessages: config.recentUserMessages,
		maxToolCalls: config.recentToolCalls,
		maxCharsPerString: config.maxFieldChars * 4,
		maxPlanChars: config.maxPlanChars,
		maxToolbox: config.maxToolbox,
		withToolbox: config.maxToolbox > 0,
	});
}
