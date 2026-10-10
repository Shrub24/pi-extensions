import { mock } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

// Only the Pi host and pi-tui primitives are mocked; the dashboard's own
// ordering, scrolling and frame math run as production code.
mock.module("@earendil-works/pi-coding-agent", () => ({ getShellConfig: () => { throw new Error("unexpected spawn"); } }));
mock.module("@earendil-works/pi-ai", () => ({ StringEnum: (values: readonly string[]) => ({ enum: values }) }));
mock.module("@earendil-works/pi-tui", () => ({
	matchesKey: () => false,
	truncateToWidth: (text: string, width: number) => {
		const stripped = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		return stripped.length <= width ? text : stripped.slice(0, width);
	},
	visibleWidth: (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").length,
	wrapTextWithAnsi: (text: string, width: number) => {
		const lines: string[] = [];
		for (let index = 0; index < text.length; index += width) lines.push(text.slice(index, index + width));
		return lines.length > 0 ? lines : [""];
	},
}));
mock.module("typebox", () => {
	const schema = (value?: unknown) => ({ schema: value });
	return { Type: { Object: schema, Optional: schema, String: schema, Number: schema, Array: schema, Boolean: schema } };
});

const { openDashboard } = await import("../../extensions/dashboard.js");

type FakeTask = {
	id: string;
	title: string;
	command: string;
	cwd: string;
	pid: number;
	logFile: string;
	startedAt: number;
	updatedAt: number;
	lastOutputAt: number | null;
	expiresAt: number | null;
	status: "running" | "completed" | "failed" | "stopped" | "timed_out";
	exitCode: number | null;
	notifyOnExit: boolean;
	notifyOnOutput: boolean;
	outputBytes: number;
	terminationReason?: string;
};

// The runner feeds fixture input on stdin; this fixture needs no options but must
// drain it so the parent's write never blocks.
try {
	await new Response(Bun.stdin.stream()).text();
} catch {
	// No stdin payload: fine, this fixture takes no inputs.
}

const now = 1_700_000_000_000;
const task = (id: string, status: FakeTask["status"], startedAt: number, command = `echo ${id}`): FakeTask => ({
	id,
	title: command,
	command,
	cwd: "/tmp",
	pid: 1000,
	logFile: `/tmp/${id}.log`,
	startedAt,
	updatedAt: startedAt,
	lastOutputAt: startedAt,
	expiresAt: null,
	status,
	exitCode: status === "running" ? null : 0,
	notifyOnExit: true,
	notifyOnOutput: false,
	outputBytes: 10,
});

// Newest finished task is listed first among finished; the running task must
// still lead the list even though it started before them.
const running = task("bg-3", "running", now - 400_000);
const finishedNew = task("bg-9", "completed", now - 2_000);
const finishedOld = task("bg-1", "failed", now - 900_000);
const tasks: FakeTask[] = [finishedNew, running, finishedOld];

let rendered: string[] = [];
const tui = { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI;
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
	dim: (text: string) => text,
} as unknown as ExtensionContext["theme"];

const ctx = {
	hasUI: true,
	cwd: "/tmp",
	ui: {
		notify() {},
		custom: async (factory: (tui: TUI, theme: ExtensionContext["theme"], keys: unknown, done: (value?: unknown) => void) => {
			render(width: number): string[];
			invalidate?(): void;
			handleInput?(data: string): void;
		}) => {
			const component = factory(tui, theme, {}, () => {});
			rendered = component.render(130);
			return undefined;
		},
	},
} as unknown as ExtensionContext;

await openDashboard(
	ctx,
	{
		sortedTasks: () => [...tasks].sort((a, b) => b.startedAt - a.startedAt) as never,
		getTask: (id: string) => (tasks.find((candidate) => candidate.id === id) ?? null) as never,
		getTaskOutput: () => "line one\nline two",
		requestStop: () => ({ ok: true, message: "stopped" }),
		clearFinishedTasks: () => 0,
		formatTaskListText: () => "bg-3 · running",
	},
	null,
);

const text = rendered.join("\n");
const indexOf = (needle: string): number => text.indexOf(needle);
const report = {
	// Ordering: the running task must precede both finished tasks regardless of start time.
	runningFirst: indexOf("bg-3") >= 0 && indexOf("bg-3") < indexOf("bg-9") && indexOf("bg-3") < indexOf("bg-1"),
	finishedNewBeforeOld: indexOf("bg-9") < indexOf("bg-1"),
	// Size: 92% of 40 rows is 36 inner rows, well beyond the old 14-row floor.
	renderedRows: rendered.length,
	headerHasCounts: /\d+ running[^0-9]{0,8}·[^0-9]{0,8}\d+ finished/.test(text),
};
report["firstLineLen"] = rendered[0]?.length ?? 0;

report["firstLines"] = rendered.slice(0, 2).join(" | ").slice(0, 160);
process.stdout.write(JSON.stringify(report));
