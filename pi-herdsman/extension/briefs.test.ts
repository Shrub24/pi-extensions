import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIEF_PROFILES,
  DELEGATION_BRIEF_EXAMPLES,
  DELEGATION_BRIEF_GUIDE,
  briefFormatHint,
  delegationBriefHash,
  normalizeDelegationBrief,
  parseDelegationBrief,
} from "./briefs.ts";

const commonFrontmatter = `---
schema: delegation-brief/v1
profile: common
objective: Inspect the task input
context:
  summary: none
  inputs: []
scope:
  allowed: ["src"]
  excluded: []
constraints: []
acceptance: ["Return one concrete source path"]
response: role-defaults
---
Inspect the code and report the relevant path.`;

function replaceYaml(source: string, from: string, to: string): string {
  assert.ok(source.includes(from), `fixture does not contain ${from}`);
  return source.replace(from, to);
}

function assertBriefError(source: string, field?: string, options?: { minimumProfile?: (typeof BRIEF_PROFILES)[number] }): void {
  assert.throws(
    () => parseDelegationBrief(source, options),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.startsWith("brief."), error.message);
      assert.ok(error.message.length <= 512, error.message);
      if (field) assert.ok(error.message.startsWith(`brief.${field}`), error.message);
      return true;
    },
  );
}

test("canonical examples parse under their supported profiles", () => {
  for (const profile of BRIEF_PROFILES) {
    const brief = parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES[profile], {
      minimumProfile: profile,
    });
    assert.equal(brief.schema, "delegation-brief/v1");
    assert.equal(brief.profile, profile);
    assert.ok(brief.body.length > 0);
    assert.ok(Object.isFrozen(brief));
    assert.ok(Object.isFrozen(brief.context.inputs));
    assert.ok(Object.isFrozen(brief.scope.allowed));
    assert.match(delegationBriefHash(brief), /^[0-9a-f]{64}$/u);
  }
});

test("rejects free text, missing fields, unsupported versions and invalid YAML", () => {
  assertBriefError("Just do the work", "schema");
  assertBriefError(replaceYaml(commonFrontmatter, "schema: delegation-brief/v1", "schema: delegation-brief/v2"), "schema");
  assertBriefError(replaceYaml(commonFrontmatter, "objective: Inspect the task input\n", ""), "objective");
  assertBriefError(replaceYaml(commonFrontmatter, "profile: common", "profile: unknown"), "profile");
  assertBriefError("---\nschema: [bad\n---\nbody", "frontmatter");
});

test("common fields require explicit context, scope, constraints, acceptance and response", () => {
  assertBriefError(replaceYaml(commonFrontmatter, "  inputs: []\n", ""), "context");
  assertBriefError(replaceYaml(commonFrontmatter, "summary: none", "summary: '   '"), "context.summary");
  assertBriefError(replaceYaml(commonFrontmatter, "allowed: [\"src\"]", "allowed: []"), "scope.allowed");
  assertBriefError(replaceYaml(commonFrontmatter, "acceptance: [\"Return one concrete source path\"]", "acceptance: []"), "acceptance");
  assertBriefError(replaceYaml(commonFrontmatter, "response: role-defaults", ""), "response");
  assertBriefError(replaceYaml(commonFrontmatter, "constraints: []", "constraints: [7]"), "constraints[0]");
  assertBriefError(replaceYaml(commonFrontmatter, "response: role-defaults", "response:\n  schema: response-contract/v2"), "response");
});

test("unknown and wrongly typed nested fields fail closed", () => {
  assertBriefError(replaceYaml(commonFrontmatter, "scope:\n", "surprise: true\nscope:\n"), "frontmatter");
  assertBriefError(replaceYaml(commonFrontmatter, "  summary: none\n", "  summary: none\n  extra: value\n"), "context");
  assertBriefError(replaceYaml(commonFrontmatter, "inputs: []", "inputs: [\"not a mapping\"]"), "context.inputs[0]");
  assertBriefError(replaceYaml(commonFrontmatter, "excluded: []", "excluded: [null]"), "scope.excluded[0]");
  assertBriefError(replaceYaml(commonFrontmatter, "acceptance: [\"Return one concrete source path\"]", "acceptance: [\"\"]"), "acceptance[0]");
  assertBriefError(replaceYaml(commonFrontmatter, "response: role-defaults", "response: {schema: response-contract/v1, target: inline}"), "response");
});

test("profile-specific requirements are mandatory and a task cannot downgrade its worker profile", () => {
  for (const profile of ["investigation", "research", "execution", "review"] as const) {
    assertBriefError(
      replaceYaml(commonFrontmatter, "profile: common", `profile: ${profile}`),
      profile,
    );
  }
  assertBriefError(commonFrontmatter, "profile", { minimumProfile: "investigation" });
  assertBriefError(
    DELEGATION_BRIEF_EXAMPLES.investigation,
    "profile",
    { minimumProfile: "research" },
  );
  assertBriefError(
    replaceYaml(DELEGATION_BRIEF_EXAMPLES.investigation, "questions: [\"Where is the request admitted?\"]", "questions: []"),
    "investigation.questions",
  );
  assertBriefError(
    replaceYaml(DELEGATION_BRIEF_EXAMPLES.execution, "affectedArea: \"Worker-side task admission\"", "affectedArea: \"   \""),
    "execution.affectedArea",
  );
});

test("explicit empty lists are retained only where the schema permits them", () => {
  const brief = parseDelegationBrief(commonFrontmatter);
  assert.deepEqual(brief.context.inputs, []);
  assert.deepEqual(brief.scope.excluded, []);
  assert.deepEqual(brief.constraints, []);
  assert.deepEqual(brief.acceptance, ["Return one concrete source path"]);
});

test("brief bytes and bounded scalar/list limits are enforced without echoing input", () => {
  assertBriefError(`${commonFrontmatter}${"x".repeat(64 * 1024)}`, "source");
  assertBriefError(replaceYaml(commonFrontmatter, "objective: Inspect the task input", `objective: ${"x".repeat(8193)}`), "objective");
  assertBriefError(
    replaceYaml(commonFrontmatter, "allowed: [\"src\"]", `allowed: [${Array.from({ length: 33 }, (_, index) => `\"${index}\"`).join(", ")}]`),
    "scope.allowed",
  );
  assertBriefError(
    replaceYaml(commonFrontmatter, "inputs: []", `inputs: [${Array.from({ length: 17 }, () => "{reference: src/a, purpose: inspect}").join(", ")}]`),
    "context.inputs",
  );
});

test("canonical metadata is independently revalidated at worker admission", () => {
  const brief = parseDelegationBrief(commonFrontmatter);
  const copy = normalizeDelegationBrief(brief, { minimumProfile: "common" });
  assert.deepEqual(copy, brief);
  assert.notStrictEqual(copy, brief);
  assert.throws(
    () => normalizeDelegationBrief({ ...brief, unexpected: true }),
    /brief\.frontmatter/u,
  );
  assert.throws(
    () => normalizeDelegationBrief({ ...brief, profile: "review" }),
    /brief\.review/u,
  );
});

test("the rejection hint and the model guide are built from the canonical examples", () => {
  for (const profile of BRIEF_PROFILES) {
    const hint = briefFormatHint(profile);
    assert.ok(hint.includes(DELEGATION_BRIEF_EXAMPLES[profile]), profile);
    parseDelegationBrief(hint.slice(hint.indexOf("---")), { minimumProfile: profile });
  }
  assert.ok(DELEGATION_BRIEF_GUIDE.includes(DELEGATION_BRIEF_EXAMPLES.execution));
  for (const block of ["investigation", "research", "execution", "review"])
    assert.ok(DELEGATION_BRIEF_GUIDE.includes(`${block}:`), block);
});
