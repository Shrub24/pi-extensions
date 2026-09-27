import { expect, test } from "bun:test";

import { renderUnknownToolCall } from "../tool-renderer/generic.js";

const theme = { bold: (t: string) => t, fg: (_t: string, x: string) => x, inverse: (t: string) => t } as never;

test("unknown-tool rows show the declared intent when present", () => {
	const withIntent = renderUnknownToolCall("web_search", { query: "x" }, theme, { toolDefinition: { intent: "search the web; network read" } });
	const without = renderUnknownToolCall("web_search", { query: "x" }, theme, { toolDefinition: {} });
	expect(withIntent.render(120).join("\n")).toContain("search the web; network read");
	expect(without.render(120).join("\n")).not.toContain("· undefined");
});
