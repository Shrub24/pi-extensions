/**
 * Herdsman control (`herdsman-control/v1`): the owner side of an operator
 * surface's close and restart requests.
 *
 * There is no socket and no inbound surface, so the filesystem is the whole
 * transport. Requests and results are JSON files under
 * `control/<ownerSessionId>/{inbox,results}`; the owner creates and trusts that
 * directory itself at session start and watches `inbox` from then on. Every
 * request id therefore ends in one of three terminal states a requester can
 * derive from the files alone, which is what makes a local requester timeout
 * harmless: the request file outlives it.
 *
 * See `docs/reference/herdsman-control.md` for the wire contract.
 */
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  writeSync,
  type FSWatcher,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { OWNER_METADATA_TTL_MS } from "./pane-metadata.ts";
import { herdsmanDataRoot } from "./storage.ts";

export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_REQUEST_LIMIT_BYTES = 8_192;
export const CONTROL_DIRECTORY_MODE = 0o700;
export const CONTROL_FILE_MODE = 0o600;
export const CONTROL_RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** The wake hint is short-lived; a missed token leaves the result file. */
export const CONTROL_METADATA_KEY = "pi_herdsman_control";
export const CONTROL_METADATA_SOURCE = "pi-herdsman:control";
export const CONTROL_METADATA_TTL_MS = OWNER_METADATA_TTL_MS;

export type ControlOperation = "close" | "restart";
export type ControlOutcome = "closed" | "restarted" | "refused" | "unknown";
export type ControlCategory =
  | "invalid_request"
  | "target_not_found"
  | "target_ambiguous"
  | "agent_busy"
  | "unsupported_target";
export type ControlEffect =
  | "process_ended"
  | "pane_closed"
  | "session_retained"
  | "process_relaunched";
export type ControlState = "result" | "started" | "not_executed" | "pending";

export type ControlConfirmation = {
  operation: ControlOperation;
  label: string;
  runId: string;
};

export type ControlRequest = {
  version: number;
  requestId: string;
  operation: ControlOperation;
  agent: string;
  runId: string;
  paneId?: string;
  piSessionId?: string;
  piSessionPath?: string;
  confirmation?: ControlConfirmation;
  requestedAt: string;
  expiresAt: string;
  requester: string;
};

export type ControlResult = {
  version: number;
  requestId: string;
  operation: ControlOperation;
  outcome: ControlOutcome;
  category?: ControlCategory;
  message: string;
  effects: ControlEffect[];
  completedAt: string;
};

/** What an operation did, as the executor observed it, not as it was asked for. */
export type ControlOperationOutcome =
  | { outcome: "closed" | "restarted"; effects: ControlEffect[]; message: string }
  | { outcome: "refused"; category: ControlCategory; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isOperation = (value: unknown): value is ControlOperation =>
  value === "close" || value === "restart";

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const isoTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

// ---- paths ----

/**
 * The control directory of one owner session. Requests are addressed by the
 * owner session id of the target, so a requester derives the path the same way.
 */
export function controlDirectory(
  ownerSessionId: string,
  root: string = herdsmanDataRoot(),
): string {
  return join(root, "control", ownerSessionId);
}

export function controlInbox(directory: string): string {
  return join(directory, "inbox");
}

export function controlResults(directory: string): string {
  return join(directory, "results");
}

export function controlRequestPath(directory: string, requestId: string): string {
  return join(controlInbox(directory), `${requestId}.json`);
}

export function controlClaimPath(directory: string, requestId: string): string {
  return join(controlInbox(directory), `${requestId}.claim`);
}

export function controlResultPath(directory: string, requestId: string): string {
  return join(controlResults(directory), `${requestId}.json`);
}

// ---- the trusted directory ----

export type ControlDirectoryTrust =
  | { trusted: true; directory: string }
  | { trusted: false; reason: string };

/**
 * The one trust check both sides apply. It fails closed: a directory that is
 * not exactly ours, mode 0700, a real directory refuses, because a request
 * written into a directory someone else can write is not attributable.
 */
export function trustControlDirectory(directory: string): ControlDirectoryTrust {
  for (const candidate of [
    directory,
    controlInbox(directory),
    controlResults(directory),
  ]) {
    const info = lstatSync(candidate, { throwIfNoEntry: false });
    if (!info)
      return { trusted: false, reason: `${candidate} does not exist` };
    if (info.isSymbolicLink())
      return { trusted: false, reason: `${candidate} is a symlink` };
    if (!info.isDirectory())
      return { trusted: false, reason: `${candidate} is not a directory` };
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid)
      return { trusted: false, reason: `${candidate} is not owned by the current user` };
    const mode = info.mode & 0o777;
    if (mode !== CONTROL_DIRECTORY_MODE)
      return {
        trusted: false,
        reason: `${candidate} has mode ${mode.toString(8)}, not ${CONTROL_DIRECTORY_MODE.toString(8)}`,
      };
  }
  return { trusted: true, directory };
}

/** Creates `inbox` and `results` for this owner, then applies the trust check. */
export function ensureControlDirectory(
  ownerSessionId: string,
  root: string = herdsmanDataRoot(),
): ControlDirectoryTrust {
  const directory = controlDirectory(ownerSessionId, root);
  try {
    mkdirSync(controlInbox(directory), {
      recursive: true,
      mode: CONTROL_DIRECTORY_MODE,
    });
    mkdirSync(controlResults(directory), {
      recursive: true,
      mode: CONTROL_DIRECTORY_MODE,
    });
  } catch (error) {
    return {
      trusted: false,
      reason: `control directory ${directory} could not be created: ${String(error)}`,
    };
  }
  return trustControlDirectory(directory);
}

// ---- files ----

function writeFileAtomic(path: string, content: string, mode: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is already gone.
    }
    throw error;
  }
}

function readBounded(path: string): string | undefined {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info || !info.isFile()) return undefined;
  if (info.size > CONTROL_REQUEST_LIMIT_BYTES)
    throw new Error(
      `${basename(path)} is ${info.size} bytes, over the ${CONTROL_REQUEST_LIMIT_BYTES} byte limit`,
    );
  return readFileSync(path, "utf8");
}

function readJson(path: string): unknown {
  const raw = readBounded(path);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ---- request parsing (tolerant reader, ADR 0022) ----

export type ControlRequestParse =
  | { ok: true; request: ControlRequest }
  | { ok: false; operation?: ControlOperation; message: string };

/**
 * Reads one request. Unknown fields are ignored and every target field beyond
 * `agent` and `runId` is optional, so a newer requester keeps working against
 * this owner; only a version this build cannot speak is refused outright.
 */
export function parseControlRequest(
  raw: unknown,
  requestId: string,
): ControlRequestParse {
  if (!isRecord(raw))
    return { ok: false, message: "Control request must be a JSON object." };
  const operation = isOperation(raw.operation) ? raw.operation : undefined;
  const refuse = (message: string): ControlRequestParse => ({
    ok: false,
    ...(operation ? { operation } : {}),
    message,
  });
  if (raw.version !== CONTROL_PROTOCOL_VERSION)
    return refuse(
      `Control request version ${String(raw.version)} is not supported.`,
    );
  if (typeof raw.requestId !== "string" || !UUID.test(raw.requestId))
    return refuse("Control request id must be a UUID.");
  if (raw.requestId !== requestId)
    return refuse(
      `Control request id ${raw.requestId} does not match its file name ${requestId}.`,
    );
  if (!operation)
    return { ok: false, message: "Control request operation must be close or restart." };
  if (!nonEmpty(raw.agent)) return refuse("Control request must name an agent.");
  if (typeof raw.runId !== "string" || !UUID.test(raw.runId))
    return refuse("Control request run id must be a UUID.");
  for (const key of ["paneId", "piSessionId", "piSessionPath"] as const)
    if (raw[key] !== undefined && !nonEmpty(raw[key]))
      return refuse(`Control request ${key} must be a non-empty string.`);
  const confirmation = raw.confirmation;
  if (!isRecord(confirmation))
    return refuse("Control request must carry a confirmation.");
  if (
    !isOperation(confirmation.operation) ||
    !nonEmpty(confirmation.label) ||
    typeof confirmation.runId !== "string" ||
    !UUID.test(confirmation.runId)
  )
    return refuse("Control request confirmation must name an operation, a label and a run id.");
  // The confirmation echoes the operation, label and run id the operator saw.
  // A confirmation that does not name this request's own target confirms
  // nothing, so it is refused before the claim is created.
  if (
    confirmation.operation !== operation ||
    confirmation.label !== raw.agent ||
    confirmation.runId !== raw.runId
  )
    return refuse(
      confirmation.label !== raw.agent
        ? `Confirmation names ${confirmation.label}, not ${raw.agent}.`
        : confirmation.operation !== operation
          ? `Confirmation names ${confirmation.operation}, not ${operation}.`
          : `Confirmation names run ${confirmation.runId}, not ${raw.runId}.`,
    );
  if (!isoTimestamp(raw.requestedAt))
    return refuse("Control request must carry a requestedAt timestamp.");
  if (!isoTimestamp(raw.expiresAt))
    return refuse("Control request must carry an expiresAt timestamp.");
  if (!nonEmpty(raw.requester))
    return refuse("Control request must name its requester.");
  return {
    ok: true,
    request: {
      version: raw.version,
      requestId: raw.requestId,
      operation,
      agent: raw.agent,
      runId: raw.runId,
      ...(typeof raw.paneId === "string" ? { paneId: raw.paneId } : {}),
      ...(typeof raw.piSessionId === "string"
        ? { piSessionId: raw.piSessionId }
        : {}),
      ...(typeof raw.piSessionPath === "string"
        ? { piSessionPath: raw.piSessionPath }
        : {}),
      confirmation: {
        operation: confirmation.operation,
        label: confirmation.label,
        runId: confirmation.runId,
      },
      requestedAt: raw.requestedAt,
      expiresAt: raw.expiresAt,
      requester: raw.requester,
    },
  };
}

export function controlRequestExpired(
  request: ControlRequest,
  now = Date.now(),
): boolean {
  return now > Date.parse(request.expiresAt);
}

// ---- results ----

function result(
  request: ControlRequest,
  outcome: ControlOutcome,
  message: string,
  effects: ControlEffect[],
  category?: ControlCategory,
  now = Date.now(),
): ControlResult {
  return {
    version: CONTROL_PROTOCOL_VERSION,
    requestId: request.requestId,
    operation: request.operation,
    outcome,
    ...(category ? { category } : {}),
    message,
    effects,
    completedAt: new Date(now).toISOString(),
  };
}

export function refusedResult(
  request: ControlRequest,
  category: ControlCategory,
  message: string,
  now = Date.now(),
): ControlResult {
  return result(request, "refused", message, [], category, now);
}

/**
 * A refusal for a request this build cannot read as far as an operation: the
 * request id comes from the file name, which is what a requester observes too.
 */
export function refusedRequestResult(
  requestId: string,
  operation: ControlOperation,
  category: ControlCategory,
  message: string,
  now = Date.now(),
): ControlResult {
  return result(
    { requestId, operation } as ControlRequest,
    "refused",
    message,
    [],
    category,
    now,
  );
}

/**
 * The terminal answer for a claim whose execution was never observed to finish.
 * It never repeats the work: a close or restart whose first attempt may have
 * succeeded cannot be retried by an owner that cannot tell.
 */
export function unknownResult(
  requestId: string,
  operation: ControlOperation,
  now = Date.now(),
): ControlResult {
  return {
    version: CONTROL_PROTOCOL_VERSION,
    requestId,
    operation,
    outcome: "unknown",
    message:
      "Execution started and its outcome is unknown; the operation is not retried.",
    effects: [],
    completedAt: new Date(now).toISOString(),
  };
}

function completedResult(
  request: ControlRequest,
  outcome: Extract<ControlOperationOutcome, { outcome: "closed" | "restarted" }>,
  now = Date.now(),
): ControlResult {
  return result(request, outcome.outcome, outcome.message, outcome.effects, undefined, now);
}

// ---- requester side ----

export function readControlResult(
  directory: string,
  requestId: string,
): ControlResult | undefined {
  if (!UUID.test(requestId)) return undefined;
  const value = readJson(controlResultPath(directory, requestId));
  return isRecord(value) ? (value as ControlResult) : undefined;
}

export function readControlRequest(
  directory: string,
  requestId: string,
): ControlRequest | undefined {
  if (!UUID.test(requestId)) return undefined;
  const parsed = parseControlRequest(
    readJson(controlRequestPath(directory, requestId)),
    requestId,
  );
  return parsed.ok ? parsed.request : undefined;
}

/**
 * The state a requester derives from the files alone: a result outranks a
 * claim, and a claim outranks expiry, because a claim proves execution started.
 */
export function deriveControlState(inputs: {
  result: boolean;
  claim: boolean;
  expiresAt: string;
  now?: number;
}): ControlState {
  if (inputs.result) return "result";
  if (inputs.claim) return "started";
  return (inputs.now ?? Date.now()) > Date.parse(inputs.expiresAt)
    ? "not_executed"
    : "pending";
}

export function controlStateOf(
  directory: string,
  requestId: string,
  expiresAt: string,
  now = Date.now(),
): ControlState {
  return deriveControlState({
    result: !!readControlResult(directory, requestId),
    claim: !!statSync(controlClaimPath(directory, requestId), {
      throwIfNoEntry: false,
    }),
    expiresAt,
    now,
  });
}

export type ControlWriteResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Writes one request into an owner's inbox, atomically and only when the
 * directory passes the trust check.
 */
export function writeControlRequest(
  request: ControlRequest,
  ownerSessionId: string,
  root: string = herdsmanDataRoot(),
): ControlWriteResult {
  if (!UUID.test(request.requestId))
    return { ok: false, reason: "requestId must be a UUID" };
  const directory = controlDirectory(ownerSessionId, root);
  const trust = trustControlDirectory(directory);
  if (!trust.trusted) return { ok: false, reason: trust.reason };
  const path = controlRequestPath(directory, request.requestId);
  const content = JSON.stringify(request);
  if (Buffer.byteLength(content, "utf8") > CONTROL_REQUEST_LIMIT_BYTES)
    return {
      ok: false,
      reason: `request exceeds ${CONTROL_REQUEST_LIMIT_BYTES} bytes`,
    };
  try {
    writeFileAtomic(path, content, CONTROL_FILE_MODE);
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
  return { ok: true, path };
}

// ---- owner side ----

export type ControlOwnerOptions = {
  ownerSessionId: string;
  /** Runs the operation through the owner's own close and relaunch paths. */
  execute: (request: ControlRequest) => Promise<ControlOperationOutcome>;
  /** Called once per result, after the result file exists. */
  onResult?: (request: ControlRequest, result: ControlResult) => void;
  root?: string;
  onError?: (error: unknown) => void;
  now?: () => number;
};

export type ControlOwner = {
  directory: string;
  /** Handles one request id, as the watcher and the start scan do. */
  handle(requestId: string): Promise<ControlResult | undefined>;
  stop(): void;
};

export type ControlOwnerStart =
  | { ok: true; owner: ControlOwner }
  | { ok: false; reason: string };

const claimRecord = (claimPath: string): { operation?: ControlOperation } => {
  const value = readJson(claimPath);
  if (!isRecord(value) || !isOperation(value.operation)) return {};
  return { operation: value.operation };
};

function listFiles(directory: string, suffix: string): string[] {
  try {
    return readdirSync(directory).filter((entry) => entry.endsWith(suffix));
  } catch {
    return [];
  }
}

/**
 * Owns one session's control directory: it finalizes orphaned claims, prunes
 * expired results, executes pending requests and watches the inbox.
 */
export function startControlOwner(options: ControlOwnerOptions): ControlOwnerStart {
  const now = options.now ?? (() => Date.now());
  const root = options.root ?? herdsmanDataRoot();
  const trust = ensureControlDirectory(options.ownerSessionId, root);
  if (!trust.trusted) return { ok: false, reason: trust.reason };
  const directory = trust.directory;
  const inbox = controlInbox(directory);
  const inFlight = new Set<string>();
  let stopped = false;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Reporting must never break request handling.
    }
  };

  const writeResult = (
    request: ControlRequest,
    value: ControlResult,
  ): ControlResult => {
    writeFileAtomic(
      controlResultPath(directory, request.requestId),
      JSON.stringify(value),
      CONTROL_FILE_MODE,
    );
    try {
      options.onResult?.(request, value);
    } catch (error) {
      report(error);
    }
    return value;
  };

  const handle = async (
    requestId: string,
  ): Promise<ControlResult | undefined> => {
    if (stopped || !UUID.test(requestId) || inFlight.has(requestId))
      return undefined;
    inFlight.add(requestId);
    try {
      const existing = readControlResult(directory, requestId);
      if (existing) return existing;
      let raw: unknown;
      try {
        raw = readJson(controlRequestPath(directory, requestId));
      } catch (error) {
        report(error);
        return undefined;
      }
      if (raw === undefined) return undefined;
      const parsed = parseControlRequest(raw, requestId);
      if (!parsed.ok) {
        // A request that never became executable leaves no claim. When it
        // names an operation this build speaks, the refusal is written; the
        // requester otherwise derives "not executed" from the files alone.
        if (!parsed.operation) return undefined;
        const value = refusedRequestResult(
          requestId,
          parsed.operation,
          "invalid_request",
          parsed.message,
          now(),
        );
        writeFileAtomic(
          controlResultPath(directory, requestId),
          JSON.stringify(value),
          CONTROL_FILE_MODE,
        );
        return value;
      }
      const request = parsed.request;
      if (controlRequestExpired(request, now())) {
        return writeResult(
          request,
          refusedResult(
            request,
            "invalid_request",
            `Control request expired at ${request.expiresAt}.`,
            now(),
          ),
        );
      }
      return await execute(request);
    } finally {
      inFlight.delete(requestId);
    }
  };

  const execute = async (
    request: ControlRequest,
  ): Promise<ControlResult | undefined> => {
    const claimPath = controlClaimPath(directory, request.requestId);
    let descriptor: number;
    try {
      // Exactly one execution can start per request id: O_EXCL is the claim.
      descriptor = openSync(claimPath, "wx", CONTROL_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw error;
    }
    try {
      writeSync(
        descriptor,
        JSON.stringify({
          operation: request.operation,
          requestedAt: request.requestedAt,
          claimedAt: new Date(now()).toISOString(),
        }),
      );
    } finally {
      closeSync(descriptor);
    }
    let outcome: ControlOperationOutcome;
    try {
      outcome = await options.execute(request);
    } catch (error) {
      // The claim stands without a result: the operation may have applied, so
      // it is never retried. The next start turns this into an `unknown`.
      report(error);
      return undefined;
    }
    return writeResult(
      request,
      outcome.outcome === "refused"
        ? refusedResult(request, outcome.category, outcome.message, now())
        : completedResult(request, outcome, now()),
    );
  };

  /**
   * A claim without a result means execution started and its outcome was never
   * observed: it is finalized as `unknown` and never repeated.
   */
  const finalizeOrphanedClaims = (): void => {
    for (const entry of listFiles(inbox, ".claim")) {
      const requestId = entry.slice(0, -".claim".length);
      if (!UUID.test(requestId)) continue;
      if (readControlResult(directory, requestId)) continue;
      const claimPath = controlClaimPath(directory, requestId);
      const request = readControlRequest(directory, requestId);
      const operation = request?.operation ?? claimRecord(claimPath).operation;
      if (!operation) continue;
      const value = unknownResult(requestId, operation, now());
      writeFileAtomic(
        controlResultPath(directory, requestId),
        JSON.stringify(value),
        CONTROL_FILE_MODE,
      );
    }
  };

  const pruneResults = (): void => {
    const deadline = now() - CONTROL_RESULT_RETENTION_MS;
    for (const entry of listFiles(controlResults(directory), ".json")) {
      const path = join(controlResults(directory), entry);
      try {
        const info = statSync(path, { throwIfNoEntry: false });
        if (info && info.mtimeMs < deadline) unlinkSync(path);
      } catch (error) {
        report(error);
      }
    }
  };

  const scan = async (): Promise<void> => {
    for (const entry of listFiles(inbox, ".json")) {
      const requestId = entry.slice(0, -".json".length);
      try {
        await handle(requestId);
      } catch (error) {
        report(error);
      }
    }
  };

  let watcher: FSWatcher | undefined;
  try {
    finalizeOrphanedClaims();
    pruneResults();
    // Watching from session start is the point: a request written while the
    // owner was down is found by the scan, and one written later by the watch.
    watcher = watch(inbox, { persistent: false }, () => {
      void scan();
    });
    watcher.on("error", report);
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
  void scan();

  return {
    ok: true,
    owner: {
      directory,
      handle,
      stop(): void {
        stopped = true;
        watcher?.close();
        watcher = undefined;
      },
    },
  };
}
