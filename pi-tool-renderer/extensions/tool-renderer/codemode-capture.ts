import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CODEMODE_DISPLAY_KEY = "kendexCodemode";
export const CODEMODE_DISPLAY_BYTES = 128 * 1024;
const PATCH_BYTES = 64 * 1024;
const CALL_LIMIT = 128;

export interface CodemodeCall {
	id: string;
	name: string;
	target: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	output?: string;
	patch?: string;
	lineCount?: number;
	additions?: number;
	removals?: number;
	notice?: string;
}
export interface CodemodeDisplay {
	version: 1;
	calls: CodemodeCall[];
	omitted: number;
}
interface Capture {
	display: CodemodeDisplay;
	started: Map<string, number>;
	invalidate?: () => void;
}

/** Display text never interprets source-controlled terminal escapes. */
export function codemodeDisplayText(value: string): string {
	return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
function bounded(value: string, chars: number): string {
	return value.length > chars ? `${value.slice(0, chars)}…` : value;
}
export function codemodeTarget(args: any): string {
	for (const key of ["path", "file_path", "command", "query", "pattern", "qualified_name", "url", "subject"]) {
		if (typeof args?.[key] === "string") return bounded(codemodeDisplayText(args[key]).replace(/\s+/g, " ").trim(), 240);
	}
	return "";
}
function preview(result: any): string {
	let text = "";
	for (const block of result?.content ?? []) {
		if (block.type !== "text" || typeof block.text !== "string") continue;
		text += `${text ? "\n" : ""}${block.text.slice(0, 2049 - text.length)}`;
		if (text.length > 2048) break;
	}
	return bounded(codemodeDisplayText(text), 2048);
}
function summaryInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Active executions only. Completed display records live on the parent result. */
export class CodemodeCapture {
	private roots = new Map<string, Capture>();
	private parents = new Map<string, string>();

	start(id: string, name: string, args: any, parent?: string): void {
		const root = parent ? this.parents.get(parent) : undefined;
		if (root) {
			const capture = this.roots.get(root)!;
			if (capture.display.calls.length >= CALL_LIMIT) {
				capture.display = { ...capture.display, omitted: capture.display.omitted + 1 };
				return;
			}
			const call: CodemodeCall = { id, name: bounded(name, 160), target: codemodeTarget(args), status: "running" };
			capture.display = { ...capture.display, calls: [...capture.display.calls, call] };
			capture.started.set(id, performance.now());
			this.parents.set(id, root);
			this.bound(capture);
			capture.invalidate?.();
		} else if (!parent && name === "codemode") {
			this.parents.set(id, id);
			this.roots.set(id, { display: { version: 1, calls: [], omitted: 0 }, started: new Map() });
		}
	}

	update(id: string, result: any, isError?: boolean): void {
		const root = this.parents.get(id);
		const capture = root && this.roots.get(root);
		const index = capture ? capture.display.calls.findIndex((call) => call.id === id) : -1;
		if (!capture || index < 0) return;
		const call = { ...capture.display.calls[index]! };
		capture.display = { ...capture.display, calls: capture.display.calls.with(index, call) };
		if (isError !== undefined) {
			call.status = isError ? "error" : "ok";
			call.durationMs = performance.now() - capture.started.get(id)!;
		}
		call.output = call.name === "edit" && isError === false ? undefined : preview(result);
		const details = result?.details;
		if (call.name === "edit" && !isError && typeof details?.patch === "string") {
			if (Buffer.byteLength(details.patch) <= PATCH_BYTES) {
				call.patch = details.patch;
				call.notice = undefined;
			} else {
				delete call.patch;
				call.notice = "diff unavailable · display budget exceeded";
			}
		}
		const summary = details?.kendexDiffSummary;
		call.lineCount = summaryInteger(summary?.lineCount);
		call.additions = summaryInteger(summary?.additions);
		call.removals = summaryInteger(summary?.removals);
		this.bound(capture);
		capture.invalidate?.();
	}

	get(root: string, invalidate?: () => void): CodemodeDisplay | undefined {
		const capture = this.roots.get(root);
		if (capture && invalidate) capture.invalidate = invalidate;
		return capture?.display;
	}

	finish(root: string): void {
		const capture = this.roots.get(root);
		if (!capture) return;
		for (const call of capture.display.calls) {
			if (call.status === "running") call.status = "cancelled";
			this.parents.delete(call.id);
		}
		capture.invalidate?.();
		this.parents.delete(root);
		this.roots.delete(root);
	}

	clear(): void {
		this.roots.clear();
		this.parents.clear();
	}

	private bound(capture: Capture): void {
		// Keep whole patches, never a malformed partial diff. Drop detail from the
		// latest retained records first; all retained headings remain visible.
		for (let i = capture.display.calls.length - 1;
			Buffer.byteLength(JSON.stringify(capture.display)) > CODEMODE_DISPLAY_BYTES && i >= 0; i--) {
			const call = capture.display.calls[i]!;
			delete call.patch;
			delete call.output;
			call.notice = "details unavailable · display budget exceeded";
		}
		while (Buffer.byteLength(JSON.stringify(capture.display)) > CODEMODE_DISPLAY_BYTES) {
			const dropped = capture.display.calls.pop();
			if (!dropped) break;
			capture.display.omitted++;
			capture.started.delete(dropped.id);
			this.parents.delete(dropped.id);
		}
	}
}

export function installCodemodeCapture(pi: ExtensionAPI, capture: CodemodeCapture): void {
	pi.on("tool_execution_start", (event) => capture.start(event.toolCallId, event.toolName, event.args, event.parentToolCallId));
	pi.on("tool_execution_update", (event) => capture.update(event.toolCallId, event.partialResult));
	pi.on("tool_execution_end", (event) => {
		capture.update(event.toolCallId, event.result, event.isError);
		if (!event.parentToolCallId) capture.finish(event.toolCallId);
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "codemode" || event.parentToolCallId) return;
		const display = capture.get(event.toolCallId);
		if (!display) return;
		const saved: CodemodeDisplay = JSON.parse(JSON.stringify(display));
		for (const call of saved.calls) if (call.status === "running") call.status = "cancelled";
		return { details: { ...(event.details && typeof event.details === "object" ? event.details : {}), [CODEMODE_DISPLAY_KEY]: saved } };
	});
	pi.on("session_shutdown", () => capture.clear());
}
