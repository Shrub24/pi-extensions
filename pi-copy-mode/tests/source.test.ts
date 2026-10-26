import { describe, expect, test } from "bun:test";
import { assistantSources, copiedText, markedRange, sourceLinesFromContent } from "../extensions/source.js";

const text = (value: string) => ({ type: "text", text: value });

describe("sourceLinesFromContent", () => {
	test("keeps raw markdown from text blocks and drops thinking and tool calls", () => {
		const lines = sourceLinesFromContent([
			{ type: "thinking", thinking: "hidden reasoning" },
			text("### Heading\n\nBody with **bold**."),
			{ type: "toolCall", name: "read", arguments: {} },
		]);
		expect(lines).toEqual(["### Heading", "", "Body with **bold**."]);
	});

	test("joins blocks with a blank line and normalises CRLF", () => {
		expect(sourceLinesFromContent([text("first\r\nline"), text("second")])).toEqual(["first", "line", "", "second"]);
	});

	test("keeps indentation inside code blocks", () => {
		expect(sourceLinesFromContent([text("```\n  indented()\n```\n")])).toEqual(["```", "  indented()", "```"]);
	});

	test("returns no lines for blank or non-array content", () => {
		expect(sourceLinesFromContent([text("   \n  ")])).toEqual([]);
		expect(sourceLinesFromContent("plain string")).toEqual([]);
	});
});

describe("assistantSources", () => {
	const entry = (role: string, content: unknown, timestamp?: number) => ({
		type: "message",
		message: { role, content, timestamp },
	});

	test("lists assistant messages newest first and skips other roles and empty replies", () => {
		const sources = assistantSources([
			entry("user", [text("question")]),
			entry("assistant", [text("first answer")], Date.UTC(2026, 0, 1, 10, 0, 0)),
			entry("assistant", [{ type: "toolCall", name: "bash", arguments: {} }]),
			entry("user", [text("follow up")]),
			entry("assistant", [text("## Second answer\nmore")], Date.UTC(2026, 0, 1, 11, 0, 0)),
		]);
		expect(sources.map((source) => source.ordinal)).toEqual([1, 2]);
		expect(sources[0]!.lines).toEqual(["## Second answer", "more"]);
		expect(sources[1]!.lines).toEqual(["first answer"]);
	});

	test("labels carry the ordinal and the first meaningful line without markdown markers", () => {
		const [source] = assistantSources([entry("assistant", [text("## Area: Boundaries")], Date.UTC(2026, 0, 1, 0, 0, 0))]);
		expect(source!.label).toMatch(/^1\. \d\d:\d\d:\d\d Area: Boundaries$/);
	});

	test("truncates long labels", () => {
		const [source] = assistantSources([entry("assistant", [text("x".repeat(200))])]);
		expect(source!.label.length).toBeLessThan(80);
		expect(source!.label.endsWith("…")).toBe(true);
	});
});

describe("markedRange and copiedText", () => {
	const lines = ["one", "two", "three", "four"];

	test("without a mark the range is the cursor line", () => {
		expect(markedRange(2, null)).toEqual({ start: 2, end: 2 });
		expect(copiedText(lines, markedRange(2, null))).toBe("three");
	});

	test("a mark below the cursor still yields an ordered inclusive range", () => {
		expect(markedRange(1, 3)).toEqual({ start: 1, end: 3 });
		expect(copiedText(lines, markedRange(3, 1))).toBe("two\nthree\nfour");
	});

	test("a single marked line copies that line", () => {
		expect(copiedText(lines, markedRange(0, 0))).toBe("one");
	});
});
