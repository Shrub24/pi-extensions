import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { claimProcessLock, ProcessLockOccupiedError } from "./lock.ts";
import { decodeWaitingEvidence, type WaitingEvidence } from "./background-waiting.ts";
import { BRIEF_PROFILES, type BriefProfile } from "./briefs.ts";
import {
  validateAcceptedAssignmentContract,
  type AcceptedAssignmentContract,
  type ArtifactDescriptor,
  type ResponseDiagnostic,
} from "./response-validation.ts";
import { herdsmanDataRoot } from "./storage.ts";

export interface ManagedAgentState {
  version: 5;
  runId: string;
  ownerSessionId: string;
  workspaceId: string;
  agentLabel: string;
  paneId: string;
  piSessionId: string;
  piSessionFile?: string;
  agentDefinition?: string;
  cwd: string;
  briefProfile?: BriefProfile;
  activeRequestId?: string;
  acceptedAssignment?: AcceptedAssignmentContract;
  legacyAcceptedRequestIds?: readonly string[];
  backgroundWorkProvider?: { id: string; version: number };
  backgroundWaiting?: WaitingEvidence;
  pendingAskId?: string;
  lastActivityAt?: number;
  completedRequestId?: string;
  resultError?: ResultPersistenceError;
  lastAck?: {
    requestId: string;
    accepted: boolean;
    code?: "busy" | "idle" | "invalid" | "identity" | "delivery";
    message?: string;
    acknowledgedAt: number;
  };
  updatedAt: number;
}
export interface ResultPersistenceError {
  code: "write_failure";
  message: string;
  requestId: string;
  runId: string;
  ownerSessionId: string;
  workspaceId: string;
  agentLabel: string;
  paneId: string;
  originalStatus: "completed" | "failed";
  attempts: number;
  failedAt: number;
  retrySafe: false;
  cleanupSafe: true;
  nextAction: string;
}
export interface RequestRecord {
  version: 4 | 5;
  runId: string;
  requestId: string;
  ownerSessionId: string;
  workspaceId: string;
  agentLabel: string;
  paneId: string;
  kind: "task" | "steer" | "interrupt" | "reply";
  askId?: string;
  acceptedAssignment?: AcceptedAssignmentContract;
  briefProfile?: BriefProfile;
  text: string;
  createdAt: number;
}
export interface AskRecord {
  version: 4 | 5;
  askId: string;
  requestId: string;
  runId: string;
  ownerSessionId: string;
  workspaceId: string;
  agentLabel: string;
  paneId: string;
  piSessionId: string;
  question: string;
  createdAt: number;
}
export interface ResultRecord {
  version: 4 | 5;
  runId: string;
  requestId: string;
  ownerSessionId: string;
  workspaceId: string;
  agentLabel: string;
  paneId: string;
  status: "completed" | "failed";
  text?: string;
  error?: {
    code:
      | "empty_result"
      | "result_too_large"
      | "write_failure"
      | "invalid_response"
      | "artifact_error";
    message: string;
  };
  responseValidation?: {
    contractHash: string;
    briefHash: string;
    workerSessionId: string;
    target: "inline" | "artifact" | "both";
    textSource: "worker" | "framework";
    artifacts: readonly ArtifactDescriptor[];
    diagnostics?: readonly ResponseDiagnostic[];
  };
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  completedAt: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAILBOX_PROTOCOL_VERSION = 5 as const;
export const MAILBOX_CONTROL_PREFIX = "__PI_HERDSMAN_AGENT_V5__:";
export const LEGACY_MAILBOX_CONTROL_PREFIX = "__PI_HERDSMAN_AGENT_V4__:";
const LEGACY_MAILBOX_PROTOCOL_VERSION = 4 as const;
/** Fixed protocol safety ceiling; configuration only limits new submissions. */
export const MAILBOX_PROTOCOL_LIMIT_BYTES = 1024 * 1024;
export function mailboxRecordBytes(record: RequestRecord | AskRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}
export class MailboxClaimOccupiedError extends Error {
  readonly code = "MAILBOX_CLAIM_OCCUPIED";
}
const LIMITS = {
  state: 64 * 1024,
  request: MAILBOX_PROTOCOL_LIMIT_BYTES,
  ask: MAILBOX_PROTOCOL_LIMIT_BYTES,
  result: 4 * 1024 * 1024,
};
// Keep the storage path stable: record envelopes migrate V4 state and its exact
// accepted assignment artifacts in place, rather than abandoning live mailboxes.
const root = join(herdsmanDataRoot(), "runtime", "mailboxes-v4");

export function agentMailboxPath(
  workspaceId: string,
  agentLabel: string,
): string {
  return join(
    root,
    createHash("sha256")
      .update(`${workspaceId}\0${agentLabel}`)
      .digest("hex")
      .slice(0, 32),
  );
}
export type ManagedAgentStateIssue = {
  path: string;
  diagnostic: string;
};

const MAILBOX_DIRECTORY = /^[0-9a-f]{32}$/;
const DIAGNOSTIC_LIMIT = 256;
const ISSUE_LIMIT = 64;

function boundedDiagnostic(error: unknown): string {
  const text = String(error).replace(/\s+/g, " ").trim();
  return text.length > DIAGNOSTIC_LIMIT
    ? `${text.slice(0, DIAGNOSTIC_LIMIT - 1)}…`
    : text;
}

export function scanAgentStates(): {
  states: Array<{ path: string; state: ManagedAgentState }>;
  issues: ManagedAgentStateIssue[];
} {
  if (!existsSync(root)) return { states: [], issues: [] };
  const states: Array<{ path: string; state: ManagedAgentState }> = [];
  const issues: ManagedAgentStateIssue[] = [];
  const entries: Array<{
    name: string;
    path: string;
    directory: boolean;
    mtimeMs: number;
    statError?: unknown;
  }> = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    try {
      const info = statSync(path);
      entries.push({
        name,
        path,
        directory: info.isDirectory(),
        mtimeMs: info.mtimeMs,
      });
    } catch (error) {
      entries.push({
        name,
        path,
        directory: false,
        mtimeMs: Number.NEGATIVE_INFINITY,
        statError: error,
      });
    }
  }
  // Prefer recently touched mailboxes so the bounded issue list reports
  // current failures instead of hiding them behind stale diagnostics.
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { name, path, directory, statError } of entries) {
    try {
      if (statError !== undefined) throw statError;
      if (!directory) continue;
      const state = readAgentState(path);
      if (state) states.push({ path, state });
    } catch (error) {
      // Only hash-named directories can be current mailbox paths. Other
      // disposable directories are omitted without projecting an identity.
      if (MAILBOX_DIRECTORY.test(name) && issues.length < ISSUE_LIMIT)
        issues.push({
          path,
          diagnostic: `Mailbox state unavailable: ${boundedDiagnostic(error)}`,
        });
    }
  }
  return { states, issues };
}

export function listAgentStates(): Array<{
  path: string;
  state: ManagedAgentState;
}> {
  return scanAgentStates().states;
}

export function listAgentStateIssues(): ManagedAgentStateIssue[] {
  return scanAgentStates().issues;
}
function ensure(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
function validate(
  value: unknown,
  kind: keyof typeof LIMITS,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object")
    throw new Error("Invalid mailbox protocol version or record");
  const version = (value as { version?: unknown }).version;
  if (version !== LEGACY_MAILBOX_PROTOCOL_VERSION && version !== MAILBOX_PROTOCOL_VERSION)
    throw new Error("Invalid mailbox protocol version or record");
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > LIMITS[kind])
    throw new Error("Mailbox record is too large");
  const v = value as Record<string, any>;
  if (
    version === LEGACY_MAILBOX_PROTOCOL_VERSION &&
    kind === "state" &&
    ["briefProfile", "acceptedAssignment", "legacyAcceptedRequestIds", "backgroundWorkProvider", "backgroundWaiting"].some((field) =>
      Object.hasOwn(v, field),
    )
  )
    throw new Error("V4 state cannot contain V5 assignment metadata");
  if (
    version === LEGACY_MAILBOX_PROTOCOL_VERSION &&
    kind === "request" &&
    ["acceptedAssignment", "briefProfile"].some((field) =>
      Object.hasOwn(v, field),
    )
  )
    throw new Error("V4 requests cannot contain accepted assignment metadata");
  const allowed =
    kind === "state"
      ? [
          "version",
          "runId",
          "ownerSessionId",
          "workspaceId",
          "agentLabel",
          "paneId",
          "piSessionId",
          "piSessionFile",
          "agentDefinition",
          "cwd",
          "briefProfile",
      "activeRequestId",
      "acceptedAssignment",
          "legacyAcceptedRequestIds",
          "backgroundWorkProvider",
          "backgroundWaiting",
          "pendingAskId",
          "lastActivityAt",
          "completedRequestId",
          "resultError",
          "lastAck",
          "updatedAt",
        ]
      : kind === "request"
        ? [
            "version",
            "runId",
            "requestId",
            "ownerSessionId",
            "workspaceId",
            "agentLabel",
            "paneId",
            "kind",
      "acceptedAssignment",
            "briefProfile",
            "askId",
            "text",
            "createdAt",
          ]
        : kind === "ask"
          ? [
              "version",
              "askId",
              "requestId",
              "runId",
              "ownerSessionId",
              "workspaceId",
              "agentLabel",
              "paneId",
              "piSessionId",
              "question",
              "createdAt",
            ]
          : [
              "version",
              "runId",
              "requestId",
              "ownerSessionId",
              "workspaceId",
              "agentLabel",
              "paneId",
              "status",
              "text",
              "error",
              "responseValidation",
              "contextUsage",
              "completedAt",
            ];
  if (Object.keys(v).some((key) => !allowed.includes(key)))
    throw new Error("Unknown mailbox field");
  const required =
    kind === "state"
      ? [
          "runId",
          "ownerSessionId",
          "workspaceId",
          "agentLabel",
          "paneId",
          "piSessionId",
          "cwd",
        ]
      : kind === "ask"
        ? [
            "askId",
            "requestId",
            "runId",
            "ownerSessionId",
            "workspaceId",
            "agentLabel",
            "paneId",
            "piSessionId",
          ]
        : [
            "runId",
            "requestId",
            "ownerSessionId",
            "workspaceId",
            "agentLabel",
            "paneId",
          ];
  for (const field of required)
    if (typeof v[field] !== "string" || !(v[field] as string).trim())
      throw new Error(`Invalid mailbox field: ${field}`);
  if (
    !UUID.test(v.runId) ||
    (kind !== "state" && !UUID.test(v.requestId)) ||
    (kind === "ask" && !UUID.test(v.askId))
  )
    throw new Error("Invalid mailbox UUID");
  const finite = (field: string) => {
    if (
      typeof v[field] !== "number" ||
      !Number.isFinite(v[field]) ||
      v[field] < 0
    )
      throw new Error(`Invalid mailbox timestamp: ${field}`);
  };
  if (kind === "state") {
    finite("updatedAt");
    if (
      v.lastActivityAt !== undefined &&
      (typeof v.lastActivityAt !== "number" ||
        !Number.isInteger(v.lastActivityAt) ||
        !Number.isFinite(v.lastActivityAt) ||
        v.lastActivityAt < 0)
    )
      throw new Error("Invalid mailbox timestamp: lastActivityAt");
    for (const field of ["activeRequestId", "completedRequestId"])
      if (
        v[field] !== undefined &&
        (!UUID.test(v[field]) || typeof v[field] !== "string")
      )
        throw new Error(`Invalid ${field}`);
    if (v.legacyAcceptedRequestIds !== undefined) {
      const legacyIds = v.legacyAcceptedRequestIds;
      const eligibleIds = [
        v.activeRequestId,
        v.completedRequestId,
        v.resultError?.requestId,
      ];
      if (
        version !== MAILBOX_PROTOCOL_VERSION ||
        !Array.isArray(legacyIds) ||
        legacyIds.length > 2 ||
        new Set(legacyIds).size !== legacyIds.length ||
        legacyIds.some(
          (id: unknown) =>
            typeof id !== "string" ||
            !UUID.test(id) ||
            !eligibleIds.includes(id),
        )
      )
        throw new Error("Invalid legacy assignment identities");
    }
    if (
      v.briefProfile !== undefined &&
      !BRIEF_PROFILES.includes(v.briefProfile as BriefProfile)
    )
      throw new Error("Invalid briefing profile");
    const legacyActive =
      typeof v.activeRequestId === "string" &&
      Array.isArray(v.legacyAcceptedRequestIds) &&
      v.legacyAcceptedRequestIds.includes(v.activeRequestId);
    if (v.acceptedAssignment !== undefined) {
      if (typeof v.activeRequestId !== "string" || !v.briefProfile || legacyActive)
        throw new Error("Accepted assignment has no active V5 identity");
      validateAcceptedAssignmentContract(v.acceptedAssignment, {
        requestId: v.activeRequestId,
        minimumProfile: v.briefProfile as BriefProfile,
      });
    } else if (
      version === MAILBOX_PROTOCOL_VERSION &&
      v.activeRequestId &&
      !legacyActive
    ) {
      throw new Error("Active V5 assignment is missing its accepted contract");
    }
    if (v.pendingAskId !== undefined && !UUID.test(v.pendingAskId as string))
      throw new Error("Invalid pendingAskId");
    if (v.pendingAskId !== undefined && !v.activeRequestId)
      throw new Error("pendingAskId requires activeRequestId");
    if (v.pendingAskId !== undefined && v.completedRequestId !== undefined)
      throw new Error("pendingAskId cannot coexist with completedRequestId");
    if (
      v.activeRequestId &&
      v.completedRequestId &&
      v.activeRequestId === v.completedRequestId
    )
      throw new Error("Active and completed request IDs must differ");
    if (v.backgroundWorkProvider !== undefined) {
      const provider = v.backgroundWorkProvider;
      if (
        !v.activeRequestId ||
        typeof provider !== "object" ||
        provider === null ||
        Array.isArray(provider) ||
        Object.keys(provider).length !== 2 ||
        !("id" in provider) ||
        !("version" in provider) ||
        typeof provider.id !== "string" ||
        !provider.id.trim() ||
        provider.id.length > 256 ||
        !Number.isSafeInteger(provider.version) ||
        (provider.version as number) < 0
      )
        throw new Error("Invalid background work provider identity");
    }
    if (v.backgroundWaiting !== undefined) {
      if (!v.activeRequestId || !v.backgroundWorkProvider)
        throw new Error("Background waiting evidence requires an active provider-backed request");
      const evidence = decodeWaitingEvidence(v.backgroundWaiting, {
        sessionId: v.piSessionId as string,
        requestId: v.activeRequestId as string,
      });
      if (
        v.backgroundWorkProvider &&
        (evidence.provider.id !== v.backgroundWorkProvider.id ||
          evidence.provider.version !== v.backgroundWorkProvider.version)
      )
        throw new Error("Background waiting provider does not match assignment");
    }
    if (v.resultError !== undefined) {
      if (v.activeRequestId !== undefined || v.completedRequestId !== undefined)
        throw new Error(
          "Result persistence error cannot coexist with an assignment",
        );
      const error = v.resultError as Record<string, unknown>;
      const errorKeys = [
        "code",
        "message",
        "requestId",
        "runId",
        "ownerSessionId",
        "workspaceId",
        "agentLabel",
        "paneId",
        "originalStatus",
        "attempts",
        "failedAt",
        "retrySafe",
        "cleanupSafe",
        "nextAction",
      ];
      if (
        Object.keys(error).some((key) => !errorKeys.includes(key)) ||
        error.code !== "write_failure" ||
        typeof error.message !== "string" ||
        !error.message.trim() ||
        !UUID.test(error.requestId as string) ||
        error.runId !== v.runId ||
        error.ownerSessionId !== v.ownerSessionId ||
        error.workspaceId !== v.workspaceId ||
        error.agentLabel !== v.agentLabel ||
        error.paneId !== v.paneId ||
        (error.originalStatus !== "completed" &&
          error.originalStatus !== "failed") ||
        typeof error.attempts !== "number" ||
        !Number.isInteger(error.attempts) ||
        error.attempts < 1 ||
        error.retrySafe !== false ||
        error.cleanupSafe !== true ||
        typeof error.nextAction !== "string" ||
        !error.nextAction.trim()
      )
        throw new Error("Invalid result persistence error");
      if (
        typeof error.failedAt !== "number" ||
        !Number.isFinite(error.failedAt) ||
        error.failedAt < 0
      )
        throw new Error("Invalid result persistence error timestamp");
    }
    if (
      v.piSessionFile !== undefined &&
      (typeof v.piSessionFile !== "string" || !v.piSessionFile.trim())
    )
      throw new Error("Invalid piSessionFile");
    if (
      v.agentDefinition !== undefined &&
      (typeof v.agentDefinition !== "string" || !v.agentDefinition.trim())
    )
      throw new Error("Invalid agentDefinition");
    if (v.lastAck !== undefined) {
      const ack = v.lastAck as Record<string, unknown>;
      const ackKeys = [
        "requestId",
        "accepted",
        "code",
        "message",
        "acknowledgedAt",
      ];
      if (
        Object.keys(ack).some((key) => !ackKeys.includes(key)) ||
        !UUID.test(ack.requestId as string) ||
        typeof ack.accepted !== "boolean" ||
        typeof ack.acknowledgedAt !== "number" ||
        !Number.isFinite(ack.acknowledgedAt) ||
        ack.acknowledgedAt < 0
      )
        throw new Error("Invalid acknowledgement");
      const codes = ["busy", "idle", "invalid", "identity", "delivery"];
      if (ack.accepted && ack.code !== undefined)
        throw new Error("Accepted acknowledgement cannot have an error code");
      if (!ack.accepted && !codes.includes(ack.code as string))
        throw new Error("Rejected acknowledgement requires an error code");
      if (
        ack.message !== undefined &&
        (typeof ack.message !== "string" || !ack.message.trim())
      )
        throw new Error("Invalid acknowledgement message");
    }
  } else if (kind === "request") {
    if (
      v.kind !== "task" &&
      v.kind !== "steer" &&
      v.kind !== "interrupt" &&
      v.kind !== "reply"
    )
      throw new Error("Invalid request kind");
    if (
      (v.kind === "reply" &&
        (typeof v.askId !== "string" || !UUID.test(v.askId))) ||
      (v.kind !== "reply" && v.askId !== undefined)
    )
      throw new Error("Invalid reply ask ID");
    if (typeof v.text !== "string" || !v.text.trim())
      throw new Error("Invalid request text");
    if (version === MAILBOX_PROTOCOL_VERSION) {
      const needsAssignment = v.kind === "task" || v.kind === "interrupt";
      if (needsAssignment !== (v.acceptedAssignment !== undefined))
        throw new Error("V5 task and interrupt requests require an accepted assignment");
      if (needsAssignment) {
        // The request carries the definition's brief profile so this boundary
        // can enforce the same profile floor as the persisted-state boundary
        // (mailbox state `briefProfile`) instead of accepting any claim.
        if (!BRIEF_PROFILES.includes(v.briefProfile as BriefProfile))
          throw new Error(
            "V5 task and interrupt requests require a valid brief profile",
          );
        const assignmentRequestId = v.acceptedAssignment?.requestId;
        if (
          typeof assignmentRequestId !== "string" ||
          !UUID.test(assignmentRequestId) ||
          (v.kind === "task" && assignmentRequestId !== v.requestId)
        )
          throw new Error("Accepted assignment request identity does not match");
        validateAcceptedAssignmentContract(v.acceptedAssignment, {
          requestId: assignmentRequestId,
          minimumProfile: v.briefProfile as BriefProfile,
        });
      } else if (v.briefProfile !== undefined) {
        throw new Error(
          "Only V5 task and interrupt requests carry a brief profile",
        );
      }
    }
    finite("createdAt");
  } else if (kind === "ask") {
    if (typeof v.question !== "string" || !v.question.trim())
      throw new Error("Invalid ask question");
    finite("createdAt");
  } else {
    if (v.status !== "completed" && v.status !== "failed")
      throw new Error("Invalid result status");
    finite("completedAt");
    if (
      v.status === "completed" &&
      (typeof v.text !== "string" || !v.text.trim() || v.error !== undefined)
    )
      throw new Error("Invalid completed result");
    if (v.status === "failed") {
      const error = v.error as Record<string, unknown> | undefined;
      const codes = [
        "empty_result",
        "result_too_large",
        "write_failure",
        "invalid_response",
        "artifact_error",
      ];
      if (
        !error ||
        Object.keys(error).some((key) => !["code", "message"].includes(key)) ||
        !codes.includes(error.code as string) ||
        typeof error.message !== "string" ||
        !error.message.trim()
      )
        throw new Error("Invalid failed result");
      if (v.text !== undefined)
        throw new Error("Failed result cannot contain text");
    }
    if (v.responseValidation !== undefined) {
      const response = v.responseValidation as Record<string, unknown>;
      if (
        !response ||
        typeof response !== "object" ||
        Object.keys(response).some(
          (key) =>
            ![
              "contractHash",
              "briefHash",
              "workerSessionId",
              "target",
              "textSource",
              "artifacts",
              "diagnostics",
            ].includes(key),
        ) ||
        typeof response.contractHash !== "string" ||
        !/^[0-9a-f]{64}$/u.test(response.contractHash) ||
        typeof response.briefHash !== "string" ||
        !/^[0-9a-f]{64}$/u.test(response.briefHash) ||
        typeof response.workerSessionId !== "string" ||
        !response.workerSessionId.trim() ||
        response.workerSessionId.length > 512 ||
        !["inline", "artifact", "both"].includes(response.target as string) ||
        !["worker", "framework"].includes(response.textSource as string) ||
        !Array.isArray(response.artifacts) ||
        response.artifacts.length > 1
      )
        throw new Error("Invalid response validation provenance");
      const artifacts = response.artifacts as unknown[];
      for (const artifactValue of artifacts) {
        if (!artifactValue || typeof artifactValue !== "object")
          throw new Error("Invalid response artifact observation");
        const artifact = artifactValue as Record<string, unknown>;
        if (
          Object.keys(artifact).some(
            (key) =>
              !["path", "canonicalPath", "sha256", "bytes", "disposition"].includes(key),
          ) ||
          typeof artifact.path !== "string" ||
          !artifact.path.trim() ||
          artifact.path.length > 4096 ||
          typeof artifact.canonicalPath !== "string" ||
          !artifact.canonicalPath.trim() ||
          artifact.canonicalPath.length > 4096 ||
          typeof artifact.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
          typeof artifact.bytes !== "number" ||
          !Number.isSafeInteger(artifact.bytes) ||
          artifact.bytes < 0 ||
          !["created", "reused"].includes(artifact.disposition as string)
        )
          throw new Error("Invalid response artifact observation");
      }
      const failedValidation =
        v.status === "failed" &&
        Array.isArray(response.diagnostics) &&
        response.diagnostics.length > 0;
      if (
        !failedValidation &&
        ((response.target === "inline" && artifacts.length !== 0) ||
          (response.target !== "inline" && artifacts.length !== 1))
      )
        throw new Error("Response artifacts do not match the accepted target");
      if (response.diagnostics !== undefined) {
        if (
          !Array.isArray(response.diagnostics) ||
          response.diagnostics.length === 0 ||
          response.diagnostics.length > 8
        )
          throw new Error("Invalid response diagnostics");
        for (const diagnosticValue of response.diagnostics) {
          if (!diagnosticValue || typeof diagnosticValue !== "object")
            throw new Error("Invalid response diagnostic");
          const diagnostic = diagnosticValue as Record<string, unknown>;
          if (
            Object.keys(diagnostic).some(
              (key) => !["field", "message", "path"].includes(key),
            ) ||
            typeof diagnostic.field !== "string" ||
            !diagnostic.field.trim() ||
            diagnostic.field.length > 256 ||
            typeof diagnostic.message !== "string" ||
            !diagnostic.message.trim() ||
            diagnostic.message.length > 512 ||
            (diagnostic.path !== undefined &&
              (typeof diagnostic.path !== "string" ||
                !diagnostic.path.trim() ||
                diagnostic.path.length > 4096))
          )
            throw new Error("Invalid response diagnostic");
        }
        if (v.status !== "failed")
          throw new Error("Completed result cannot contain response diagnostics");
      }
      if (
        response.diagnostics !== undefined &&
        !["invalid_response", "artifact_error"].includes(
          (v.error as Record<string, unknown> | undefined)?.code as string,
        )
      )
        throw new Error("Response diagnostics require a validation failure");
    } else if (
      v.error &&
      ["invalid_response", "artifact_error"].includes(
        (v.error as Record<string, unknown>).code as string,
      )
    ) {
      throw new Error("Validation failure requires response diagnostics");
    }
    if (v.contextUsage !== undefined) {
      const usage = v.contextUsage as Record<string, unknown>;
      if (
        Object.keys(usage).length !== 3 ||
        Object.keys(usage).some(
          (key) => !["tokens", "contextWindow", "percent"].includes(key),
        ) ||
        (usage.tokens !== null &&
          (typeof usage.tokens !== "number" ||
            !Number.isFinite(usage.tokens) ||
            usage.tokens < 0)) ||
        typeof usage.contextWindow !== "number" ||
        !Number.isFinite(usage.contextWindow) ||
        usage.contextWindow <= 0 ||
        (usage.percent !== null &&
          (typeof usage.percent !== "number" ||
            !Number.isFinite(usage.percent) ||
            usage.percent < 0 ||
            usage.percent > 100))
      )
        throw new Error("Invalid context usage");
    }
  }
}
function atomic(path: string, value: unknown, kind: keyof typeof LIMITS): void {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { version?: unknown }).version !== MAILBOX_PROTOCOL_VERSION
  )
    throw new Error("Legacy mailbox records are read-only");
  validate(value, kind);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function read<T>(path: string, kind: keyof typeof LIMITS): T | undefined {
  try {
    if (statSync(path).size > LIMITS[kind])
      throw new Error("Mailbox record is too large");
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function file(path: string, name: string): string {
  return join(path, name);
}
function assertFileId(requestId: string): void {
  if (!UUID.test(requestId) || requestId.length !== 36)
    throw new Error("Invalid request ID");
}
export function claimAgentMailbox(
  path: string,
  hooks: { afterStaleOwnerRemoved?: () => void } = {},
): () => void {
  ensure(root);
  ensure(path);
  try {
    return claimProcessLock(file(path, ".starting"), {
      name: "mailbox startup claim",
      occupiedMessage: "Mailbox startup is in progress",
      afterStaleOwnerRemoved: hooks.afterStaleOwnerRemoved,
    });
  } catch (error) {
    if (error instanceof ProcessLockOccupiedError)
      throw new MailboxClaimOccupiedError(error.message);
    throw error;
  }
}
export function resetAgentMailbox(path: string): void {
  ensure(root);
  ensure(path);
  for (const name of [
    "state.json",
    "ask.json",
    ...readdirSync(path).filter((x: string) =>
      /^(request|result)-.*\.json$/.test(x),
    ),
  ]) {
    try {
      unlinkSync(file(path, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
export function removeAgentMailbox(path: string): void {
  let names: string[];
  try {
    names = readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (name === ".starting" || name === "state.json") continue;
    try {
      unlinkSync(file(path, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (names.includes("state.json")) {
    try {
      unlinkSync(file(path, "state.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    rmdirSync(path);
  } catch {
    // State removal is the logical cleanup commit point; pruning is best effort.
  }
}
export function writeAgentState(path: string, state: ManagedAgentState): void {
  atomic(file(path, "state.json"), state, "state");
}
export function agentStatePath(path: string): string {
  return file(path, "state.json");
}
export function readAgentState(path: string): ManagedAgentState | undefined {
  const value = read<Record<string, unknown>>(file(path, "state.json"), "state");
  if (!value) return undefined;
  validate(value, "state");
  if (value.version === LEGACY_MAILBOX_PROTOCOL_VERSION) {
    const legacyAcceptedRequestIds = [value.activeRequestId, value.completedRequestId].filter(
      (requestId): requestId is string => typeof requestId === "string",
    );
    const migrated = {
      ...value,
      version: MAILBOX_PROTOCOL_VERSION,
      ...(legacyAcceptedRequestIds.length > 0 ? { legacyAcceptedRequestIds } : {}),
    };
    validate(migrated, "state");
    return migrated as unknown as ManagedAgentState;
  }
  return value as unknown as ManagedAgentState;
}
export function writeRequest(path: string, request: RequestRecord): void {
  assertFileId(request.requestId);
  atomic(file(path, `request-${request.requestId}.json`), request, "request");
}
export function readRequest(
  path: string,
  requestId: string,
): RequestRecord | undefined {
  assertFileId(requestId);
  const v = read<RequestRecord>(
    file(path, `request-${requestId}.json`),
    "request",
  );
  if (v) validate(v, "request");
  if (v && v.requestId !== requestId)
    throw new Error("Request filename identity mismatch");
  if (v?.version === LEGACY_MAILBOX_PROTOCOL_VERSION) {
    const state = readAgentState(path);
    const legacyIds = state?.legacyAcceptedRequestIds ?? [];
    const allowed =
      v.kind === "task"
        ? state?.activeRequestId === requestId && legacyIds.includes(requestId)
        : !!state?.activeRequestId && legacyIds.includes(state.activeRequestId);
    if (!allowed) throw new Error("V4 request is outside the migrated active assignment");
  }
  return v;
}
export function readUnacknowledgedRequest(
  path: string,
  state?: Pick<
    ManagedAgentState,
    | "runId"
    | "ownerSessionId"
    | "workspaceId"
    | "agentLabel"
    | "paneId"
    | "lastAck"
  >,
): RequestRecord | undefined {
  let names: string[];
  try {
    names = readdirSync(path).filter((name) => /^request-.*\.json$/.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let pending: RequestRecord | undefined;
  for (const name of names) {
    const requestId = name.slice("request-".length, -".json".length);
    const request = readRequest(path, requestId);
    if (!request) continue;
    if (
      state &&
      (request.runId !== state.runId ||
        request.ownerSessionId !== state.ownerSessionId ||
        request.workspaceId !== state.workspaceId ||
        request.agentLabel !== state.agentLabel ||
        request.paneId !== state.paneId)
    )
      throw new Error("Request identity did not match agent state");
    if (state?.lastAck?.requestId === request.requestId) continue;
    if (pending) throw new Error("Multiple unacknowledged requests found");
    pending = request;
  }
  return pending;
}
export function unacknowledgedRequestExists(
  path: string,
  state?: Pick<
    ManagedAgentState,
    | "runId"
    | "ownerSessionId"
    | "workspaceId"
    | "agentLabel"
    | "paneId"
    | "lastAck"
  >,
): boolean {
  // This is mailbox-owned durable settlement truth; it does not change the mailbox schema or protocol.
  try {
    return readUnacknowledgedRequest(path, state) !== undefined;
  } catch {
    return true;
  }
}
export function removeRequest(path: string, requestId: string): void {
  assertFileId(requestId);
  try {
    unlinkSync(file(path, `request-${requestId}.json`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export function writeAsk(path: string, ask: AskRecord): void {
  assertFileId(ask.askId);
  atomic(file(path, "ask.json"), ask, "ask");
}
export function readAsk(path: string): AskRecord | undefined {
  const v = read<AskRecord>(file(path, "ask.json"), "ask");
  if (v) validate(v, "ask");
  if (v?.version === LEGACY_MAILBOX_PROTOCOL_VERSION) {
    const state = readAgentState(path);
    if (!state?.activeRequestId || !state.legacyAcceptedRequestIds?.includes(v.requestId))
      throw new Error("V4 ask is outside the migrated active assignment");
  }
  return v;
}
export function readPendingAsk(
  path: string,
  state: ManagedAgentState,
): AskRecord | undefined {
  if (!state.pendingAskId) return undefined;
  const ask = readAsk(path);
  if (!ask) throw new Error("Pending owner ask artifact is missing");
  if (
    ask.askId !== state.pendingAskId ||
    !state.activeRequestId ||
    ask.requestId !== state.activeRequestId ||
    ask.runId !== state.runId ||
    ask.ownerSessionId !== state.ownerSessionId ||
    ask.workspaceId !== state.workspaceId ||
    ask.agentLabel !== state.agentLabel ||
    ask.paneId !== state.paneId ||
    ask.piSessionId !== state.piSessionId
  )
    throw new Error("Pending owner ask identity did not match agent state");
  return ask;
}
export function removeAsk(path: string): void {
  try {
    unlinkSync(file(path, "ask.json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export function writeResult(path: string, result: ResultRecord): void {
  assertFileId(result.requestId);
  atomic(file(path, `result-${result.requestId}.json`), result, "result");
}
export function readResult(
  path: string,
  requestId: string,
): ResultRecord | undefined {
  assertFileId(requestId);
  const v = read<ResultRecord>(
    file(path, `result-${requestId}.json`),
    "result",
  );
  if (v) validate(v, "result");
  if (v && v.requestId !== requestId)
    throw new Error("Result filename identity mismatch");
  if (v?.version === LEGACY_MAILBOX_PROTOCOL_VERSION) {
    const state = readAgentState(path);
    if (!state?.legacyAcceptedRequestIds?.includes(requestId))
      throw new Error("V4 result is outside the migrated assignment");
  }
  return v;
}
export function removeResult(path: string, requestId: string): void {
  assertFileId(requestId);
  try {
    unlinkSync(file(path, `result-${requestId}.json`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export function controlMarker(
  requestId: string,
  version: 4 | 5 = MAILBOX_PROTOCOL_VERSION,
): string {
  if (!UUID.test(requestId)) throw new Error("Invalid request ID");
  const prefix = version === LEGACY_MAILBOX_PROTOCOL_VERSION
    ? LEGACY_MAILBOX_CONTROL_PREFIX
    : MAILBOX_CONTROL_PREFIX;
  return `${prefix}${requestId}`;
}
export function parseControlMarkerVersion(
  text: string,
): { requestId: string; version: 4 | 5 } | undefined {
  const version = text.startsWith(MAILBOX_CONTROL_PREFIX)
    ? MAILBOX_PROTOCOL_VERSION
    : text.startsWith(LEGACY_MAILBOX_CONTROL_PREFIX)
      ? LEGACY_MAILBOX_PROTOCOL_VERSION
      : undefined;
  if (version === undefined) return undefined;
  const prefix = version === MAILBOX_PROTOCOL_VERSION
    ? MAILBOX_CONTROL_PREFIX
    : LEGACY_MAILBOX_CONTROL_PREFIX;
  const requestId = text.slice(prefix.length);
  return UUID.test(requestId) && requestId.length === 36
    ? { requestId, version }
    : undefined;
}
export function parseControlMarker(text: string): string | undefined {
  return parseControlMarkerVersion(text)?.requestId;
}
export function waitForState(
  path: string,
  predicate: (state: ManagedAgentState) => boolean,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ManagedAgentState> {
  return new Promise((resolve, reject) => {
    let done = false;
    let abortListener: (() => void) | undefined;
    const finish = (error?: Error, state?: ManagedAgentState) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(interval);
      if (abortListener && options.signal)
        options.signal.removeEventListener("abort", abortListener);
      error ? reject(error) : resolve(state!);
    };
    const check = () => {
      try {
        const state = readAgentState(path);
        if (state && predicate(state)) finish(undefined, state);
      } catch (e) {
        finish(e as Error);
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for agent state")),
      options.timeoutMs,
    );
    const interval = setInterval(check, 250);
    if (options.signal?.aborted) {
      finish(new Error("Aborted"));
      return;
    }
    abortListener = () => finish(new Error("Aborted"));
    options.signal?.addEventListener("abort", abortListener, { once: true });
    check();
  });
}
