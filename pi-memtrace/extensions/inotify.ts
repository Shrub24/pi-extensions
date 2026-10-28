// Inotify accounting. A recursive file watch holds one mark per directory, and the per-user budget
// is shared by every process, so a single watcher can starve every other one with ENOSPC.
//
// ownInotify reads this process's own instances; the sweep is for on-demand inspection only, since
// it reads every fdinfo on the system.
import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";

export type InotifyCounts = { instances: number; watches: number; capped?: boolean };

const MARK = "\ninotify ";
const READ_BUDGET = 1 << 20; // ~8,000 marks; beyond that only "capped" matters

/** Marks held by one inotify fdinfo file, read in bounded chunks so a huge instance cannot flood a sample. */
export function countMarks(path: string, budget = READ_BUDGET): { marks: number; capped: boolean } {
	let handle: number;
	try {
		handle = openSync(path, "r");
	} catch {
		return { marks: 0, capped: false };
	}
	try {
		const buf = Buffer.allocUnsafe(1 << 16);
		let marks = 0;
		let consumed = 0;
		// A mark can straddle a chunk boundary, so each chunk is read with the previous one's tail.
		let carry = "\n";
		for (;;) {
			const read = readSync(handle, buf, 0, buf.length, null);
			if (read <= 0) return { marks, capped: false };
			consumed += read;
			const text = carry + buf.subarray(0, read).toString("latin1");
			for (let at = text.indexOf(MARK); at !== -1; at = text.indexOf(MARK, at + MARK.length)) marks += 1;
			carry = text.slice(-(MARK.length - 1));
			if (consumed >= budget) return { marks, capped: true };
		}
	} finally {
		closeSync(handle);
	}
}

/** What this process holds. Cheap while the count is small, which is the normal case. */
export function ownInotify(): InotifyCounts {
	let fds: string[];
	try {
		fds = readdirSync("/proc/self/fd");
	} catch {
		return { instances: 0, watches: 0 };
	}
	let instances = 0;
	let watches = 0;
	let capped = false;
	for (const fd of fds) {
		const counted = countMarks(`/proc/self/fdinfo/${fd}`);
		if (!counted.marks) continue;
		instances += 1;
		watches += counted.marks;
		capped ||= counted.capped;
	}
	return { instances, watches, ...(capped ? { capped: true } : {}) };
}

export function maxUserWatches(): number {
	try {
		return Number(readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8").trim());
	} catch {
		return 0;
	}
}

/** Marks held by every process on the box, heaviest first. Reads the whole system: on demand only. */
export function systemInotify(limit = 8): { pid: number; watches: number; command: string }[] {
	const rows: { pid: number; watches: number; command: string }[] = [];
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
	} catch {
		return rows;
	}
	for (const pid of pids) {
		let fds: string[];
		try {
			fds = readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue;
		}
		let watches = 0;
		for (const fd of fds) {
			let text: string;
			try {
				text = readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8");
			} catch {
				continue;
			}
			for (let at = text.indexOf(MARK); at !== -1; at = text.indexOf(MARK, at + MARK.length)) watches += 1;
			if (text.startsWith("inotify ")) watches += 1;
		}
		if (!watches) continue;
		let command = "";
		try {
			command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
		} catch {
			/* a process may exit mid-sweep */
		}
		rows.push({ pid: Number(pid), watches, command });
	}
	return rows.sort((a, b) => b.watches - a.watches).slice(0, limit);
}
