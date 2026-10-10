// The provider's snapshot distinguishes the two terminal states a consumer
// must treat differently (openspec `background-unread-results` provider
// delta): a certified terminal result that is merely unretrieved stays
// `awaiting-result-review` with a handoff reason, while a restored capture
// that can never certify is explicitly identified by its reason.
// The fixture is the persisted snapshot a restart reads, which is the only way
// a capture reaches the never-certified state.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { startExtensionHost, type ExtensionHost } from "./fixtures/extension-host.js";
import { bindBackgroundWorkAssignment, queryBackgroundWorkSnapshot } from "../extensions/background-work.js";
import { sidecarStatePath } from "../extensions/persistence.js";

const host: ExtensionHost = await startExtensionHost({ settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
afterAll(() => host.dispose());

const SESSION = `extension-host-${process.pid}`;
const REQUEST = "req-readiness";
const bgTask = () => host.tools.get("bg_task")!;

/**
 * A restored terminal task associated with `REQUEST`. `captured` distinguishes
 * the two durable records: a certified capture (`resultReady` + `outputComplete`)
 * whose result was never retrieved, and a capture the previous process left
 * unestablished, which no later process can certify.
 */
const restoredTask = (id: string, captured: boolean) => ({
	id,
	command: `printf '${id}'`,
	title: id,
	cwd: tmpdir(),
	status: "completed",
	exitCode: 0,
	pid: 4194303,
	startedAt: Date.now() - 60_000,
	updatedAt: Date.now() - 30_000,
	logFile: join(tmpdir(), `settlement-readiness-${id}-${process.pid}.log`),
	// Wake-suppressed: the assertions below are about the durable records, not
	// about the session-start replay of missed exits.
	notifyOnExit: false,
	notifyOnOutput: false,
	exitNotified: true,
	outputBytes: 0,
	assignmentRequestId: REQUEST,
	sessionId: SESSION,
	resultReady: captured ? true : false,
	outputComplete: captured,
});

test("a snapshot marks the never-certified restored capture and omits the mark on the certified unretrieved result", async () => {
	const sidecar = sidecarStatePath(host.ctx);
	mkdirSync(dirname(sidecar), { recursive: true });
	writeFileSync(sidecar, `${JSON.stringify({ tasks: [restoredTask("bg-910", true), restoredTask("bg-911", false)] })}\n`);
	await host.dispatch("session_start");
	expect(bindBackgroundWorkAssignment(host.events, { sessionId: SESSION, requestId: REQUEST })).toStrictEqual({ state: "bound" });

	const result = queryBackgroundWorkSnapshot(host.events, { sessionId: SESSION, requestId: REQUEST });
	if (result.state !== "ready") throw new Error(`expected ready, received ${JSON.stringify(result)}`);
	const outstanding = result.snapshot.outstanding;
	expect(outstanding).toHaveLength(2);
	expect(outstanding[0]).toMatchObject({ taskId: "bg-910", state: "awaiting-result-review" });
	expect(outstanding[0]?.reason).toContain("awaiting an actual result handoff");
	expect(outstanding[1]).toMatchObject({ taskId: "bg-911", state: "awaiting-result-review" });
	expect(outstanding[1]?.reason).toContain("never certified");

	// Delivering the unrecoverable capture error resolves it, so the blocking
	// entry retires through the ordinary retrieval path and only the advisory
	// unretrieved result remains.
	await bgTask().execute("readiness-get-incomplete", { action: "get", id: "bg-911" });
	const after = queryBackgroundWorkSnapshot(host.events, { sessionId: SESSION, requestId: REQUEST });
	if (after.state !== "ready") throw new Error(`expected ready, received ${JSON.stringify(after)}`);
	expect(after.snapshot.outstanding).toHaveLength(1);
	expect(after.snapshot.outstanding[0]).toMatchObject({ taskId: "bg-910", state: "awaiting-result-review" });
});
