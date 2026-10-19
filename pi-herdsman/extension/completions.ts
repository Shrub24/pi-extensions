import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { herdsmanDataRoot } from "./storage.ts";
import type { ResultRecord } from "./mailbox.ts";

export type Disposition = "keep" | "park" | "retire";
export type WrapupOutcome = {
  status: "success" | "skipped" | "failed";
  reason?: string;
  messagesWrapped?: number;
};
export type Completion = {
  version: 1;
  requestId: string;
  ownerSessionId: string;
  runId: string;
  workspaceId: string;
  agentLabel: string;
  paneId: string;
  cwd: string;
  definition: string;
  piSessionId?: string;
  piSessionFile?: string;
  status: "completed" | "failed";
  completedAt: number;
  summary: string;
  disposition?: Disposition;
  providedAt?: number;
  preparationId?: string;
  wrapup?: WrapupOutcome;
  closed?: boolean;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function completionDirectory(owner: string, id?: string): string {
  if (!UUID.test(owner) || (id !== undefined && !UUID.test(id)))
    throw new Error("Invalid completion identity");
  return join(herdsmanDataRoot(), "completions", owner, ...(id ? [id] : []));
}
function atomicWrite(path: string, text: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
export function handoffPath(completion: Completion): string {
  return join(completionDirectory(completion.ownerSessionId, completion.requestId), "handoff.md");
}
export function readCompletion(owner: string, id: string): Completion | undefined {
  let value: Completion;
  try {
    value = JSON.parse(readFileSync(join(completionDirectory(owner, id), "completion.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (value.version !== 1 || value.ownerSessionId !== owner || value.requestId !== id ||
      !UUID.test(value.runId) || typeof value.agentLabel !== "string" ||
      typeof value.summary !== "string" || !["completed", "failed"].includes(value.status) ||
      (value.disposition !== undefined && !["keep", "park", "retire"].includes(value.disposition)))
    throw new Error("Invalid completion record");
  return value;
}
export function saveCompletion(completion: Completion): void {
  const directory = completionDirectory(completion.ownerSessionId, completion.requestId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWrite(join(directory, "completion.json"), JSON.stringify(completion));
}
export function persistCompletion(
  result: ResultRecord,
  source: Pick<Completion, "cwd" | "definition" | "piSessionId" | "piSessionFile">,
): Completion {
  const report = result.status === "completed" ? result.text ?? "" : result.error?.message ?? "Agent failed";
  const summary = report.split(/\n\s*\n/u).find((paragraph) => paragraph.trim() && !/^\s*#/u.test(paragraph))
    ?.replace(/\s+/gu, " ").trim().slice(0, 600) || `${result.agentLabel}: ${result.status}`;
  const completion: Completion = {
    version: 1, ...source,
    requestId: result.requestId, ownerSessionId: result.ownerSessionId,
    runId: result.runId, workspaceId: result.workspaceId,
    agentLabel: result.agentLabel, paneId: result.paneId,
    status: result.status, completedAt: result.completedAt, summary,
  };
  const handoff = [
    `# ${result.agentLabel} completion`,
    `Completion: ${result.requestId}\nOutcome: ${result.status}\nSession: ${source.piSessionId ?? "unknown"}`,
    `## Summary\n\n${summary}`, `## Handoff\n\n${report}`,
    ...(result.responseValidation ? [`## Validation\n\n\`\`\`json\n${JSON.stringify(result.responseValidation, null, 2)}\n\`\`\``] : []),
  ].join("\n\n") + "\n";
  const existing = readCompletion(result.ownerSessionId, result.requestId);
  if (existing) {
    if (existing.runId !== result.runId || existing.agentLabel !== result.agentLabel ||
        existing.status !== result.status || existing.completedAt !== result.completedAt ||
        existing.summary !== summary ||
        readFileSync(handoffPath(existing), "utf8") !== handoff)
      throw new Error("Completion identity or report changed");
    return existing;
  }
  mkdirSync(completionDirectory(result.ownerSessionId, result.requestId), { recursive: true, mode: 0o700 });
  atomicWrite(handoffPath(completion), handoff);
  saveCompletion(completion);
  return completion;
}

/**
 * Record a retrieved Radar report verbatim. The stored handoff is the report
 * bytes, so an identical retrieval is a no-op and a changed one is refused.
 */
export function persistSealedCompletion(
  identity: Pick<Completion, "requestId" | "ownerSessionId" | "runId" | "workspaceId" | "agentLabel" | "paneId" | "cwd" | "definition" | "piSessionId" | "piSessionFile">,
  report: { status: "completed" | "failed"; summary: string; content: string },
  completedAt: number,
): Completion {
  const existing = readCompletion(identity.ownerSessionId, identity.requestId);
  if (existing) {
    if (existing.runId !== identity.runId || readFileSync(handoffPath(existing), "utf8") !== report.content)
      throw new Error("Completion identity or report changed");
    return existing;
  }
  const completion: Completion = {
    version: 1, ...identity, status: report.status, completedAt, summary: report.summary,
  };
  mkdirSync(completionDirectory(identity.ownerSessionId, identity.requestId), { recursive: true, mode: 0o700 });
  atomicWrite(handoffPath(completion), report.content);
  saveCompletion(completion);
  return completion;
}

/** Legacy-only: builds a handoff from a pre-Radar result's chat text. New completions never take this path. */
export function listCompletions(owner: string): Completion[] {
  const directory = completionDirectory(owner);
  let ids: string[];
  try { ids = readdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return ids.filter((id) => UUID.test(id)).map((id) => readCompletion(owner, id)!)
    .filter(Boolean).sort((a, b) => a.completedAt - b.completedAt);
}
export function sessionManuallyRetired(owner: string, sessionId: string): boolean {
  return listCompletions(owner).some((completion) =>
    completion.piSessionId === sessionId && completion.disposition === "retire");
}
export function writePreparationResult(owner: string, id: string, outcome: WrapupOutcome): void {
  const directory = completionDirectory(owner);
  if (!UUID.test(id)) throw new Error("Invalid preparation identity");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWrite(join(directory, `wrapup-${id}.json`), JSON.stringify(outcome));
}
export function readPreparationResult(owner: string, id: string): WrapupOutcome | undefined {
  if (!UUID.test(id)) throw new Error("Invalid preparation identity");
  try {
    const outcome = JSON.parse(readFileSync(join(completionDirectory(owner), `wrapup-${id}.json`), "utf8"));
    if (!["success", "skipped", "failed"].includes(outcome.status)) throw new Error("Invalid wrapup result");
    return outcome;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function waitForPreparation(owner: string, id: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<WrapupOutcome> {
  const path = join(completionDirectory(owner), `wrapup-${id}.json`);
  return new Promise((resolve, reject) => {
    const finish = (outcome?: WrapupOutcome, error?: unknown) => {
      clearTimeout(timer);
      unwatchFile(path, check);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolve(outcome!);
    };
    const check = () => {
      try {
        const result = readPreparationResult(owner, id);
        if (result) finish(result);
      } catch (error) { finish(undefined, error); }
    };
    const abort = () => finish(undefined, new Error("Completion preparation interrupted; retry the same completion"));
    const timer = setTimeout(() => finish(undefined,
      new Error("Wrapup is unresolved; worker kept live. Retry the same completion")), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    watchFile(path, { interval: 100 }, check);
    check();
  });
}

/** Flush replies synchronously; no reply means the lifecycle seam is absent. */
export async function wrapupContext(
  events: { on(name: string, handler: (payload: any) => void): () => void; emit(name: string, payload: unknown): void },
  sessionId: string,
  timeoutMs = 10 * 60_000,
): Promise<WrapupOutcome> {
  let available = false;
  const offFlush = events.on("magic-context:flush-result", (payload) => {
    if (payload?.sessionId === sessionId) available = true;
  });
  try { events.emit("magic-context:flush", { sessionId }); } finally { offFlush(); }
  if (!available) return { status: "skipped", reason: "provider-unavailable" };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      // A timeout is not completion: the historian might still be running.
      reject(new Error("Wrapup result is unresolved; keep the worker live and retry completion"));
    }, timeoutMs);
    const off = events.on("magic-context:wrapup-result", (payload) => {
      if (payload?.sessionId !== undefined && payload.sessionId !== sessionId) return;
      if (!["success", "skipped", "failed"].includes(payload?.status)) return;
      clearTimeout(timer);
      off();
      resolve({ status: payload.status, ...(payload.reason ? { reason: payload.reason } : {}),
        ...(typeof payload.messagesWrapped === "number" ? { messagesWrapped: payload.messagesWrapped } : {}) });
    });
    try { events.emit("magic-context:wrapup", { sessionId }); } catch (error) {
      clearTimeout(timer); off(); reject(error);
    }
  });
}
