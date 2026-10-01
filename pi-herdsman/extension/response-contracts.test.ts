import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RESPONSE_CONTRACT,
  normalizeResponseContract,
  resolveResponseContract,
  type ResponseContract,
} from "./response-contracts.ts";

const minimalValue = () => ({
  schema: "response-contract/v1",
  target: "inline",
  format: "text",
  requiredSections: [],
});

const artifactValue = () => ({
  schema: "response-contract/v1",
  target: "artifact",
  format: "markdown",
  requiredSections: ["Outcome", "Changes"],
  path: "reports/phase/result.md",
  metadataSchema: "handoff/v1",
});

/** Every rejection is a responseContract.-prefixed, bounded, input-free error. */
const assertContractError = (
  fn: () => unknown,
  field?: string,
  absentRawInput?: string,
): void => {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error, `expected an Error, received ${String(error)}`);
    assert.ok(error.message.startsWith("responseContract."), `unexpected error prefix: ${error.message}`);
    assert.ok(error.message.length <= 512, `error message longer than 512 characters: ${error.message.length}`);
    if (field !== undefined) {
      assert.ok(error.message.startsWith(field), `expected a ${field} error, got: ${error.message}`);
    }
    if (absentRawInput !== undefined) {
      assert.ok(!error.message.includes(absentRawInput), `error message echoes raw input: ${error.message}`);
    }
    return true;
  });
};

test("the common default is exactly the minimal inline text contract and is immutable", () => {
  assert.deepEqual(DEFAULT_RESPONSE_CONTRACT, {
    schema: "response-contract/v1",
    target: "inline",
    format: "text",
    requiredSections: [],
  });
  assert.ok(Object.isFrozen(DEFAULT_RESPONSE_CONTRACT), "the default is frozen");
  assert.ok(Object.isFrozen(DEFAULT_RESPONSE_CONTRACT.requiredSections), "the default section list is frozen");
  const normalized = normalizeResponseContract(DEFAULT_RESPONSE_CONTRACT);
  assert.deepEqual(normalized, DEFAULT_RESPONSE_CONTRACT);
  assert.notStrictEqual(normalized, DEFAULT_RESPONSE_CONTRACT, "normalization returns a new object");
});

test("artifact and both targets normalize with path, materialized reuse permission and freezing", () => {
  const artifact = normalizeResponseContract(artifactValue());
  assert.deepEqual(artifact, {
    schema: "response-contract/v1",
    target: "artifact",
    format: "markdown",
    requiredSections: ["Outcome", "Changes"],
    path: "reports/phase/result.md",
    allowExistingArtifact: false,
    metadataSchema: "handoff/v1",
  } satisfies ResponseContract);
  assert.ok(Object.isFrozen(artifact), "the artifact contract is frozen");
  assert.ok(Object.isFrozen((artifact as { requiredSections: readonly string[] }).requiredSections), "sections are frozen");

  const both = normalizeResponseContract({ ...artifactValue(), target: "both", allowExistingArtifact: true });
  assert.equal(both.target, "both");
  assert.equal((both as { allowExistingArtifact?: boolean }).allowExistingArtifact, true, "true is preserved verbatim");

  const withoutReuse = normalizeResponseContract(artifactValue());
  assert.equal((withoutReuse as { allowExistingArtifact?: boolean }).allowExistingArtifact, false, "absent defaults to false");
});

test("missing required fields are rejected one by one, including path for artifacts", () => {
  for (const field of ["schema", "target", "format", "requiredSections"] as const) {
    const value = minimalValue() as Record<string, unknown>;
    delete value[field];
    assertContractError(() => normalizeResponseContract(value), `responseContract.${field}`);
  }
  const noPath = artifactValue() as Record<string, unknown>;
  delete noPath.path;
  assertContractError(() => normalizeResponseContract(noPath), "responseContract.path");
});

test("unknown fields are rejected without echoing their names or values", () => {
  assertContractError(() => normalizeResponseContract({ ...minimalValue(), surprise: "briefProfile" }), "responseContract.value", "briefProfile");
  // Briefing requirements are a separate module; response policy must not
  // accept them.
  for (const briefField of ["briefProfile", "scope", "acceptance"] as const) {
    assertContractError(() => normalizeResponseContract({ ...minimalValue(), [briefField]: ["Outcome"] }), "responseContract.value", briefField);
  }
  assertContractError(
    () => normalizeResponseContract({ ...artifactValue(), extra: 1 }),
    "responseContract.value",
    "extra",
  );
});

test("unsupported schema versions and enum values are rejected", () => {
  assertContractError(() => normalizeResponseContract({ ...minimalValue(), schema: "response-contract/v2" }), "responseContract.schema");
  assertContractError(() => normalizeResponseContract({ ...minimalValue(), schema: "response-contract/v10" }), "responseContract.schema");
  assertContractError(() => normalizeResponseContract({ ...minimalValue(), target: "file" }), "responseContract.target");
  assertContractError(() => normalizeResponseContract({ ...minimalValue(), target: null }), "responseContract.target");
  assertContractError(() => normalizeResponseContract({ ...minimalValue(), format: "html" }), "responseContract.format");
  assertContractError(() => normalizeResponseContract({ ...minimalValue(), format: ["markdown"] }), "responseContract.format");
});

test("malformed containers and wrong field types are rejected without coercion", () => {
  for (const value of [null, undefined, "contract", 42, ["inline"], true]) {
    assertContractError(() => normalizeResponseContract(value), "responseContract.value");
  }
  assertContractError(() => normalizeResponseContract({ ...minimalValue(), schema: 1 }), "responseContract.schema");
  assertContractError(() => normalizeResponseContract({ ...minimalValue(), requiredSections: "Outcome" }), "responseContract.requiredSections");
  assertContractError(() => normalizeResponseContract({ ...minimalValue(), requiredSections: null }), "responseContract.requiredSections");
});

test("section bounds: 32 passes, 33 fails, long/whitespace-only entries fail", () => {
  const atBound = Array.from({ length: 32 }, (_, index) => `Section ${index}`);
  const accepted = normalizeResponseContract({ ...minimalValue(), target: "both", format: "markdown", path: "r.md", requiredSections: atBound });
  assert.deepEqual(accepted.requiredSections, atBound);

  const overBound = Array.from({ length: 33 }, (_, index) => `Section ${index}`);
  assertContractError(
    () => normalizeResponseContract({ ...minimalValue(), target: "both", format: "markdown", path: "r.md", requiredSections: overBound }),
    "responseContract.requiredSections",
  );

  for (const badSection of ["", "   ", "x".repeat(257), 7, null]) {
    assertContractError(
      () => normalizeResponseContract({ ...minimalValue(), target: "artifact", format: "markdown", path: "r.md", requiredSections: [badSection] }),
      "responseContract.requiredSections[0]",
    );
  }
  // Unicode of exactly 256 UTF-16 units is in-bounds and preserved verbatim.
  const wide = "😀".repeat(128);
  const unicode = normalizeResponseContract({ ...minimalValue(), target: "artifact", format: "markdown", path: "r.md", requiredSections: [wide] });
  assert.equal(unicode.requiredSections[0], wide);
});

test("duplicate sections are rejected verbatim, never silently deduplicated", () => {
  assertContractError(
    () => normalizeResponseContract({ ...minimalValue(), target: "artifact", format: "markdown", path: "r.md", requiredSections: ["Outcome", "Outcome"] }),
    "responseContract.requiredSections[1]",
  );
  // Spacing and case are preserved, so these two are distinct entries.
  const distinct = normalizeResponseContract({
    ...minimalValue(),
    target: "artifact",
    format: "markdown",
    path: "r.md",
    requiredSections: ["Outcome", "outcome", " Outcome "],
  });
  assert.deepEqual(distinct.requiredSections, ["Outcome", "outcome", " Outcome "]);
});

test("section newlines and NUL are rejected", () => {
  for (const badSection of ["Out\ncome", "Outcome\r", "Out\u0000come"]) {
    assertContractError(
      () => normalizeResponseContract({ ...minimalValue(), target: "artifact", format: "markdown", path: "r.md", requiredSections: [badSection] }),
      "responseContract.requiredSections[0]",
    );
  }
});

test("text contracts require empty sections and no metadataSchema", () => {
  assertContractError(
    () => normalizeResponseContract({ ...minimalValue(), requiredSections: ["Outcome"] }),
    "responseContract.requiredSections",
  );
  assertContractError(
    () => normalizeResponseContract({ ...minimalValue(), metadataSchema: "handoff/v1" }),
    "responseContract.metadataSchema",
  );
  const empty = normalizeResponseContract({ ...minimalValue(), requiredSections: [] });
  assert.deepEqual(empty.requiredSections, []);
});

test("registered metadata id passes with markdown; unsupported ids are rejected", () => {
  const withMetadata = normalizeResponseContract({ ...artifactValue(), metadataSchema: "handoff/v1" });
  assert.equal((withMetadata as { metadataSchema?: string }).metadataSchema, "handoff/v1");
  for (const metadataSchema of ["handoff/v2", "brief/v1", "", 1]) {
    assertContractError(
      () => normalizeResponseContract({ ...artifactValue(), metadataSchema }),
      "responseContract.metadataSchema",
    );
  }
  const withoutMetadata = normalizeResponseContract({
    schema: "response-contract/v1",
    target: "both",
    format: "markdown",
    requiredSections: [],
    path: "r.md",
  });
  assert.ok(!("metadataSchema" in withoutMetadata), "absent optional keys are omitted, not undefined-valued");
});

test("path and reuse rules follow the target", () => {
  assertContractError(() => normalizeResponseContract({ ...minimalValue(), path: "r.md" }), "responseContract.path", "r.md");
  assertContractError(
    () => normalizeResponseContract({ ...minimalValue(), allowExistingArtifact: false }),
    "responseContract.allowExistingArtifact",
    "false",
  );
  assertContractError(
    () => normalizeResponseContract({ ...minimalValue(), allowExistingArtifact: true }),
    "responseContract.allowExistingArtifact",
  );
  for (const path of ["", "   ", "x".repeat(4097), "with\u0000nul", 42, null]) {
    assertContractError(
      () => normalizeResponseContract({ ...artifactValue(), path }),
      "responseContract.path",
    );
  }
  assertContractError(
    () => normalizeResponseContract({ ...artifactValue(), allowExistingArtifact: "yes" }),
    "responseContract.allowExistingArtifact",
  );
  const atLimit = normalizeResponseContract({ ...artifactValue(), path: "p".repeat(4096) });
  assert.equal((atLimit as { path: string }).path.length, 4096, "the 4096-unit path bound is inclusive");
});

test("an assignment override is a complete replacement, not a patch", () => {
  const roleDefault = artifactValue();
  const shortInline = minimalValue();
  const resolved = resolveResponseContract(roleDefault, shortInline);
  assert.deepEqual(resolved, {
    schema: "response-contract/v1",
    target: "inline",
    format: "text",
    requiredSections: [],
  });
  assert.ok(!("path" in resolved), "no inherited path leaks from the role default");
  assert.ok(!("metadataSchema" in resolved), "no inherited metadata leaks from the role default");
  assert.ok(Object.isFrozen(resolved), "the override result is frozen");
});

test("an invalid role default is rejected even when an override is supplied", () => {
  assertContractError(() => resolveResponseContract({ schema: "response-contract/v1" }, minimalValue()), "responseContract.target");
  assertContractError(() => resolveResponseContract(null, minimalValue()), "responseContract.value");
});

test("an explicit null override is invalid; an absent override uses the default", () => {
  assertContractError(() => resolveResponseContract(DEFAULT_RESPONSE_CONTRACT, null), "responseContract.value");
  assert.deepEqual(resolveResponseContract(DEFAULT_RESPONSE_CONTRACT, undefined), DEFAULT_RESPONSE_CONTRACT);
});

test("successive resolutions do not inherit earlier overrides or retain state", () => {
  const roleDefault = artifactValue();
  const first = resolveResponseContract(roleDefault, { ...minimalValue(), target: "both", format: "markdown", path: "first.md" });
  assert.equal(first.target, "both");
  assert.equal((first as { path?: string }).path, "first.md");

  const second = resolveResponseContract(roleDefault);
  assert.deepEqual(second, {
    schema: "response-contract/v1",
    target: "artifact",
    format: "markdown",
    requiredSections: ["Outcome", "Changes"],
    path: "reports/phase/result.md",
    allowExistingArtifact: false,
    metadataSchema: "handoff/v1",
  });
  assert.notStrictEqual(second, first, "each resolution returns its own object");

  const third = resolveResponseContract();
  assert.deepEqual(third, DEFAULT_RESPONSE_CONTRACT);
});

test("normalization copies input and later input mutation cannot change accepted output", () => {
  const value = {
    ...minimalValue(),
    target: "artifact",
    format: "markdown",
    path: "reports/result.md",
    requiredSections: ["Outcome"],
  };
  const normalized = normalizeResponseContract(value);
  assert.notStrictEqual(normalized, value, "a new object is returned");
  assert.notStrictEqual(normalized.requiredSections, value.requiredSections, "the section array is copied");

  value.path = "mutated.md";
  value.requiredSections.push("Mutated");
  value.format = "text";

  assert.equal((normalized as { path: string }).path, "reports/result.md");
  assert.deepEqual(normalized.requiredSections, ["Outcome"]);
  assert.equal(normalized.format, "markdown");
});
