import { expect, test } from "bun:test";

import { THINKING_ROW_SENTINEL, __test } from "../tool-renderer/messages.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m`,
	bold: (text: string) => text,
} as never;

test("thinking panel rows keep their fill and the marker lands on the message", () => {
	const panelRow = `${THINKING_ROW_SENTINEL}\u001b[48;5;236m thinking text \u001b[49m`;
	const lines = [panelRow, "", "# Heading", "body"];
	const out = __test.assistantTextGutterLines(lines, 60, theme, "/tmp", "agent");
	// Panel row: sentinel stripped, no gutter lead, background intact at column 0.
	expect(out[0]).toBe("\u001b[48;5;236m thinking text \u001b[49m");
	expect(out[0]!.startsWith(THINKING_ROW_SENTINEL)).toBe(false);
	// Marker sits on the first real message line, with a space after it.
	expect(out[2]!.endsWith("# Heading")).toBe(true);
	expect(out[2]!.startsWith("   ")).toBe(false);
	// Continuation lines hang on the same indent.
	expect(out[3]).toBe("   body");
});
