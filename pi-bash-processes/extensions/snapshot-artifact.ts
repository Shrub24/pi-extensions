// Immutable output artifacts for the declared full-output handoff.
//
// A preview is a tail of the live capture and is allowed to change under the
// caller; a snapshot is not. This module exists to hold one rule: once an
// artifact has been handed to a caller, nothing that happens to the task
// afterwards may alter the bytes that artifact contains.
//
// There are two sources and one contract:
//
//   * A terminal, certified capture is already immutable — once the log writer
//     has settled, nothing appends to it — so the retained log *is* the
//     artifact. Handing it over copies nothing.
//   * A capture that can still grow (running, mid-flush, or never certified)
//     cannot be handed over directly: the caller would be reading a file the
//     producer is still writing. Its captured prefix is copied to an artifact
//     named after the byte boundary it was taken at, and a later boundary gets
//     a different file. That is what keeps an earlier artifact's bytes intact
//     when the same task is snapshotted again.
//
// Copying is streamed and byte-bounded, never `readFileSync`: the log can be
// larger than memory, and the boundary has to mean something even if the
// producer appends while the copy is running.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { CAPTURE_FILE_MODE } from "./constants.js";

/** Suffix marking a copied prefix artifact. */
export const SNAPSHOT_ARTIFACT_SUFFIX = ".snapshot";

export interface SnapshotArtifact {
	path: string;
	/** Bytes the artifact holds, fixed at preparation time. */
	bytes: number;
	/** True when the artifact is a prefix of a capture that may still grow. */
	partial: boolean;
	/** True when the artifact is the whole, certified-complete output. */
	complete: boolean;
	/** True when an identical artifact from an earlier preparation was reused. */
	reused: boolean;
}

export type SnapshotHandoff =
	| { ok: true; artifact: SnapshotArtifact }
	| { ok: false; code: "expired" | "internal"; message: string };

export interface SnapshotDeps {
	/** Byte size, or -1 when the file is gone or unreadable. */
	size: (file: string) => Promise<number>;
	/** Copy exactly the first `bytes` bytes of `from` into `to`, streamed. */
	copyPrefix: (from: string, to: string, bytes: number) => Promise<void>;
	mkdir: (dir: string) => Promise<void>;
}

async function realSize(file: string): Promise<number> {
	try {
		const info = await stat(file);
		return info.isFile() ? info.size : -1;
	} catch {
		return -1;
	}
}

async function realCopyPrefix(from: string, to: string, bytes: number): Promise<void> {
	if (bytes <= 0) {
		// An empty capture is a real artifact, not a missing one: it gets a real
		// (empty) file rather than an absent path.
		await writeFile(to, new Uint8Array(0), { mode: CAPTURE_FILE_MODE });
		return;
	}
	// `end` is inclusive, so byte N is index N-1: the copy holds exactly the
	// boundary's bytes even if the producer appends while it runs.
	await pipeline(createReadStream(from, { end: bytes - 1 }), createWriteStream(to, { flags: "w", mode: CAPTURE_FILE_MODE }));
}

const DEFAULT_DEPS: SnapshotDeps = {
	copyPrefix: realCopyPrefix,
	mkdir: async (dir) => {
		await mkdir(dir, { recursive: true });
	},
	size: realSize,
};

/** File-name-safe form of an id or generation token (`bg-3@123` → `bg-3_123`). */
function safeName(value: string): string {
	return value.replace(/[^\w.-]+/g, "_") || "task";
}

export interface PrepareSnapshotInput {
	/** The persisted combined log: the source of truth, never an in-memory tail. */
	logFile: string;
	/** Directory the partial artifacts belong to (the session's task lane). */
	laneDir: string;
	taskId: string;
	/** Task incarnation, so a replaced task's artifacts cannot collide. */
	generation: string;
	/**
	 * True when the capture may still grow or was never certified: the artifact
	 * must be a prefix copy, and it is labelled as not the complete output.
	 */
	partial: boolean;
	deps?: Partial<SnapshotDeps>;
}

/**
 * Prepare the immutable artifact for one output handoff. Returns the artifact
 * descriptor the caller may hand over, or an explicit failure — never a
 * fabricated success for a capture that is gone.
 */
export async function prepareSnapshot(input: PrepareSnapshotInput): Promise<SnapshotHandoff> {
	const deps: SnapshotDeps = { ...DEFAULT_DEPS, ...input.deps };
	if (!input.logFile) {
		return { ok: false, code: "expired", message: "no retained output file for this task" };
	}
	const bytes = await deps.size(input.logFile);
	if (bytes < 0) {
		return {
			ok: false,
			code: "expired",
			message: `retained output is gone (${input.logFile}); the task may have expired`,
		};
	}
	if (!input.partial) {
		// A settled capture is the artifact: nothing will append to it, so the
		// caller streams the file itself and no bytes are duplicated on disk.
		return { ok: true, artifact: { bytes, complete: true, partial: false, path: input.logFile, reused: true } };
	}
	const artifactPath = join(
		input.laneDir,
		`${safeName(input.taskId)}-${safeName(input.generation)}.at-${bytes}${SNAPSHOT_ARTIFACT_SUFFIX}`,
	);
	try {
		const existing = await deps.size(artifactPath);
		if (existing === bytes) {
			// The same boundary was already materialized: reuse it rather than
			// rewriting bytes that may already have been handed over.
			return { ok: true, artifact: { bytes, complete: false, partial: true, path: artifactPath, reused: true } };
		}
		await deps.mkdir(input.laneDir);
		await deps.copyPrefix(input.logFile, artifactPath, bytes);
	} catch (error) {
		return {
			ok: false,
			code: "internal",
			message: `snapshot copy failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return { ok: true, artifact: { bytes, complete: false, partial: true, path: artifactPath, reused: false } };
}
