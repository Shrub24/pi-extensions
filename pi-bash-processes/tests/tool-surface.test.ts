import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { bashPromptGuidelines, registerAll, registerBgTaskTool, type RegistrationDeps } from "../extensions/registrations.js";
import { BASH_TASK_GUIDELINES, BG_TASK_ACTIONS, retrievalHint, TASK_GUIDANCE, wakeTaskLine } from "../extensions/tool-surface.js";
import { startExtensionHost } from "./fixtures/extension-host.js";
import { createToolRegistry, declaredActionEnum, declaredSchemaText } from "./fixtures/tool-surface-harness.js";

// The declared surface. Background tasks exist only in the interactive TUI, with
// one `bg_task` whose action set is spawn/get/stop/list/extend. Every other mode
// declares nothing and keeps Pi's own bash.
//
// The assertion target is the effective registry and prompt, not the TypeBox
// literal a tool was handed: `createToolRegistry` is the model of Pi's real
// activation and prompt-assembly rules (see the fixture for the host citations).

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

/** A registry driven like Pi drives it, with the tool declared as `session_start` declares it. */
function surface(options: { activeTools?: string[]; excludedTools?: string[] } = {}) {
	const registry = createToolRegistry(options);
	const pi = {
		registerTool(tool: { name: string }) {
			registry.register(tool as never);
		},
		registerCommand() {},
		registerShortcut() {},
	} as never;
	const registrationDeps = deps();
	registerAll(pi, registrationDeps);
	const atLoad = { names: registry.getAllTools().map((tool) => tool.name) };
	registerBgTaskTool(pi, registrationDeps);
	return { registry, atLoad };
}

const bgTask = (registry: ReturnType<typeof createToolRegistry>) => registry.getAllTools().find((tool) => tool.name === "bg_task")!;

/** The text the model is given: the available-tool lines and every guideline. */
function promptText(): string {
	const prompt = surface().registry.systemPromptSurface();
	return [...prompt.availableTools, ...prompt.guidelines].join("\n");
}

test("loading the extension declares no tool; the mode decides at session_start", () => {
	expect(surface().atLoad.names).toStrictEqual([]);
});

test("the TUI declares exactly one tool with exactly five actions", () => {
	const { registry } = surface();
	expect(registry.getAllTools().map((tool) => tool.name)).toStrictEqual(["bg_task"]);
	expect(declaredActionEnum(bgTask(registry))).toStrictEqual([...BG_TASK_ACTIONS]);
	expect([...BG_TASK_ACTIONS]).toStrictEqual(["spawn", "get", "stop", "list", "extend"]);
});

test("a session that is not the TUI declares no bash and no bg_task", async () => {
	for (const mode of ["print", "json", "rpc", "future-mode"]) {
		const host = await startExtensionHost({ mode });
		try {
			expect(host.allTools().map((tool) => tool.name), `${mode}: nothing is declared`).toStrictEqual([]);
		} finally {
			await host.dispose();
		}
	}
});

test("the prompt recommends ending the turn and names no operation the surface lacks", () => {
	const text = promptText();
	expect(text).toContain("end the turn");
	expect(text).toContain("completion always wakes you");
	expect(text).toContain("about its expected duration");
	for (const absent of ["bg_status", 'action:"wait"', "bg_task clear", "bg_task log", "noninteractive or child caller"]) {
		expect(text, `the prompt must not name ${absent}`).not.toContain(absent);
	}
});

test("the coupled bash/bg_task contract is contributed once from one shared rule set", () => {
	const text = promptText();
	for (const rule of BASH_TASK_GUIDELINES) {
		expect(text, "shared rule is present").toContain(rule);
		expect(text.split(rule).length - 1, "shared rule appears once").toBe(1);
	}
	// The bash tool itself carries no competing copy of the shared feature rules.
	for (const rule of BASH_TASK_GUIDELINES) expect(bashPromptGuidelines().join("\n")).not.toContain(rule);
});

test("the declared parameter schema names no action the surface does not declare", () => {
	const schema = declaredSchemaText(bgTask(surface().registry));
	for (const absent of ["action=log", "action=wait", "action=clear", "waitSeconds", "taskWaitDefaultSeconds", "ids"]) {
		expect(schema, `the schema must not name ${absent}`).not.toContain(absent);
	}
	for (const present of ["action=get", "action=extend", "action=stop"]) expect(schema, `the schema names ${present}`).toContain(present);
});

test("an explicit tool selection is preserved", () => {
	expect(surface().registry.getActiveTools()).toStrictEqual(["bg_task"]);
	expect(surface({ excludedTools: ["bg_task"] }).registry.getAllTools().map((tool) => tool.name)).toStrictEqual([]);
	const { registry } = surface();
	// A user or another extension narrowed the set, exactly as `setActiveTools` allows.
	registry.setActiveTools([]);
	expect(registry.getActiveTools()).toStrictEqual([]);
});

test("the soft reminder offers the extend lever the surface declares, and no get on a running task", () => {
	expect(TASK_GUIDANCE.softReminderChoices).toContain('bg_task action:"extend"');
	expect(TASK_GUIDANCE.softReminderChoices, "continuing repeats the same interval").toContain("same interval");
	expect(TASK_GUIDANCE.softReminderChoices).toContain("end your turn");
	for (const advice of [TASK_GUIDANCE.softReminderChoices, TASK_GUIDANCE.duplicateRunning, TASK_GUIDANCE.similarRunning]) {
		expect(advice).not.toContain('action:"get"');
	}
});

test("a wake line states the task and its exit code, and the retrieval instruction is stated once", () => {
	expect(wakeTaskLine({ id: "bg-7", status: "completed", exitCode: 0 })).toBe("bg-7 · exit 0");
	expect(wakeTaskLine({ id: "bg-8", status: "running" })).toBe("bg-8 · still running");
	expect(wakeTaskLine({ id: "bg-9", status: "completed", exitCode: null })).toBe("bg-9 · ended without an exit code");
	expect(retrievalHint("bg-7")).toBe('Retrieve its result with bg_task action:"get" id: bg-7.');
	expect(retrievalHint()).toBe('Retrieve a result with bg_task action:"get" id: <id>.');
	for (const text of [promptText(), JSON.stringify(TASK_GUIDANCE), retrievalHint("bg-7")]) expect(text).not.toContain("clear");
});

/**
 * An exact-literal audit over every model-facing and transcript-facing text
 * surface, so a live log path cannot creep back in by prose. The structured task
 * snapshot keeps `logFile` as machine metadata; what this checks is that no
 * *text* invites a read of it.
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
		"../extensions/format.ts",
		"../extensions/render.ts",
	];
	for (const path of surfaces) {
		const source = readFileSync(new URL(path, import.meta.url), "utf8");
		for (const pattern of advertising) {
			expect(source, `${path} must not advertise a live log: ${pattern}`).not.toMatch(pattern);
		}
	}
	// The only path a full read may advertise is the immutable artifact, which is
	// a different field from the task snapshot's live `logFile`.
	const registrations = readFileSync(new URL("../extensions/registrations.ts", import.meta.url), "utf8");
	expect(registrations, "the full read names the artifact").toContain("fullOutputPath: truncateForTranscript(handoff.artifact.path");

	// Text producers name only declared operations; naming a fixed raw-log action is how this regressed.
	for (const producer of ["../extensions/wake-events.ts", "../extensions/auto-background.ts", "../extensions/managed-bash.ts"]) {
		const source = readFileSync(new URL(producer, import.meta.url), "utf8");
		expect(source, `${producer} must not hard-code a raw log action`).not.toMatch(/bg_task log/);
	}
});

test("the shipped documents describe the single TUI-only surface and the retired mechanisms", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const development = readFileSync(new URL("../DEVELOPMENT.md", import.meta.url), "utf8");
	const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

	expect(readme, "the README states the TUI action set").toContain("`spawn/get/stop/list/extend`");
	expect(readme, "the README states other modes are unsupported").toContain("declares no tools");
	expect(development, "the maintainer notes name the single surface module").toContain("extensions/tool-surface.ts");
	expect(development, "and say the tools are declared at session_start").toContain("declared at\n  `session_start`");

	const forkDelta = readme.slice(readme.indexOf("## Fork delta"));
	for (const retired of ["read shim (`read-shim.ts`)", "sleep-as-wait interception", "consume logs"]) {
		expect(forkDelta, `the fork delta records ${retired} as retired`).toContain(retired);
	}
	expect(readme, "the CLI helpers are stated as removed").toContain("are **removed**");

	const unreleased = changelog.slice(changelog.indexOf("### Unreleased"), changelog.indexOf("### 2.1.1"));
	expect(unreleased, "the TUI-only change is recorded").toContain("TUI-only");
	expect(unreleased, "the acknowledgment change is recorded").toContain("no longer acknowledges its completion");
	expect(unreleased, "and the migration is named").toContain("pi-bg get <task-id> [--output]");
});
