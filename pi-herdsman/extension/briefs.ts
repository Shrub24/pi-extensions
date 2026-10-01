import { createHash } from "node:crypto";
import { parseFrontmatter as parsePiFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  normalizeResponseContract,
  type ResponseContract,
} from "./response-contracts.ts";

export const DELEGATION_BRIEF_SCHEMA = "delegation-brief/v1" as const;
export const BRIEF_PROFILES = [
  "common",
  "investigation",
  "research",
  "execution",
  "review",
] as const;
export type BriefProfile = (typeof BRIEF_PROFILES)[number];

const MAX_BRIEF_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 8192;
const MAX_LIST_ITEMS = 32;
const MAX_CONTEXT_INPUTS = 16;
const ROOT_FIELDS = [
  "schema",
  "profile",
  "objective",
  "context",
  "scope",
  "constraints",
  "acceptance",
  "response",
  "investigation",
  "research",
  "execution",
  "review",
] as const;

export interface BriefContextInput {
  readonly reference: string;
  readonly purpose: string;
}

export interface DelegationBrief {
  readonly schema: typeof DELEGATION_BRIEF_SCHEMA;
  readonly profile: BriefProfile;
  readonly objective: string;
  readonly context: {
    readonly summary: string;
    readonly inputs: readonly BriefContextInput[];
  };
  readonly scope: {
    readonly allowed: readonly string[];
    readonly excluded: readonly string[];
  };
  readonly constraints: readonly string[];
  readonly acceptance: readonly string[];
  readonly response: "role-defaults" | ResponseContract;
  readonly body: string;
  readonly investigation?: {
    readonly questions: readonly string[];
    readonly targetLocations: readonly string[];
  };
  readonly research?: {
    readonly questions: readonly string[];
    readonly sourceConstraints: readonly string[];
  };
  readonly execution?: {
    readonly affectedArea: string;
    readonly validationExpectations: readonly string[];
  };
  readonly review?: {
    readonly baseline: string;
    readonly criteria: readonly string[];
  };
}

const fail = (detail: string): Error => new Error(`brief.${detail}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactFields = (
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
};

const requireText = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_TEXT_CHARS ||
    value.includes("\u0000")
  ) {
    throw fail(`${field}: expected nonempty text of at most ${MAX_TEXT_CHARS} characters`);
  }
  return value;
};

const requireList = (
  value: unknown,
  field: string,
  { minimum = 0, maximum = MAX_LIST_ITEMS }: { minimum?: number; maximum?: number } = {},
): readonly string[] => {
  if (!Array.isArray(value)) throw fail(`${field}: expected an array`);
  if (value.length < minimum || value.length > maximum) {
    throw fail(`${field}: expected ${minimum === maximum ? `exactly ${minimum}` : `between ${minimum} and ${maximum}`} entries`);
  }
  return Object.freeze(value.map((entry, index) => requireText(entry, `${field}[${index}]`)));
};

function normalizeBriefFields(
  raw: unknown,
  bodyValue: unknown,
  minimumProfile: BriefProfile,
): DelegationBrief {
  if (!isRecord(raw)) throw fail("frontmatter: expected a YAML mapping");
  if (Object.keys(raw).some((key) => !(ROOT_FIELDS as readonly string[]).includes(key))) {
    throw fail("frontmatter: unknown field");
  }
  if (raw.schema !== DELEGATION_BRIEF_SCHEMA) {
    throw fail(`schema: expected ${DELEGATION_BRIEF_SCHEMA}`);
  }
  if (typeof raw.profile !== "string" || !(BRIEF_PROFILES as readonly string[]).includes(raw.profile)) {
    throw fail("profile: expected common, investigation, research, execution or review");
  }
  const profile = raw.profile as BriefProfile;
  if (minimumProfile !== "common" && profile !== minimumProfile) {
    throw fail(`profile: this worker requires ${minimumProfile}`);
  }

  const objective = requireText(raw.objective, "objective");
  const context = raw.context;
  if (!isRecord(context) || !hasExactFields(context, ["summary", "inputs"])) {
    throw fail("context: expected summary and inputs fields");
  }
  const summary = requireText(context.summary, "context.summary");
  const inputsRaw = context.inputs;
  if (!Array.isArray(inputsRaw) || inputsRaw.length > MAX_CONTEXT_INPUTS) {
    throw fail(`context.inputs: expected an array of at most ${MAX_CONTEXT_INPUTS} entries`);
  }
  const inputs = Object.freeze(
    inputsRaw.map((input, index) => {
      if (!isRecord(input) || !hasExactFields(input, ["reference", "purpose"])) {
        throw fail(`context.inputs[${index}]: expected reference and purpose fields`);
      }
      return Object.freeze({
        reference: requireText(input.reference, `context.inputs[${index}].reference`),
        purpose: requireText(input.purpose, `context.inputs[${index}].purpose`),
      });
    }),
  );

  const scope = raw.scope;
  if (!isRecord(scope) || !hasExactFields(scope, ["allowed", "excluded"])) {
    throw fail("scope: expected allowed and excluded fields");
  }
  const normalizedScope = Object.freeze({
    allowed: requireList(scope.allowed, "scope.allowed", { minimum: 1 }),
    excluded: requireList(scope.excluded, "scope.excluded"),
  });
  const constraints = requireList(raw.constraints, "constraints");
  const acceptance = requireList(raw.acceptance, "acceptance", { minimum: 1 });

  let response: DelegationBrief["response"];
  if (raw.response === "role-defaults") {
    response = "role-defaults";
  } else {
    try {
      response = normalizeResponseContract(raw.response);
    } catch {
      throw fail("response: expected role-defaults or a valid response-contract/v1 object");
    }
  }

  const body = requireText(bodyValue, "body");
  if (profile === "investigation") {
    const value = raw.investigation;
    if (!isRecord(value) || !hasExactFields(value, ["questions", "targetLocations"])) {
      throw fail("investigation: expected questions and targetLocations fields");
    }
    if (["research", "execution", "review"].some((field) => Object.hasOwn(raw, field))) {
      throw fail("profile: fields for a different briefing profile are not allowed");
    }
    return Object.freeze({
      schema: DELEGATION_BRIEF_SCHEMA,
      profile,
      objective,
      context: Object.freeze({ summary, inputs }),
      scope: normalizedScope,
      constraints,
      acceptance,
      response,
      body,
      investigation: Object.freeze({
        questions: requireList(value.questions, "investigation.questions", { minimum: 1 }),
        targetLocations: requireList(value.targetLocations, "investigation.targetLocations", { minimum: 1 }),
      }),
    });
  }
  if (profile === "research") {
    const value = raw.research;
    if (!isRecord(value) || !hasExactFields(value, ["questions", "sourceConstraints"])) {
      throw fail("research: expected questions and sourceConstraints fields");
    }
    if (["investigation", "execution", "review"].some((field) => Object.hasOwn(raw, field))) {
      throw fail("profile: fields for a different briefing profile are not allowed");
    }
    return Object.freeze({
      schema: DELEGATION_BRIEF_SCHEMA,
      profile,
      objective,
      context: Object.freeze({ summary, inputs }),
      scope: normalizedScope,
      constraints,
      acceptance,
      response,
      body,
      research: Object.freeze({
        questions: requireList(value.questions, "research.questions", { minimum: 1 }),
        sourceConstraints: requireList(value.sourceConstraints, "research.sourceConstraints", { minimum: 1 }),
      }),
    });
  }
  if (profile === "execution") {
    const value = raw.execution;
    if (!isRecord(value) || !hasExactFields(value, ["affectedArea", "validationExpectations"])) {
      throw fail("execution: expected affectedArea and validationExpectations fields");
    }
    if (["investigation", "research", "review"].some((field) => Object.hasOwn(raw, field))) {
      throw fail("profile: fields for a different briefing profile are not allowed");
    }
    return Object.freeze({
      schema: DELEGATION_BRIEF_SCHEMA,
      profile,
      objective,
      context: Object.freeze({ summary, inputs }),
      scope: normalizedScope,
      constraints,
      acceptance,
      response,
      body,
      execution: Object.freeze({
        affectedArea: requireText(value.affectedArea, "execution.affectedArea"),
        validationExpectations: requireList(value.validationExpectations, "execution.validationExpectations", { minimum: 1 }),
      }),
    });
  }
  if (profile === "review") {
    const value = raw.review;
    if (!isRecord(value) || !hasExactFields(value, ["baseline", "criteria"])) {
      throw fail("review: expected baseline and criteria fields");
    }
    if (["investigation", "research", "execution"].some((field) => Object.hasOwn(raw, field))) {
      throw fail("profile: fields for a different briefing profile are not allowed");
    }
    return Object.freeze({
      schema: DELEGATION_BRIEF_SCHEMA,
      profile,
      objective,
      context: Object.freeze({ summary, inputs }),
      scope: normalizedScope,
      constraints,
      acceptance,
      response,
      body,
      review: Object.freeze({
        baseline: requireText(value.baseline, "review.baseline"),
        criteria: requireList(value.criteria, "review.criteria", { minimum: 1 }),
      }),
    });
  }

  if (["investigation", "research", "execution", "review"].some((field) => Object.hasOwn(raw, field))) {
    throw fail("profile: common briefs cannot include role-specific fields");
  }
  return Object.freeze({
    schema: DELEGATION_BRIEF_SCHEMA,
    profile,
    objective,
    context: Object.freeze({ summary, inputs }),
    scope: normalizedScope,
    constraints,
    acceptance,
    response,
    body,
  });
}

/** Parse strict YAML frontmatter and a nonempty Markdown work body. */
export function parseDelegationBrief(
  source: string,
  options: { minimumProfile?: BriefProfile } = {},
): DelegationBrief {
  if (typeof source !== "string") throw fail("source: expected Markdown text");
  if (Buffer.byteLength(source, "utf8") > MAX_BRIEF_BYTES) {
    throw fail(`source: exceeds the ${MAX_BRIEF_BYTES}-byte brief limit`);
  }
  let parsed: ReturnType<typeof parsePiFrontmatter>;
  try {
    parsed = parsePiFrontmatter<Record<string, unknown>>(source.replace(/^\uFEFF/u, ""));
  } catch {
    throw fail("frontmatter: invalid YAML frontmatter");
  }
  return normalizeBriefFields(
    parsed.frontmatter,
    parsed.body,
    options.minimumProfile ?? "common",
  );
}

/** Revalidate persisted canonical metadata at worker admission and recovery. */
export function normalizeDelegationBrief(
  value: unknown,
  options: { minimumProfile?: BriefProfile } = {},
): DelegationBrief {
  if (!isRecord(value) || !Object.hasOwn(value, "body")) {
    throw fail("value: expected a canonical brief object");
  }
  const frontmatter: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key !== "body") frontmatter[key] = field;
  }
  return normalizeBriefFields(
    frontmatter,
    value.body,
    options.minimumProfile ?? "common",
  );
}

export function delegationBriefHash(brief: DelegationBrief): string {
  return createHash("sha256").update(JSON.stringify(brief), "utf8").digest("hex");
}

export const DELEGATION_BRIEF_EXAMPLES: Readonly<Record<BriefProfile, string>> = Object.freeze({
  common: `---
schema: delegation-brief/v1
profile: common
objective: Identify the entry point for a small configuration bug
context:
  summary: none
  inputs: []
scope:
  allowed: ["pi-herdsman/extension"]
  excluded: ["pi-bash-processes"]
constraints: []
acceptance: ["Return the relevant file and the responsible function"]
response: role-defaults
---
Inspect the extension and report the narrowest relevant source path.`,
  investigation: `---
schema: delegation-brief/v1
profile: investigation
objective: Trace how an assignment reaches its worker
context:
  summary: The task concerns the current delegation path.
  inputs: []
scope:
  allowed: ["pi-herdsman/extension"]
  excluded: ["unrelated packages"]
constraints: ["Do not edit files"]
acceptance: ["Cite the admission function and its callers"]
response: role-defaults
investigation:
  questions: ["Where is the request admitted?"]
  targetLocations: ["pi-herdsman/extension/index.ts"]
---
Trace the request from the tool handler to worker admission.`,
  research: `---
schema: delegation-brief/v1
profile: research
objective: Compare the documented API with its current implementation
context:
  summary: none
  inputs: []
scope:
  allowed: ["official API documentation"]
  excluded: ["secondary commentary"]
constraints: ["Cite primary sources"]
acceptance: ["Summarize the documented behavior and material gaps"]
response: role-defaults
research:
  questions: ["What does the API guarantee?"]
  sourceConstraints: ["Use official documentation"]
---
Research the API contract and cite the primary sources.`,
  execution: `---
schema: delegation-brief/v1
profile: execution
objective: Add one regression test for worker admission
context:
  summary: none
  inputs: []
scope:
  allowed: ["pi-herdsman/extension/agent-runtime.test.ts"]
  excluded: ["production behavior outside admission"]
constraints: ["Do not change runtime semantics"]
acceptance: ["The regression test fails before the fix and passes afterward"]
response: role-defaults
execution:
  affectedArea: "Worker-side task admission"
  validationExpectations: ["Run the focused runtime test"]
---
Add the test at the existing runtime boundary.`,
  review: `---
schema: delegation-brief/v1
profile: review
objective: Review the assignment lifecycle changes
context:
  summary: none
  inputs: []
scope:
  allowed: ["the requested diff"]
  excluded: ["unmodified code"]
constraints: ["Read-only review"]
acceptance: ["Report only actionable findings with evidence"]
response: role-defaults
review:
  baseline: "the current branch base"
  criteria: ["Lifecycle correctness", "Protocol compatibility"]
---
Review the diff against the stated baseline and criteria.`,
});

export function validateBriefExamples(): void {
  for (const [profile, source] of Object.entries(DELEGATION_BRIEF_EXAMPLES) as [BriefProfile, string][]) {
    parseDelegationBrief(source, { minimumProfile: profile });
  }
}
