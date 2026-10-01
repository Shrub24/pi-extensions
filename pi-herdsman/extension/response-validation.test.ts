import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DELEGATION_BRIEF_EXAMPLES, normalizeDelegationBrief, parseDelegationBrief } from "./briefs.ts";
import { DEFAULT_RESPONSE_CONTRACT, normalizeResponseContract } from "./response-contracts.ts";
import {
  captureArtifactBaseline,
  createAcceptedAssignmentContract,
  ResponseValidationError,
  validateAcceptedAssignmentContract,
  validateResponse,
} from "./response-validation.ts";

const REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAX_BYTES = 4096;

function withDirectory(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "pi-herdsman-response-validation-"));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function acceptedBrief() {
  return normalizeDelegationBrief(
    parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES.common),
  );
}

function report(overrides: Record<string, unknown> = {}) {
  return normalizeResponseContract({
    schema: "response-contract/v1",
    target: "artifact",
    format: "markdown",
    requiredSections: ["Outcome"],
    path: "report.md",
    ...overrides,
  });
}

const VALID_REPORT = "---\nschema: handoff/v1\ntitle: Result\nsummary: Done\n---\n\n## Outcome\nComplete.\n";

test("accepted response requirements are frozen to one request and can be revalidated", () => {
  withDirectory((cwd) => {
    const override = normalizeResponseContract({
      schema: "response-contract/v1",
      target: "inline",
      format: "markdown",
      requiredSections: ["Result"],
    });
    const accepted = createAcceptedAssignmentContract(
      REQUEST_ID,
      { ...acceptedBrief(), response: override },
      DEFAULT_RESPONSE_CONTRACT,
      cwd,
      MAX_BYTES,
    );
    assert.equal(accepted.requestId, REQUEST_ID);
    assert.equal(accepted.responseContract.target, "inline");
    assert.equal(accepted.responseContractHash.length, 64);
    assert.ok(Object.isFrozen(accepted));
    assert.ok(Object.isFrozen(accepted.brief));
    assert.equal(
      validateAcceptedAssignmentContract(accepted, {
        requestId: REQUEST_ID,
        minimumProfile: "common",
      }).responseContractHash,
      accepted.responseContractHash,
    );
    assert.throws(
      () => validateAcceptedAssignmentContract(accepted, {
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        minimumProfile: "common",
      }),
      /request identity does not match/,
    );
    assert.throws(
      () => validateAcceptedAssignmentContract(accepted, {
        requestId: REQUEST_ID,
        minimumProfile: "research",
      }),
      /profile/,
    );
  });
});

test("inline response validation checks actual Markdown sections and registered metadata", () => {
  const contract = normalizeResponseContract({
    schema: "response-contract/v1",
    target: "inline",
    format: "markdown",
    requiredSections: ["Outcome"],
    metadataSchema: "handoff/v1",
  });
  const valid = validateResponse({
    contract,
    inlineText: VALID_REPORT,
    cwd: tmpdir(),
    maxInlineBytes: MAX_BYTES,
    maxArtifactBytes: MAX_BYTES,
  });
  assert.equal(valid.artifacts.length, 0);
  assert.throws(
    () => validateResponse({
      contract,
      inlineText: "---\nschema: handoff/v1\ntitle: Result\nsummary: Done\n---\n\n## Changes\nNo outcome.\n",
      cwd: tmpdir(),
      maxInlineBytes: MAX_BYTES,
      maxArtifactBytes: MAX_BYTES,
    }),
    (error) => error instanceof ResponseValidationError && error.code === "invalid_response",
  );
  assert.throws(
    () => validateResponse({
      contract,
      inlineText: "## Outcome\nComplete.\n",
      cwd: tmpdir(),
      maxInlineBytes: MAX_BYTES,
      maxArtifactBytes: MAX_BYTES,
    }),
    (error) => error instanceof ResponseValidationError && error.code === "invalid_response",
  );
});

test("HTML comments and raw HTML blocks cannot satisfy required Markdown headings", () => {
  const contract = normalizeResponseContract({
    schema: "response-contract/v1",
    target: "inline",
    format: "markdown",
    requiredSections: ["Outcome"],
  });
  for (const inlineText of [
    "<!--\n## Outcome\n-->\n",
    "## Summary <!--\n## Outcome\n-->\n",
    "<div>\n## Outcome\n</div>\n",
  ]) {
    assert.throws(
      () => validateResponse({
        contract,
        inlineText,
        cwd: tmpdir(),
        maxInlineBytes: MAX_BYTES,
        maxArtifactBytes: MAX_BYTES,
      }),
      (error) =>
        error instanceof ResponseValidationError &&
        error.diagnostics[0]?.field === "requiredSections",
    );
  }
});

test("artifact-only responses validate bounded output without requiring inline duplication", () => {
  withDirectory((cwd) => {
    const contract = report();
    const baseline = captureArtifactBaseline(contract, cwd, MAX_BYTES);
    writeFileSync(join(cwd, "report.md"), "## Outcome\nComplete.\n", "utf8");
    const result = validateResponse({
      contract,
      baseline,
      inlineText: "",
      cwd,
      maxInlineBytes: 0,
      maxArtifactBytes: MAX_BYTES,
    });
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0]?.disposition, "created");
    assert.equal(result.artifacts[0]?.bytes, Buffer.byteLength("## Outcome\nComplete.\n"));
  });
});

test("required artifacts that remain missing are rejected", () => {
  withDirectory((cwd) => {
    const contract = report();
    const baseline = captureArtifactBaseline(contract, cwd, MAX_BYTES);
    assert.throws(
      () => validateResponse({
        contract,
        baseline,
        inlineText: "",
        cwd,
        maxInlineBytes: 0,
        maxArtifactBytes: MAX_BYTES,
      }),
      (error) =>
        error instanceof ResponseValidationError &&
        error.code === "artifact_error" &&
        error.diagnostics[0]?.field === "path",
    );
  });
});

test("artifact validation rejects a target replaced by a symlink after acceptance", () => {
  withDirectory((cwd) => {
    const contract = report();
    const baseline = captureArtifactBaseline(contract, cwd, MAX_BYTES);
    const replacement = join(cwd, "replacement.md");
    writeFileSync(replacement, "## Outcome\nComplete.\n", "utf8");
    symlinkSync(replacement, join(cwd, contract.path));
    assert.throws(
      () => validateResponse({
        contract,
        baseline,
        inlineText: "",
        cwd,
        maxInlineBytes: MAX_BYTES,
        maxArtifactBytes: MAX_BYTES,
      }),
      (error) => error instanceof ResponseValidationError && error.code === "artifact_error",
    );
  });
});

test("artifact replacement with unchanged bytes cannot satisfy a new-output contract", () => {
  withDirectory((cwd) => {
    const contract = report();
    const target = join(cwd, contract.path);
    const replacement = join(cwd, "replacement.md");
    const existing = "## Outcome\nAlready present.\n";
    writeFileSync(target, existing, "utf8");
    const baseline = captureArtifactBaseline(contract, cwd, MAX_BYTES);
    writeFileSync(replacement, existing, "utf8");
    renameSync(replacement, target);
    assert.throws(
      () => validateResponse({
        contract,
        baseline,
        inlineText: "",
        cwd,
        maxInlineBytes: MAX_BYTES,
        maxArtifactBytes: MAX_BYTES,
      }),
      (error) =>
        error instanceof ResponseValidationError &&
        error.code === "artifact_error" &&
        error.message.includes("unchanged from the pre-assignment file"),
    );
  });
});

test("artifact validation rejects stale, escaped, symlinked, and oversized files", () => {
  withDirectory((cwd) => {
    const staleContract = report({ allowExistingArtifact: false });
    writeFileSync(join(cwd, "report.md"), "## Outcome\nOld.\n", "utf8");
    const staleBaseline = captureArtifactBaseline(staleContract, cwd, MAX_BYTES);
    assert.throws(
      () => validateResponse({
        contract: staleContract,
        baseline: staleBaseline,
        inlineText: "",
        cwd,
        maxInlineBytes: 0,
        maxArtifactBytes: MAX_BYTES,
      }),
      (error) => error instanceof ResponseValidationError && error.code === "artifact_error",
    );

    assert.throws(
      () => captureArtifactBaseline(report({ path: "../outside.md" }), cwd, MAX_BYTES),
      (error) => error instanceof ResponseValidationError && error.code === "artifact_error",
    );

    mkdirSync(join(cwd, "nested"));
    writeFileSync(join(cwd, "nested", "real.md"), "## Outcome\nComplete.\n", "utf8");
    symlinkSync(join(cwd, "nested", "real.md"), join(cwd, "link.md"));
    assert.throws(
      () => captureArtifactBaseline(report({ path: "link.md" }), cwd, MAX_BYTES),
      (error) => error instanceof ResponseValidationError && error.code === "artifact_error",
    );

    const limited = report({ path: "large.md" });
    const largeBaseline = captureArtifactBaseline(limited, cwd, MAX_BYTES);
    writeFileSync(join(cwd, "large.md"), `## Outcome\n${"x".repeat(MAX_BYTES)}\n`, "utf8");
    assert.throws(
      () => validateResponse({
        contract: limited,
        baseline: largeBaseline,
        inlineText: "",
        cwd,
        maxInlineBytes: 0,
        maxArtifactBytes: 32,
      }),
      (error) => error instanceof ResponseValidationError && error.code === "artifact_error",
    );
  });
});

test("permitted artifact reuse is recorded and non-regular outputs are rejected", () => {
  withDirectory((cwd) => {
    const contract = report({ allowExistingArtifact: true });
    writeFileSync(join(cwd, "report.md"), "## Outcome\nComplete.\n", "utf8");
    const baseline = captureArtifactBaseline(contract, cwd, MAX_BYTES);
    const result = validateResponse({
      contract,
      baseline,
      inlineText: "",
      cwd,
      maxInlineBytes: 0,
      maxArtifactBytes: MAX_BYTES,
    });
    assert.equal(result.artifacts[0]?.disposition, "reused");

    mkdirSync(join(cwd, "directory"));
    assert.throws(
      () => captureArtifactBaseline(report({ path: "directory" }), cwd, MAX_BYTES),
      (error) => error instanceof ResponseValidationError && error.code === "artifact_error",
    );
  });
});
