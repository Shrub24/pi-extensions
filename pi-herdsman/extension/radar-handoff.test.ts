import assert from "node:assert/strict";
import { test } from "node:test";
import type { RadarMailboxPort } from "pi-radar/communication";
import type { ResultRecord } from "./mailbox.ts";
import {
  decodeCompletionMessage, decodeSealedReport, publishCompletionHandoff,
  sealedCompletionFor, type CompletionMessage,
} from "./radar-handoff.ts";

const SEALED = [
  "---", "schema: handoff/v1", "title: Parser fix",
  "summary: The parser now accepts empty files.", "---", "",
  "## Outcome", "Complete.", "## Changes and findings", "Changed the parser.",
  "## Evidence", "Tests pass.", "## Decisions", "Empty input is valid.",
  "## Caveats", "None.", "## Remaining work", "None.", "## Relevant artifacts", "- parser.ts", "",
].join("\n");
const completed: ResultRecord = {
  version: 6, requestId: "11111111-1111-4111-8111-111111111111", runId: "run-1",
  ownerSessionId: "owner-1", workspaceId: "workspace-1", agentLabel: "worker", paneId: "%4",
  status: "completed", text: "Acknowledged.", completedAt: 1234,
  handoff: { title: "Parser fix", summary: "The parser now accepts empty files.", content: SEALED, sha256: "x", bytes: SEALED.length, published: false },
};
const message: CompletionMessage = {
  version: 1, id: completed.requestId, created_at_unix_ms: 1234,
  producer: { registration_id: "registration", session_id: "session", subject_id: "worker-subject", claim_id: "claim" },
  recipients: ["owner-subject"],
  body: { kind: "handoff", correlation_id: completed.runId, summary: "A transport summary", content: SEALED },
};
const expected = { runId: completed.runId, subjectId: "worker-subject" };

test("publication sends the sealed report with a stable ID and body across an uncertain retry", async () => {
  const requests: Parameters<RadarMailboxPort["publish"]>[0][] = [];
  const port: Pick<RadarMailboxPort, "publish"> = {
    publish: async (value) => {
      requests.push(value);
      if (requests.length === 1) throw new Error("reply lost after dispatch");
      return { ok: true, value: { message, created: false } };
    },
  };
  await assert.rejects(() => publishCompletionHandoff(port, completed), /reply lost/u);
  await publishCompletionHandoff(port, completed);
  assert.equal(requests[0]?.request_id, completed.requestId);
  assert.equal(requests[0]?.correlation_id, completed.runId);
  assert.equal(requests[0]?.content, SEALED);
  assert.equal(requests[0]?.summary, "The parser now accepts empty files.");
  assert.deepEqual(requests[1], requests[0]);
});

test("a result without a sealed handoff is refused, not reconstructed from chat", () => {
  assert.throws(() => sealedCompletionFor({ ...completed, handoff: undefined }), /no sealed handoff/u);
});

test("a failed worker publishes a distinct Herdsman failure record", () => {
  const sealed = sealedCompletionFor({
    ...completed, status: "failed", text: undefined, handoff: undefined,
    error: { code: "invalid_response", message: "Missing Evidence section" },
  });
  assert.equal(sealed.status, "failed");
  assert.deepEqual(decodeSealedReport(sealed.content), {
    status: "failed", title: "Failed: worker", summary: "invalid_response: Missing Evidence section",
  });
});

test("capture maps the message ID and sealed body, not the transport summary", () => {
  assert.deepEqual(decodeCompletionMessage(message, expected), {
    requestId: completed.requestId, status: "completed",
    summary: "The parser now accepts empty files.", content: SEALED,
  });
});

test("capture refuses another subject, another run, or an invalid sealed report", () => {
  assert.throws(() => decodeCompletionMessage({
    ...message, producer: { ...message.producer, subject_id: "other-worker" },
  }, expected), /does not match/u);
  assert.throws(() => decodeCompletionMessage({
    ...message, body: { ...message.body, correlation_id: "other-run" },
  }, expected), /does not match/u);
  assert.throws(() => decodeCompletionMessage({
    ...message, body: { ...message.body, content: "plain acknowledgement" },
  }, expected), /not a handoff\/v1/u);
});
