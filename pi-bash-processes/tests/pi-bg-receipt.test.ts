import { afterAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { requestBridge } from "../extensions/bridge.js";
import { startExtensionHost, type HostTool } from "./fixtures/extension-host.js";

// The receipt gate: the manager prepares a result, and nothing is acknowledged
// or reviewed until the caller says the output actually reached it. These
// assertions drive the endpoint the declared CLI talks to, so they pin the
// protocol rather than one caller's use of it.
const host = await startExtensionHost();
afterAll(() => host.dispose());

const bash = (): HostTool => host.tools.get("bash")!;
const bgTask = (): HostTool => host.tools.get("bg_task")!;

const spawned = (result: { details: Record<string, unknown> }) => result.details.task as { id: string };

/** The endpoint a managed command is handed, read from its own environment. */
async function endpoint(): Promise<{ session: string; socketPath: string }> {
	const result = await bash().execute("endpoint", { command: 'printf "%s\\n%s\\n" "$PI_BG_SESSION" "$PI_BG_SOCKET"' }, undefined, undefined, host.ctx);
	const [session, socketPath] = (result.content[0]?.text ?? "").trim().split("\n");
	expect(socketPath, "managed bash is told which endpoint to ask").toBeTruthy();
	return { session: session!, socketPath: socketPath! };
}

const listed = async (id: string) => (await host.listTasks()).find((task) => task.id === id);

async function awaitLogContains(id: string, needle: string, budgetMs = 20_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const task = await listed(id);
		if (task?.logFile && (await Bun.file(task.logFile as string).text()).includes(needle)) return;
		if (Date.now() >= deadline) return;
		await Bun.sleep(10);
	}
}

const asResult = (outcome: Awaited<ReturnType<typeof requestBridge>>) => {
	if (!outcome.ok) throw new Error(`bridge refused the request: ${outcome.error.code}: ${outcome.error.message}`);
	if (!outcome.response.ok) throw new Error(`bridge answered with an error payload`);
	return outcome.response.result;
};

test("a prepared handoff commits nothing until its receipt arrives, and the token is idempotent", async () => {
	const { session, socketPath } = await endpoint();
	const task = spawned(await bgTask().execute("receipt-review", { action: "spawn", command: "printf 'one\\n'; sleep 30" }));
	await awaitLogContains(task.id, "one");
	const before = await listed(task.id);
	expect(before?.lastReviewedAt, "nothing reviewed yet").toBeUndefined();

	// Preparing hands over an artifact and a token — and commits neither a review
	// nor an acknowledgment.
	const prepared = asResult(await requestBridge({ session, socketPath }, { op: "get", id: task.id, output: "full" }));
	expect(prepared.receipt, "every handoff carries the token that would settle it").toBeTruthy();
	expect(prepared.output?.kind).toBe("snapshot");
	expect((await listed(task.id))?.lastReviewedAt, "preparation alone commits nothing").toBeUndefined();

	// The receipt is what settles it.
	const accepted = asResult(await requestBridge({ session, socketPath }, { op: "receipt", token: prepared.receipt! }));
	expect(accepted.ack).toMatchObject({ acknowledged: false, committed: "review", reviewed: true });
	const reviewed = await listed(task.id);
	expect(reviewed?.lastReviewedAt).toBeGreaterThan(0);

	// Retrying the same token replays the committed outcome instead of committing
	// a second review: a dropped confirmation must be recoverable, not re-run.
	const replayed = asResult(await requestBridge({ session, socketPath }, { op: "receipt", token: prepared.receipt! }));
	expect(replayed.ack).toMatchObject({ committed: "replayed", reviewed: true });
	expect((await listed(task.id))?.lastReviewedAt, "the replay did not move the clock").toBe(reviewed?.lastReviewedAt);
	expect((await listed(task.id))?.reviewRevision).toBe(reviewed?.reviewRevision);

	await bgTask().execute("receipt-review-stop", { action: "stop", id: task.id });
});

test("a handoff prepared while running cannot acknowledge a completion it did not deliver", async () => {
	const { session, socketPath } = await endpoint();
	const task = spawned(await bgTask().execute("receipt-race", { action: "spawn", command: "printf 'partial\\n'; sleep 2; printf 'rest\\n'" }));
	await awaitLogContains(task.id, "partial");

	// Prepared as a running capture: the caller is streaming a partial artifact.
	const prepared = asResult(await requestBridge({ session, socketPath }, { op: "get", id: task.id, output: "full" }));
	expect(prepared.task?.readiness).toBe("running");

	// The task finishes while that handoff is still in flight.
	await host.settledTask(task.id);
	expect((await listed(task.id))?.status).not.toBe("running");

	// The receipt must not turn the partial stream into a completion
	// acknowledgment: the bytes the caller received were not the whole result.
	const accepted = asResult(await requestBridge({ session, socketPath }, { op: "receipt", token: prepared.receipt! }));
	expect(accepted.ack).toMatchObject({ acknowledged: false, committed: "review", reviewed: true });
});

test("an unknown receipt is refused, and never reported as a rolled-back acknowledgment", async () => {
	const { session, socketPath } = await endpoint();
	const outcome = await requestBridge({ session, socketPath }, { op: "receipt", token: "bg-1:bg-1@0:never-prepared" });
	expect(outcome.ok).toBe(false);
	if (!outcome.ok) {
		expect(outcome.error.code).toBe("receipt-unaccepted");
		// The wording matters: this says nothing is recorded for the token, not that
		// something acknowledged was undone.
		expect(outcome.error.message).toContain("nothing is recorded as acknowledged");
	}
});

test("an accepted receipt outlives its task as a task expiry, never as a rolled-back acknowledgment", async () => {
	const { session, socketPath } = await endpoint();
	const task = spawned(await bgTask().execute("receipt-retention", { action: "spawn", command: "printf 'kept\n'" }));
	await host.settledTask(task.id);

	const prepared = asResult(await requestBridge({ session, socketPath }, { op: "get", id: task.id }));
	const accepted = asResult(await requestBridge({ session, socketPath }, { op: "receipt", token: prepared.receipt! }));
	// A terminal handoff that reached the caller is what settles the completion:
	// the receipt reports the obligation acknowledged, not merely a terminal
	// commit that left it owed.
	expect(accepted.ack).toMatchObject({ acknowledged: true, committed: "terminal", reviewed: false });

	// Retained: a retry replays the committed outcome rather than committing again.
	const replayed = asResult(await requestBridge({ session, socketPath }, { op: "receipt", token: prepared.receipt! }));
	expect(replayed.ack?.committed).toBe("replayed");

	// The task then leaves the retained map, the way the finished-task bound drops
	// it. The commit still happened, so the retry must be told the *task* expired
	// — an unaccepted-preparation error here would read as an undone
	// acknowledgment.
	await bgTask().execute("receipt-retention-clear", { action: "clear" });
	expect(await listed(task.id), "the task is out of the retained map").toBeUndefined();
	const afterPrune = await requestBridge({ session, socketPath }, { op: "receipt", token: prepared.receipt! });
	expect(afterPrune.ok).toBe(false);
	if (!afterPrune.ok) {
		expect(afterPrune.error.code).toBe("expired");
		expect(afterPrune.error.message).toContain("no longer retained");
	}
});

test("an accepted receipt outlives the abandoned-preparation window, and is never reported as unaccepted", async () => {
	const { session, socketPath } = await endpoint();
	const task = spawned(await bgTask().execute("receipt-ttl", { action: "spawn", command: "printf 'kept\n'" }));
	await host.settledTask(task.id);

	const prepared = asResult(await requestBridge({ session, socketPath }, { op: "get", id: task.id }));
	const accepted = asResult(await requestBridge({ session, socketPath }, { op: "receipt", token: prepared.receipt! }));
	expect(accepted.ack).toMatchObject({ acknowledged: true, committed: "terminal" });

	// The task leaves the retained map, the way the finished-task bound drops it.
	await bgTask().execute("receipt-ttl-clear", { action: "clear" });
	expect(await listed(task.id)).toBeUndefined();

	// Advance a full hour past the window in which a preparation the session never
	// accepted is forgotten, and mint once so the aging pass runs. An accepted
	// handoff is not an abandoned preparation: the spec's answer for a pruned task
	// is an explicit task expiry, so forgetting this record would answer an
	// acknowledged token with `receipt-unaccepted`.
	const witness = spawned(await bgTask().execute("receipt-ttl-witness", { action: "spawn", command: "printf 'witness\n'" }));
	await host.settledTask(witness.id);
	const realNow = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(realNow + 60 * 60_000);
	try {
		await requestBridge({ session, socketPath }, { op: "get", id: witness.id });
	} finally {
		clock.mockRestore();
	}

	const afterWindow = await requestBridge({ session, socketPath }, { op: "receipt", token: prepared.receipt! });
	expect(afterWindow.ok).toBe(false);
	if (!afterWindow.ok) {
		expect(afterWindow.error.code, "an acknowledged token is reported as a task expiry, not as an unaccepted preparation").toBe("expired");
		expect(afterWindow.error.message).toContain("no longer retained");
		// The wording must not read as a reversal of the acknowledgment.
		expect(afterWindow.error.message).toContain("its acknowledgment stands");
	}
});

test("a filled receipt store retires the oldest accepted handoff without calling it unaccepted", async () => {
	const { session, socketPath } = await endpoint();

	// More accepted handoffs than the store's cap, each with its task pruned, so
	// the cap is forced to retire accepted records. The cap is a memory bound; the
	// tokens it retires were still genuine accepted handoffs.
	const oldest = { id: "", token: "" };
	for (let index = 0; index < 66; index++) {
		const task = spawned(await bgTask().execute(`receipt-overflow-${index}`, { action: "spawn", command: "printf 'x\n'" }));
		await host.settledTask(task.id);
		const prepared = asResult(await requestBridge({ session, socketPath }, { op: "get", id: task.id }));
		asResult(await requestBridge({ session, socketPath }, { op: "receipt", token: prepared.receipt! }));
		if (index === 0) oldest.token = prepared.receipt!;
		oldest.id = task.id;
		await bgTask().execute(`receipt-overflow-clear-${index}`, { action: "clear", id: task.id });
	}
	expect(await listed(oldest.id), "the first task left the retained map").toBeUndefined();

	// One more mint runs the aging and capacity pass, which retires the oldest
	// accepted records to stay inside the bound.
	const witness = spawned(await bgTask().execute("receipt-overflow-witness", { action: "spawn", command: "printf 'witness\n'" }));
	await host.settledTask(witness.id);
	asResult(await requestBridge({ session, socketPath }, { op: "get", id: witness.id }));

	// The retired token is still recognizable as this session's, so the answer is
	// an expiry that claims nothing about acknowledgment — never the
	// unaccepted-preparation refusal, which would describe a settled handoff as one
	// that was never accepted. The memory bound is unchanged; only the answer is.
	const retired = await requestBridge({ session, socketPath }, { op: "receipt", token: oldest.token });
	expect(retired.ok).toBe(false);
	if (!retired.ok) {
		expect(retired.error.code, "a retired accepted token is an expiry, not an unaccepted preparation").toBe("expired");
		expect(retired.error.message, "the answer claims nothing false about the acknowledgment").not.toContain("nothing is recorded as acknowledged");
		expect(retired.error.message).toContain("makes no claim");
	}

	// Unknown-token refusal is unchanged: a token this session never minted still
	// gets the unaccepted-preparation answer, because for it that answer is true.
	const forged = await requestBridge({ session, socketPath }, { op: "receipt", token: `${oldest.id}:${oldest.id}@0:forged:not-a-tag` });
	expect(forged.ok).toBe(false);
	if (!forged.ok) {
		expect(forged.error.code).toBe("receipt-unaccepted");
		expect(forged.error.message).toContain("nothing is recorded as acknowledged");
	}
});

test("an altered token is refused as never issued, and a refused receipt mutates nothing", async () => {
	const { session, socketPath } = await endpoint();
	const task = spawned(await bgTask().execute("receipt-altered", { action: "spawn", command: "printf 'kept\n'" }));
	await host.settledTask(task.id);

	const prepared = asResult(await requestBridge({ session, socketPath }, { op: "get", id: task.id }));
	const token = prepared.receipt!;
	const before = await listed(task.id);

	// The digest covers the *whole* issued token, nonce included, so altering any
	// part of it — including the nonce, which is not otherwise authenticated by the
	// task identity — is refused as a token this session never minted. Nothing is
	// settled, so no acknowledgment state is claimed and no clock moves.
	const body = token.slice(0, token.lastIndexOf(":"));
	const tag = token.slice(token.lastIndexOf(":") + 1);
	const nonceAltered = `${body.slice(0, body.lastIndexOf(":"))}:${randomUUID()}:${tag}`;
	for (const altered of [nonceAltered, `${body}:${tag.slice(0, -1)}a`, `x${token}`]) {
		const refused = await requestBridge({ session, socketPath }, { op: "receipt", token: altered });
		expect(refused.ok, `an altered token is refused: ${altered.slice(-12)}`).toBe(false);
		if (!refused.ok) {
			expect(refused.error.code).toBe("receipt-unaccepted");
			expect(refused.error.message).toContain("nothing is recorded as acknowledged");
		}
	}

	// The refusals did not settle the genuine preparation: its own receipt is still
	// the one that commits, and the task's obligation was untouched throughout.
	const after = await listed(task.id);
	expect({ exitNotified: after?.exitNotified, lastReviewedAt: after?.lastReviewedAt }).toEqual({
		exitNotified: before?.exitNotified,
		lastReviewedAt: before?.lastReviewedAt,
	});
	const accepted = asResult(await requestBridge({ session, socketPath }, { op: "receipt", token }));
	expect(accepted.ack?.committed).toBe("terminal");
});

test("a receipt store saturated with retained handoffs fails the read explicitly instead of handing out an unusable token", async () => {
	const { session, socketPath } = await endpoint();
	// One retained task, read and accepted past the store's capacity: every record
	// is an accepted handoff of a task the session still retains, so none of them
	// may be retired.
	const task = spawned(await bgTask().execute("receipt-saturate", { action: "spawn", command: "printf 'kept\n'" }));
	await host.settledTask(task.id);

	const oldest: string[] = [];
	const refusal = await (async () => {
		for (let index = 0; index < 200; index++) {
			const prepared = await requestBridge({ session, socketPath }, { op: "get", id: task.id });
			if (!prepared.ok) return prepared;
			if (!prepared.response.ok) return { ok: false as const, error: prepared.response.error };
			const receipt = prepared.response.result.receipt!;
			if (oldest.length < 4) oldest.push(receipt);
			const accepted = await requestBridge({ session, socketPath }, { op: "receipt", token: receipt });
			expect(accepted.ok, "each handoff within capacity still settles").toBe(true);
		}
		return null;
	})();

	// The refusal is explicit and names the capacity, rather than succeeding with a
	// token whose record was not kept, or silently exceeding the bound.
	expect(refusal, "the store refused rather than growing without bound").not.toBeNull();
	if (refusal && !refusal.ok) {
		expect(refusal.error.code).toBe("capacity");
		expect(refusal.error.message).toContain("cannot be acknowledged");
	}

	// No accepted handoff of a retained task was retired to make room: the earliest
	// tokens still replay their committed outcome rather than reading as unaccepted.
	expect(await listed(task.id), "the task is still retained throughout").toBeDefined();
	for (const token of oldest) {
		const replayed = await requestBridge({ session, socketPath }, { op: "receipt", token });
		expect(replayed.ok, "an accepted handoff of a retained task is never retired").toBe(true);
		if (replayed.ok) expect(replayed.response.ok && replayed.response.result.ack?.committed).toBe("replayed");
	}
});

test("the endpoint refuses a receipt with no token before any handler sees it", async () => {
	const { session, socketPath } = await endpoint();
	const outcome = await requestBridge({ session, socketPath }, { op: "receipt" } as never);
	expect(outcome.ok).toBe(false);
	if (!outcome.ok) expect(outcome.error.code).toBe("malformed");
});
