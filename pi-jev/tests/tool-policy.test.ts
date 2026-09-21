/*
 * The policy file: parsing, loading, and the resolution that turns a file into
 * a ruling about one call.
 *
 * The parser is hand-rolled and structural, so its tests pin the shapes it
 * accepts and — more importantly — the ones it refuses. A malformed file must
 * degrade to the default policy, never to a nudge per call.
 */

import { expect, test } from "bun:test";

import { applyGuidance, parseToolPolicy } from "../extensions/tool-policy.js";
import { DEFAULT_TOOL_POLICY } from "../extensions/tool-choice.js";
import type { ActionAskFacts } from "../extensions/action-pack.js";

const facts = (value: string, toolName = "bash"): ActionAskFacts => ({
	requestId: "req-1",
	toolCallId: "req-1",
	surface: "tool_call",
	kind: "tool",
	value,
	toolName,
	invokedToolName: null,
	matchedPattern: null,
	commandContext: null,
	executedUnit: null,
	agentName: null,
	forwarded: false,
	policy: { surfaceState: "ungated", toolState: null },
	path: null,
	preferredTool: null,
	preferredReason: null,
	rankedAlternatives: [],
	policyIntent: null,
	policyDirectives: [],
	policyAvoid: null,
});

test("preferences parse as before: tool, match, reason", () => {
	const policy = parseToolPolicy(`
preferences:
  - tool: grep
    match: "rg "
    reason: ripgrep is faster
margin: 0.3
`);
	expect(policy?.preferences).toEqual([{ tool: "grep", match: "rg ", reason: "ripgrep is faster" }]);
	expect(policy?.margin).toBe(0.3);
	expect(policy?.precedence).toBeUndefined();
	expect(policy?.avoid).toBeUndefined();
	expect(policy?.directives).toBeUndefined();
});

test("a precedence block parses into ranked orders, capped at four tools", () => {
	const policy = parseToolPolicy(`
precedence:
  - intent: edit code
    order: [edit, write, bash, sed, awk]
    reason: surgical edits beat rewrites
`);
	expect(policy?.precedence).toEqual([{ intent: "edit code", order: ["edit", "write", "bash", "sed"], reason: "surgical edits beat rewrites" }]);
});

test("avoid and directives parse with their reasons verbatim", () => {
	const policy = parseToolPolicy(`
avoid:
  - tool: bash
    when: "cat "
    reason: reading through the shell skips guards
directives:
  - text: prefer edit for anything surgical
  - when: edit
    text: write only for new files
`);
	expect(policy?.avoid).toEqual([{ tool: "bash", when: "cat ", reason: "reading through the shell skips guards" }]);
	expect(policy?.directives).toEqual([{ text: "prefer edit for anything surgical" }, { when: "edit", text: "write only for new files" }]);
});

test("avoidMargin parses and falls back to margin when absent", () => {
	const withBoth = parseToolPolicy("preferences:\n  - tool: grep\n    match: \"rg \"\n    reason: faster\nmargin: 0.2\navoidMargin: 0.4\n");
	expect(withBoth?.margin).toBe(0.2);
	expect(withBoth?.avoidMargin).toBe(0.4);
	const onlyMargin = parseToolPolicy("preferences:\n  - tool: grep\n    match: \"rg \"\n    reason: faster\nmargin: 0.25\n");
	expect(onlyMargin?.avoidMargin).toBeUndefined();
});

test("a file with none of the four constructs yields nothing", () => {
	expect(parseToolPolicy("# only comments\n")).toBeUndefined();
	expect(parseToolPolicy("margin: 0.5\navoidMargin: 0.3\n")).toBeUndefined();
});

test("garbage sections are ignored; a valid one beside them still lands", () => {
	const policy = parseToolPolicy(`
precedence:
  - intent: edit code
    order: [edit, bash]
    reason: surgical edits
nonsense:
  - tool: nope
`);
	expect(policy?.precedence).toHaveLength(1);
	expect(policy?.preferences).toEqual([]);
});

test("an intent precedence whose order contains the tool in use wins", () => {
	const policy = parseToolPolicy(`
precedence:
  - intent: edit code
    order: [edit, bash]
    reason: surgical edits
preferences:
  - tool: grep
    match: "sed "
    reason: never matched
`);
	const guidance = applyGuidance(facts("sed -i 's/a/b/' f.ts"), policy);
	expect(guidance.preferredTool).toBe("edit");
	expect(guidance.policyIntent).toBe("edit code");
	expect(guidance.rankedAlternatives).toEqual([{ tool: "edit", reason: "surgical edits", intent: "edit code" }]);
	expect(guidance.policyDirectives).toEqual([]);
});

test("a per-call match beats nothing when no precedence names the tool", () => {
	const policy = parseToolPolicy(`
preferences:
  - tool: grep
    match: "rg "
    reason: ripgrep is faster
`);
	const guidance = applyGuidance(facts("rg 'retry' src/"), policy);
	expect(guidance.preferredTool).toBe("grep");
	expect(guidance.preferredReason).toBe("ripgrep is faster");
	expect(guidance.policyIntent).toBeNull();
});

test("an avoid pair matches on the value substring and stamps the reason", () => {
	const policy = parseToolPolicy(`
avoid:
  - tool: bash
    when: "cat "
    reason: reading through the shell skips guards
`);
	const hit = applyGuidance(facts("cat /etc/hosts"), policy);
	expect(hit.policyAvoid).toEqual({ reason: "reading through the shell skips guards" });
	const miss = applyGuidance(facts("cargo build --release"), policy);
	expect(miss.policyAvoid).toBeNull();
});

test("directives apply when unset-for-all or naming the tool in use", () => {
	const policy = parseToolPolicy(`
directives:
  - text: prefer edit for anything surgical
  - when: bash
    text: keep commands short
  - when: read
    text: never matched here
`);
	const guidance = applyGuidance(facts("ls -la"), policy);
	expect(guidance.policyDirectives).toEqual(["prefer edit for anything surgical", "keep commands short"]);
});

test("no policy means no ruling: facts pass through untouched", () => {
	const plain = facts("cat /etc/hosts");
	const guidance = applyGuidance(plain, undefined);
	expect(guidance.preferredTool).toBeNull();
	expect(guidance.policyAvoid).toBeNull();
	expect(guidance.rankedAlternatives).toEqual([]);
});

test("an empty policy is the default and rules nothing", () => {
	const guidance = applyGuidance(facts("cat /etc/hosts"), DEFAULT_TOOL_POLICY);
	expect(guidance.preferredTool).toBeNull();
	expect(guidance.policyAvoid).toBeNull();
});
