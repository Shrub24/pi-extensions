import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";

import { buildStructuredDiff, structuredDiffFromPatch, type StructuredDiff } from "../tool-renderer/diff.js";

const counts = (diff: StructuredDiff) => `+${diff.additions}/-${diff.removals}`;

const numbered = (count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `${prefix} ${index}`);

describe("text diffs report only the lines that changed", () => {
	test("two one-line edits far apart in a large file are two changes, not the span between them", () => {
		const before = numbered(12_000);
		const after = before.slice();
		after[10] = "changed near the top";
		after[6_010] = "changed in the middle";
		const diff = buildStructuredDiff(before.join("\n"), after.join("\n"));
		expect(counts(diff)).toBe("+2/-2");
		expect(diff.lines.filter((line) => line.type === "sep").length).toBeGreaterThan(0);
	});

	test("an unrelated pair of large texts is reported as skipped instead of blocking the render", () => {
		const before = Array.from({ length: 12_000 }, (_, index) => `before ${(index * 7919) % 12_000}`).join("\n");
		const after = Array.from({ length: 9_000 }, (_, index) => `after ${index}`).join("\n");
		const started = performance.now();
		const diff = buildStructuredDiff(before, after);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(diff.skipped).toBe(true);
		expect(diff.lines).toHaveLength(0);
	});
});

describe("rows derived from a stored patch", () => {
	const fixture = readFileSync(join(import.meta.dir, "fixtures", "edit-three-hunks.patch"), "utf8");

	test("a captured three-hunk patch keeps its own addition and removal counts", () => {
		const diff = structuredDiffFromPatch(fixture, 10_800);
		expect(diff.hunks).toBe(3);
		expect(diff.additions).toBe(
			fixture.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
		);
		expect(diff.removals).toBe(
			fixture.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
		);
	});

	test("unchanged gaps between hunks collapse into one separator each", () => {
		const diff = structuredDiffFromPatch(fixture, 10_800);
		const separators = diff.lines.filter((line) => line.type === "sep");
		// A leading gap, two between the three hunks, and a trailing gap.
		expect(separators).toHaveLength(4);
		expect(separators[0]!.content).toBe("… 2546 unchanged lines …");
	});

	test("the trailing gap uses the file's line count when it is stored", () => {
		const diff = structuredDiffFromPatch(fixture, 10_800);
		const trailing = diff.lines.at(-1)!;
		expect(trailing.type).toBe("sep");
		// The last hunk ends at new line 10486 (10477 + 10 - 1), so 10800 - 10486 lines follow.
		expect(trailing.content).toBe("… 314 unchanged lines …");
	});

	test("without a stored line count the trailing gap is omitted rather than guessed", () => {
		const diff = structuredDiffFromPatch(fixture);
		expect(diff.lines.at(-1)!.type).not.toBe("sep");
	});

	test("rows from a patch match the counts of the texts it was made from", () => {
		const before = numbered(400).join("\n");
		const after = numbered(400).map((line, index) => (index === 50 || index === 300 ? `${line} edited` : line)).join("\n");
		const patch = createTwoFilesPatch("a.ts", "a.ts", before, after);
		const fromPatch = structuredDiffFromPatch(patch, 400);
		const fromTexts = buildStructuredDiff(before, after);
		expect(counts(fromPatch)).toBe(counts(fromTexts));
		expect(fromPatch.hunks).toBe(fromTexts.hunks);
	});

	test("a malformed patch degrades to a skipped diff", () => {
		const diff = structuredDiffFromPatch("@@ nonsense @@\n+oops\n\\ mangled");
		expect(diff.skipped).toBe(true);
		expect(diff.lines).toHaveLength(0);
	});
});
