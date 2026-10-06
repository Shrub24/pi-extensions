import { isDeepStrictEqual } from "node:util";

/**
 * Durable, session-local classification of a Herdsman session: whether the
 * session is an ordinary operator or a managed worker, its effective role and,
 * for managed sessions, its direct owner. It is discovery information for
 * offline consumers — never admission authority. Assignment and continuation
 * rights stay with the existing ownership provenance.
 *
 * `parentSessionId` is the current direct owner (`pi_herdsman_parent_session`),
 * not Pi's native fork parent and not the root lead.
 */
export const SESSION_METADATA_ENTRY = "pi-herdsman-session-metadata";
export const SESSION_METADATA_VERSION = 1;
export const OPERATOR_ROLES = ["lead", "manager", "chief"] as const;

export type OperatorRole = (typeof OPERATOR_ROLES)[number];
export type OperatorSessionMetadata = {
  version: 1;
  sessionId: string;
  kind: "operator";
  role: OperatorRole;
};
export type ManagedSessionMetadata = {
  version: 1;
  sessionId: string;
  kind: "managed";
  /** The effective definition name, matching the live pane role. */
  role: string;
  parentSessionId: string;
  definition: string;
  label: string;
};
export type SessionMetadata = OperatorSessionMetadata | ManagedSessionMetadata;

export type SessionMetadataRead =
  | { status: "absent" }
  | { status: "available"; metadata: SessionMetadata }
  | { status: "unavailable"; reason: string };

export type SessionMetadataUpdate =
  | { status: "appended"; metadata: SessionMetadata }
  | { status: "unchanged"; metadata: SessionMetadata }
  /** Current-session managed origin kept: an operator candidate is not written. */
  | { status: "preserved"; metadata: SessionMetadata }
  | { status: "unavailable"; reason: string };

/** Sorted field names; anything else in a version-1 payload is rejected. */
const OPERATOR_KEYS = ["kind", "role", "sessionId", "version"];
const MANAGED_KEYS = [
  "definition",
  "kind",
  "label",
  "parentSessionId",
  "role",
  "sessionId",
  "version",
];
const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Parsed =
  | { ok: true; metadata: SessionMetadata }
  | { ok: false; reason: string };

const invalid = (detail: string): Parsed => ({
  ok: false,
  reason: `invalid ${SESSION_METADATA_ENTRY}: ${detail}`,
});
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" && value.trim() === value
    ? value
    : undefined;

function sameKeys(keys: string[], expected: string[]): boolean {
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function parseSessionMetadata(
  data: Record<string, unknown>,
  sessionId: string,
): Parsed {
  if (data.version !== SESSION_METADATA_VERSION)
    return invalid(`unsupported version ${JSON.stringify(data.version)}`);
  const keys = Object.keys(data).sort();
  if (data.kind === "operator") {
    if (!sameKeys(keys, OPERATOR_KEYS))
      return invalid(`unexpected operator fields ${keys.join(", ")}`);
    const role = text(data.role);
    if (!role || !(OPERATOR_ROLES as readonly string[]).includes(role))
      return invalid(`unknown operator role ${JSON.stringify(data.role)}`);
    return {
      ok: true,
      metadata: {
        version: 1,
        sessionId,
        kind: "operator",
        role: role as OperatorRole,
      },
    };
  }
  if (data.kind === "managed") {
    if (!sameKeys(keys, MANAGED_KEYS))
      return invalid(`unexpected managed fields ${keys.join(", ")}`);
    const parentSessionId = text(data.parentSessionId);
    if (!parentSessionId || !SESSION_UUID.test(parentSessionId))
      return invalid(
        `parentSessionId must be a session ID, got ${JSON.stringify(
          data.parentSessionId,
        )}`,
      );
    const definition = text(data.definition);
    const label = text(data.label);
    if (!definition || !label)
      return invalid("definition and label must be non-empty text");
    if (text(data.role) !== definition)
      return invalid("role must be the effective definition name");
    return {
      ok: true,
      metadata: {
        version: 1,
        sessionId,
        kind: "managed",
        role: definition,
        parentSessionId,
        definition,
        label,
      },
    };
  }
  return invalid(`unknown kind ${JSON.stringify(data.kind)}`);
}

function entryData(entry: unknown): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    return undefined;
  const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (record.type !== "custom" || record.customType !== SESSION_METADATA_ENTRY)
    return undefined;
  const data = record.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

/**
 * Selects the latest record for `sessionId`. A record for another session is
 * skipped before its payload is read, so a fork that copied its source's
 * entries cannot inherit that session's classification.
 */
export function readSessionMetadata(
  entries: readonly unknown[],
  sessionId: string,
): SessionMetadataRead {
  let latest: Record<string, unknown> | undefined;
  for (const entry of entries) {
    const data = entryData(entry);
    if (!data || data.sessionId !== sessionId) continue;
    latest = data;
  }
  if (!latest) return { status: "absent" };
  // An unreadable latest record stays unresolved: an earlier record is history,
  // not a fallback classification.
  const parsed = parseSessionMetadata(latest, sessionId);
  return parsed.ok
    ? { status: "available", metadata: parsed.metadata }
    : { status: "unavailable", reason: parsed.reason };
}

/**
 * Appends `metadata` unless the current-session classification already says
 * the same thing. Updates are chronological: a role or direct-owner change
 * appends a record and leaves earlier ones intact.
 */
export function updateSessionMetadata(
  entries: readonly unknown[],
  metadata: SessionMetadata,
  append: (data: SessionMetadata) => void,
): SessionMetadataUpdate {
  const current = readSessionMetadata(entries, metadata.sessionId);
  if (current.status === "unavailable") return current;
  if (current.status === "available") {
    if (current.metadata.kind === "managed" && metadata.kind === "operator")
      return { status: "preserved", metadata: current.metadata };
    if (isDeepStrictEqual(current.metadata, metadata))
      return { status: "unchanged", metadata: current.metadata };
  }
  append(metadata);
  return { status: "appended", metadata };
}
