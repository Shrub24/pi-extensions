/*
 * The decision log: an append-only JSONL file of ask and decision records.
 *
 * One file, two record kinds, joined offline by `requestId`. Nothing in the
 * permission path reads it back, and no error from it may ever change a
 * verdict: a judge that cannot write its record still answers the ask, because
 * losing a log line must not become a refused tool call.
 *
 * The file is rotated once at a size threshold rather than compacted: keeping
 * one previous generation is enough to recover from a bad run, and rotation is
 * the only operation that touches a file the reader is not holding open.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { JevRecord } from "./decision-record.js";
import { RECORD_KINDS } from "./decision-record.js";

export interface DecisionLogOptions {
	path: string;
	/** Rotate to `<path>.1` once the file reaches this size. Default: 8 MiB. */
	maxBytes?: number;
}

export interface DecisionLog {
	readonly path: string;
	/** Append one record. Never throws. */
	write(record: JevRecord): void;
	/** Every record currently in the file, oldest first. */
	read(): JevRecord[];
}

export const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;

export function openDecisionLog(options: DecisionLogOptions): DecisionLog {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
	let ready = false;

	const ensure = (): boolean => {
		if (ready) return true;
		try {
			mkdirSync(dirname(options.path), { recursive: true });
			ready = true;
			return true;
		} catch {
			return false;
		}
	};

	return {
		path: options.path,
		write(record) {
			if (!ensure()) return;
			try {
				if (existsSync(options.path) && statSync(options.path).size >= maxBytes) {
					renameSync(options.path, `${options.path}.1`);
				}
				appendFileSync(options.path, `${JSON.stringify(record)}\n`, "utf8");
			} catch {
				// A log that cannot be written is not a reason to fail an ask.
			}
		},
		read() {
			try {
				if (!existsSync(options.path)) return [];
				return parseJsonl(readFileSync(options.path, "utf8"));
			} catch {
				return [];
			}
		},
	};
}

/**
 * Parse JSONL, skipping lines that are not records.
 *
 * A log appended to while it is read can end in a torn line, and a killed
 * process leaves one behind every time; skipping it keeps the rest readable
 * instead of discarding a whole run's data over its last byte.
 */
export function parseJsonl(text: string): JevRecord[] {
	const records: JevRecord[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed = JSON.parse(trimmed) as JevRecord;
			if (parsed && RECORD_KINDS.includes(parsed.record)) records.push(parsed);
		} catch {
			continue;
		}
	}
	return records;
}
