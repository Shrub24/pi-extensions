// Real-provider integration for extensions/background-work.ts: the actual
// background-tasks extension lifecycle registers, replaces and disposes its
// settlement provider on the shared `pi.events` bus, and every query below is
// answered from the authoritative task map — no fake provider is registered
// anywhere in this file. Group 2 (openspec `herdsman-background-handoffs`
// tasks 2.1): assignment binding with spawn-time association, quarantine of
// unresolved work that is not attributable to the request, ready-with-
// outstanding for the bound scope's decidable states (terminal-ready stays
// `awaiting-result-review` until an actual delivery is recorded), warm rebind
// over resolved history, restart-preserved association, protect refusals, and
// the fail-closed restore/registration states the staged adapter already
// pinned.

import { afterAll, expect, test } from "bun:test";

import { startExtensionHost, type ExtensionHost } from "./fixtures/extension-host.js";
import {
	bindBackgroundWorkAssignment,
	protectBackgroundWorkAssignment,
	queryBackgroundWorkSnapshot,
} from "../extensions/background-work.js";

const host: ExtensionHost = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const SESSION = `extension-host-${process.pid}`;
const scope = (requestId: string, sessionId: string = SESSION) => ({ sessionId, requestId });
const bgTask = () => host.tools.get("bg_task")!;
const listed = async (id: string) => (await host.listTasks()).find((task) => task.id === id);

const readySnapshot = (requestId: string) => {
	const result = queryBackgroundWorkSnapshot(host.events, scope(requestId));
	if (result.state !== "ready") throw new Error(`expected ready for ${requestId}, received ${JSON.stringify(result)}`);
	return result.snapshot;
};
const readyRevision = (requestId: string) => readySnapshot(requestId).revision;

test("a restored session with an empty task map answers ready for the exact scope identity", () => {
	const snapshot = readySnapshot("req-1");
	expect(snapshot.provider).toStrictEqual({ id: "pi-bash-processes", version: 1 });
	expect(snapshot.sessionId).toBe(SESSION);
	expect(snapshot.requestId).toBe("req-1");
	expect(snapshot.reconciliation).toStrictEqual({ state: "ready" });
	expect(snapshot.outstanding).toStrictEqual([]);
});

test("bind through the real provider succeeds on an empty map and is idempotent for the same request", () => {
	expect(bindBackgroundWorkAssignment(host.events, scope("req-bind"))).toStrictEqual({ state: "bound" });
	expect(bindBackgroundWorkAssignment(host.events, scope("req-bind"))).toStrictEqual({ state: "bound" });
});

let spawnedTaskId = "";

test("a bind's spawn inherits its request; another request cannot bind while it is unresolved", async () => {
	await host.dispatch("before_agent_start");
	expect(bindBackgroundWorkAssignment(host.events, scope("req-2"))).toStrictEqual({ state: "bound" });
	const revisionBefore = readyRevision("req-2");
	const spawned = await bgTask().execute("provider-spawn", { action: "spawn", command: "sleep 1" });
	const id = (spawned.details.task as { id: string }).id;
	spawnedTaskId = id;

	const record = await listed(id);
	expect(record?.assignmentRequestId, "the spawn records which assignment it was launched under").toBe("req-2");
	expect(record?.resultResolution, "running work has no result resolution").toBeUndefined();

	const snapshot = readySnapshot("req-2");
	expect(snapshot.outstanding).toStrictEqual([
		{ taskId: id, state: "running", reason: expect.stringContaining("spawned under this assignment") },
	]);
	expect(snapshot.revision, "a spawn bumps the monotonic revision").toBeGreaterThan(revisionBefore);

	const wrong = bindBackgroundWorkAssignment(host.events, scope("req-other"));
	if (wrong.state !== "refused") throw new Error(`expected refused for a different request, received ${JSON.stringify(wrong)}`);
	expect(wrong.reason, "the refusal names the unresolved task blocking it").toContain(id);
	expect(wrong.reason, "and says how to reconcile it").toContain("reconcile it explicitly");

	const other = queryBackgroundWorkSnapshot(host.events, scope("req-other"));
	if (other.state !== "error") throw new Error(`an unbound scope must not answer over another request's work: ${JSON.stringify(other)}`);
	expect(other.error.message, "the error names the actual bound assignment").toContain("req-2");

	// A running retrieval commits only a review, but it also persists the task
	// snapshot — the restart test below depends on this spawn being durable,
	// since a silent task normally persists only with its first output.
	await bgTask().execute("provider-persist-get", { action: "get", id });
	// Let the task finish naturally before the restart test: after a restart
	// the restored task has no live process handle, so its later exit could
	// not be observed through the spawn's close listener.
	await host.settledTask(id);
});

test("a restart preserves association but clears the binding: new spawns are unassociated until a rebind", async () => {
	await host.dispatch("session_start");

	const record = await listed(spawnedTaskId);
	expect(record?.assignmentRequestId, "association is durable across the restart").toBe("req-2");

	// The binding itself is session-scoped: with nothing bound, a fresh spawn
	// inherits no request — which is exactly what quarantines it below.
	const orphan = await bgTask().execute("provider-restart-orphan", { action: "spawn", command: "printf 'restart-orphan\\n'" });
	const orphanId = (orphan.details.task as { id: string }).id;
	expect((await listed(orphanId))?.assignmentRequestId, "a spawn after the restart is unassociated").toBeUndefined();

	const refused = bindBackgroundWorkAssignment(host.events, scope("req-2"));
	if (refused.state !== "refused") throw new Error(`expected refused while the orphan is unresolved, received ${JSON.stringify(refused)}`);
	expect(refused.reason, "the unassociated restart orphan is the blocker").toContain(orphanId);

	// Reconcile the orphan explicitly, then rebind: the previously associated
	// task is adopted back into outstanding, not re-quarantined.
	await host.settledTask(orphanId);
	await bgTask().execute("provider-restart-orphan-get", { action: "get", id: orphanId });
	expect(bindBackgroundWorkAssignment(host.events, scope("req-2"))).toStrictEqual({ state: "bound" });
	const snapshot = readySnapshot("req-2");
	expect(snapshot.outstanding, "the restored terminal task is still awaiting its result delivery").toStrictEqual([
		{ taskId: spawnedTaskId, state: "awaiting-result-review", reason: expect.stringContaining("awaiting an actual result handoff") },
	]);
});

test("a terminal task stays awaiting-result-review until a delivery is recorded, never retired by notification state", async () => {
	const snapshot = readySnapshot("req-2");
	expect(snapshot.reconciliation, "the snapshot itself is authoritative").toStrictEqual({ state: "ready" });
	expect(snapshot.outstanding, "terminal-ready is outstanding, not excluded").toStrictEqual([
		{ taskId: spawnedTaskId, state: "awaiting-result-review", reason: expect.stringContaining("awaiting an actual result handoff") },
	]);
	// No host wake has been delivered for it either (the turn is still in
	// flight), but even one would not resolve it.
	expect((await listed(spawnedTaskId))?.resultResolution, "nothing has delivered this result yet").toBeUndefined();
});

test("an actual retrieval retires the task, and the resolved history then binds freely (warm reuse)", async () => {
	const got = await bgTask().execute("provider-get", { action: "get", id: spawnedTaskId });
	expect(got.content[0]?.text ?? "").toContain(spawnedTaskId);

	expect((await listed(spawnedTaskId))?.resultResolution, "the certified retrieval is the resolution").toBe("delivered");
	expect(readySnapshot("req-2").outstanding, "resolved history is not outstanding").toStrictEqual([]);

	expect(bindBackgroundWorkAssignment(host.events, scope("req-warm"))).toStrictEqual({ state: "bound" });
	const snapshot = readySnapshot("req-warm");
	expect(snapshot.reconciliation).toStrictEqual({ state: "ready" });
	expect(snapshot.outstanding, "completed history answers without blocking the new request").toStrictEqual([]);
});

test("a running task's inspection is not a resolution", async () => {
	const spawned = await bgTask().execute("provider-inspect", { action: "spawn", command: "sleep 1" });
	const id = (spawned.details.task as { id: string }).id;
	await bgTask().execute("provider-inspect-get", { action: "get", id });
	expect((await listed(id))?.resultResolution, "reading a running task resolves nothing").toBeUndefined();
	expect(readySnapshot("req-warm").outstanding).toStrictEqual([
		{ taskId: id, state: "running", reason: expect.stringContaining("spawned under this assignment") },
	]);
	await host.settledTask(id);
	await bgTask().execute("provider-inspect-final-get", { action: "get", id });
	expect((await listed(id))?.resultResolution).toBe("delivered");
	expect(readySnapshot("req-warm").outstanding).toStrictEqual([]);
});

test("unassociated work quarantines every bind until it is explicitly reconciled", async () => {
	await host.dispatch("session_start");
	const spawned = await bgTask().execute("provider-orphan", { action: "spawn", command: "printf 'orphan\\n'" });
	const id = (spawned.details.task as { id: string }).id;
	expect((await listed(id))?.assignmentRequestId, "nothing is bound, so the spawn is unassociated").toBeUndefined();

	const refused = bindBackgroundWorkAssignment(host.events, scope("req-8"));
	if (refused.state !== "refused") throw new Error(`expected refused, received ${JSON.stringify(refused)}`);
	expect(refused.reason).toContain(id);
	expect(refused.reason).toContain("blocks binding");

	const snapshotQuery = queryBackgroundWorkSnapshot(host.events, scope("req-8"));
	if (snapshotQuery.state !== "error") throw new Error(`expected error, received ${JSON.stringify(snapshotQuery)}`);
	expect(snapshotQuery.error.message).toContain(id);

	// The documented migration path: an explicit result handoff resolves the
	// orphan, after which the bind is no longer blocked by it.
	await host.settledTask(id);
	await bgTask().execute("provider-orphan-get", { action: "get", id });
	expect((await listed(id))?.resultResolution).toBe("delivered");
	expect(bindBackgroundWorkAssignment(host.events, scope("req-8"))).toStrictEqual({ state: "bound" });
	expect(readySnapshot("req-8").outstanding).toStrictEqual([]);
});

test("protect is refused until the request is the bound assignment, and dies with the binding", () => {
	const neverBound = protectBackgroundWorkAssignment(host.events, scope("req-protect-x"), true);
	if (neverBound.state !== "refused") throw new Error(`expected refused, received ${JSON.stringify(neverBound)}`);
	expect(neverBound.reason).toContain("not the bound assignment");

	expect(bindBackgroundWorkAssignment(host.events, scope("req-protect"))).toStrictEqual({ state: "bound" });
	expect(protectBackgroundWorkAssignment(host.events, scope("req-protect"), true)).toStrictEqual({ state: "bound" });
	expect(protectBackgroundWorkAssignment(host.events, scope("req-protect"), false)).toStrictEqual({ state: "bound" });

	// Wrong session: the provider refuses rather than protecting foreign scope.
	const foreign = protectBackgroundWorkAssignment(host.events, scope("req-protect", "some-other-session"), true);
	if (foreign.state !== "refused") throw new Error(`expected refused for a foreign session, received ${JSON.stringify(foreign)}`);

	// After a restart nothing is bound, so protection must be re-established.
	expect(bindBackgroundWorkAssignment(host.events, scope("req-protect"))).toStrictEqual({ state: "bound" });
	expect(protectBackgroundWorkAssignment(host.events, scope("req-protect"), true)).toStrictEqual({ state: "bound" });
	expect(bindBackgroundWorkAssignment(host.events, scope("req-protect-rebind"))).toStrictEqual({ state: "bound" });
	const stale = protectBackgroundWorkAssignment(host.events, scope("req-protect"), true);
	if (stale.state !== "refused") throw new Error(`protection must not follow a rebind: ${JSON.stringify(stale)}`);
});

test("clearing finished tasks through the public tool keeps the view ready", async () => {
	const cleared = await bgTask().execute("provider-clear", { action: "clear" });
	expect((cleared.content[0]?.text ?? "")).toContain("Removed");
	const snapshot = readySnapshot("req-8");
	expect(snapshot.outstanding).toStrictEqual([]);
});

test("a query for another session fails closed as identity mismatch, not a snapshot", () => {
	const result = queryBackgroundWorkSnapshot(host.events, scope("req-5", "some-other-session"));
	if (result.state !== "error") throw new Error(`expected error, received ${JSON.stringify(result)}`);
	expect(result.error.code).toBe("identity-mismatch");
	expect(result.snapshot, "the mismatched answer carries no authoritative view").toBeUndefined();
});

test("session_shutdown disposes the registration: absent, and missing when a provider is expected", async () => {
	await host.dispatch("session_shutdown");
	const unexpected = queryBackgroundWorkSnapshot(host.events, scope("req-6"));
	expect(unexpected.state).toBe("absent");
	const expected = queryBackgroundWorkSnapshot(host.events, { ...scope("req-6"), expectedProviderId: "pi-bash-processes" });
	if (expected.state !== "missing") throw new Error(`expected missing for an expected-but-disposed provider, received ${JSON.stringify(expected)}`);
	expect(expected.expectedProviderId).toBe("pi-bash-processes");
});

test("a fresh session_start re-registers the provider after disposal", async () => {
	await host.dispatch("session_start");
	const snapshot = readySnapshot("req-7");
	expect(snapshot.provider).toStrictEqual({ id: "pi-bash-processes", version: 1 });
});

test("a failing restore reports an actionable provider error, never an empty successful snapshot", async () => {
	const branch = host.ctx.sessionManager;
	const originalGetBranch = branch.getBranch;
	branch.getBranch = () => {
		throw new Error("injected branch read failure");
	};
	try {
		let rejection: unknown;
		try {
			await host.dispatch("session_start");
		} catch (error) {
			rejection = error;
		}
		expect(rejection, "the pre-existing control flow rethrows the restore failure").toBeInstanceOf(Error);
		expect((rejection as Error).message).toContain("injected branch read failure");
	} finally {
		branch.getBranch = originalGetBranch;
	}

	const failed = queryBackgroundWorkSnapshot(host.events, scope("req-8-fail"));
	if (failed.state !== "error") throw new Error(`a failed restore must read as provider error, received ${JSON.stringify(failed)}`);
	expect(failed.error.code).toBe("provider-error");
	expect(failed.error.message, "the error names the restore failure").toContain("task snapshot restore failed");
	expect(failed.error.message).toContain("injected branch read failure");
	// A provider-reported reconciliation error carries its snapshot for
	// diagnostics (phase-01 contract), and that snapshot is explicitly the
	// failed reconciliation state — never a ready or empty one.
	expect(failed.snapshot?.reconciliation).toMatchObject({ state: "error" });
	expect(failed.snapshot?.outstanding).toStrictEqual([]);

	// Recovery: the next session_start restores cleanly and the provider answers ready again.
	await host.dispatch("session_start");
	const recovered = readySnapshot("req-9");
	expect(recovered.outstanding).toStrictEqual([]);
});
