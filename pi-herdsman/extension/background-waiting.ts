// Codec for persisted background-waiting evidence. The mailbox validates and
// normalizes this bounded, scope-bound summary; the Herdsman runtime constructs
// it from provider snapshots. It carries identity and task IDs, never task
// status, output, process handles or provider state. Validation is fail-closed:
// malformed, oversized or out-of-scope evidence is rejected.
//
// Bounds mirror the protocol contract: 256-character identities, 128 task IDs,
// and a 64 KiB UTF-8 evidence budget. The mailbox encoder separately enforces
// its complete-record budget.

/** Scope-matching identity strings: nonempty, not whitespace-only, bounded. */
const MAX_ID_CHARS = 256;
/** Task-id list bound (mirrors the provider's outstanding-task bound). */
const MAX_TASK_IDS = 128;
/** Canonical serialized evidence budget in UTF-8 bytes (mailbox state budget). */
const MAX_EVIDENCE_BYTES = 64 * 1024;

const EVIDENCE_FIELDS = ["sessionId", "requestId", "provider", "revision", "taskIds"] as const;
const PROVIDER_FIELDS = ["id", "version"] as const;

/**
 * Persisted evidence that a background assignment is waiting: whose scope it
 * belongs to, which provider revision saw it, and which tasks it covers.
 */
export interface WaitingEvidence {
  sessionId: string;
  requestId: string;
  provider: { id: string; version: number };
  revision: number;
  taskIds: readonly string[];
}

const fail = (detail: string): Error => new Error(`backgroundWaiting.${detail}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Exactly the expected own enumerable fields — no missing, no unknown. */
const hasExactFields = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

/**
 * An identity string, validated but never trimmed or rewritten: empty,
 * whitespace-only and over-long values throw, while incidental surrounding
 * whitespace inside an otherwise valid identity is preserved as-is.
 */
const requireIdentity = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_ID_CHARS
  ) {
    throw fail(`${field}: expected a nonempty, non-whitespace identity of at most ${MAX_ID_CHARS} characters`);
  }
  return value;
};

/**
 * Decode and validate persisted waiting evidence against the already
 * validated outer scope the caller supplies. Returns a new canonical object
 * with copied provider/taskIds, so later mutation of the input can never
 * mutate accepted evidence. Throws field-specific `backgroundWaiting.`
 * errors (≤ 512 characters, no raw input interpolated) for malformed input
 * or identity mismatch; empty `taskIds` is valid so a provider that cannot
 * decide its task list can still block.
 */
export function decodeWaitingEvidence(
  value: unknown,
  expectedScope: { sessionId: string; requestId: string },
): WaitingEvidence {
  if (!isRecord(value)) throw fail("value: expected a non-null, non-array object");
  if (!hasExactFields(value, EVIDENCE_FIELDS)) {
    throw fail("value: expected exactly the fields sessionId, requestId, provider, revision, taskIds");
  }

  const provider = value.provider;
  if (!isRecord(provider)) throw fail("provider: expected a non-null, non-array object");
  if (!hasExactFields(provider, PROVIDER_FIELDS)) {
    throw fail("provider: expected exactly the fields id, version");
  }

  const sessionId = requireIdentity(value.sessionId, "sessionId");
  const requestId = requireIdentity(value.requestId, "requestId");
  const providerId = requireIdentity(provider.id, "provider.id");

  if (sessionId !== expectedScope.sessionId) {
    throw fail("sessionId: must exactly match expectedScope.sessionId");
  }
  if (requestId !== expectedScope.requestId) {
    throw fail("requestId: must exactly match expectedScope.requestId");
  }

  const providerVersion = provider.version;
  if (typeof providerVersion !== "number" || !Number.isSafeInteger(providerVersion) || providerVersion <= 0) {
    throw fail("provider.version: expected a positive safe integer");
  }

  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw fail("revision: expected a nonnegative safe integer");
  }

  const rawTaskIds = value.taskIds;
  if (!Array.isArray(rawTaskIds)) throw fail("taskIds: expected an array");
  if (rawTaskIds.length > MAX_TASK_IDS) {
    throw fail(`taskIds: expected at most ${MAX_TASK_IDS} entries`);
  }
  const taskIds: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawTaskIds.length; index += 1) {
    const taskId = requireIdentity(rawTaskIds[index], `taskIds[${index}]`);
    if (seen.has(taskId)) throw fail(`taskIds[${index}]: duplicate task id`);
    seen.add(taskId);
    taskIds.push(taskId);
  }

  const evidence: WaitingEvidence = {
    sessionId,
    requestId,
    provider: { id: providerId, version: providerVersion },
    revision,
    taskIds,
  };
  if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > MAX_EVIDENCE_BYTES) {
    throw fail(`canonical evidence exceeds the ${MAX_EVIDENCE_BYTES}-byte state budget`);
  }
  return evidence;
}
