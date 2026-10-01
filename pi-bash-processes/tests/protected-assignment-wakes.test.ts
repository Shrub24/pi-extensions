// Protected-assignment wakes (openspec `herdsman-background-handoffs`
// tasks 2.4) against the real provider and the real delivery path: while a
// bound assignment is marked protected, its tasks' terminal results reach the
// model exactly once — even under `notifyOnExit: false`, even mid-turn as one
// grouped wake — and a retrieval that already delivered the result cancels
// the held wake instead of double-delivering it. Protecting an assignment
// also reconciles work that ended before protection existed: a suppressed
// completion is woken once (at protect time, or at the run boundary when it
// is held), and never again once the result is retrieved. Unprotected
// `notifyOnExit: false` tasks stay silent, so the forcing is the protection's
// and not a change to ordinary wake policy.

import { afterAll, expect, test } from "bun:test";

import { startExtensionHost, type ExtensionHost, type HostTool } from "./fixtures/extension-host.js";
import { bindBackgroundWorkAssignment, protectBackgroundWorkAssignment, queryBackgroundWorkSnapshot } from "../extensions/background-work.js";

const host: ExtensionHost = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const SESSION = `extension-host-${process.pid}`;
const scope = (requestId: string) => ({ sessionId: SESSION, requestId });
const bgTask = (): HostTool => host.tools.get("bg_task")!;
const listed = async (id: string) => (await host.listTasks()).find((task) => task.id === id);

/** Bounded harness wait; never part of the product surface. */
async function until(predicate: () => boolean, budgetMs = 15_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
}

const exitMessagesFor = (id: string) =>
	host.messages.filter(([message]) => {
		const details = (message as { details?: { eventType?: string; grouped?: boolean } }).details;
		return details?.eventType === "exit" && JSON.stringify(message).includes(id);
	});
const settle = async () => {
	await host.dispatch("agent_end");
	await host.dispatch("agent_settled");
};

test("a protected assignment forces the terminal wake for a notifyOnExit:false task", async () => {
	expect(bindBackgroundWorkAssignment(host.events, scope("req-a"))).toStrictEqual({ state: "bound" });
	expect(protectBackgroundWorkAssignment(host.events, scope("req-a"), true)).toStrictEqual({ state: "bound" });

	const spawned = await bgTask().execute("protected-forced", { action: "spawn", command: "printf 'forced-wake\\n'", notifyOnExit: false });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	await until(() => exitMessagesFor(id).length > 0);

	expect(exitMessagesFor(id), "the protected exit wakes exactly once").toHaveLength(1);
	expect((await listed(id))?.exitNotified, "and records the delivered obligation").toBe(true);
	// Resolve it: the next test binds a different request, which refuses while
	// this assignment's work is unresolved.
	await bgTask().execute("protected-forced-get", { action: "get", id });
});

test("without protection a notifyOnExit:false task stays silent", async () => {
	expect(bindBackgroundWorkAssignment(host.events, scope("req-b"))).toStrictEqual({ state: "bound" });
	// A fresh bind drops the previous binding's protection; nothing marks
	// this one.
	const spawned = await bgTask().execute("protected-silent", { action: "spawn", command: "printf 'silent-exit\\n'", notifyOnExit: false });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	await Bun.sleep(200);

	expect(exitMessagesFor(id), "an unprotected notifyOnExit:false exit is dropped").toHaveLength(0);
	expect((await listed(id))?.exitNotified, "and claims no delivered obligation").toBe(false);
	await bgTask().execute("protected-silent-get", { action: "get", id });
});

test("mid-turn protected exits coalesce into one grouped wake at the run boundary", async () => {
	await host.dispatch("before_agent_start");
	expect(bindBackgroundWorkAssignment(host.events, scope("req-c"))).toStrictEqual({ state: "bound" });
	expect(protectBackgroundWorkAssignment(host.events, scope("req-c"), true)).toStrictEqual({ state: "bound" });

	const first = await bgTask().execute("protected-group-a", { action: "spawn", command: "printf 'group-a\\n'", notifyOnExit: false });
	const second = await bgTask().execute("protected-group-b", { action: "spawn", command: "printf 'group-b\\n'", notifyOnExit: false });
	const idA = (first.details.task as { id: string }).id;
	const idB = (second.details.task as { id: string }).id;
	await host.settledTask(idA);
	await host.settledTask(idB);
	expect(exitMessagesFor(idA), "mid-turn exits are held, not delivered").toHaveLength(0);
	expect(exitMessagesFor(idB), "mid-turn exits are held, not delivered").toHaveLength(0);

	await settle();
	const grouped = host.messages.filter(([message]) => {
		const content = (message as { content?: string }).content ?? "";
		return content.includes(idA) && content.includes(idB);
	});
	expect(grouped, "both protected completions arrive as one grouped wake").toHaveLength(1);
	expect((await listed(idA))?.exitNotified).toBe(true);
	expect((await listed(idB))?.exitNotified).toBe(true);
	await bgTask().execute("protected-group-get", { action: "get", id: idA });
	await bgTask().execute("protected-group-get", { action: "get", id: idB });
});

test("a retrieval after a held protected wake cancels it instead of double-delivering", async () => {
	await host.dispatch("before_agent_start");
	expect(bindBackgroundWorkAssignment(host.events, scope("req-d"))).toStrictEqual({ state: "bound" });
	expect(protectBackgroundWorkAssignment(host.events, scope("req-d"), true)).toStrictEqual({ state: "bound" });

	const spawned = await bgTask().execute("protected-cancel", { action: "spawn", command: "printf 'cancel-me\\n'", notifyOnExit: false });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	// The exit is held (mid-turn); the retrieval is the observation that makes
	// the held wake redundant.
	const got = await bgTask().execute("protected-cancel-get", { action: "get", id });
	expect(got.content[0]?.text ?? "").toContain(id);

	await settle();
	expect(exitMessagesFor(id), "the consumed held wake is never delivered").toHaveLength(0);
	expect((await listed(id))?.exitNotified, "the obligation is still recorded").toBe(true);
});

test("a protected assignment's soft-timeout reminder still reaches the model", async () => {
	await host.dispatch("before_agent_start");
	expect(bindBackgroundWorkAssignment(host.events, scope("req-e"))).toStrictEqual({ state: "bound" });
	expect(protectBackgroundWorkAssignment(host.events, scope("req-e"), true)).toStrictEqual({ state: "bound" });

	const spawned = await bgTask().execute("protected-reminder", {
		action: "spawn",
		command: "sleep 1",
		notifyOnExit: false,
		softTimeoutMs: 100,
	});
	const id = (spawned.details.task as { id: string }).id;
	await until(() =>
		host.messages.some(([message]) => (message as { details?: { eventType?: string } }).details?.eventType === "soft-timeout" && JSON.stringify(message).includes(id)),
	);
	await host.settledTask(id);
	await settle();
	expect((await listed(id))?.exitNotified, "its terminal wake is forced as well").toBe(true);
	await bgTask().execute("protected-reminder-get", { action: "get", id });
});

test("protect wakes a settled-before-protect suppressed completion exactly once, and never again after resolution", async () => {
	expect(bindBackgroundWorkAssignment(host.events, scope("req-f"))).toStrictEqual({ state: "bound" });
	// No protection yet: a notifyOnExit:false completion is suppressed.
	const spawned = await bgTask().execute("protect-late", { action: "spawn", command: "printf 'late-protect\\n'", notifyOnExit: false });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	await Bun.sleep(200);
	expect(exitMessagesFor(id), "suppressed before protection").toHaveLength(0);
	expect((await listed(id))?.exitNotified, "and no obligation was recorded for the dropped wake").toBe(false);

	// Protecting now must reconcile the already-terminal unresolved work:
	// the scheduler re-enters it as an exit event, where the exitMandatory
	// gate forces the delivery that protection owes.
	expect(protectBackgroundWorkAssignment(host.events, scope("req-f"), true)).toStrictEqual({ state: "bound" });
	await until(() => exitMessagesFor(id).length > 0);
	expect(exitMessagesFor(id), "exactly one forced wake").toHaveLength(1);
	expect((await listed(id))?.exitNotified).toBe(true);
	expect((await listed(id))?.resultResolution, "the wake itself resolves nothing").toBeUndefined();

	// Resolving it cancels/ends the obligation: no resurrected wake at the
	// run boundary or afterwards.
	await bgTask().execute("protect-late-get", { action: "get", id });
	await settle();
	await Bun.sleep(200);
	expect(exitMessagesFor(id), "never a second wake after retrieval").toHaveLength(1);
});

test("protect does not duplicate a wake that was already delivered before it", async () => {
	expect(bindBackgroundWorkAssignment(host.events, scope("req-g"))).toStrictEqual({ state: "bound" });
	const spawned = await bgTask().execute("protect-prior", { action: "spawn", command: "printf 'prior-wake\\n'", notifyOnExit: true });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	await until(() => exitMessagesFor(id).length > 0);
	expect(exitMessagesFor(id), "delivered before protection").toHaveLength(1);

	expect(protectBackgroundWorkAssignment(host.events, scope("req-g"), true)).toStrictEqual({ state: "bound" });
	await settle();
	await Bun.sleep(200);
	expect(exitMessagesFor(id), "protection never duplicates a delivered wake").toHaveLength(1);

	// Distinguish a consumed wake from a queued/held one: the notification
	// was already delivered and must not be re-fired, yet the assignment must
	// not be left waiting with no path to review. The path is durable, not a
	// second wake — the snapshot still reports the result as awaiting review,
	// a fresh scope is refused with this task's id, and retrieval retires it.
	// (Automatic re-prompting of a consumed-but-unretrieved wake is the Group-3
	// settlement-consumption guard, deliberately not claimed here.)
	const snapshot = queryBackgroundWorkSnapshot(host.events, scope("req-g"));
	if (snapshot.state !== "ready") throw new Error(`expected ready with the consumed result still outstanding, received ${JSON.stringify(snapshot)}`);
	expect(snapshot.snapshot.outstanding, "the consumed wake still reports awaiting-result-review").toStrictEqual([
		{ taskId: id, state: "awaiting-result-review", reason: expect.stringContaining("awaiting an actual result handoff") },
	]);
	const refused = bindBackgroundWorkAssignment(host.events, scope("req-i"));
	expect(refused.state, "a fresh scope is refused while the result is unretrieved").toBe("refused");
	if (refused.state === "refused") expect(refused.reason, "the refusal names the task blocking review").toContain(id);

	await bgTask().execute("protect-prior-get", { action: "get", id });
});

test("protect over a held mid-turn wake queues nothing extra and forces one delivery at the boundary", async () => {
	await host.dispatch("before_agent_start");
	expect(bindBackgroundWorkAssignment(host.events, scope("req-h"))).toStrictEqual({ state: "bound" });
	const spawned = await bgTask().execute("protect-held", { action: "spawn", command: "printf 'held-protect\\n'", notifyOnExit: false });
	const id = (spawned.details.task as { id: string }).id;
	await host.settledTask(id);
	// The mid-turn exit is held (its obligation acked at hold), so protection
	// must not queue a second entry for it.
	expect((await listed(id))?.exitNotified, "the held wake already acked its obligation").toBe(true);
	expect(protectBackgroundWorkAssignment(host.events, scope("req-h"), true)).toStrictEqual({ state: "bound" });
	await Bun.sleep(150);
	expect(exitMessagesFor(id), "nothing is delivered mid-turn").toHaveLength(0);

	await settle();
	await until(() => exitMessagesFor(id).length > 0);
	await Bun.sleep(150);
	expect(exitMessagesFor(id), "the held wake is delivered exactly once, forced by protection").toHaveLength(1);
	await bgTask().execute("protect-held-get", { action: "get", id });
});
