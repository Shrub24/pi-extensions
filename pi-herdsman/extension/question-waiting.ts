import { randomUUID } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { QUESTION_WAITING_MARKER_FILE } from "./mailbox.ts";

/** Public lifecycle event emitted by @juicesharp/rpiv-ask-user-question. */
export const RPIV_ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";

const MARKER_VERSION = 1;
const MAX_MARKER_BYTES = 2048;
const MAX_ID_CHARS = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface QuestionWaitScope {
  runId: string;
  requestId: string;
  piSessionId: string;
}

interface QuestionWaitMarker extends QuestionWaitScope {
  version: 1;
}

export type QuestionWaitEvidence = "waiting" | "clear" | "invalid";

export interface QuestionWaitEventBus {
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

function validScope(scope: QuestionWaitScope): boolean {
  return (
    UUID.test(scope.runId) &&
    UUID.test(scope.requestId) &&
    typeof scope.piSessionId === "string" &&
    scope.piSessionId.trim().length > 0 &&
    scope.piSessionId.length <= MAX_ID_CHARS
  );
}

function markerPath(mailboxPath: string): string {
  return join(mailboxPath, QUESTION_WAITING_MARKER_FILE);
}

function removeMarker(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writeAtomically(path: string, contents: Buffer): void {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    let offset = 0;
    while (offset < contents.length)
      offset += writeSync(fd, contents, offset, contents.length - offset);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    removeMarker(temporary);
  }
}

/** Persist only the identity needed to match this wait to its live assignment. */
export function writeQuestionWaitEvidence(
  mailboxPath: string,
  scope: QuestionWaitScope,
): void {
  if (!validScope(scope)) throw new Error("Invalid question-wait scope");
  const marker: QuestionWaitMarker = { version: MARKER_VERSION, ...scope };
  const contents = Buffer.from(JSON.stringify(marker), "utf8");
  if (contents.length > MAX_MARKER_BYTES)
    throw new Error("Question-wait marker is too large");
  writeAtomically(markerPath(mailboxPath), contents);
}

/** Remove the transient wait marker; a missing marker is already cleared. */
export function clearQuestionWaitEvidence(mailboxPath: string): void {
  removeMarker(markerPath(mailboxPath));
}

/**
 * Read a bounded marker and accept it only for the exact current run, Pi
 * session, and active assignment. Stale markers are harmless; malformed ones
 * are surfaced as invalid so callers can fail closed for this agent only.
 */
export function readQuestionWaitEvidence(
  mailboxPath: string,
  expected: QuestionWaitScope | undefined,
): QuestionWaitEvidence {
  let marker: unknown;
  try {
    const path = markerPath(mailboxPath);
    if (statSync(path).size > MAX_MARKER_BYTES) return "invalid";
    marker = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "clear";
    return "invalid";
  }

  if (
    typeof marker !== "object" ||
    marker === null ||
    Array.isArray(marker)
  )
    return "invalid";
  const value = marker as Record<string, unknown>;
  if (
    Object.keys(value).length !== 4 ||
    !Object.hasOwn(value, "version") ||
    !Object.hasOwn(value, "runId") ||
    !Object.hasOwn(value, "requestId") ||
    !Object.hasOwn(value, "piSessionId") ||
    value.version !== MARKER_VERSION ||
    typeof value.runId !== "string" ||
    value.runId.length > MAX_ID_CHARS ||
    !UUID.test(value.runId) ||
    typeof value.requestId !== "string" ||
    value.requestId.length > MAX_ID_CHARS ||
    !UUID.test(value.requestId) ||
    typeof value.piSessionId !== "string" ||
    !value.piSessionId.trim() ||
    value.piSessionId.length > MAX_ID_CHARS
  )
    return "invalid";

  if (
    !expected ||
    !validScope(expected) ||
    value.runId !== expected.runId ||
    value.requestId !== expected.requestId ||
    value.piSessionId !== expected.piSessionId
  )
    return "clear";
  return "waiting";
}

/** Bridge the optional rpiv event into the current worker assignment marker. */
export function registerQuestionWaitReporter(
  bus: QuestionWaitEventBus,
  mailboxPath: string,
  currentScope: () => QuestionWaitScope | undefined,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  return bus.on(RPIV_ASK_USER_BLOCKED_EVENT, (payload) => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      typeof (payload as { active?: unknown }).active !== "boolean"
    )
      return;
    try {
      if ((payload as { active: boolean }).active) {
        const scope = currentScope();
        if (scope) writeQuestionWaitEvidence(mailboxPath, scope);
        else clearQuestionWaitEvidence(mailboxPath);
      } else {
        clearQuestionWaitEvidence(mailboxPath);
      }
    } catch (error) {
      try {
        onError(error);
      } catch {
        // Optional reporting must not interfere with the questionnaire itself.
      }
    }
  });
}
