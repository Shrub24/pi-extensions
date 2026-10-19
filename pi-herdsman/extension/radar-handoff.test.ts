import assert from "node:assert/strict";
import { test } from "node:test";
import type { RadarHandoffPort } from "pi-radar/communication";
import type { ResultRecord } from "./mailbox.ts";
import {
  decodeSealedReport,
  persistAndAcknowledgeCompletion,
  publishCompletionHandoff,
  sealedCompletionFor,
} from "./radar-handoff.ts";

const SEALED = [
  "---",
  "schema: handoff/v1",
  "title: Parser fix",
  "summary: The parser now accepts empty files.",
  "---",
  "",
  "## Outcome", "Complete.",
  "## Changes and findings", "Changed the parser.",
  "## Evidence", "Tests pass.",
  "## Decisions", "Empty input is valid.",
  "## Caveats", "None.",
  "## Remaining work", "None.",
  "## Relevant artifacts", "- parser.ts",
  "",
].join("\n");

const completed: ResultRecord = {
  version: 6, requestId: "11111111-1111-4111-8111-111111111111", runId: "run-1",
  ownerSessionId: "owner-1", workspaceId: "workspace-1", agentLabel: "worker", paneId: "%4",
  status: "completed", text: "Acknowledged.", completedAt: 1234,
  handoff: { title: "Parser fix", summary: "The parser now accepts empty files.", content: SEALED, sha256: "x", bytes: SEALED.length, published: false },
};

test("publication sends the sealed Markdown report, never the chat acknowledgement", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const port = {
    publish: async (value: Record<string, unknown>) => {
      requests.push(value);
      if (requests.length === 1) throw new Error("reply lost after dispatch");
      return { ok: true as const, value: { handoff: { id: value.request_id }, created: false } };
    },
  } as unknown as RadarHandoffPort;
  await assert.rejects(() => publishCompletionHandoff(port, completed), /reply lost/u);
  await publishCompletionHandoff(port, completed);
  assert.equal(requests[0]?.request_id, completed.requestId);
  assert.equal(requests[0]?.correlation_id, completed.runId);
  assert.equal(requests[0]?.content, SEALED);
  assert.equal(requests[0]?.summary, "The parser now accepts empty files.");
  assert.deepEqual(requests[1], requests[0]);
});

test("a result with no sealed handoff is refused rather than reconstructed from chat text", () => {
  assert.throws(
    () => sealedCompletionFor({ ...completed, handoff: undefined }),
    /no sealed handoff/u,
  );
});

test("a failed worker publishes a Herdsman failure record that cannot be mistaken for a report", () => {
  const sealed = sealedCompletionFor({
    ...completed, status: "failed", text: undefined, handoff: undefined,
    error: { code: "invalid_response", message: "Missing Evidence section" },
  });
  assert.equal(sealed.status, "failed");
  assert.match(sealed.content, /^---\nschema: handoff\/v1\ntitle: "Failed: worker"/u);
  assert.deepEqual(decodeSealedReport(sealed.content), {
    status: "failed", title: "Failed: worker", summary: "invalid_response: Missing Evidence section",
  });
});

test("a retrieved worker report decodes to its title and summary as completed", () => {
  assert.deepEqual(decodeSealedReport(SEALED), {
    status: "completed", title: "Parser fix", summary: "The parser now accepts empty files.",
  });
});

test("the owner durably records the report before acknowledging it", async () => {
  const events: string[] = [];
  const port = {
    ack: async (id: string) => {
      events.push(`ack:${id}`);
      return { ok: true as const, value: { receipt: {}, created: true } };
    },
  } as unknown as RadarHandoffPort;
  await persistAndAcknowledgeCompletion(port, {
    id: completed.requestId, correlation_id: completed.runId,
    sender: { registration_id: "worker-agent" }, content: SEALED,
  }, { runId: completed.runId, agentId: "worker-agent" }, (report) => {
    events.push("persist");
    assert.equal(report.content, SEALED);
    assert.equal(report.status, "completed");
  });
  assert.deepEqual(events, ["persist", `ack:${completed.requestId}`]);
});

test("failed local persistence leaves the report unacknowledged", async () => {
  let acknowledged = false;
  const port = {
    ack: async () => { acknowledged = true; return { ok: true, value: {} }; },
  } as unknown as RadarHandoffPort;
  await assert.rejects(() => persistAndAcknowledgeCompletion(port, {
    id: completed.requestId, correlation_id: completed.runId,
    sender: { registration_id: "worker-agent" }, content: SEALED,
  }, { runId: completed.runId, agentId: "worker-agent" }, () => { throw new Error("disk unavailable"); }));
  assert.equal(acknowledged, false);
});

test("a report from another managed execution is never acknowledged", async () => {
  let acknowledged = false;
  const port = {
    ack: async () => { acknowledged = true; return { ok: true, value: {} }; },
  } as unknown as RadarHandoffPort;
  await assert.rejects(() => persistAndAcknowledgeCompletion(port, {
    id: completed.requestId, correlation_id: "another-run",
    sender: { registration_id: "worker-agent" }, content: SEALED,
  }, { runId: completed.runId, agentId: "worker-agent" }, () => {}));
  assert.equal(acknowledged, false);
});
