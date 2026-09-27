import { expect, test } from "bun:test";

import { __test } from "../tool-renderer/messages.js";

const theme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as never;

test("unchanged thinking rows keep their fill", () => {
	const lines = ["plain line", "", "another"];
	const out = __test.assistantTextGutterLines(lines, 40, theme, "/tmp", "agent");
	expect(out[0]!.startsWith("  ")).toBe(false);
	expect(out[2]).toBe("   another");
	expect(out.length).toBe(3);
});
