import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { applyTaskToolSurface, registerAll, type RegistrationDeps } from "../extensions/registrations.js";
import { taskSurfaceGuidance } from "../extensions/tool-surface.js";
import { createToolRegistry, declaredActionEnum, declaredSchemaText } from "./fixtures/tool-surface-harness.js";

// Task 4.1: the declared surface for each session mode.
//
// The assertion target is the effective registry and prompt, not the TypeBox
// literal a tool was handed: `createToolRegistry` is the model of Pi's real
// activation and prompt-assembly rules (see the fixture for the host citations),
// and every row below reads the answer back out of it. A real boot is verified
// separately by the fresh-host check.

const unused = () => {
	throw new Error("surface test reached an unrelated operation");
};

/** The minimum deps `registerAll` needs; nothing here executes a tool. */
const deps = (): RegistrationDeps =>
	({
		getActiveCtx: () => null,
		setActiveCtx: unused,
		rememberSnapshot: unused,
		sortedTasks: unused,
		formatTaskListText: unused,
		getTaskOutput: unused,
		resolveTask: unused,
		readTaskResult: unused,
		stopTaskConfirmed: unused,
		requestStop: unused,
		extendSoftTimeout: unused,
		spawnTask: unused,
		similarRunningTasks: unused,
		recentlyFinishedTasks: unused,
		oldestRunningTask: unused,
		waitForTask: unused,
		consumeObservedExitWake: unused,
		clearFinishedTasks: unused,
		armForcedBackground: unused,
		toggleWidget: unused,
		dashboardDeps: {
			sortedTasks: unused,
			getTask: unused,
			getTaskOutput: unused,
			requestStop: unused,
			clearFinishedTasks: unused,
			formatTaskListText: unused,
		},
		dashboardShortcut: "none",
		backgroundBashShortcut: "none",
		widgetToggleShortcut: "none",
	}) as unknown as RegistrationDeps;

/** A host whose registry is the real activation model, driven like Pi drives it. */
function surfaceFor(mode: string | undefined, options: { activeTools?: string[]; excludedTools?: string[] } = {}) {
	const registry = createToolRegistry(options);
	const pi = {
		registerTool(tool: { name: string }) {
			registry.register(tool as never);
		},
		registerCommand() {},
		registerShortcut() {},
	} as never;
	const registrationDeps = deps();
	// What the extension does at load, before the mode is known.
	registerAll(pi, registrationDeps);
	const atLoad = { active: registry.getActiveTools(), names: registry.getAllTools().map((tool) => tool.name) };
	// What it does again from `session_start`, when ctx.mode is known.
	const surface = applyTaskToolSurface(pi, registrationDeps, mode);
	return { registry, surface, atLoad };
}

const toolNamed = (registry: ReturnType<typeof createToolRegistry>, name: string) =>
	registry.getAllTools().find((tool) => tool.name === name);

test("only the interactive TUI is narrowed; every other mode keeps the compatibility surface", () => {
	const rows = [
		{ mode: "tui", expected: "tui" },
		{ mode: "print", expected: "compat" },
		{ mode: "json", expected: "compat" },
		{ mode: "rpc", expected: "compat" },
		// The installed mode union has no `"unknown"` member, so this is the
		// runtime guard a mode this build does not know falls into.
		{ mode: "future-mode", expected: "compat" },
		{ mode: undefined, expected: "compat" },
	];
	for (const row of rows) {
		expect(surfaceFor(row.mode).surface, `mode ${String(row.mode)}`).toBe(row.expected);
	}
});

test("bg_status is never registered at load, and only the compatibility modes register it at all", () => {
	// At load the mode is unknown, so the conservative surface is declared — and
	// `bg_status` is deliberately absent, because a mode that must not expose it
	// can then never have to remove a definition it already declared.
	const tui = surfaceFor("tui");
	expect(tui.atLoad.names, "load registers bg_task only").toStrictEqual(["bg_task"]);
	expect(tui.registry.getAllTools().map((tool) => tool.name), "TUI never registers bg_status").toStrictEqual(["bg_task"]);

	const compat = surfaceFor("print");
	expect(compat.registry.getAllTools().map((tool) => tool.name).sort()).toStrictEqual(["bg_status", "bg_task"]);
});

test("the declared action enum is exactly the five TUI actions, and the full set everywhere else", () => {
	const tui = surfaceFor("tui");
	expect(declaredActionEnum(toolNamed(tui.registry, "bg_task")!)).toStrictEqual(["spawn", "get", "stop", "list", "extend"]);

	const compat = surfaceFor("print");
	expect(declaredActionEnum(toolNamed(compat.registry, "bg_task")!)).toStrictEqual([
		"spawn",
		"list",
		"log",
		"get",
		"stop",
		"clear",
		"wait",
		"extend",
	]);
});

test("the TUI prompt never recommends bg_status or the bounded wait, and no mode's prompt names an absent tool", () => {
	const cases = [
		{ mode: "tui", forbiddenTools: ["bg_status"] },
		{ mode: "print", forbiddenTools: [] as string[] },
		{ mode: "json", forbiddenTools: [] as string[] },
		{ mode: "rpc", forbiddenTools: [] as string[] },
		{ mode: "future-mode", forbiddenTools: [] as string[] },
	];
	for (const testCase of cases) {
		const { registry, surface } = surfaceFor(testCase.mode);
		const prompt = registry.systemPromptSurface();
		const text = [...prompt.availableTools, ...prompt.guidelines].join("\n");
		const active = registry.getActiveTools();
		// Every tool named by the prompt must actually be declared and active here;
		// the reverse is what the per-mode rows below pin.
		for (const name of ["bg_task", "bg_status"]) {
			const named = text.includes(name);
			expect(named, `${testCase.mode}: the prompt names ${name} only when it is active`).toBe(active.includes(name));
		}
		for (const forbidden of testCase.forbiddenTools) {
			expect(text, `${testCase.mode}: the prompt must not name ${forbidden}`).not.toContain(forbidden);
		}
		if (surface === "tui") {
			expect(text, "TUI guidance must not recommend the absent bounded wait").not.toContain('action:"wait"');
			expect(text, "TUI guidance must not name the absent status tool").not.toContain("bg_status");
			expect(text, "TUI guidance must not offer compatibility-wait advice").not.toContain("noninteractive or child caller");
			expect(text, "TUI guidance recommends ending the turn for the wake").toContain("finish the turn");
		} else {
			expect(text, "compatibility guidance names the retained bounded wait").toContain('action:"wait"');
			expect(text, "compatibility guidance names what the wait is for").toContain("noninteractive or child caller");
		}
	}
});

test("the declared parameter schema never names an action the same schema does not declare", () => {
	const tui = surfaceFor("tui");
	const tuiSchema = declaredSchemaText(toolNamed(tui.registry, "bg_task")!);
	for (const absent of ['action=log', 'action=wait', "action=\"log\"", 'waitSeconds', 'action="wait"']) {
		expect(tuiSchema, `the TUI schema must not name ${absent}`).not.toContain(absent);
	}
	// `extend` is declared in the TUI now, so its action and its parameter are named.
	expect(tuiSchema, "the TUI schema names the extend action it declares").toContain("action=extend");
	// The properties that exist only for those actions are not declared either.
	expect(tuiSchema, "the TUI schema declares no bounded wait window").not.toContain("taskWaitDefaultSeconds");
	expect(tuiSchema, "the TUI schema names the actions it does declare").toContain("action=get");

	// The compatibility schema keeps every field and description it had.
	const compat = declaredSchemaText(toolNamed(surfaceFor("print").registry, "bg_task")!);
	for (const present of ["action=log", "action=wait", "action=extend", "waitSeconds", "taskWaitDefaultSeconds"]) {
		expect(compat, `the compatibility schema keeps ${present}`).toContain(present);
	}
});

test("an explicit tool selection is preserved, including one that excludes the late tool", () => {
	// No selection: the late registration activates through the ordinary path.
	const open = surfaceFor("print");
	expect(open.registry.getActiveTools()).toContain("bg_status");

	// A selection that NAMES the tool: it is registered late, after the allowlist
	// was applied, and must still be honoured.
	const named = surfaceFor("json", { activeTools: ["bg_task", "bg_status"] });
	expect(named.registry.getActiveTools().sort()).toStrictEqual(["bg_status", "bg_task"]);

	// A selection that OMITS it: late registration must not force it on.
	const omitted = surfaceFor("json", { activeTools: ["bg_task"] });
	expect(omitted.registry.getActiveTools()).toStrictEqual(["bg_task"]);

	// An exclusion is honoured too: the tool is not even registered.
	const excluded = surfaceFor("print", { excludedTools: ["bg_status"] });
	expect(excluded.registry.getAllTools().map((tool) => tool.name)).toStrictEqual(["bg_task"]);
});

test("a pre-existing active selection survives the mode surface being applied", () => {
	const { registry } = surfaceFor("print");
	// A user or another extension narrowed the set before/after load, exactly as
	// `setActiveTools` allows; applying the surface must not widen it back.
	registry.setActiveTools(["bg_task"]);
	expect(registry.getActiveTools()).toStrictEqual(["bg_task"]);
});

/**
 * The soft reminder the TUI now receives names the `extend` lever the surface
 * declares, so the agent can re-arm the interval instead of only choosing it at
 * spawn. `wake-events.ts` renders this field, so the wake text and the schema
 * cannot disagree about the operation that exists.
 */
test("the TUI soft reminder offers the extend lever its surface declares", () => {
	const choices = taskSurfaceGuidance("tui").softReminderChoices;
	expect(choices).toContain('bg_task action:"extend"');
	expect(choices, "the reminder states that continuing repeats the same interval").toContain("same interval");
});

/**
 * Task 4.5: the installed append-system block is shared by every mode, so it may
 * not name a tool or action some mode lacks, may not present push-only
 * end-response waiting as the only way to await a result, and may not advertise
 * a mutable live log as the way to read one.
 */
test("the installed append-system block is mode-neutral", () => {
	const instructions = readFileSync(new URL("../instructions.md", import.meta.url), "utf8");
	// Absent in TUI, so the shared block may not name them at all.
	expect(instructions).not.toContain("bg_status");
	expect(instructions).not.toContain('action:"wait"');
	expect(instructions).not.toContain("pi-bg path");
	expect(instructions).not.toContain("pi-bg peek");
	expect(instructions).not.toContain("pi-bg read");
	// Push-only waiting is qualified for a caller that cannot end its response.
	expect(instructions).toContain("A caller that cannot end its response before it has the result");
	// The retired inferred read is not advertised as an acknowledgment.
	expect(instructions).toContain("never by reading a log file");
	// The declared operations it does name are common to every mode.
	for (const named of ["`pi-bg get <task-id> [--output]`", "`pi-bg list`", "`pi-bg stop <task-id>`"]) {
		expect(instructions).toContain(named);
	}
});

/**
 * Task 4.2: an exact-literal audit over every model-facing and transcript-facing
 * text surface, so a live log path cannot creep back in by prose. The structured
 * task snapshot keeps `logFile` as machine metadata (asserted in
 * `tests/log-tool-result-bounds.test.ts`); what this checks is that no *text*
 * invites a read of it.
 */
test("no model-facing text advertises the mutable live log path as the retrieval route", () => {
	const advertising = [
		/Full log:/,
		/full log:/,
		/Full background log:/,
		/on disk at/,
		/\bLog: \$\{/,
		/\bLog: /,
		// The retired live-path helpers may not be advertised as a route either.
		/pi-bg (?:path|peek|read)/,
		/use the Log file/,
	];
	const surfaces = [
		"../extensions/registrations.ts",
		"../extensions/auto-background.ts",
		"../extensions/wake-events.ts",
		"../extensions/managed-bash.ts",
		"../extensions/task-wait.ts",
		"../extensions/format.ts",
		"../extensions/render.ts",
	];
	for (const surface of surfaces) {
		const source = readFileSync(new URL(surface, import.meta.url), "utf8");
		for (const pattern of advertising) {
			expect(source, `${surface} must not advertise a live log: ${pattern}`).not.toMatch(pattern);
		}
	}
	// The only path a full read may advertise is the immutable artifact, which is
	// a different field from the task snapshot's live `logFile`.
	const registrations = readFileSync(new URL("../extensions/registrations.ts", import.meta.url), "utf8");
	expect(registrations, "the full read names the artifact").toContain("fullOutputPath: truncateForTranscript(handoff.artifact.path");
	expect(registrations, "the raw log action advertises no path at all").not.toContain("fullOutputPath: truncateForTranscript(task.logFile");

	// An action the narrowed surface does not declare may not be recommended from
	// text that a TUI session can receive. These producers all read the resolved
	// surface; naming a fixed action is how this regressed.
	const actionProducers = [
		"../extensions/wake-events.ts",
		"../extensions/auto-background.ts",
		"../extensions/managed-bash.ts",
	];
	for (const producer of actionProducers) {
		const source = readFileSync(new URL(producer, import.meta.url), "utf8");
		expect(source, `${producer} must resolve its surface`).toContain("tool-surface.js");
		expect(source, `${producer} must not hard-code a narrowed-away raw log action`).not.toMatch(/bg_task log/);
	}
});

/**
 * Task 4.5 also covers the written surfaces: the fork delta may not advertise a
 * mechanism that no longer exists, the mode split has to be stated where a
 * maintainer and an operator will look, and the changelog has to record both the
 * surface switch and the retirement. These are the documents the repo ships.
 */
test("the shipped documents describe the mode surface and the retired mechanisms", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const development = readFileSync(new URL("../DEVELOPMENT.md", import.meta.url), "utf8");
	const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

	// The mode split is stated in the consumer docs and the maintainer notes.
	expect(readme, "the README states the TUI action set").toContain("`spawn/get/stop/list/extend`");
	expect(readme, "the README states the compatibility surface").toContain("`bg_status`");
	expect(development, "the maintainer notes name the single surface module").toContain("extensions/tool-surface.ts");
	expect(development, "and say why it is declared at session_start").toContain("never at factory load");

	// The retired mechanisms are described as retired, not as still present.
	const forkDelta = readme.slice(readme.indexOf("## Fork delta"));
	for (const retired of ["read shim (`read-shim.ts`)", "sleep-as-wait interception", "consume logs"]) {
		expect(forkDelta, `the fork delta records ${retired} as retired`).toContain(retired);
	}
	expect(forkDelta, "and says so").toContain("retired");
	expect(readme, "the CLI helpers are stated as removed").toContain("are **removed**");
	expect(forkDelta, "the fork delta no longer claims the shim is present").not.toMatch(/a read shim \(`read-shim\.ts`\) so a log read/);

	// The changelog records the consumer-visible contract changes.
	const unreleased = changelog.slice(changelog.indexOf("### Unreleased"), changelog.indexOf("### 2.1.1"));
	expect(unreleased, "the surface switch is recorded").toContain("session mode");
	expect(unreleased, "the acknowledgment change is recorded").toContain("no longer acknowledges its completion");
	expect(unreleased, "and the migration is named").toContain("pi-bg get <task-id> [--output]");
});
