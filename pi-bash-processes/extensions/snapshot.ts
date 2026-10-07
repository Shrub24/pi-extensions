import { readFile } from "node:fs/promises";

import { DEFAULT_SOFT_TIMEOUT_MS } from "./constants.js";
import { parseOutputMatcher } from "./format.js";
import { runProbe, type ProbeRunner } from "./probes.js";
import type { BackgroundTaskSnapshot, ManagedTask, ProcessIdentity } from "./types.js";
import { normalizeNotifyMode, normalizeOutputWakeBudget } from "./wake-events.js";

const liveSnapshots = new Map<string, BackgroundTaskSnapshot>();

export function taskSnapshot(task: ManagedTask): BackgroundTaskSnapshot {
	return {
		command: task.command,
		cwd: task.cwd,
		exitCode: task.exitCode,
		exitNotified: task.exitNotified === true,
		expiresAt: task.expiresAt,
		id: task.id,
		lastOutputAt: task.lastOutputAt,
		logFile: task.logFile,
		notifyOnExit: task.notifyOnExit,
		notifyOnOutput: task.notifyOnOutput,
		notifyPattern: task.notifyPattern,
		notifyMode: normalizeNotifyMode(task.notifyMode),
		dedupeKey: task.dedupeKey,
		outputBytes: task.outputBytes,
		wakeSequence: task.wakeSequence ?? 0,
		wakeEvents: task.wakeEvents ?? [],
		voidedWakeSequences: task.voidedWakes instanceof Set
			? [...task.voidedWakes].sort((a, b) => a - b)
			: (task.voidedWakeSequences ?? []),
		pendingWakes: task.pendingWakes ?? [],
		lastOutputDedupeHash: task.lastOutputDedupeHash,
		lastOutputDedupeByKey: task.lastOutputDedupeByKey,
		lastReviewedAt: task.lastReviewedAt,
		reviewedOutputBytes: task.reviewedOutputBytes,
		reviewRevision: task.reviewRevision ?? 0,
		resultReady: task.resultReady === true,
		// Task → assignment association and result resolution (openspec tasks
		// 2.1-2.3) are durable settlement state: written at spawn / at an
		// observed handoff, they must survive the restart they are recorded for.
		assignmentRequestId: task.assignmentRequestId,
		resultResolution: task.resultResolution,
		// Only a terminal task has an established capture record; a running task
		// writes none, so restore reads "not recorded" and reconciles.
		outputComplete: task.status === "running" ? undefined : task.outputComplete === true,
		outputPatternMatched: task.outputPatternMatched === true,
		outputWakeBudget: task.outputWakeBudget ? normalizeOutputWakeBudget(task.outputWakeBudget) : undefined,
		softExpiresAt: task.softExpiresAt,
		softTimeoutNotified: task.softTimeoutNotified === true,
		softTimeoutMs: task.softTimeoutMs,
		pid: task.pid,
		procIdent: task.procIdent,
		resourceControl: task.resourceControl,
		sessionId: task.sessionId,
		startedAt: task.startedAt,
		status: task.status,
		terminationReason: task.terminationReason,
		supersededBy: task.supersededBy,
		title: task.title,
		updatedAt: task.updatedAt,
	};
}

export function rememberSnapshot(task: ManagedTask): BackgroundTaskSnapshot {
	const snapshot = taskSnapshot(task);
	liveSnapshots.set(snapshot.id, snapshot);
	return snapshot;
}

export function forgetSnapshot(id: string): void {
	liveSnapshots.delete(id);
}

export function latestSnapshot(snapshot: BackgroundTaskSnapshot | undefined): BackgroundTaskSnapshot | undefined {
	if (!snapshot) return undefined;
	return liveSnapshots.get(snapshot.id) ?? snapshot;
}

export function latestSnapshots(snapshots: BackgroundTaskSnapshot[]): BackgroundTaskSnapshot[] {
	return snapshots.map((snapshot) => latestSnapshot(snapshot) ?? snapshot);
}

export function resolveTaskByToken<T extends Pick<BackgroundTaskSnapshot, "id" | "pid">>(
	tasks: Iterable<T>,
	token: string | number | undefined,
): T | null {
	if (token === undefined || token === null || token === "") return null;
	const normalized = String(token).trim();
	if (!normalized) return null;
	for (const task of tasks) {
		if (task.id === normalized || String(task.pid) === normalized) return task;
	}
	return null;
}

// Default pid-liveness probe. Returns true iff the kernel reports the
// pid as alive (or EPERM, which means alive-but-foreign). It cannot tell
// PID reuse, so the identity read uses it only on a host without `ps`.
export function defaultProcessAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** What one identity read learned about a pid. */
export type IdentityReading =
	| { kind: "identity"; identity: ProcessIdentity }
	/** The pid lives, but this host has no way to read its identity. */
	| { kind: "alive" }
	| { kind: "gone" }
	| { kind: "unknown"; reason: string };

export type IdentityProbe = (pid: number) => Promise<IdentityReading>;

export interface IdentityReaderDeps {
	platform?: NodeJS.Platform;
	readStat?: (path: string) => Promise<string>;
	run?: ProbeRunner;
	processAlive?: (pid: number) => boolean;
}

// Read kernel-stable process identity. Linux fast path: /proc/<pid>/stat
// field 22 (starttime in jiffies since boot) + /proc/<pid>/comm. Other
// platforms, and a /proc read that fails for another reason: `ps -o
// lstart=,comm= -p <pid>` returns an absolute start time string + comm, as a
// time-limited asynchronous probe. This detects PID reuse: the kernel may
// recycle a PID for an unrelated process, but the start token cannot collide
// for the same recycled pid within the same boot.
//
// `gone`: /proc has no entry, or ps exited non-zero or printed nothing. A
// host without ps falls back to a signal-0 check. An unsettled ps result, or
// ps output this cannot parse, answers `unknown`.
export async function defaultReadProcessIdentity(pid: number, deps: IdentityReaderDeps = {}): Promise<IdentityReading> {
	if (!Number.isFinite(pid) || pid <= 0) return { kind: "gone" };
	if ((deps.platform ?? process.platform) === "linux") {
		try {
			const stat = await (deps.readStat ?? ((path: string) => readFile(path, "utf8")))(`/proc/${pid}/stat`);
			const lastParen = stat.lastIndexOf(")");
			// stat fields after the closing paren of comm are space-separated.
			// starttime is field 22 globally, which is index 22-3=19 inside the
			// post-paren slice (fields 1, 2 (parenthesized comm), 3..N).
			const starttime = lastParen < 0 ? undefined : stat.slice(lastParen + 1).trim().split(/\s+/)[19];
			if (starttime) {
				const comm = stat.slice(stat.indexOf("(") + 1, lastParen);
				return { kind: "identity", identity: { pid, startToken: starttime, comm } };
			}
			// An unparseable stat falls through to the portable ps path.
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "gone" };
			// Fall through to the portable ps path.
		}
	}
	const result = await (deps.run ?? runProbe)("ps", ["-o", "lstart=,comm=", "-p", String(pid)]);
	switch (result.kind) {
		case "exited": break;
		case "missing": return (deps.processAlive ?? defaultProcessAlive)(pid) ? { kind: "alive" } : { kind: "gone" };
		case "unsettled": return { kind: "unknown", reason: `ps ${result.cause}` };
		default: {
			const unreachable: never = result;
			throw new Error(`unknown probe result: ${JSON.stringify(unreachable)}`);
		}
	}
	if (result.status !== 0) return { kind: "gone" };
	const line = result.stdout.trim();
	if (!line) return { kind: "gone" };
	// lstart format: "Day Mon DD HH:MM:SS YYYY" (5 whitespace-separated tokens),
	// then comm. Split on whitespace and reassemble.
	const parts = line.split(/\s+/);
	if (parts.length < 6) return { kind: "unknown", reason: `ps output unparseable: ${line}` };
	return { kind: "identity", identity: { pid, startToken: parts.slice(0, 5).join(" "), comm: parts.slice(5).join(" ") } };
}

// True iff the kernel-stable subset matches. "Kernel-stable" means pid +
// startToken (process start time): these cannot drift while the original
// process lives. comm is captured and persisted as a diagnostic so
// `bg_task list` / logs can show what the process was at spawn, but it is NOT
// part of equality: the common `bash -lc "sleep 5"` pattern rotates
// /proc/<pid>/comm from "bash" to "sleep" via exec(2) without changing pid or
// starttime. Gating identity on comm would false-finalize a still-live task.
//
// A snapshot with no identity (the spawn-time probe failed) is treated
// as a match because there is no pre-recorded token to compare against;
// PID-only liveness is the documented degraded path.
export function identityMatches(recorded: ProcessIdentity | undefined, current: ProcessIdentity): boolean {
	if (!recorded) return true;
	return recorded.pid === current.pid
		&& recorded.startToken === current.startToken;
}

export type LivenessVerdict = "alive" | "pid-gone" | "pid-reused" | "unknown";

export interface LivenessProbes {
	identityProbe: IdentityProbe;
	// For a systemd-run task the transient unit is more authoritative than the
	// wrapper pid: true = active, false = known inactive, null = cannot be
	// queried, so the pid decides.
	unitActiveProbe?: (unitName: string) => Promise<boolean | null>;
}

/**
 * Decide whether a running task's process still lives. Restore and the orphan
 * watcher both ask this; `unknown` means the probes could not answer, and
 * both callers treat it as alive for this pass.
 */
export async function livenessVerdict(
	task: Pick<BackgroundTaskSnapshot, "pid" | "procIdent" | "resourceControl">,
	probes: LivenessProbes,
): Promise<LivenessVerdict> {
	const unitName = task.resourceControl?.mode === "systemd-run" ? task.resourceControl.unitName : undefined;
	const unitActive = unitName && probes.unitActiveProbe ? await probes.unitActiveProbe(unitName) : null;
	if (unitActive === true) return "alive";
	if (unitActive === false) return "pid-gone";
	const current = await probes.identityProbe(task.pid);
	switch (current.kind) {
		case "alive": return "alive";
		case "gone": return "pid-gone";
		case "unknown": return "unknown";
		case "identity": return identityMatches(task.procIdent, current.identity) ? "alive" : "pid-reused";
		default: {
			const unreachable: never = current;
			throw new Error(`unknown identity reading: ${JSON.stringify(unreachable)}`);
		}
	}
}

export interface RestoreOptions {
	now?: number;
	// Identity probe. Default is defaultReadProcessIdentity; livenessVerdict
	// reads its answer.
	identityProbe?: IdentityProbe;
	// Current Pi session id. Snapshots whose sessionId disagrees with this
	// value are still rehydrated (so the dashboard can show their final
	// state) but are not eligible for missed-exit replay; replay is scoped
	// to the session that spawned the task. A fork discards them before
	// this point instead — see snapshotBelongsToSession.
	sessionId?: string;
	// Optional systemd unit liveness probe for resource-controlled tasks.
	// Resolves true while the persisted transient unit is active, false
	// when it is known inactive, and null when the unit cannot be queried.
	unitActiveProbe?: (unitName: string) => Promise<boolean | null>;
}

// A fork inherits its parent's branch, so the snapshots it replays still
// belong to the session that spawned them. A session that is not a fork keeps
// rehydrating foreign snapshots so the dashboard can show their final state.
export function snapshotBelongsToSession(
	snapshot: BackgroundTaskSnapshot,
	sessionId: string | undefined,
	forked: boolean,
): boolean {
	if (!forked) return true;
	return typeof sessionId === "string" && snapshot.sessionId === sessionId;
}

// Rehydrate a persisted snapshot into a ManagedTask placeholder. The child
// process is gone in the vast majority of cases, so closed=true and timers
// are zeroed. Two cases get special treatment:
//
// 1. snapshot.status === 'running' AND livenessVerdict says the process
//    is gone or its pid was reused -> coerce to 'stopped', stopReason=shutdown, exitNotified=false
//    so selectMissedExits / replayMissedExits can deliver the deferred
//    'exit' wake. This is the primary defense against a missed exit.
//
// 2. snapshot.status === 'running' AND livenessVerdict says alive or
//    unknown (Pi restarted but the detached child group is still chugging) ->
//    keep status='running', child=null, exitNotified untouched, and tag
//    the rehydrated task as `restored: true` + `closed: false` so the
//    caller can re-attach output streams (or at minimum surface the
//    orphan in the dashboard) instead of falsely announcing it exited.
//
// Everything else takes snapshot.exitNotified === true, so a terminal
// snapshot that never carried the field is replay-eligible, as is a fresh
// running->stopped coercion.
//
// Readiness is read back from the snapshot rather than recomputed: a snapshot
// that recorded an unsettled flush (`resultReady === false`) restores as an
// unrecoverable incomplete capture, and one that recorded a short capture
// (`outputComplete === false`) restores as ready but explicitly short. See the
// `captureRecorded` / `captureUnestablished` derivation below.
//
// Only a same-session running snapshot is probed, so a restore probes each
// task of its final set at most once.
export async function restoredTaskFromSnapshot(snapshot: BackgroundTaskSnapshot, options: RestoreOptions = {}): Promise<ManagedTask> {
	const now = options.now ?? Date.now();
	const probe = options.identityProbe ?? defaultReadProcessIdentity;
	const softTimeoutMs = Number.isFinite(snapshot.softTimeoutMs)
		? Math.max(0, snapshot.softTimeoutMs ?? 0)
		: DEFAULT_SOFT_TIMEOUT_MS;
	// The persisted deadline wins over a recomputation, so a snapshot written by
	// an older version (no lastReviewedAt) restores exactly the interval it was
	// carrying rather than re-deriving it from startedAt.
	const softExpiresAt = softTimeoutMs > 0
		? (snapshot.softExpiresAt ?? snapshot.startedAt + softTimeoutMs)
		: null;
	const lastReviewedAt = snapshot.lastReviewedAt ?? (softExpiresAt != null ? softExpiresAt - softTimeoutMs : undefined);
	const wasRunning = snapshot.status === "running";
	const foreignSession = typeof options.sessionId === "string"
		&& typeof snapshot.sessionId === "string"
		&& snapshot.sessionId !== options.sessionId;
	// A task whose liveness the probes could not answer stays running; the
	// orphan watcher asks again on its next pass.
	let pidStillAlive = false;
	if (wasRunning && !foreignSession) {
		const verdict = await livenessVerdict(snapshot, { identityProbe: probe, unitActiveProbe: options.unitActiveProbe });
		pidStillAlive = verdict === "alive" || verdict === "unknown";
	}
	const coercedFromRunning = wasRunning && !pidStillAlive;

	// What the snapshot itself recorded about the capture, honoured instead of
	// re-derived. A rehydrated task has no process left to flush and a fresh,
	// empty writer queue, so nothing here can re-establish either fact —
	// recomputing would answer "ready and complete" for bytes that never
	// reached disk.
	//
	// `resultReady` is written by every snapshot this version takes, so its
	// presence is what marks a snapshot as modern; a snapshot that does not
	// carry it recorded nothing and is reconciled below.
	//
	//   captureUnestablished — the process had not reached its flush barrier
	//     (`resultReady === false`). Live, that is finalizeTask's mid-flush
	//     window or the session_shutdown coercion, which stamps a terminal
	//     status without awaiting the flush it later drains; it is also every
	//     running task. A writer this process owns can still settle those
	//     bytes. Rehydrated, the process that owned that writer is gone, the
	//     bytes are unrecoverable, and the task must not come back ready.
	//   captureShort — the writer dropped bytes before the barrier
	//     (`resultReady === true` with `outputComplete === false`). Readiness
	//     landed, capture integrity did not.
	const captureRecorded = typeof snapshot.resultReady === "boolean";
	const captureUnestablished = captureRecorded && snapshot.resultReady === false;
	const captureShort = captureRecorded && snapshot.resultReady === true && snapshot.outputComplete === false;

	// A same-session snapshot is replay-eligible unless its persisted
	// exitNotified is true: the running->stopped coercion forces false, and an
	// absent or false flag stays false. Foreign-session snapshots are pinned
	// true so cross-session leaks are impossible.
	let exitNotified: boolean;
	if (coercedFromRunning && !foreignSession) {
		exitNotified = false;
	} else if (foreignSession) {
		exitNotified = true;
	} else {
		exitNotified = snapshot.exitNotified === true;
	}

	// annotate the running -> stopped coercion so callers can
	// distinguish a Pi-restart reconcile from a clean self-exit or an
	// explicit extension stop. Pre-existing termination reasons (e.g. a
	// snapshot persisted at extension-stop time) are preserved.
	let terminationReason = snapshot.terminationReason;
	if (coercedFromRunning && terminationReason === undefined) {
		terminationReason = "reconcile-on-restart";
	}

	return {
		...snapshot,
		child: null,
		closed: !pidStillAlive,
		exitNotified,
		forceKillTimer: null,
		lastAnnouncedLength: snapshot.outputBytes,
		lastOutputDedupeHash: snapshot.lastOutputDedupeHash,
		lastOutputDedupeByKey: snapshot.lastOutputDedupeByKey ?? {},
		lastReviewedAt,
		matcher: parseOutputMatcher(snapshot.notifyPattern),
		notifyMode: normalizeNotifyMode(snapshot.notifyMode),
		output: "",
		outputPatternMatched: snapshot.outputPatternMatched === true,
		outputWakeBudget: normalizeOutputWakeBudget(snapshot.outputWakeBudget),
		outputTimer: null,
		softTimeoutTimer: null,
		softExpiresAt,
		softTimeoutNotified: snapshot.softTimeoutNotified === true,
		softTimeoutMs,
		reviewedOutputBytes: snapshot.reviewedOutputBytes,
		reviewRevision: snapshot.reviewRevision ?? 0,
		// A rehydrated task has no process left to flush, so a snapshot that
		// recorded a certified capture is the terminal record. A snapshot that
		// recorded an unsettled flush or a short capture stays exactly that:
		// reconciliation may establish *unknown* readiness, never overwrite a
		// known incomplete capture with a complete one. A snapshot that recorded
		// nothing (legacy) is the one case reconciliation may resolve as ready.
		resultReady: pidStillAlive ? false : !captureRecorded || snapshot.resultReady === true,
		outputComplete: pidStillAlive ? false : !captureUnestablished && !captureShort,
		// Settlement state rides the spread, but is re-narrowed here: a snapshot
		// from disk must not be able to smuggle a non-string association or an
		// unknown resolution into the live map. Anything unrecognizable reads as
		// absent, which fails closed — an unassociated task stays quarantined and
		// an unresolved task stays outstanding.
		assignmentRequestId: typeof snapshot.assignmentRequestId === "string" && snapshot.assignmentRequestId.length > 0
			? snapshot.assignmentRequestId
			: undefined,
		// A foreign-session task is another session's history (a fork replays its
		// parent's branch). This session can never retrieve its result, so nothing
		// here waits on it: a terminal one is closed as `delivered` instead of
		// being advertised as awaiting review for the life of the fork.
		resultResolution: snapshot.resultResolution === "delivered" || snapshot.resultResolution === "error"
			? snapshot.resultResolution
			: foreignSession ? "delivered" : undefined,
		pendingWakes: [],
		status: pidStillAlive ? "running" : (wasRunning ? "stopped" : snapshot.status),
		stopReason: pidStillAlive ? null : (coercedFromRunning ? "shutdown" : null),
		terminationReason,
		supersededBy: snapshot.supersededBy,
		timeoutTimer: null,
		voidedWakeSequences: snapshot.voidedWakeSequences ?? [],
		voidedWakes: new Set(snapshot.voidedWakeSequences ?? []),
		wakeEvents: snapshot.wakeEvents ?? [],
		wakeSequence: snapshot.wakeSequence ?? 0,
		restored: true,
		updatedAt: coercedFromRunning ? now : snapshot.updatedAt,
		sessionId: options.sessionId ?? snapshot.sessionId,
	};
}

// Select tasks whose terminal transition never produced an exit wake.
// Drives replayMissedExits on session_start so a session restart can
// recover from running->stopped coercion in restoredTaskFromSnapshot or
// a session_shutdown that killed tasks without notifying the agent.
//
// A same-session snapshot is replay-eligible unless its persisted
// exitNotified is true: the running->stopped coercion forces false, and an
// absent or false flag stays false.
export function selectMissedExits<T extends Pick<BackgroundTaskSnapshot, "status" | "notifyOnExit" | "exitNotified">>(
	tasks: Iterable<T>,
): T[] {
	const out: T[] = [];
	for (const task of tasks) {
		if (task.status === "running") continue;
		if (!task.notifyOnExit) continue;
		if (task.exitNotified !== false) continue;
		out.push(task);
	}
	return out;
}
