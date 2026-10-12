import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { join } from "node:path";
import {
  fakePi, realFs, PI_AGENT_ROOT,
} from "./support.ts";
import {
  handoffPath, listCompletions, persistCompletion, readCompletion,
  saveCompletion, sessionManuallyRetired, wrapupContext, waitForPreparation,
  writePreparationResult,
} from "./completions.ts";

function report(text = "A short summary.\n\nFull report evidence.") {
  return persistCompletion({
    version: 5, runId: randomUUID(), requestId: randomUUID(),
    ownerSessionId: randomUUID(), workspaceId: randomUUID(),
    agentLabel: "worker", paneId: "%1", status: "completed", text,
    completedAt: Date.now(),
  }, { cwd: "/tmp", definition: "worker", piSessionId: randomUUID(), piSessionFile: join(PI_AGENT_ROOT, "session.jsonl") });
}

test("completion handoff survives metadata changes and repeated reads without being rewritten", () => {
  const completion = report();
  const path = handoffPath(completion);
  const first = realFs.readFileSync(path, "utf8");
  assert.match(first, /Full report evidence/);
  assert.equal(completion.summary, "A short summary.");
  assert.equal(readCompletion(randomUUID(), completion.requestId), undefined);
  completion.providedAt = Date.now();
  completion.disposition = "park";
  completion.closed = true;
  saveCompletion(completion);
  assert.deepEqual(readCompletion(completion.ownerSessionId, completion.requestId), completion);
  assert.equal(realFs.readFileSync(path, "utf8"), first);
  assert.equal(realFs.statSync(path).mode & 0o777, 0o600);
});

test("manual retirement is durable and leaves the handoff and transcript untouched", () => {
  const completion = report();
  realFs.writeFileSync(completion.piSessionFile!, "saved transcript");
  assert.equal(sessionManuallyRetired(completion.ownerSessionId, completion.piSessionId!), false);
  completion.disposition = "retire";
  completion.closed = true;
  saveCompletion(completion);
  assert.equal(sessionManuallyRetired(completion.ownerSessionId, completion.piSessionId!), true);
  assert.equal(listCompletions(completion.ownerSessionId)[0].requestId, completion.requestId);
  assert.match(realFs.readFileSync(handoffPath(completion), "utf8"), /Full report evidence/);
  assert.equal(realFs.readFileSync(completion.piSessionFile!, "utf8"), "saved transcript");
});

test("wrapup uses the installed lifecycle seam and waits for the matching session's outcome", async () => {
  const { pi } = fakePi();
  const sessionId = randomUUID();
  let requests = 0;
  pi.events.on("magic-context:flush", () => {
    pi.events.emit("magic-context:flush-result", { sessionId, status: "success" });
  });
  pi.events.on("magic-context:wrapup", () => {
    requests++;
    pi.events.emit("magic-context:wrapup-result", { sessionId: randomUUID(), status: "success" });
    pi.events.emit("magic-context:wrapup-result", { sessionId, status: "success" });
  });
  assert.deepEqual(await wrapupContext(pi.events, sessionId), { status: "success" });
  assert.equal(requests, 1);
});

test("missing wrapup provider is reported rather than faked as success", async () => {
  assert.deepEqual(await wrapupContext(fakePi().pi.events, randomUUID()), {
    status: "skipped", reason: "provider-unavailable",
  });
});

test("wrapup refusal preserves its reason; it is not worker failure", async () => {
  const { pi } = fakePi();
  const sessionId = randomUUID();
  pi.events.on("magic-context:flush", () => {
    pi.events.emit("magic-context:flush-result", { sessionId, status: "success" });
  });
  pi.events.on("magic-context:wrapup", () => {
    pi.events.emit("magic-context:wrapup-result", { status: "skipped", reason: "subagent" });
  });
  assert.deepEqual(await wrapupContext(pi.events, sessionId), { status: "skipped", reason: "subagent" });
});

test("preparation cancellation remains unresolved and a later durable reply can be retrieved", async () => {
  const owner = randomUUID();
  const id = randomUUID();
  const controller = new AbortController();
  const pending = waitForPreparation(owner, id, controller.signal);
  controller.abort();
  await assert.rejects(pending, /interrupted/);
  writePreparationResult(owner, id, { status: "success" });
  assert.deepEqual(await waitForPreparation(owner, id), { status: "success" });
});
