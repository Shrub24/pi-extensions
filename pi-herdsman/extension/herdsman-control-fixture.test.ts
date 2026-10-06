import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name: string) =>
  readFileSync(new URL(`../docs/reference/${name}`, import.meta.url), "utf8");

const TERMINAL_STATES = ["result", "started", "not_executed"];
const OUTCOMES = ["closed", "restarted", "refused", "unknown"];
const OPERATIONS = ["close", "restart"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_BYTES = 8192;

// A requester derives the terminal state the contract documents, from file
// evidence alone: a result wins over a claim, a claim wins over expiry.
const deriveState = ({
  resultFile,
  claimFile,
  expiresAt,
  observedAt,
}: {
  resultFile: boolean;
  claimFile: boolean;
  expiresAt: string;
  observedAt: string;
}) => {
  if (resultFile) return "result";
  if (claimFile) return "started";
  return Date.parse(observedAt) > Date.parse(expiresAt)
    ? "not_executed"
    : "pending";
};

test("the control fixture parses and every case names its spec scenario", () => {
  const fixture = JSON.parse(read("herdsman-control.fixture.json"));
  const cases = [
    ...fixture.requests,
    ...fixture.results,
    ...fixture.derivation,
    ...fixture.directory.untrusted,
  ];
  assert.ok(fixture.requests.length > 0 && fixture.results.length > 0);
  for (const item of cases) {
    assert.ok(item.case, "every fixture case carries a label");
    assert.match(item.scenario, /^(?:Scenario|Requirement): \S/u);
  }
});

test("every fixture outcome, category, effect and state is documented", () => {
  const fixture = JSON.parse(read("herdsman-control.fixture.json"));
  const page = read("herdsman-control.md");
  const terms = new Set([
    ...fixture.requests.flatMap(({ request, expect }) => [
      request.operation,
      expect.outcome,
      ...(expect.category ? [expect.category] : []),
    ]),
    ...fixture.results.flatMap(({ result }) => [
      result.outcome,
      ...(result.category ? [result.category] : []),
      ...result.effects,
    ]),
    ...fixture.derivation.map(({ state }) => state),
  ]);
  for (const term of terms)
    assert.ok(page.includes(`\`${term}\``), `${term} is not documented`);
});

test("every fixture request and result carries the documented shape", () => {
  const fixture = JSON.parse(read("herdsman-control.fixture.json"));
  const byId = new Map(
    fixture.requests.map(({ request }) => [request.requestId, request]),
  );
  for (const { request, expect: expected } of fixture.requests) {
    assert.equal(request.version, 1);
    assert.match(request.requestId, UUID);
    assert.ok(OPERATIONS.includes(request.operation));
    assert.ok(request.agent && request.runId);
    assert.equal(request.confirmation.operation, request.operation);
    assert.equal(request.confirmation.runId, request.runId);
    if (expected.category !== "invalid_request")
      assert.equal(request.confirmation.label, request.agent);
    assert.ok(request.requestedAt && request.expiresAt && request.requester);
    assert.ok(JSON.stringify(request).length <= MAX_BYTES);
  }
  for (const { result } of fixture.results) {
    const request = byId.get(result.requestId);
    assert.ok(request, `no fixture request for result ${result.requestId}`);
    assert.equal(result.version, 1);
    assert.match(result.requestId, UUID);
    assert.equal(result.operation, request.operation);
    assert.ok(OUTCOMES.includes(result.outcome));
    assert.equal(result.outcome === "refused", typeof result.category === "string");
    assert.ok(result.message && result.completedAt);
    assert.ok(Array.isArray(result.effects));
    assert.ok(JSON.stringify(result).length <= MAX_BYTES);
  }
});

test("the derivation table covers all three terminal states", () => {
  const fixture = JSON.parse(read("herdsman-control.fixture.json"));
  const states = new Set<string>();
  for (const entry of fixture.derivation) {
    assert.match(entry.requestId, UUID);
    states.add(entry.state);
    assert.equal(entry.state, deriveState(entry), entry.case);
    assert.equal(entry.terminal, entry.state !== "pending", entry.case);
  }
  for (const state of TERMINAL_STATES)
    assert.ok(states.has(state), `the derivation table omits ${state}`);
});
