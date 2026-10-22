// Task-state persistence for pi-bash-processes.
//
// One authority: the per-session sidecar `state.json` holds the recoverable task
// records and is written atomically (temp file + rename) on each persist. The
// Pi session carries only small lifecycle transition entries — identity, the
// handful of fields that mark a transition, the writing session and a
// timestamp — never a roster, a full command history or output. Sessions are
// append-only, so anything written there is permanent; keeping the transcript to
// transitions is what stops it growing with task count times output activity.
//
// Restore reads the sidecar first (see `background-tasks.ts`). Session entries of
// the old `kendex-background-tasks:state` snapshot type are read only for a
// session that has no sidecar yet, and are never written again.

import { createHash } from "node:crypto";
import {
	mkdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { logBackgroundDiagnostic } from "./diagnostics.js";
import { piUserDir } from "./package-config.js";
import type { BackgroundTaskSnapshot } from "./types.js";

/** Sidecar format version. Version 1 files (full payload, no session id) still load. */
export const BG_TASK_STORE_VERSION = 2;

/** Longest command prefix a transition entry carries, on a task's first appearance only. */
const TRANSITION_COMMAND_MAX_CHARS = 80;

/**
 * One lifecycle transition as it lands in the session. Only the fields that mark
 * a transition are present; `command` appears on `created` alone.
 */
export interface TaskTransitionEntry {
	v: 1;
	session: string;
	at: number;
	id: string;
	transition: "created" | "changed" | "removed";
	command?: string;
	status?: BackgroundTaskSnapshot["status"];
	exitCode?: number | null;
	exitNotified?: boolean;
	resultReady?: boolean;
	resultResolution?: BackgroundTaskSnapshot["resultResolution"];
	resultReminded?: boolean;
}

/**
 * Applies one legacy `kendex-background-tasks:state` entry to a restore in
 * progress. A full snapshot replaces what came before it; a bounded manifest
 * carried no tasks and changes nothing. Used only for a session with no sidecar.
 */
export interface ApplyLegacyEntryArgs<T> {
	data: unknown;
	clear: () => void;
	apply: (snapshot: T) => void;
}

export function applyLegacySnapshotEntry<T>(args: ApplyLegacyEntryArgs<T>): void {
	const data = args.data as { tasks?: unknown; fullSnapshot?: unknown } | undefined;
	if (data?.fullSnapshot === false) return;
	args.clear();
	if (Array.isArray(data?.tasks)) for (const snapshot of data.tasks) args.apply(snapshot as T);
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) sorted[key] = stableValue((value as Record<string, unknown>)[key]);
	return sorted;
}

// Fingerprints are persisted inside the overflow manifest;
// returning the full canonical JSON defeats the byte cap. Hash to a
// fixed-size hex digest so an oversized task list yields a small
// manifest even when the underlying payload is many MB.
export function stableSnapshotFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export interface PersistResult {
	/** Transition entries appended to the session by this persist. */
	transitions: number;
	/** Whether the sidecar now holds the current state. */
	sidecar: boolean;
}

export interface PersistencePayload {
	version: number;
	sessionId?: string;
	tasks: BackgroundTaskSnapshot[];
	updatedAt: number;
}

export interface PersistenceDeps {
	pi: ExtensionAPI;
	/** Session entry type the transition entries are appended under. */
	transitionType: string;
	getActiveCtx: () => ExtensionContext | null;
	listSnapshots: () => BackgroundTaskSnapshot[];
	notify?: (where: string, message: string) => void;
}

export function safeFileName(value: string): string {
	return value.replace(/[^\w.-]+/g, "_");
}

export function sessionIdForContext(ctx: ExtensionContext): string {
	const id = ctx.sessionManager.getSessionId();
	if (id && id.trim()) return id;
	const file = ctx.sessionManager.getSessionFile();
	if (file) return file.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") ?? `ephemeral-${process.pid}`;
	return `ephemeral-${process.pid}`;
}

export function sidecarStatePath(ctx: ExtensionContext): string {
	return join(
		piUserDir(),
		"kendex",
		"sessions",
		safeFileName(sessionIdForContext(ctx)),
		"pi-background-tasks",
		"state.json",
	);
}

// Atomic write: temp file in the same directory + rename(2). Aborts on
// error so the previous good state is preserved. Mode 0600 on the temp
// file matches the eventual file's permissions; mode 0700 on the
// parent directory prevents cross-user read of session state.
export function writeSidecarAtomic(file: string, payload: string): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
	try {
		writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, file);
	} catch (error) {
		try { unlinkSync(tmp); } catch { /* */ }
		throw error;
	}
}

export function reportPersistFailure(
	where: string,
	error: unknown,
	notify?: (where: string, message: string) => void,
): void {
	const msg = error instanceof Error ? error.message : String(error);
	logBackgroundDiagnostic("persistence failed", { where, error: msg });
	notify?.(where, msg);
}

const transitionKey = (task: BackgroundTaskSnapshot): string =>
	JSON.stringify([task.status, task.exitCode ?? null, task.exitNotified === true, task.resultReady === true, task.resultResolution ?? null, task.resultReminded === true]);

function transitionFacts(task: BackgroundTaskSnapshot): Omit<TaskTransitionEntry, "v" | "session" | "at" | "id" | "transition" | "command"> {
	return {
		status: task.status,
		exitCode: task.exitCode ?? null,
		exitNotified: task.exitNotified === true,
		resultReady: task.resultReady === true,
		...(task.resultResolution !== undefined ? { resultResolution: task.resultResolution } : {}),
		resultReminded: task.resultReminded === true,
	};
}

// Persist the current task set.
//   1. The sidecar is written in full, atomically. It is the only recoverable
//      copy; a failure is reported and leaves the previous file intact.
//   2. The session gets one small entry per task whose lifecycle changed since
//      the last persist, and one per task that disappeared. Output growth changes
//      neither, so a chatty task adds nothing to the session.
// The two are independent: a failed sidecar write does not suppress the entries,
// which describe what happened rather than what can be recovered.
export function createPersistence(deps: PersistenceDeps): {
	persistSnapshots: () => PersistResult;
	/** Records the restored tasks as already seen, so a resume appends no transitions for them. */
	seed: (tasks: BackgroundTaskSnapshot[]) => void;
	payloadFor: (tasks: BackgroundTaskSnapshot[], sessionId?: string) => PersistencePayload;
} {
	const notify = deps.notify;
	// Last lifecycle tuple appended per task id; absence means the session has not seen the task.
	const lastSeen = new Map<string, string>();

	function payloadFor(tasks: BackgroundTaskSnapshot[], sessionId?: string): PersistencePayload {
		return { version: BG_TASK_STORE_VERSION, ...(sessionId !== undefined ? { sessionId } : {}), tasks, updatedAt: Date.now() };
	}

	function seed(tasks: BackgroundTaskSnapshot[]): void {
		lastSeen.clear();
		for (const task of tasks) lastSeen.set(task.id, transitionKey(task));
	}

	function persistSnapshots(): PersistResult {
		const ctx = deps.getActiveCtx();
		if (!ctx) return { transitions: 0, sidecar: false };
		const tasks = deps.listSnapshots();
		const session = sessionIdForContext(ctx);
		let sidecarOk = false;
		try {
			writeSidecarAtomic(sidecarStatePath(ctx), `${JSON.stringify(payloadFor(tasks, session))}\n`);
			sidecarOk = true;
		} catch (error) {
			reportPersistFailure("sidecar", error, notify);
		}

		const at = Date.now();
		const entries: { id: string; key: string | null; entry: TaskTransitionEntry }[] = [];
		const present = new Set<string>();
		for (const task of tasks) {
			present.add(task.id);
			const key = transitionKey(task);
			const before = lastSeen.get(task.id);
			if (before === key) continue;
			entries.push({
				id: task.id,
				key,
				entry: {
					v: 1,
					session,
					at,
					id: task.id,
					transition: before === undefined ? "created" : "changed",
					...(before === undefined ? { command: task.command.slice(0, TRANSITION_COMMAND_MAX_CHARS) } : {}),
					...transitionFacts(task),
				},
			});
		}
		for (const id of lastSeen.keys()) {
			if (!present.has(id)) entries.push({ id, key: null, entry: { v: 1, session, at, id, transition: "removed" } });
		}
		let appended = 0;
		for (const { id, key, entry } of entries) {
			try {
				deps.pi.appendEntry(deps.transitionType, entry);
				if (key === null) lastSeen.delete(id);
				else lastSeen.set(id, key);
				appended += 1;
			} catch (error) {
				reportPersistFailure("appendEntry", error, notify);
				break;
			}
		}
		return { transitions: appended, sidecar: sidecarOk };
	}

	return { persistSnapshots, seed, payloadFor };
}
