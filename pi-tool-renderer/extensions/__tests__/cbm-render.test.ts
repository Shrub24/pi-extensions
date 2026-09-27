import { describe, expect, it } from "bun:test";

import { parseCbmResult, renderCbmCall, renderCbmResult } from "../tool-renderer/cbm.js";

const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
} as any;

const SEARCH_GRAPH = `results: 1  (cols: qn label file lines rank)
  mnt-LinuxData-Projects-dev-custom-pi-extensions.pi-tool-renderer.extensions.tool-renderer.chrome.renderPanelChrome Function chrome.ts 231-252 -19.12
total: 1
total_relation: eq
search_mode: bm25
returned: 1
has_more: false
truncated: false`;

const TRACE_PATH = `function: renderPanelChrome
direction: inbound
callers_total: 1
callers_total_relation: eq
callers: 1  (cols: qn hop)
  mnt-LinuxData-Projects-dev-custom-pi-extensions.pi-tool-renderer.extensions.tool-renderer.chrome.renderToolChromeLines 1`;

const SEARCH_CODE = `results: 1  (cols: qn label file lines matches matches_omitted in out)
  mnt-LinuxData-Projects-dev-custom-pi-extensions.pi-tool-renderer.extensions.tool-renderer.fff-patch.fffAwareRegisterTool Function fff-patch.ts 24-40 "30" 0 0 3
directories: 1  (cols: dir hits)
  pi-tool-renderer/ 1
total_grep_matches: 1
total_results: 1
raw_match_count: 0
total_relation: eq
result_offset: 0
results_returned: 1
has_more: false
raw_returned: 0
raw_has_more: false
directories_total: 1
directories_returned: 1
directories_has_more: false
truncated: false
elapsed_ms: 89`;

const QUERY_EMPTY = `rows: 0  (cols: "COUNT(s)")
returned: 0
total: 0
total_relation: eq
has_more: false
truncated: false
hint: "Query returned no results. Use get_graph_schema() to see available labels and edge types."`;

describe("cbm result parsing (real cli contracts)", () => {
	it("search_graph summarizes count and truncation state", () => {
		const { summary, warnings } = parseCbmResult("search_graph", SEARCH_GRAPH);
		expect(summary.join(" ")).toContain("results=1");
		expect(warnings).toHaveLength(0);
	});

	it("flags has_more on paginated semantic results", () => {
		const text = SEARCH_GRAPH.replace("has_more: false", "semantic_has_more: true");
		const { warnings } = parseCbmResult("search_graph", `semantic: 50  (cols: qn label file score)\n  a.b.c Function f.ts 0.01\n${text}`);
		expect(warnings.some((w) => w.includes("has_more"))).toBe(true);
	});

	it("trace_path reports caller totals", () => {
		const { summary, preview } = parseCbmResult("trace_path", TRACE_PATH);
		expect(summary.join(" ")).toContain("callers=1");
		expect(preview[0]).toContain("renderToolChromeLines");
	});

	it("search_code surfaces grep totals and elapsed time", () => {
		const { summary } = parseCbmResult("search_code", SEARCH_CODE);
		const joined = summary.join(" ");
		expect(joined).toContain("results=1");
		expect(joined).toContain("grep_matches=1");
		expect(joined).toContain("elapsed_ms=89");
	});

	it("passes the empty-query hint through", () => {
		const { summary } = parseCbmResult("query_graph", QUERY_EMPTY);
		expect(summary[0]).toContain("get_graph_schema");
	});
});

describe("cbm rendering", () => {
	it("call row carries the query argument", () => {
		const row = renderCbmCall("search_graph", { query: "foreground yield timing", project: "p" }, theme) as any;
		expect(String(row.text ?? row)).toContain("foreground yield timing");
	});

	it("result header is compact; expanded adds row previews", () => {
		const result = { content: [{ type: "text", text: SEARCH_GRAPH }] };
		const collapsed = renderCbmResult("search_graph", result, {}, theme) as any;
		expect(String(collapsed.text ?? collapsed)).toContain("✓ search_graph");
		const expanded = renderCbmResult("search_graph", result, { expanded: true }, theme) as unknown[];
		expect(expanded.length).toBeGreaterThan(1);
	});

	it("error results render with the error marker", () => {
		const result = { content: [{ type: "text", text: "unknown tool: nope" }], isError: true };
		const row = renderCbmResult("search_graph", result, {}, theme) as any;
		expect(String(row.text ?? row)).toContain("✗");
	});
});
