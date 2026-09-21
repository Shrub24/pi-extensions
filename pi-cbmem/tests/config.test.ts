import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import {
	DEFAULTS,
	expandToolNames,
	projectFromPath,
	readSettingsFile,
	resolveConfig,
	sessionProjectFor,
} from "../extensions/config.js";
import { selectTools, TOOL_SPECS, wireParameters } from "../extensions/tools.js";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

test("defaults register the query surface and no admin tools", () => {
	const config = resolveConfig({}, EMPTY_ENV);
	expect(config).toEqual(DEFAULTS);
	const names = selectTools(config).map((spec) => spec.name);
	expect(names).not.toContain("index_repository");
	expect(names).not.toContain("delete_project");
	expect(names).not.toContain("manage_adr");
	expect(names).not.toContain("ingest_traces");
	expect(names).toContain("search_graph");
	expect(names).toHaveLength(13);
});

test("adminTools adds exactly the four mutating tools", () => {
	const config = resolveConfig({ adminTools: true }, EMPTY_ENV);
	const names = selectTools(config).map((spec) => spec.name);
	expect(names).toHaveLength(17);
	for (const name of ["index_repository", "delete_project", "manage_adr", "ingest_traces"]) {
		expect(names).toContain(name);
	}
});

test("enabledTools is an allowlist and disabledTools subtracts after it", () => {
	const allow = resolveConfig({ enabledTools: ["search_graph", "trace_path"] }, EMPTY_ENV);
	expect(selectTools(allow).map((spec) => spec.name)).toEqual(["search_graph", "trace_path"]);

	const subtract = resolveConfig(
		{ enabledTools: ["search_graph", "trace_path"], disabledTools: "trace_path" },
		EMPTY_ENV,
	);
	expect(selectTools(subtract).map((spec) => spec.name)).toEqual(["search_graph"]);

	// An allowlist bypasses adminTools: naming an admin tool is the opt-in.
	const explicit = resolveConfig({ enabledTools: ["delete_project"] }, EMPTY_ENV);
	expect(selectTools(explicit).map((spec) => spec.name)).toEqual(["delete_project"]);
});

test("the admin group name expands", () => {
	const config = resolveConfig({ disabledTools: "admin" }, EMPTY_ENV);
	const expanded = expandToolNames(config.disabledTools);
	expect(expanded.has("delete_project")).toBe(true);
	expect(expanded.has("search_graph")).toBe(false);
});

test("environment overrides win over the settings file", () => {
	const settings = { binary: "/from/file", requestTimeoutMs: 1000, enabled: true, adminTools: false };
	const env = {
		PI_CBMEM_BINARY: "/from/env",
		PI_CBMEM_REQUEST_TIMEOUT_MS: "5000",
		PI_CBMEM_ADMIN_TOOLS: "1",
		PI_CBMEM_DISABLED: "1",
	} as NodeJS.ProcessEnv;
	const config = resolveConfig(settings, env);
	expect(config.binary).toBe("/from/env");
	expect(config.requestTimeoutMs).toBe(5000);
	expect(config.adminTools).toBe(true);
	expect(config.enabled).toBe(false);
});

test("malformed values fall back to the default rather than throwing", () => {
	const config = resolveConfig(
		{ requestTimeoutMs: -5, binary: "", project: "   ", enabled: "yes", notifyOnError: 7 },
		EMPTY_ENV,
	);
	expect(config.requestTimeoutMs).toBe(DEFAULTS.requestTimeoutMs);
	expect(config.binary).toBe(DEFAULTS.binary);
	expect(config.project).toBeUndefined();
	expect(config.enabled).toBe(true);
	expect(config.notifyOnError).toBe(true);
});

test("every tool carries a snippet so the tool list stays one line per tool", () => {
	for (const spec of TOOL_SPECS) {
		expect(spec.snippet.length).toBeGreaterThan(0);
		expect(spec.snippet).not.toContain("\n");
	}
});

test("the wire schema makes project optional exactly where the session project applies", () => {
	for (const spec of TOOL_SPECS) {
		const schema = wireParameters(spec) as {
			properties?: Record<string, unknown>;
			required?: string[];
		};
		const hasProject = Boolean(schema.properties?.project);
		expect(hasProject).toBe(spec.injectProject);
		expect(schema.required ?? []).not.toContain("project");
	}
});

test("compare_graphs keeps its two explicit project arguments", () => {
	const spec = TOOL_SPECS.find((entry) => entry.name === "compare_graphs");
	expect(spec?.injectProject).toBe(false);
	const schema = wireParameters(spec!) as { properties: Record<string, unknown>; required: string[] };
	expect(Object.keys(schema.properties)).toContain("base_project");
	expect(Object.keys(schema.properties)).toContain("target_project");
	expect(schema.properties.project).toBeUndefined();
});

test("project names match the server's derivation", () => {
	// Path separators, spaces, and '@' all map to '-', and repeats collapse.
	expect(projectFromPath("/a/b-c/d")).toBe("a-b-c-d");
	expect(projectFromPath("/home/u/my project")).toBe("home-u-my-project");
	expect(projectFromPath("/x/@scope/pkg")).toBe("x-scope-pkg");
	// Repeated separators collapse to one dash.
	expect(projectFromPath("/a//b")).toBe("a-b");
	// Non-ASCII bytes transliterate to lowercase hex, two digits per byte.
	expect(projectFromPath("/tmp/caf\u00e9")).toBe("tmp-cafc3a9");
	// The empty result is "root", which the session never treats as a project.
	expect(projectFromPath("/")).toBe("root");
});

test("cwd at / or $HOME has no session project", () => {
	expect(sessionProjectFor("/", { HOME: "/home/u" } as NodeJS.ProcessEnv)).toBeUndefined();
	expect(sessionProjectFor("/home/u", { HOME: "/home/u" } as NodeJS.ProcessEnv)).toBeUndefined();
	expect(sessionProjectFor("/home/u/code/app", { HOME: "/home/u" } as NodeJS.ProcessEnv)).toBe("home-u-code-app");
});

test("settings are read from the user settings file only", () => {
	const dir = `${process.env.TMPDIR ?? "/tmp"}/pi-cbmem-settings-${process.pid}`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		`${dir}/settings.json`,
		JSON.stringify({
			kendex: {
				extensionManager: {
					config: { "@vanillagreen/pi-cbmem": { adminTools: true, binary: "/pinned/cbm" } },
				},
			},
		}),
	);
	try {
		const settings = readSettingsFile({ PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv);
		expect(settings).toEqual({ adminTools: true, binary: "/pinned/cbm" });
		expect(resolveConfig(settings, EMPTY_ENV).binary).toBe("/pinned/cbm");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
