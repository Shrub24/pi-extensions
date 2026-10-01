import { afterAll, expect, test } from "bun:test";

import { autoBackgroundDecision, duplicateTaskNote } from "../extensions/auto-background.js";
import { startExtensionHost, type ExtensionHost } from "./fixtures/extension-host.js";

// F1/F2 review corrections: the `user_bash` interception path.
//
// The mode-aware surface work replaced a literal reason string in
// `autoBackgroundDecision` with `taskSurfaceGuidance(surface)`, but that function
// was never given a `surface` binding, and the same handler calls
// `duplicateTaskNote`, which was never imported. Both are free identifiers in
// value position, so both throw `ReferenceError` before any decision is
// returned: Pi's interactive `user_bash` emit swallows the throw and drops the
// user's command, and RPC rejects the request.
//
// These are behavioural regressions on purpose. The earlier surface test only
// scanned this file's source text for a `./tool-surface.js` import, which is
// exactly why a green suite shipped both defects.
//
// The host is the real extension against a real Pi surface, so `dispatch`
// reaches the handler Pi would call and the returned value is the handling Pi
// would act on — not a re-implementation of it. One host per test file: the host
// environment is process-wide and the package's settings reads are memoized over
// it.

const host: ExtensionHost = await startExtensionHost();

/** The ordinary polling shapes `decisionForBashCommand` is reached with. */
const POLLING_COMMANDS = [
	"while true; do sleep 5; done",
	"for i in $(seq 1 100); do sleep 1; done",
	"while true; do echo hi; sleep 5; done",
];

/**
 * A bounded variant of the same shape: it takes the identical branch
 * (`seq 1 30` is a finite loop at the threshold) but ends on its own, so the
 * handler test below never leaves an unbounded process behind.
 */
const BOUNDED_POLLING_COMMAND = "for i in $(seq 1 30); do sleep 1; done";

let counter = 0;
const nextCommand = () => `${BOUNDED_POLLING_COMMAND} # f1-${process.pid}-${counter++}`;

async function stopEveryTask(): Promise<void> {
	await host.tools.get("bg_task")!.execute(`stop-all-${counter++}`, { action: "stop", id: "all" });
}

/**
 * The polling loop is the shape the branch exists for: a decision must come
 * back, and the reason must be the one the *given* surface declares. The default
 * has to stay the conservative compatibility surface — a caller that has not
 * been told its mode must not be handed a TUI-only claim.
 */
test("an ordinary polling loop returns a decision in every surface, and never throws", () => {
	for (const command of POLLING_COMMANDS) {
		const defaulted = autoBackgroundDecision(command);
		expect(defaulted, `default decision for ${command}`).not.toBeNull();
		expect(defaulted!.title).toStartWith("monitor: ");

		const compat = autoBackgroundDecision(command, undefined, "compat");
		const tui = autoBackgroundDecision(command, undefined, "tui");
		expect(compat, `compat decision for ${command}`).not.toBeNull();
		expect(tui, `tui decision for ${command}`).not.toBeNull();

		// The default is the conservative surface, not whichever the module last saw.
		expect(defaulted!.reason, `default is compat for ${command}`).toBe(compat!.reason);
		// Each surface names only the waiting route it declares.
		expect(compat!.reason).toContain('bg_task wait');
		expect(tui!.reason).not.toContain('bg_task wait');
		expect(tui!.reason).toContain("ending the turn");
		expect(tui!.reason).not.toBe(compat!.reason);
	}
});

/**
 * The same branch through the handler Pi actually calls. Pi's interactive mode
 * wraps this emit in a `try`/`catch` that returns without falling back to local
 * execution, so a throw here is a *silently dropped* user command — the test
 * asserts the handling value, not merely "no exception".
 */
test("an auto-backgrounded user bash command is handled, with the ack the mode declares", async () => {
	const command = nextCommand();
	const results = await host.dispatch("user_bash", { command, cwd: host.cwd });
	const handled = results[0] as { result?: { output?: string; exitCode?: number; cancelled?: boolean } } | undefined;

	expect(handled?.result, "the handler returned a handling result instead of throwing").toBeDefined();
	expect(handled!.result!.exitCode).toBe(0);
	expect(handled!.result!.cancelled).toBe(false);
	const output = handled!.result!.output ?? "";
	expect(output).toStartWith("Started bg-");
	expect(output, "the ack carries the mode's polling reason").toContain("polling loop");
	expect(output, "and the waiting route the compat surface declares").toContain('bg_task wait');

	const taskId = output.match(/^Started (bg-\d+)/)?.[1];
	expect(taskId, "the ack names the started task").toBeString();
	await stopEveryTask();
});

/**
 * F2: the same handler path builds the duplicate note. `duplicateTaskNote` is
 * imported now, so a second identical command running at the same time is
 * actually reported — the note pi-bash-processes promises on both the spawn and
 * the auto-background ack.
 */
test("a duplicate auto-backgrounded command is reported instead of throwing", async () => {
	const command = nextCommand();
	const first = await host.dispatch("user_bash", { command, cwd: host.cwd });
	const firstOutput = (first[0] as { result?: { output?: string } }).result?.output ?? "";
	const firstId = firstOutput.match(/^Started (bg-\d+)/)?.[1];
	expect(firstId, "the first command started a task").toBeString();

	const second = await host.dispatch("user_bash", { command, cwd: host.cwd });
	const secondOutput = (second[0] as { result?: { output?: string } }).result?.output ?? "";
	expect(secondOutput, "the second command was handled too").toStartWith("Started bg-");
	expect(secondOutput, "and its ack names the identical running command").toContain(`identical command already running: ${firstId}`);
	await stopEveryTask();
});

/**
 * The note itself, directly: the signature is exercised with and without a
 * surface so the default stays compat, and the empty case returns "" rather than
 * a note-shaped string.
 */
test("the duplicate note binds the surface, and is empty when nothing is flagged", () => {
	expect(duplicateTaskNote([], [], [])).toBe("");
	expect(duplicateTaskNote(["bg-7"], [], [], "compat")).toContain('bg_task wait/log');
	expect(duplicateTaskNote(["bg-7"], [], [], "tui")).not.toContain('bg_task wait/log');
	expect(duplicateTaskNote([], ["bg-8"], [], "compat")).toContain("similar command already running: bg-8");
	expect(duplicateTaskNote([], [], [{ id: "bg-9", updatedAt: Date.now() }], "compat")).toContain("finished recently");
});

afterAll(async () => {
	await stopEveryTask();
	await host.dispose();
});
