/**
 * Render CBM graph tools in this extension's row style. The official adapter
 * (`~/.pi/agent/extensions/cbmem.ts`) registers its tools without renderers,
 * so they fall to the generic unknown-tool row. This module gives the 17
 * registered names real rows: chrome bullet, dim arg summary keyed per tool,
 * and result rows parsed from the CLI's actual text contract (the adapter
 * returns the raw `cli --json` stdout text, so the parser reads that).
 *
 * Adopted through the same registerTool intercept as fff (see fff-patch.ts),
 * so nothing inside the generated adapter file is edited and regeneration is
 * safe. Gated by the `cbmRenderers` setting (default on).
 */
import { Text } from "@earendil-works/pi-tui";

import { oneLine } from "./generic.js";
import { truncateText } from "./glyphs.js";
import { settingBoolean } from "./settings.js";

export const CBM_TOOL_NAMES = new Set([
	"index_repository",
	"search_graph",
	"query_graph",
	"trace_path",
	"get_code_snippet",
	"get_file_outline",
	"get_graph_schema",
	"compare_graphs",
	"get_architecture",
	"search_code",
	"list_projects",
	"delete_project",
	"index_status",
	"check_index_coverage",
	"detect_changes",
	"manage_adr",
	"ingest_traces",
]);

/** Stable render width matching pi's ToolExecution container. */
function renderWidth(theme: any, context: any): number {
	return typeof context?.width === "number" ? context.width : 96;
}

const dim = (theme: any, text: string) => (text ? theme.fg("dim", ` ${text}`) : "");
const warn = (theme: any, text: string) => (text ? theme.fg("warning", ` ${text}`) : "");

function argSummary(name: string, args: Record<string, unknown>): string {
	const s = (key: string): string => {
		const v = args?.[key];
		return typeof v === "string" && v.trim() ? v.trim() : "";
	};
	switch (name) {
		case "search_graph":
		case "search_code":
			return oneLine(s("query") || s("semantic_query") || s("pattern") || s("name_pattern") || "", 56);
		case "query_graph":
			return oneLine(s("query") || "", 56);
		case "trace_path":
			return oneLine([s("function_name"), s("direction") && `(${s("direction")})`].filter(Boolean).join(" "), 56);
		case "get_code_snippet": {
			const qn = s("qualified_name");
			const short = qn.split(".").slice(-3).join(".");
			return oneLine(short || "", 56);
		}
		case "get_file_outline":
			return oneLine(s("file_path"), 56);
		case "get_architecture":
			return "overview";
		case "index_repository":
			return oneLine(s("repo_path"), 56);
		case "compare_graphs":
			return oneLine(`${s("base_project")} → ${s("target_project")}`, 56);
		case "check_index_coverage":
			return [s("project") && oneLine(s("project"), 44), s("path") && `path: ${oneLine(s("path"), 24)}`].filter(Boolean).join(" · ");
		default:
			return oneLine(s("project") || s("repo_path") || s("query") || "", 56);
	}
}

/** `Name arg-summary` header with chrome bullet supplied by the tool chrome. */
export function renderCbmCall(name: string, args: Record<string, unknown>, theme: any): unknown {
	const summary = argSummary(name, args ?? {});
	return new Text(`${theme.fg("toolTitle", theme.bold(name))}${summary ? theme.fg("accent", ` ${summary}`) : ""}`, 0, 0);
}

interface ParsedRows {
	summary: string[];
	preview: string[];
	warnings: string[];
}

/**
 * Parse the `cli --json` text contract into (summary, preview, warnings).
 * The text is line-oriented: `key: value` meta lines and indented row blocks
 * announced by `name: N  (cols: ...)`.
 */
export function parseCbmResult(name: string, text: string): ParsedRows {
	const warnings: string[] = [];
	const summary: string[] = [];
	const lines = text.split("\n");
	const preview: string[] = [];

	const meta = (key: string): string | undefined => {
		const line = lines.find((l) => l.startsWith(`${key}:`));
		return line ? line.slice(key.length + 1).trim() : undefined;
	};

	// Global truncation / paging flags first — these matter most for trust.
	if (meta("truncated") === "true") warnings.push("truncated");
	const hasMoreKey = lines.find((l) => /^(?:\w+_)?has_more:/.test(l));
	if (hasMoreKey?.endsWith("true")) warnings.push("has_more — continue with cursor/offset");

	// Error/hint passthrough.
	const hint = meta("hint");
	if (hint) summary.push(hint);

	// Row blocks: `label: N  (cols: a b c)`.
	const blockRe = /^(\S+): (\d+)\s+\(cols: ([^)]*)\)\s*$/;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]!.match(blockRe);
		if (!m) continue;
		const [, blockName, countStr] = m;
		const count = Number(countStr);
		summary.push(`${blockName}=${count}`);
		if (count === 0) continue;
		// Rows follow while indented by two spaces.
		let taken = 0;
		for (let j = i + 1; j < lines.length && taken < 3; j++) {
			const row = lines[j]!;
			if (!row.startsWith("  ") || !row.trim()) continue;
			if (blockRe.test(row.trim())) break;
			// Strip the two-space indent; shorten qualified names to their tail.
			let body = row.trimStart();
			// Shorten every dotted qualified name to its last 3 segments; other
			// columns (label, file, lines, score) stay intact.
			body = body.replace(/[\w-]+(?:\.[\w-]+){2,}/g, (full) => `…${full.split(".").slice(-3).join(".")}`);
			preview.push(body);
			taken += 1;
		}
	}

	// Scalar totals worth surfacing even without row blocks.
	for (const key of ["total_grep_matches", "callers_total", "total_nodes", "total_edges", "elapsed_ms"]) {
		const v = meta(key);
		if (v !== undefined) summary.push(`${key.replace("total_", "")}=${v}`);
	}

	void name;
	return { summary, preview, warnings };
}

/** `✓ N results · total=12` plus up to 3 preview lines; warnings appended. */
export function renderCbmResult(name: string, result: any, options: { expanded?: boolean } | undefined, theme: any): unknown {
	const text = (result?.content ?? [])
		.filter((c: any) => c?.type === "text")
		.map((c: any) => String(c.text ?? ""))
		.join("\n");
	const isError = Boolean(result?.isError) || /isError["':\s]+true/.test(text);
	const { summary, preview, warnings } = parseCbmResult(name, text);

	const bits = [isError ? theme.fg("error", `✗ ${name}`) : theme.fg("success", `✓ ${name}`)];
	for (const bit of summary.slice(0, 4)) bits.push(theme.fg("muted", ` · ${bit}`));
	for (const w of warnings) bits.push(warn(theme, w));
	const header = new Text(bits.join(""), 0, 0);
	if (!options?.expanded || preview.length === 0) return header;

	const expandedLines: unknown[] = [header];
	for (const row of preview) expandedLines.push(new Text(theme.fg("dim", `  ${truncateText(row, 110)}`), 0, 0));
	return expandedLines;
}
