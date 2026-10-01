import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseFrontmatter as parsePiFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  delegationBriefHash,
  normalizeDelegationBrief,
  type BriefProfile,
  type DelegationBrief,
} from "./briefs.ts";
import { snapshotTextFiles } from "./core.ts";
import {
  normalizeResponseContract,
  resolveResponseContract,
  type ArtifactResponseContract,
  type ResponseContract,
} from "./response-contracts.ts";

export interface ArtifactIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedAt: number;
}

export interface ArtifactBaseline {
  readonly path: string;
  readonly exists: boolean;
  readonly canonicalPath?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly identity?: ArtifactIdentity;
}

export interface ArtifactDescriptor {
  readonly path: string;
  readonly canonicalPath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly disposition: "created" | "reused";
}

export interface AcceptedContextSnapshot {
  readonly reference: string;
  readonly purpose: string;
  readonly snapshotPath: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface AcceptedAssignmentContract {
  readonly requestId: string;
  readonly brief: DelegationBrief;
  readonly briefHash: string;
  readonly responseContract: ResponseContract;
  readonly responseContractHash: string;
  readonly contextSnapshots: readonly AcceptedContextSnapshot[];
  readonly artifactBaseline?: ArtifactBaseline;
}

export interface ResponseDiagnostic {
  readonly field: string;
  readonly message: string;
  readonly path?: string;
}

export type ResponseErrorCode = "invalid_response" | "artifact_error";

export class ResponseValidationError extends Error {
  readonly code: ResponseErrorCode;
  readonly diagnostics: readonly ResponseDiagnostic[];

  constructor(code: ResponseErrorCode, diagnostics: readonly ResponseDiagnostic[]) {
    super(diagnostics[0]?.message ?? "Response contract validation failed");
    this.name = "ResponseValidationError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

const MAX_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_PATH_CHARS = 256;
const HANDOFF_FIELDS = ["schema", "title", "summary"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

function throwDiagnostic(
  code: ResponseErrorCode,
  field: string,
  message: string,
  path?: string,
): never {
  const diagnostic: ResponseDiagnostic = {
    field: field.slice(0, 128),
    message: message.slice(0, 256),
    ...(path === undefined
      ? {}
      : { path: path.slice(0, MAX_DIAGNOSTIC_PATH_CHARS) }),
  };
  throw new ResponseValidationError(
    code,
    Object.freeze([diagnostic].slice(0, MAX_DIAGNOSTICS)),
  );
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function artifactPath(path: string, cwd: string): { root: string; candidate: string } {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    throwDiagnostic("artifact_error", "path", "Artifact root is unavailable", path);
  }
  const candidate = resolve(root, path);
  if (!isWithin(root, candidate)) {
    throwDiagnostic("artifact_error", "path", "Artifact path escapes the worker directory", path);
  }
  return { root, candidate };
}

function nearestExistingDirectory(candidate: string, root: string, declaredPath: string): void {
  let ancestor = dirname(candidate);
  for (;;) {
    try {
      const canonical = realpathSync(ancestor);
      if (!isWithin(root, canonical)) {
        throwDiagnostic("artifact_error", "path", "Artifact parent escapes the worker directory", declaredPath);
      }
      if (!statSync(canonical).isDirectory()) {
        throwDiagnostic("artifact_error", "path", "Artifact parent is not a directory", declaredPath);
      }
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throwDiagnostic("artifact_error", "path", "Artifact parent is unavailable", declaredPath);
      }
      ancestor = parent;
    }
  }
}

function identity(stats: ReturnType<typeof statSync>): ArtifactIdentity {
  return Object.freeze({
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedAt: stats.mtimeMs,
  });
}

function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt
  );
}

function artifactSnapshot(
  path: string,
  cwd: string,
  maxBytes: number,
): { canonicalPath: string; text: string; bytes: number; sha256: string; identity: ArtifactIdentity } {
  const { root, candidate } = artifactPath(path, cwd);
  let linkStats: ReturnType<typeof lstatSync>;
  try {
    linkStats = lstatSync(candidate);
  } catch {
    throwDiagnostic("artifact_error", "path", "Required artifact is missing", path);
  }
  if (linkStats.isSymbolicLink()) {
    throwDiagnostic("artifact_error", "path", "Artifact path must not be a symlink", path);
  }
  if (!linkStats.isFile()) {
    throwDiagnostic("artifact_error", "path", "Artifact path is not a regular file", path);
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(candidate);
  } catch {
    throwDiagnostic("artifact_error", "path", "Artifact path is unavailable", path);
  }
  if (!isWithin(root, canonicalPath)) {
    throwDiagnostic("artifact_error", "path", "Artifact target escapes the worker directory", path);
  }
  const before = identity(statSync(canonicalPath));
  let snapshots;
  try {
    snapshots = snapshotTextFiles([candidate], root, "agent_result", { maxBytes });
  } catch {
    throwDiagnostic("artifact_error", "path", "Artifact is not a bounded UTF-8 text file", path);
  }
  const snapshot = snapshots[0];
  if (!snapshot || snapshot.canonicalPath !== canonicalPath) {
    throwDiagnostic("artifact_error", "path", "Artifact identity changed during validation", path);
  }
  let after: ArtifactIdentity;
  try {
    after = identity(statSync(canonicalPath));
  } catch {
    throwDiagnostic("artifact_error", "path", "Artifact identity changed during validation", path);
  }
  if (!sameIdentity(before, after) || snapshot.bytes !== after.size) {
    throwDiagnostic("artifact_error", "path", "Artifact changed during validation", path);
  }
  const sha256 = createHash("sha256").update(snapshot.text, "utf8").digest("hex");
  return {
    canonicalPath,
    text: snapshot.text,
    bytes: snapshot.bytes,
    sha256,
    identity: after,
  };
}

/** Capture the output path before the worker can create or modify it. */
export function captureArtifactBaseline(
  contract: ArtifactResponseContract,
  cwd: string,
  maxBytes: number,
): ArtifactBaseline {
  const { root, candidate } = artifactPath(contract.path, cwd);
  let stats: ReturnType<typeof lstatSync> | undefined;
  try {
    stats = lstatSync(candidate);
  } catch (error) {
    if (!isMissing(error)) {
      throwDiagnostic("artifact_error", "path", "Artifact path cannot be inspected", contract.path);
    }
  }
  if (!stats) {
    nearestExistingDirectory(candidate, root, contract.path);
    return Object.freeze({ path: contract.path, exists: false });
  }
  if (stats.isSymbolicLink()) {
    throwDiagnostic("artifact_error", "path", "Artifact path must not be a symlink", contract.path);
  }
  if (!stats.isFile()) {
    throwDiagnostic("artifact_error", "path", "Artifact path is not a regular file", contract.path);
  }
  const snapshot = artifactSnapshot(contract.path, cwd, maxBytes);
  return Object.freeze({
    path: contract.path,
    exists: true,
    canonicalPath: snapshot.canonicalPath,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes,
    identity: snapshot.identity,
  });
}

export function responseContractHash(contract: ResponseContract): string {
  return createHash("sha256").update(JSON.stringify(contract), "utf8").digest("hex");
}

export function createAcceptedAssignmentContract(
  requestId: string,
  briefValue: DelegationBrief,
  roleDefault: unknown,
  cwd: string,
  maxArtifactBytes: number,
  contextSnapshots: readonly AcceptedContextSnapshot[] = [],
): AcceptedAssignmentContract {
  const brief = normalizeDelegationBrief(briefValue);
  const contract = resolveResponseContract(
    roleDefault,
    brief.response === "role-defaults" ? undefined : brief.response,
  );
  const artifactBaseline =
    contract.target === "inline"
      ? undefined
      : captureArtifactBaseline(contract, cwd, maxArtifactBytes);
  return Object.freeze({
    requestId,
    brief,
    briefHash: delegationBriefHash(brief),
    responseContract: contract,
    responseContractHash: responseContractHash(contract),
    contextSnapshots: normalizeContextSnapshots(contextSnapshots, brief),
    ...(artifactBaseline === undefined ? {} : { artifactBaseline }),
  });
}

/** Revalidate a persisted accepted contract without consulting mutable defaults. */
export function validateAcceptedAssignmentContract(
  value: unknown,
  options: { requestId: string; minimumProfile: BriefProfile },
): AcceptedAssignmentContract {
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, "requestId") ||
    !Object.hasOwn(value, "brief") ||
    !Object.hasOwn(value, "briefHash") ||
    !Object.hasOwn(value, "responseContract") ||
    !Object.hasOwn(value, "responseContractHash") ||
    !Object.hasOwn(value, "contextSnapshots")
  ) {
    throw new Error("accepted assignment contract is incomplete");
  }
  if (value.requestId !== options.requestId) {
    throw new Error("accepted assignment request identity does not match");
  }
  const brief = normalizeDelegationBrief(value.brief, {
    minimumProfile: options.minimumProfile,
  });
  if (value.briefHash !== delegationBriefHash(brief)) {
    throw new Error("accepted brief digest does not match");
  }
  const responseContract = normalizeResponseContract(value.responseContract);
  if (value.responseContractHash !== responseContractHash(responseContract)) {
    throw new Error("accepted response-contract digest does not match");
  }
  let artifactBaseline: ArtifactBaseline | undefined;
  if (responseContract.target === "inline") {
    if (Object.hasOwn(value, "artifactBaseline")) {
      throw new Error("inline response contract cannot carry an artifact baseline");
    }
  } else {
    const baseline = value.artifactBaseline;
    if (
      !isRecord(baseline) ||
      baseline.path !== responseContract.path ||
      typeof baseline.exists !== "boolean"
    ) {
      throw new Error("accepted artifact baseline does not match the response path");
    }
    if (baseline.exists) {
      if (
        typeof baseline.canonicalPath !== "string" ||
        typeof baseline.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(baseline.sha256) ||
        typeof baseline.bytes !== "number" ||
        !Number.isSafeInteger(baseline.bytes) ||
        baseline.bytes < 0 ||
        !isRecord(baseline.identity) ||
        !Number.isSafeInteger(baseline.identity.device) ||
        !Number.isSafeInteger(baseline.identity.inode) ||
        !Number.isSafeInteger(baseline.identity.size) ||
        typeof baseline.identity.modifiedAt !== "number"
      ) {
        throw new Error("accepted artifact baseline is malformed");
      }
      artifactBaseline = Object.freeze({
        path: responseContract.path,
        exists: true,
        canonicalPath: baseline.canonicalPath,
        sha256: baseline.sha256,
        bytes: baseline.bytes,
        identity: Object.freeze({
          device: baseline.identity.device,
          inode: baseline.identity.inode,
          size: baseline.identity.size,
          modifiedAt: baseline.identity.modifiedAt,
        }),
      });
    } else {
      if (["canonicalPath", "sha256", "bytes", "identity"].some((key) => Object.hasOwn(baseline, key))) {
        throw new Error("missing artifact baseline cannot carry file identity");
      }
      artifactBaseline = Object.freeze({ path: responseContract.path, exists: false });
    }
  }
  return Object.freeze({
    requestId: options.requestId,
    brief,
    briefHash: value.briefHash,
    responseContract,
    responseContractHash: value.responseContractHash,
    contextSnapshots: normalizeContextSnapshots(value.contextSnapshots, brief),
    ...(artifactBaseline === undefined ? {} : { artifactBaseline }),
  });
}

function normalizeContextSnapshots(
  value: unknown,
  brief: DelegationBrief,
): readonly AcceptedContextSnapshot[] {
  if (!Array.isArray(value) || value.length !== brief.context.inputs.length) {
    throw new Error("accepted context snapshots do not match the brief inputs");
  }
  return Object.freeze(
    value.map((entry, index) => {
      const input = brief.context.inputs[index];
      if (
        !isRecord(entry) ||
        Object.keys(entry).some(
          (key) => !["reference", "purpose", "snapshotPath", "bytes", "sha256"].includes(key),
        ) ||
        entry.reference !== input.reference ||
        entry.purpose !== input.purpose ||
        typeof entry.snapshotPath !== "string" ||
        !entry.snapshotPath.trim() ||
        typeof entry.bytes !== "number" ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        typeof entry.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(entry.sha256)
      ) {
        throw new Error(`accepted context snapshot ${index} is malformed`);
      }
      return Object.freeze({
        reference: input.reference,
        purpose: input.purpose,
        snapshotPath: entry.snapshotPath,
        bytes: entry.bytes,
        sha256: entry.sha256,
      });
    }),
  );
}

function markdownBody(text: string): string {
  const normalized = text.replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) return normalized;
  const lines = normalized.split(/\r?\n/u);
  const close = lines.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
  return close < 0 ? normalized : lines.slice(close + 1).join("\n");
}

function markdownHeadings(text: string): ReadonlySet<string> {
  const lines = markdownBody(text).split(/\r?\n/u);
  const headings = new Set<string>();
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let htmlComment = false;
  let htmlBlock = false;
  let rawHtmlTag: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]!;
    if (htmlComment) {
      if (line.includes("-->")) htmlComment = false;
      continue;
    }
    if (rawHtmlTag) {
      if (new RegExp(`</${rawHtmlTag}\\s*>`, "iu").test(line)) rawHtmlTag = undefined;
      continue;
    }
    if (htmlBlock) {
      if (!line.trim()) htmlBlock = false;
      else continue;
    }
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0] as "`" | "~";
      if (!fence) fence = { marker, length: fenceMatch[1]!.length };
      else if (fence.marker === marker && fenceMatch[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    let commentOpenedOnLine = false;
    const commentStart = line.indexOf("<!--");
    if (commentStart >= 0) {
      const prefix = line.slice(0, commentStart);
      if (!prefix.trim()) {
        if (!line.slice(commentStart + 4).includes("-->")) htmlComment = true;
        continue;
      }
      if (!line.slice(commentStart + 4).includes("-->")) {
        htmlComment = true;
        commentOpenedOnLine = true;
      }
      line = prefix;
    }
    const rawTag = line.match(/^ {0,3}<(script|pre|style|textarea)\b/iu)?.[1];
    if (rawTag) {
      const tag = rawTag.toLowerCase();
      if (!new RegExp(`</${tag}\\s*>`, "iu").test(line)) rawHtmlTag = tag;
      continue;
    }
    if (
      /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)\b/iu.test(line)
    ) {
      htmlBlock = true;
      continue;
    }
    const atx = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)\s*$/u);
    if (atx) {
      headings.add(atx[1]!.replace(/[ \t]+#+[ \t]*$/u, "").trim());
      continue;
    }
    if (
      line.trim() &&
      !commentOpenedOnLine &&
      index + 1 < lines.length &&
      /^ {0,3}(?:=+|-+)[ \t]*$/u.test(lines[index + 1]!)
    ) {
      headings.add(line.trim());
      index += 1;
    }
  }
  return headings;
}

function validateMetadata(text: string, schema: "handoff/v1", artifactPath?: string): void {
  let frontmatter: unknown;
  try {
    frontmatter = parsePiFrontmatter<Record<string, unknown>>(text).frontmatter;
  } catch {
    throwDiagnostic(
      artifactPath === undefined ? "invalid_response" : "artifact_error",
      "metadata.frontmatter",
      "Markdown frontmatter is malformed",
      artifactPath,
    );
  }
  const code = artifactPath === undefined ? "invalid_response" : "artifact_error";
  if (!isRecord(frontmatter) || Object.keys(frontmatter).some((key) => !(HANDOFF_FIELDS as readonly string[]).includes(key))) {
    throwDiagnostic(code, "metadata.frontmatter", "handoff/v1 frontmatter has unknown fields", artifactPath);
  }
  if (frontmatter.schema !== schema) {
    throwDiagnostic(code, "metadata.schema", "Markdown frontmatter must declare handoff/v1", artifactPath);
  }
  for (const field of ["title", "summary"] as const) {
    if (typeof frontmatter[field] !== "string" || !frontmatter[field].trim()) {
      throwDiagnostic(code, `metadata.${field}`, `Markdown frontmatter requires ${field}`, artifactPath);
    }
  }
}

function validateMarkdown(
  text: string,
  contract: ResponseContract,
  code: ResponseErrorCode,
  artifactPath?: string,
): void {
  if (contract.format !== "markdown") return;
  const headings = markdownHeadings(text);
  for (const section of contract.requiredSections) {
    if (!headings.has(section.trim())) {
      throwDiagnostic(code, "requiredSections", `Missing Markdown heading: ${section.slice(0, 160)}`, artifactPath);
    }
  }
  if (contract.metadataSchema === "handoff/v1") {
    validateMetadata(text, "handoff/v1", artifactPath);
  }
}

export interface ValidateResponseOptions {
  readonly contract: ResponseContract;
  readonly baseline?: ArtifactBaseline;
  readonly inlineText: string;
  readonly cwd: string;
  readonly maxInlineBytes: number;
  readonly maxArtifactBytes: number;
}

export interface ValidatedResponse {
  readonly contractHash: string;
  readonly artifacts: readonly ArtifactDescriptor[];
}

/** Validate actual inline Markdown and safely observe any declared artifact. */
export function validateResponse(
  options: ValidateResponseOptions,
): ValidatedResponse {
  const contract = normalizeResponseContract(options.contract);
  const inlineRequired = contract.target !== "artifact";
  if (inlineRequired) {
    if (!options.inlineText.trim()) {
      throwDiagnostic("invalid_response", "inline.text", "A nonempty inline response is required");
    }
    if (Buffer.byteLength(options.inlineText, "utf8") > options.maxInlineBytes) {
      throwDiagnostic("invalid_response", "inline.text", "Inline response exceeds the configured byte limit");
    }
    validateMarkdown(options.inlineText, contract, "invalid_response");
  }

  const artifacts: ArtifactDescriptor[] = [];
  if (contract.target !== "inline") {
    const baseline = options.baseline;
    if (!baseline || baseline.path !== contract.path) {
      throwDiagnostic("artifact_error", "artifact.baseline", "Accepted artifact baseline is missing", contract.path);
    }
    const observation = artifactSnapshot(contract.path, options.cwd, options.maxArtifactBytes);
    validateMarkdown(observation.text, contract, "artifact_error", contract.path);
    const reused = baseline.exists && baseline.sha256 === observation.sha256;
    if (reused && !contract.allowExistingArtifact) {
      throwDiagnostic("artifact_error", "artifact.identity", "Artifact is unchanged from the pre-assignment file", contract.path);
    }
    artifacts.push(
      Object.freeze({
        path: contract.path,
        canonicalPath: observation.canonicalPath,
        sha256: observation.sha256,
        bytes: observation.bytes,
        disposition: reused ? "reused" : "created",
      }),
    );
  }
  return Object.freeze({
    contractHash: responseContractHash(contract),
    artifacts: Object.freeze(artifacts),
  });
}
