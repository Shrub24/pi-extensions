// Pure response-contract shape: validation, canonical normalization and the
// deliberately simple full-replacement resolver (task 5.1 slice — no mailbox
// transport, no runtime wiring, no enforcement). An assignment override is a
// COMPLETE validated replacement contract, never a partial patch: there is no
// deep merge, no inherited path/sections, no null-to-delete mechanism and no
// cross-call state. Briefing requirements (briefProfile/scope/acceptance and
// friends) belong to a separate module and are rejected here, so response
// policy can never select or weaken incoming requirements.
//
// Validation is fail-closed: malformed values, unknown fields, unsupported
// enums and incompatible combinations throw field-specific
// `responseContract.`-prefixed errors (fixed messages, well under 512
// characters, never echoing raw input). Values are never coerced, trimmed or
// deduplicated; normalized output is a new frozen canonical object with a
// copied, frozen section array. The fixed field bounds keep serialized
// contracts far below the existing 1 MiB request budget, so no separate
// payload budget exists in this helper.

/** The only supported contract schema version. */
const SCHEMA = "response-contract/v1";
/** The only registered metadata identifier; an identifier, not a validator. */
const METADATA_SCHEMA = "handoff/v1";

const MAX_SECTIONS = 32;
const MAX_SECTION_CHARS = 256;
const MAX_PATH_CHARS = 4096;

const KNOWN_FIELDS = [
  "schema",
  "target",
  "format",
  "requiredSections",
  "metadataSchema",
  "path",
  "allowExistingArtifact",
] as const;

const TARGETS = ["inline", "artifact", "both"] as const;
const FORMATS = ["text", "markdown"] as const;

type ResponseTarget = (typeof TARGETS)[number];
type ResponseFormat = (typeof FORMATS)[number];

/** Inline responses carry no path and no reuse permission. */
export interface InlineResponseContract {
  readonly schema: "response-contract/v1";
  readonly target: "inline";
  readonly format: "text" | "markdown";
  readonly requiredSections: readonly string[];
  readonly metadataSchema?: "handoff/v1";
}

/** Artifact/both responses require a path and carry the reuse permission. */
export interface ArtifactResponseContract {
  readonly schema: "response-contract/v1";
  readonly target: "artifact" | "both";
  readonly format: "text" | "markdown";
  readonly requiredSections: readonly string[];
  readonly path: string;
  readonly allowExistingArtifact: boolean;
  readonly metadataSchema?: "handoff/v1";
}

/** Discriminated by `target`: inline has no path/reuse, artifact/both require them. */
export type ResponseContract = InlineResponseContract | ArtifactResponseContract;

/** The common fallback when a definition provides no response default. */
export const DEFAULT_RESPONSE_CONTRACT: InlineResponseContract = Object.freeze({
  schema: SCHEMA,
  target: "inline",
  format: "text",
  requiredSections: Object.freeze([]) as readonly string[],
} as const satisfies InlineResponseContract);

const fail = (detail: string): Error => new Error(`responseContract.${detail}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);

/** A required field must exist (explicit undefined counts as present). */
const requireField = (value: Record<string, unknown>, field: string): unknown => {
  if (!hasOwn(value, field)) throw fail(`${field}: required field`);
  return value[field];
};

/** Sections: unique, non-whitespace, ≤256 UTF-16 units, no NUL/CR/LF, verbatim. */
const validateSections = (raw: unknown): readonly string[] => {
  if (!Array.isArray(raw)) throw fail("requiredSections: expected an array");
  if (raw.length > MAX_SECTIONS) throw fail(`requiredSections: expected at most ${MAX_SECTIONS} entries`);
  const sections: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const section = raw[index];
    if (typeof section !== "string" || section.trim().length === 0 || section.length > MAX_SECTION_CHARS) {
      throw fail(
        `requiredSections[${index}]: expected a nonempty, non-whitespace string of at most ${MAX_SECTION_CHARS} characters`,
      );
    }
    if (section.includes("\u0000") || section.includes("\r") || section.includes("\n")) {
      throw fail(`requiredSections[${index}]: must not contain NUL, CR or LF`);
    }
    if (seen.has(section)) throw fail(`requiredSections[${index}]: duplicate section`);
    seen.add(section);
    sections.push(section);
  }
  return Object.freeze(sections) as readonly string[];
};

/** Path: verbatim, non-whitespace, ≤4096 UTF-16 units, no NUL. Never accessed. */
const validatePath = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > MAX_PATH_CHARS || raw.includes("\u0000")) {
    throw fail(
      `path: expected a nonempty, non-whitespace string of at most ${MAX_PATH_CHARS} characters without NUL`,
    );
  }
  return raw;
};

/**
 * Validate an unknown value into a frozen canonical contract. Rejects
 * non-objects, missing/unknown fields, unsupported schema/target/format
 * values, malformed types and incompatible combinations (text with sections
 * or metadata; metadata outside `handoff/v1`; path/reuse on inline; missing
 * path on artifact/both). Absent optional keys are omitted from the output;
 * artifact/both contracts materialize `allowExistingArtifact` (default
 * false). Arrays are copied; caller input is never modified.
 */
export function normalizeResponseContract(value: unknown): ResponseContract {
  if (!isRecord(value)) throw fail("value: expected a non-null, non-array object");
  for (const key of Object.keys(value)) {
    if (!(KNOWN_FIELDS as readonly string[]).includes(key)) {
      throw fail("value: unknown field in response contract");
    }
  }

  const schema = requireField(value, "schema");
  if (schema !== SCHEMA) throw fail(`schema: expected ${SCHEMA}`);

  const targetRaw = requireField(value, "target");
  if (!isOneOf(targetRaw, TARGETS)) throw fail("target: expected inline, artifact or both");
  const target: ResponseTarget = targetRaw;

  const formatRaw = requireField(value, "format");
  if (!isOneOf(formatRaw, FORMATS)) throw fail("format: expected text or markdown");
  const format: ResponseFormat = formatRaw;

  const requiredSections = validateSections(requireField(value, "requiredSections"));

  if (format === "text") {
    if (requiredSections.length > 0) throw fail("requiredSections: text contracts require an empty section list");
    if (hasOwn(value, "metadataSchema")) throw fail("metadataSchema: allowed only with markdown format");
  }

  let metadataSchema: "handoff/v1" | undefined;
  if (hasOwn(value, "metadataSchema")) {
    if (value.metadataSchema !== METADATA_SCHEMA) {
      throw fail(`metadataSchema: expected the registered identifier ${METADATA_SCHEMA}`);
    }
    metadataSchema = METADATA_SCHEMA;
  }

  if (target === "inline") {
    if (hasOwn(value, "path")) throw fail("path: forbidden for inline target");
    if (hasOwn(value, "allowExistingArtifact")) throw fail("allowExistingArtifact: forbidden for inline target");
    const contract: InlineResponseContract = Object.freeze({
      schema: SCHEMA,
      target,
      format,
      requiredSections,
      ...(metadataSchema === undefined ? {} : { metadataSchema }),
    } as const satisfies InlineResponseContract);
    return contract;
  }

  if (!hasOwn(value, "path")) throw fail("path: required for artifact and both targets");
  const path = validatePath(value.path);
  let allowExistingArtifact = false;
  if (hasOwn(value, "allowExistingArtifact")) {
    if (typeof value.allowExistingArtifact !== "boolean") {
      throw fail("allowExistingArtifact: expected a boolean");
    }
    allowExistingArtifact = value.allowExistingArtifact;
  }
  const contract: ArtifactResponseContract = Object.freeze({
    schema: SCHEMA,
    target,
    format,
    requiredSections,
    path,
    allowExistingArtifact,
    ...(metadataSchema === undefined ? {} : { metadataSchema }),
  } as const satisfies ArtifactResponseContract);
  return contract;
}

/**
 * Resolve a response contract: the role default is validated even when an
 * override is supplied (an override must not conceal a malformed default),
 * then the assignment override — a COMPLETE replacement, never a patch — is
 * used when it is not undefined; otherwise the result is a fresh canonical
 * copy of the default. An explicit null override is invalid input and fails
 * normalization. No state is retained between calls.
 */
export function resolveResponseContract(
  roleDefault: unknown = DEFAULT_RESPONSE_CONTRACT,
  assignmentOverride?: unknown,
): ResponseContract {
  const normalizedDefault = normalizeResponseContract(roleDefault);
  if (assignmentOverride !== undefined) return normalizeResponseContract(assignmentOverride);
  return normalizedDefault;
}
