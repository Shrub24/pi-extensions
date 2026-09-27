import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { formatClock, stampLabel, withInlineStamp, withTrailingGap } from "../tool-renderer/stamps.js";

const theme = { fg: (_token: string, text: string) => text } as never;

test("clock formats in 24h and 12h without locale surprises", () => {
	const ts = new Date(2026, 0, 2, 15, 4, 9).getTime();
	expect(formatClock(ts, "/nonexistent")).toBeDefined();
});

test("inline stamp right-aligns on the last non-empty line", () => {
	const lines = withInlineStamp(["hello world", "second line", ""], theme, "14:32:07", 40);
	const stamped = lines.find((line) => line.includes("14:32:07"))!;
	expect(stamped).toBeDefined();
	expect(visibleWidth(stamped)).toBe(40);
	expect(stamped!.startsWith("second line")).toBe(true);
});

test("stamp moves to its own line when the last line is full width", () => {
	const full = "x".repeat(40);
	const lines = withInlineStamp([full], theme, "14:32:07", 40);
	expect(lines.length).toBe(2);
	expect(lines[0]).toBe(full);
	expect(visibleWidth(lines[1]!)).toBe(40);
});

test("a terminal narrower than the label renders unstamped", () => {
	const lines = withInlineStamp(["hello"], theme, "14:32:07", 6);
	expect(lines).toEqual(["hello"]);
});

test("stamp label appends response time when known", () => {
	const label = stampLabel({ theme, timestamp: Date.now(), startedAt: 1000, completedAt: 3500, responseTime: true, cwd: "/nonexistent" });
	expect(label).toContain("2.5s");
});

test("trailing gap keeps exactly one blank row", () => {
	expect(withTrailingGap(["a", "", "", ""])).toEqual(["a", ""]);
});
