/*
 * The codebase-memory tool surface, as registered with Pi.
 *
 * Seventeen are available from the server; thirteen are registered by default.
 * The four admin tools are opt-in (`adminTools: true`) because each of them is
 * either destructive or redundant: the daemon auto-indexes on connect, and
 * `delete_project` / `manage_adr` / `ingest_traces` are rare enough to run by
 * hand through `codebase-memory-mcp cli`.
 *
 * Every entry carries a `promptSnippet`. Without one, Pi dumps the full
 * description into the Available-tools list; with one, the list stays a
 * one-line-per-tool index and the schema carries the detail.
 *
 * `injectProject` marks the tools whose `project` argument defaults to the
 * session project. Tools that name two projects (compare_graphs) or take a
 * repository path instead (index_repository) are left alone.
 */

import { ADMIN_TOOLS, type CbmemConfig, expandToolNames } from "./config.js";

export interface ToolSpec {
	name: string;
	description: string;
	snippet: string;
	guidelines?: string[];
	/** JSON schema, without the injected `project` property. */
	schema: Record<string, unknown>;
	/** Fill in the session project when the call omits it. */
	injectProject: boolean;
	/** Member of ADMIN_TOOLS. */
	admin: boolean;
}

const projectParam = {
	type: "string",
	description:
		"Optional; defaults to the current session project, derived from the working directory. Pass a name from list_projects to query another indexed project.",
};

export const TOOL_SPECS: ToolSpec[] = [
	{
		name: "search_graph",
		description:
			"Find symbols via BM25 query, regex name/qn filters, or semantic_query. Rows keep qn/file/lines and in/out over CALLS/USAGE/CALL_REFERENCE/INHERITS/IMPLEMENTS.",
		snippet: "Search the code graph for symbols by name, pattern, or meaning",
		guidelines: [
			"Use search_graph before grep or read for structural code questions (\"where is X\", \"who handles Y\"); rows carry qualified names, files, and line ranges.",
		],
		schema: {
			type: "object",
			properties: {
				query: { type: "string" },
				label: { type: "string" },
				name_pattern: { type: "string" },
				qn_pattern: { type: "string" },
				file_pattern: { type: "string" },
				relationship: { type: "string" },
				min_degree: { type: "integer" },
				max_degree: { type: "integer" },
				exclude_entry_points: { type: "boolean" },
				include_connected: { type: "boolean" },
				semantic_query: { type: "array", items: { type: "string" }, description: "Not with query." },
				semantic_limit: { type: "integer", default: 50, minimum: 0, maximum: 500 },
				semantic_offset: { type: "integer", default: 0, minimum: 0, maximum: 99998 },
				limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
				offset: { type: "integer", default: 0, minimum: 0 },
				max_output_tokens: { type: "integer", default: 3200, minimum: 128, maximum: 1000000 },
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
				fields: { type: "array", items: { type: "string" } },
				detail: { type: "string", enum: ["ids", "default"], default: "default" },
			},
		},
		injectProject: true,
		admin: false,
	},
	{
		name: "query_graph",
		description:
			"Read-only Cypher for multi-hop, aggregation, complexity, or cross-service analysis. Default: 200 visible rows with exact/lower-bound totals and truncation; continue safely with next_cursor. graph=missed is a file tree of flagged coverage gaps; absence is not proof of completeness. Use get_graph_schema(diagnostics=full) for properties.",
		snippet: "Run read-only Cypher against the code graph",
		schema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Cypher query" },
				graph: {
					type: "string",
					enum: ["code", "missed"],
					default: "code",
					description: "code graph (default) or missed coverage-gap file tree.",
				},
				max_rows: {
					type: "integer",
					description: "Visible rows (default 200; max 99998); 0 uses the legacy maximum. Evaluation is unchanged.",
					minimum: 0,
					default: 200,
				},
				offset: {
					type: "integer",
					minimum: 0,
					default: 0,
					description: "Live compatibility paging; cannot be combined with cursor.",
				},
				cursor: {
					type: "string",
					description: "Snapshot continuation; keep query/project/graph. Format, budget, and max_rows may change.",
				},
				max_output_tokens: { type: "integer", minimum: 128, maximum: 1000000 },
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
			},
			required: ["query"],
		},
		injectProject: true,
		admin: false,
	},
	{
		name: "trace_path",
		description:
			"Trace callers/callees, data flow, or cross-service paths. Defaults exclude tests and resolver evidence. Rows keep qn/hop with explicit totals, relations, and continuations.",
		snippet: "Trace callers, callees, data flow, or cross-service paths from a function",
		guidelines: [
			"Use trace_path (not repeated search_graph) for callers, impact, or blast-radius questions; keep depth shallow.",
		],
		schema: {
			type: "object",
			properties: {
				function_name: { type: "string" },
				direction: { type: "string", enum: ["inbound", "outbound", "both"], default: "both" },
				depth: { type: "integer", default: 3, minimum: 1, maximum: 15 },
				limit: {
					type: "integer",
					default: 100,
					minimum: 1,
					maximum: 5000,
					description: "Rows/page; gte flags the 5000-node engine ceiling.",
				},
				max_output_tokens: { type: "integer", default: 3200, minimum: 128, maximum: 1000000 },
				cursor: { type: "string" },
				mode: { type: "string", enum: ["calls", "data_flow", "cross_service"], default: "calls" },
				parameter_name: { type: "string" },
				edge_types: { type: "array", items: { type: "string" } },
				risk_labels: { type: "boolean", default: false },
				include_tests: { type: "boolean", default: false },
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
				include_evidence: { type: "boolean", default: false },
			},
			required: ["function_name"],
		},
		injectProject: true,
		admin: false,
	},
	{
		name: "get_code_snippet",
		description:
			"Read a search_graph symbol. auto bounds source and outlines large containers; full restores up to 500 lines. Source/outline pages continue; coverage_note marks gaps.",
		snippet: "Read the source of one symbol by qualified name",
		schema: {
			type: "object",
			properties: {
				qualified_name: { type: "string", description: "search_graph qn, or short name." },
				include_neighbors: { type: "boolean", default: false },
				source_mode: { type: "string", enum: ["auto", "full", "outline"], default: "auto" },
				member_limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
				member_offset: { type: "integer", default: 0, minimum: 0 },
				start_line: { type: "integer", minimum: 1 },
				max_lines: { type: "integer", minimum: 1, maximum: 500 },
				max_output_tokens: { type: "integer", minimum: 128, maximum: 1000000 },
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
			},
			required: ["qualified_name"],
		},
		injectProject: true,
		admin: false,
	},
	{
		name: "get_file_outline",
		description:
			"Declaration outline of one exact repository-relative file: optional exact label filter, source order, exact total/offset/limit paging; file/folder/container nodes excluded.",
		snippet: "List the declarations in one file",
		schema: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "Exact repository-relative file path" },
				labels: { type: "array", items: { type: "string" }, maxItems: 16 },
				limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
				offset: { type: "integer", minimum: 0, default: 0 },
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
			},
			additionalProperties: false,
			required: ["file_path"],
		},
		injectProject: true,
		admin: false,
	},
	{
		name: "get_graph_schema",
		description: "Get node-label and edge-type counts. diagnostics=full also lists queryable properties.",
		snippet: "Show graph node labels, edge types, and queryable properties",
		guidelines: ["Use get_graph_schema(diagnostics=full) before writing query_graph Cypher."],
		schema: {
			type: "object",
			properties: {
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
				diagnostics: { type: "string", enum: ["none", "full"], default: "none" },
				limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
				offset: { type: "integer", default: 0 },
			},
		},
		injectProject: true,
		admin: false,
	},
	{
		name: "compare_graphs",
		description:
			"Compare two indexed snapshots: deterministic target-only additions and base-only removals of stable node/edge identities; each set capped by limit and a 512 KiB budget with exact totals and truncation reasons.",
		snippet: "Diff two indexed projects",
		schema: {
			type: "object",
			properties: {
				base_project: { type: "string", minLength: 1 },
				target_project: { type: "string", minLength: 1 },
				limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
				scan_limit: { type: "integer", minimum: 1, maximum: 10000000, default: 2000000 },
			},
			additionalProperties: false,
			required: ["base_project", "target_project"],
		},
		injectProject: false,
		admin: false,
	},
	{
		name: "get_architecture",
		description:
			"Compact counts, languages, packages, entry points. Request structure, dependencies, routes, hotspots, boundaries, layers, clusters, cycles, or file_tree; path scopes a directory.",
		snippet: "Summarize a project's architecture: packages, entry points, routes, hotspots",
		schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory prefix (for example apps/hoa)." },
				aspects: {
					type: "array",
					items: {
						type: "string",
						enum: [
							"all",
							"overview",
							"structure",
							"dependencies",
							"routes",
							"languages",
							"packages",
							"entry_points",
							"hotspots",
							"boundaries",
							"layers",
							"file_tree",
							"clusters",
							"cycles",
						],
					},
				},
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
			},
		},
		injectProject: true,
		admin: false,
	},
	{
		name: "search_code",
		description: "Graph-ranked text search: compact symbols, full bounded source, or file paths.",
		snippet: "Text-search indexed files with graph-ranked results",
		schema: {
			type: "object",
			properties: {
				pattern: { type: "string" },
				file_pattern: { type: "string" },
				path_filter: { type: "string" },
				mode: { type: "string", enum: ["compact", "full", "files"], default: "compact" },
				context: { type: "integer" },
				regex: { type: "boolean", default: false },
				debug: { type: "boolean", default: false },
				limit: { type: "integer", default: 10, minimum: 1, maximum: 500 },
				result_limit: { type: "integer", default: 10, minimum: 1, maximum: 500 },
				result_offset: { type: "integer", default: 0, minimum: 0 },
				raw_limit: { type: "integer", default: 5, minimum: 0, maximum: 100 },
				raw_offset: { type: "integer", default: 0, minimum: 0 },
				raw_content_offset: { type: "integer", minimum: 0 },
				directory_limit: { type: "integer", default: 20, minimum: 0, maximum: 64 },
				directory_offset: { type: "integer", default: 0, minimum: 0 },
				match_limit: { type: "integer", default: 8, minimum: 1, maximum: 500 },
				source_max_lines: { type: "integer", default: 20, minimum: 1, maximum: 200 },
				max_output_tokens: { type: "integer", minimum: 128, maximum: 1000000 },
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
			},
			required: ["pattern"],
		},
		injectProject: true,
		admin: false,
	},
	{
		name: "list_projects",
		description: "List projects with stable paging. Identity is lean; stats adds graph sizes.",
		snippet: "List every indexed project",
		schema: {
			type: "object",
			properties: {
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
				detail: { type: "string", enum: ["identity", "stats"], default: "identity" },
				include_details: { type: "boolean", default: false },
				limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
				offset: { type: "integer", default: 0, minimum: 0 },
				metadata_only: { type: "boolean", default: false },
			},
		},
		injectProject: false,
		admin: false,
	},
	{
		name: "index_status",
		description:
			"Project readiness, counts, root, and coverage gaps. diagnostics adds coverage rows; verbose adds Git paths. Best-effort only; verify cited paths with check_index_coverage.",
		snippet: "Report what is indexed for the session project and when",
		schema: {
			type: "object",
			properties: {
				verbose: { type: "boolean", default: false },
				diagnostics: { type: "string", enum: ["none", "summary", "full"], default: "none" },
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
			},
		},
		injectProject: true,
		admin: false,
	},
	{
		name: "check_index_coverage",
		description:
			"Best-effort exact-path/scope coverage and freshness, paged separately. full diagnostics adds raw detail. Clean is not proof of completeness.",
		snippet: "Check whether specific paths are indexed and fresh",
		guidelines: [
			"Run check_index_coverage before asserting that something does not exist, is dead code, or is fully covered.",
		],
		schema: {
			type: "object",
			properties: {
				paths: { type: "array", items: { type: "string" }, maxItems: 128 },
				path_limit: { type: "integer", default: 20, minimum: 1, maximum: 128 },
				path_offset: { type: "integer", default: 0, minimum: 0 },
				scopes: { type: "array", items: { type: "string" }, maxItems: 32 },
				scope_limit: { type: "integer", default: 20, minimum: 1, maximum: 1000 },
				scope_offset: { type: "integer", default: 0, minimum: 0 },
				diagnostics: { type: "string", enum: ["none", "full"], default: "none" },
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
			},
		},
		injectProject: true,
		admin: false,
	},
	{
		name: "detect_changes",
		description: "Map a Git diff to files and impact. Page with snapshot cursors.",
		snippet: "Map the working-tree diff to files and impacted symbols",
		schema: {
			type: "object",
			properties: {
				scope: { type: "string", enum: ["files", "impact"], default: "impact" },
				direction: { type: "string", enum: ["inbound", "outbound", "both"], default: "inbound" },
				depth: { type: "integer", default: 2 },
				limit: { type: "integer", default: 200, maximum: 5000 },
				impact_offset: { type: "integer", default: 0, minimum: 0 },
				impact_cursor: { type: "string" },
				changed_limit: { type: "integer", default: 20, minimum: 0, maximum: 5000 },
				changed_offset: { type: "integer", default: 0, minimum: 0 },
				changed_cursor: { type: "string" },
				module_limit: { type: "integer", default: 20, minimum: 0, maximum: 256 },
				module_offset: { type: "integer", default: 0, minimum: 0 },
				module_cursor: { type: "string" },
				max_output_tokens: { type: "integer", default: 3200, minimum: 128, maximum: 1000000 },
				base_branch: { type: "string", default: "main" },
				since: { type: "string" },
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
			},
		},
		injectProject: true,
		admin: false,
	},
	{
		name: "index_repository",
		description:
			"Index a repository. full/moderate add semantics; fast omits them; cross-repo-intelligence links services. Reports coverage gaps. The daemon indexes this session's project automatically on connect; call this only to reindex a different path by hand.",
		snippet: "Index a repository into the graph (usually automatic)",
		schema: {
			type: "object",
			properties: {
				repo_path: { type: "string", description: "Repository path" },
				mode: {
					type: "string",
					enum: ["full", "moderate", "fast", "cross-repo-intelligence"],
					default: "full",
					description:
						"full: all+semantic; moderate: filtered+semantic; fast: filtered only; cross-repo-intelligence: link services.",
				},
				target_projects: {
					type: "array",
					items: { type: "string" },
					description: "Cross-repo targets; [\"*\"] means all.",
				},
				name: {
					type: "string",
					description: "Name override; Non-ASCII bytes are encoded; unsafe characters normalized.",
				},
				persistence: { type: "boolean", default: false, description: "Write .codebase-memory/graph.db.zst." },
			},
			required: ["repo_path"],
		},
		injectProject: false,
		admin: true,
	},
	{
		name: "delete_project",
		description: "Delete a project from the index",
		snippet: "Delete an indexed project",
		schema: { type: "object", properties: {}, required: [] },
		injectProject: true,
		admin: true,
	},
	{
		name: "manage_adr",
		description:
			"Architecture Decision Records for the project. outline lists headings, get reads, update replaces the whole document, set_sections rewrites only the named sections and leaves every other byte untouched, sections is legacy.",
		snippet: "Read or write the project's architecture decision record",
		schema: {
			type: "object",
			properties: {
				mode: {
					type: "string",
					enum: ["outline", "get", "update", "set_sections", "sections"],
					default: "outline",
					description:
						"outline pages headings; get reads; update replaces the whole document; set_sections rewrites only the named sections and leaves every other byte untouched (an identical repeated write is byte-identical, so retrying is safe); sections is legacy.",
				},
				content: { type: "string", description: "Whole document for update" },
				section_updates: {
					type: "object",
					description:
						"set_sections: section name -> new body. Any heading name works; names match exactly, including case.",
					additionalProperties: { type: "string" },
				},
				section_limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
				section_offset: { type: "integer", default: 0, minimum: 0 },
				format: { type: "string", enum: ["tree", "json"], default: "tree" },
			},
			additionalProperties: false,
		},
		injectProject: true,
		admin: true,
	},
	{
		name: "ingest_traces",
		description: "Validate and count traces; graph edge creation is not implemented",
		snippet: "Validate runtime traces against the graph",
		schema: {
			type: "object",
			properties: {
				traces: {
					type: "array",
					items: {
						type: "object",
						properties: {
							caller: { type: "string" },
							callee: { type: "string" },
							count: { type: "integer" },
						},
						additionalProperties: false,
					},
				},
			},
			required: ["traces"],
		},
		injectProject: true,
		admin: true,
	},
];

export const ADMIN_TOOL_NAMES = new Set<string>(ADMIN_TOOLS);
export const ALL_TOOL_NAMES = TOOL_SPECS.map((spec) => spec.name);

/**
 * Which tools this configuration registers.
 *
 * `enabledTools` is an allowlist when non-empty; `disabledTools` subtracts
 * after it. `adminTools: false` (the default) drops the mutating tools even
 * when neither list mentions them, so the common case needs no configuration.
 */
export function selectTools(config: CbmemConfig, specs: ToolSpec[] = TOOL_SPECS): ToolSpec[] {
	const allowed = config.enabledTools.length > 0 ? expandToolNames(config.enabledTools) : undefined;
	const denied = expandToolNames(config.disabledTools);
	return specs.filter((spec) => {
		if (denied.has(spec.name)) return false;
		if (allowed) return allowed.has(spec.name);
		return config.adminTools ? true : !spec.admin;
	});
}

/**
 * The wire schema: the tool's own properties plus an optional `project`, which
 * the caller fills in from the session when the model omits it.
 */
export function wireParameters(spec: ToolSpec): Record<string, unknown> {
	const schema = JSON.parse(JSON.stringify(spec.schema)) as {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	if (!spec.injectProject) return schema;
	schema.properties = { project: projectParam, ...(schema.properties ?? {}) };
	if (schema.required) {
		const required = schema.required.filter((name) => name !== "project");
		if (required.length > 0) schema.required = required;
		else delete schema.required;
	}
	return schema;
}
