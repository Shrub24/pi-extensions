/**
 * Terminal pipe truncation (`cmd | tail -20`) is the other half of the
 * poll-and-truncate anti-pattern: a buffered filter keeps the log empty until
 * exit, a failed pipeline still exits 0 through the filter (pipefail is not
 * set), and the truncation cannot be revisited. Strip the final stage from
 * managed-bash commands, run to completion, and emulate the truncation on the
 * result instead. Anything but a terminal, well-formed `head/tail [-n] N`
 * stays exactly as written.
 */

const STRIPABLE = /^\|\s*(head|tail)(?:\s+-n\s+|\s+-|\s+)(\d{1,6})\s*$/i;
const BARE = /^\|\s*(head|tail)\s*$/i;

export interface PipeStrip {
	/** The command with the final truncation stage removed. */
	command: string;
	/** Which filter was stripped. */
	tool: "head" | "tail";
	/** How many lines to emulate. Bare `| tail` defaults to 10. */
	lines: number;
}

export function stripTerminalTruncation(command: string): PipeStrip | null {
	const trimmed = command.trimEnd();
	// Reject the shapes we must not touch: heredocs, command substitution,
	// backgrounding, process substitution anywhere in the command.
	if (/<<|`|\$\(|&&|\|\||(^|\s)&($|\s)|\bsudo\b/.test(trimmed)) return null;
	// Exactly one unescaped pipe, and the stage after it must be a truncation.
	if (countUnescapedPipes(trimmed) !== 1) return null;
	const pipeAt = lastUnescapedPipe(trimmed);
	if (pipeAt < 0) return null;
	const body = trimmed.slice(0, pipeAt).trimEnd();
	const stage = trimmed.slice(pipeAt + 1).trim();
	const match = stage.match(/^(head|tail)(?:\s+-n\s+|\s+-|\s+)(\d{1,6})$/i) ?? stage.match(/^(head|tail)$/i);
	if (!match) return null;
	if (!body) return null;
	return {
		command: body,
		tool: match[1]!.toLowerCase() as "head" | "tail",
		lines: match[2] ? Number(match[2]) : 10,
	};
}

function lastUnescapedPipe(command: string): number {
	let last = -1;
	for (let index = 0; index < command.length; index += 1) {
		if (command[index] === "\\") { index += 1; continue; }
		if (command[index] === "'") {
			while (index < command.length && command[++index] !== "'") { /* skip */ }
			continue;
		}
		if (command[index] === '"') {
			while (index < command.length && command[++index] !== '"') {
				if (command[index] === "\\") index += 1;
			}
			continue;
		}
		if (command[index] === "|" && command[index + 1] !== "|") last = index;
	}
	return last;
}

function countUnescapedPipes(command: string): number {
	let count = 0;
	for (let index = 0; index < command.length; index += 1) {
		if (command[index] === "\\") { index += 1; continue; }
		if (command[index] === "'" ) {
			while (index < command.length && command[++index] !== "'") { /* skip */ }
			continue;
		}
		if (command[index] === '"') {
			while (index < command.length && command[++index] !== '"') {
				if (command[index] === "\\") index += 1;
			}
			continue;
		}
		if (command[index] === "|" && command[index + 1] !== "|") count += 1;
	}
	return count;
}

/** Applies head/tail semantics to already-collected text. */
export function emulateTruncation(text: string, tool: "head" | "tail", lines: number): { text: string; dropped: number } {
	const rows = text.split("\n");
	// A trailing newline produces a final empty row that is not a line of output.
	const trailingEmpty = rows.length > 1 && rows.at(-1) === "";
	if (trailingEmpty) rows.pop();
	const kept = tool === "tail" ? rows.slice(-lines) : rows.slice(0, lines);
	const dropped = rows.length - kept.length;
	const restored = kept.join("\n") + (trailingEmpty ? "\n" : "");
	return { text: restored, dropped };
}
