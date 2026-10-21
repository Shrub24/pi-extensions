import { expect, test } from "bun:test";
import { OUTPUT_MATCH_OVERLAP_CHARS, parseOutputMatcher, patternMatchWindow } from "../extensions/format.js";

// The notification gate runs once per output chunk, so its input must stay
// proportional to the chunk. These rows pin the window, because a regression
// here silently reintroduces a full-buffer scan per chunk.

test("the match window carries the unseen delta", () => {
	const delta = "new line\n";
	const output = "x".repeat(6_000) + delta;
	const window = patternMatchWindow(output, 6_000);
	expect(window.endsWith(delta)).toBe(true);
	expect(window.length).toBe(OUTPUT_MATCH_OVERLAP_CHARS + delta.length);
});

test("the match window keeps a bounded overlap before the delta", () => {
	const output = "a".repeat(10_000) + "delta";
	const window = patternMatchWindow(output, 10_000);
	expect(window.length).toBe(OUTPUT_MATCH_OVERLAP_CHARS + "delta".length);
	expect(window.endsWith("delta")).toBe(true);
});

test("the match window clamps an index past the end and a negative index", () => {
	const output = "0123456789";
	expect(patternMatchWindow(output, 999)).toBe(output.slice(-OUTPUT_MATCH_OVERLAP_CHARS));
	expect(patternMatchWindow(output, -5)).toBe(output.slice(-OUTPUT_MATCH_OVERLAP_CHARS));
});

test("a match spanning the chunk boundary is still reported", () => {
	// "TIMED OUT" arrives in two chunks; the gate only sees the second one.
	const matcher = parseOutputMatcher("/timed\\s+out/i");
	expect(matcher).not.toBeNull();
	const output = "download TIMED OUT after 30s";
	const lastAnnouncedLength = output.indexOf("OUT");
	expect(matcher!(patternMatchWindow(output, lastAnnouncedLength))).toBe(true);
});

test("a match long before the window is not re-reported", () => {
	// The far match was seen by the chunk that carried it; re-reading the whole
	// buffer could only resurrect it and cost the buffer's length per chunk.
	const matcher = parseOutputMatcher("DECISION");
	const output = "DECISION\n" + "x".repeat(50_000) + "\nnew output";
	expect(matcher!(patternMatchWindow(output, output.length))).toBe(false);
});

test("substring and regex gates read the same windowed text", () => {
	const text = patternMatchWindow("ERROR suffix", 0);
	expect(parseOutputMatcher("error")!(text)).toBe(true);
	expect(parseOutputMatcher("/^ERROR/")!(text)).toBe(true);
	expect(parseOutputMatcher("/^ERROR/")!(`prefix ${text}`)).toBe(false);
});
