import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	createPersistence,
	type PersistenceDeps,
	type PersistencePayload,
	type TaskTransitionEntry,
} from "../extensions/persistence.js";
import type { BackgroundTaskSnapshot } from "../extensions/types.js";
import { boundedSnapshot } from "./fixtures/bounded-snapshot.js";
import { clearPackageConfigCache } from "../extensions/package-config.js";

function withPersistenceContext(run: (ctx: NonNullable<ReturnType<PersistenceDeps["getActiveCtx"]>>, sidecarFile: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "pi-bg-bounded-"));
	const previousPiDir = process.env.PI_CODING_AGENT_DIR;
	const previousDiagnosticLog = process.env.PI_BG_TASK_DIAGNOSTIC_LOG;
	try {
		const piDir = join(root, "agent");
		process.env.PI_CODING_AGENT_DIR = piDir;
		clearPackageConfigCache();
		process.env.PI_BG_TASK_DIAGNOSTIC_LOG = join(root, "diagnostics.log");
		const ctx = {
			cwd: root,
			sessionManager: {
				getSessionId: () => "session",
				getSessionFile: () => join(root, "session.jsonl"),
			},
		} as NonNullable<ReturnType<PersistenceDeps["getActiveCtx"]>>;
		run(ctx, join(piDir, "pi-bash-processes", "sessions", "session", "state.json"));
	} finally {
		if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousPiDir;
		if (previousDiagnosticLog === undefined) delete process.env.PI_BG_TASK_DIAGNOSTIC_LOG;
		else process.env.PI_BG_TASK_DIAGNOSTIC_LOG = previousDiagnosticLog;
		clearPackageConfigCache();
		rmSync(root, { recursive: true, force: true });
	}
}


function harness(ctx: NonNullable<ReturnType<PersistenceDeps["getActiveCtx"]>>, notices: string[] = []) {
	const appended: { customType: string; entry: TaskTransitionEntry }[] = [];
	let snapshots: BackgroundTaskSnapshot[] = [];
	const persistence = createPersistence({
		transitionType: "transition",
		getActiveCtx: () => ctx,
		listSnapshots: () => snapshots,
		notify: (where) => notices.push(where),
		pi: { appendEntry: (customType: string, entry: TaskTransitionEntry) => appended.push({ customType, entry }) } as unknown as PersistenceDeps["pi"],
	});
	return { appended, persistence, set: (next: BackgroundTaskSnapshot[]) => { snapshots = next; } };
}

test("the session gets an entry per lifecycle transition and none for output growth", () => {
	withPersistenceContext((ctx, sidecarFile) => {
		const { appended, persistence, set } = harness(ctx);
		set([boundedSnapshot({ status: "running", exitCode: null })]);
		expect(persistence.persistSnapshots()).toEqual({ transitions: 1, sidecar: "written" });
		expect(appended[0]!.entry).toMatchObject({ transition: "created", id: "bg-1", session: "session", status: "running", command: "printf ready" });

		// A chatty task: output counters and timestamps move on every chunk.
		for (let chunk = 1; chunk <= 200; chunk++) {
			set([boundedSnapshot({ status: "running", exitCode: null, outputBytes: chunk * 4096, lastOutputAt: chunk, updatedAt: chunk })]);
			expect(persistence.persistSnapshots(), `chunk ${chunk}`).toEqual({ transitions: 0, sidecar: "unchanged" });
		}
		expect(appended, "output alone appends nothing").toHaveLength(1);
		// The counters on disk are therefore stale by design; restore re-derives them from the log.
		const sidecar = JSON.parse(readFileSync(sidecarFile, "utf8")) as PersistencePayload;
		expect(sidecar.tasks[0]!.outputBytes).toBe(0);

		set([boundedSnapshot({ status: "completed", exitCode: 0, resultReady: true })]);
		expect(persistence.persistSnapshots()).toEqual({ transitions: 1, sidecar: "written" });
		expect(appended[1]!.entry).toMatchObject({ transition: "changed", status: "completed", exitCode: 0, resultReady: true, exitNotified: false });
		expect(appended[1]!.entry.command, "the command is carried once, on creation").toBeUndefined();

		set([boundedSnapshot({ status: "completed", exitCode: 0, resultReady: true, exitNotified: true, resultResolution: "delivered", resultReminded: true })]);
		persistence.persistSnapshots();
		expect(appended[2]!.entry).toMatchObject({ exitNotified: true, resultResolution: "delivered", resultReminded: true });

		set([]);
		expect(persistence.persistSnapshots().transitions).toBe(1);
		expect(appended[3]!.entry).toMatchObject({ transition: "removed", id: "bg-1" });
		expect(appended.every(({ customType }) => customType === "transition")).toBe(true);
	});
});

test("a transition entry is bounded however large the task is", () => {
	withPersistenceContext((ctx) => {
		const { appended, persistence, set } = harness(ctx);
		set(Array.from({ length: 70 }, (_, index) => boundedSnapshot({ id: `bg-${index}`, command: "x".repeat(10 * 1024), wakeEvents: Array.from({ length: 50 }, () => ({ at: 1 })) as never })));
		persistence.persistSnapshots();
		expect(appended).toHaveLength(70);
		const largest = Math.max(...appended.map(({ entry }) => JSON.stringify(entry).length));
		expect(largest, "each entry stays small: no roster, no history, a truncated command").toBeLessThan(400);
	});
});

test("a resumed session appends nothing for tasks it restored", () => {
	withPersistenceContext((ctx) => {
		const { appended, persistence, set } = harness(ctx);
		const restored = [boundedSnapshot({ id: "bg-1", status: "completed" }), boundedSnapshot({ id: "bg-2", status: "running" })];
		set(restored);
		persistence.seed(restored);
		expect(persistence.persistSnapshots().transitions).toBe(0);
		set([restored[0]!, boundedSnapshot({ id: "bg-2", status: "completed" })]);
		expect(persistence.persistSnapshots().transitions, "a later change to a restored task is still recorded").toBe(1);
		expect(appended[0]!.entry).toMatchObject({ transition: "changed", id: "bg-2" });
	});
});

test("a failed sidecar write is reported and leaves the previous state readable", () => {
	if (process.getuid?.() === 0) return;
	withPersistenceContext((ctx, sidecarFile) => {
		const notices: string[] = [];
		const { persistence, set } = harness(ctx, notices);
		set([boundedSnapshot({ id: "bg-keep" })]);
		expect(persistence.persistSnapshots().sidecar).toBe("written");
		const dir = dirname(sidecarFile);
		chmodSync(dir, 0o500);
		try {
			set([boundedSnapshot({ id: "bg-keep" }), boundedSnapshot({ id: "bg-lost" })]);
			expect(persistence.persistSnapshots().sidecar).toBe("failed");
		} finally {
			chmodSync(dir, 0o700);
		}
		expect(notices).toEqual(["sidecar"]);
		const kept = JSON.parse(readFileSync(sidecarFile, "utf8")) as PersistencePayload;
		expect(kept.tasks.map((task) => task.id), "the prior good state survives the failed replace").toEqual(["bg-keep"]);
	});
});
