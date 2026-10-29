import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { requestRadarRuntime } from "pi-radar/runtime";
import type { RadarMailboxPort } from "pi-radar/communication";
import type { CompletionMessage } from "./radar-handoff.ts";
import {
  LEAD_SESSION_ID, WORKSPACE, agentMailboxPath, fakeContext, fakePi, managedState,
  readAgentState, registerExtension, resetAgentMailbox, setLeadEnvironment,
  startRadarSession, writeAgentState,
} from "./support.ts";
import { readCompletion, saveCompletion } from "./completions.ts";

const content = "---\nschema: handoff/v1\ntitle: Ready\nsummary: Ready for review.\n---\n\n## Outcome\nDone.\n";

async function recipient(t: TestContext) {
  setLeadEnvironment();
  const label = `inbox-${randomUUID().slice(0, 8)}`;
  const state = { ...managedState(label), activeRequestId: undefined, completedRequestId: randomUUID() };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, state);
  const subjectId = randomUUID();
  const message: CompletionMessage = {
    version: 1, id: state.completedRequestId, created_at_unix_ms: 123,
    producer: { registration_id: randomUUID(), session_id: state.piSessionId, subject_id: subjectId, claim_id: randomUUID() },
    recipients: [randomUUID()],
    body: { kind: "handoff", correlation_id: state.runId, summary: "Transport summary", content },
  };
  const entries: any[] = [{ type: "custom", customType: "pi-herdsman-radar-spawn", data: {
    stage: "bound", requestId: randomUUID(), subjectId, runId: state.runId,
    label, ownerSessionId: LEAD_SESSION_ID, workspaceId: WORKSPACE, mailbox,
    paneId: state.paneId, piSessionId: state.piSessionId, agentDefinition: "agent",
  } }];
  const host = fakePi({ entries, persistMessages: true });
  registerExtension!(host.pi as never);
  const request = requestRadarRuntime(host.pi.events);
  assert.equal(request.ok, true);
  if (!request.ok) throw new Error("No fixture runtime");
  const services = await request.handle.start();
  let hint: Parameters<typeof services.publication.facts.onAttention>[0] | undefined;
  let subscriptions = 0;
  t.mock.method(services.publication.facts, "onAttention", (listener) => {
    hint = listener;
    subscriptions++;
    return () => { subscriptions--; };
  });
  const ctx = fakeContext(entries);
  t.after(async () => {
    await host.events.get("session_shutdown")?.[0](undefined, ctx);
    resetAgentMailbox(mailbox);
  });
  return {
    state, mailbox, message, entries, host, services, ctx,
    start: () => startRadarSession(host, ctx),
    hint: () => hint?.({ revision: randomUUID(), pending: 1 }),
    subscriptions: () => subscriptions,
  };
}

test("startup captures before receipt without prompting; lost receipt redelivery preserves disposition", async (t) => {
  const r = await recipient(t);
  let attempts = 0;
  let pending = true;
  let durableAtReceipt = false;
  const port: RadarMailboxPort = {
    publish: async () => ({ ok: false, code: "refused", message: "recipient only" }),
    page: async () => ({ ok: true, value: { message_ids: pending ? [r.message.id] : [], next: null } }),
    get: async () => ({ ok: true, value: { message: r.message, receipt: null } }),
    receive: async () => {
      attempts++;
      durableAtReceipt = readCompletion(LEAD_SESSION_ID, r.message.id)?.summary === "Ready for review.";
      if (attempts === 1) return { ok: false, code: "transport", message: "receipt reply lost" };
      pending = false;
      return { ok: true, value: { created: false, receipt: {
        version: 1, message_id: r.message.id, recipient: r.message.producer, received_at_unix_ms: 456,
      } } };
    },
  };
  r.services.communication = port;
  await r.start();
  await t.waitFor(() => assert.equal(attempts, 1));
  assert.equal(durableAtReceipt, true);
  const captured = readCompletion(LEAD_SESSION_ID, r.message.id)!;
  saveCompletion({ ...captured, disposition: "keep", providedAt: 789 });
  // Identity evidence may disappear after capture. Identical redelivery is
  // reconciled by the completion store, not by recreating the old mailbox.
  resetAgentMailbox(r.mailbox);
  r.hint();
  await t.waitFor(() => assert.equal(attempts, 2));
  assert.deepEqual(readCompletion(LEAD_SESSION_ID, r.message.id), { ...captured, disposition: "keep", providedAt: 789 });
  assert.equal(r.entries.filter((entry) => entry.customType === "pi-herdsman-radar-message-rejected").length, 0);
  assert.equal(r.host.sent.filter((entry: any) => entry.customType === "pi-herdsman-agent-result").length, 0);
  assert.equal(r.subscriptions(), 1);
  await r.host.events.get("session_shutdown")?.[0](undefined, r.ctx);
  assert.equal(r.subscriptions(), 0);
});

test("turn, tool and questionnaire transitions publish owned status, not Pi's idle flag", async (t) => {
  const r = await recipient(t);
  let status: string | undefined;
  t.mock.method(r.ctx.ui, "setStatus", (key: string, text: string | undefined) => {
    if (key === "pi-herdsman") status = text;
  });
  t.mock.method(r.ctx, "isIdle", () => true);
  await r.start();
  const dispatch = async (name: string, event: unknown = {}) => {
    for (const handler of r.host.events.get(name) ?? []) await handler(event, r.ctx);
  };
  await dispatch("agent_start");
  assert.equal(status, "\u{F04E6}");
  await dispatch("tool_execution_start", { toolCallId: "tool-1", toolName: "bash" });
  assert.equal(status, "\u{F051F}");
  await dispatch("tool_execution_end", { toolCallId: "tool-1", toolName: "bash" });
  assert.equal(status, "\u{F04E6}");
  r.host.pi.events.emit("rpiv:ask-user:blocked", { active: true });
  assert.equal(status, "\u{F02D7}");
  await dispatch("agent_end", { messages: [] });
  r.host.pi.events.emit("rpiv:ask-user:blocked", { active: false });
  assert.equal(status, "\u{F04B2}");
});

test("a proven mailbox replacement is rejected rather than blocking later work", async (t) => {
  const r = await recipient(t);
  writeAgentState(r.mailbox, { ...r.state, runId: randomUUID() });
  let received = false;
  r.services.communication = {
    publish: async () => ({ ok: false, code: "refused", message: "recipient only" }),
    page: async () => ({ ok: true, value: { message_ids: received ? [] : [r.message.id], next: null } }),
    get: async () => ({ ok: true, value: { message: r.message, receipt: null } }),
    receive: async () => {
      received = true;
      return { ok: true, value: { created: true, receipt: {
        version: 1, message_id: r.message.id, recipient: r.message.producer, received_at_unix_ms: 456,
      } } };
    },
  };
  await r.start();
  await t.waitFor(() => assert.equal(received, true));
  assert.equal(readCompletion(LEAD_SESSION_ID, r.message.id), undefined);
  const rejected = r.entries.find((entry) => entry.customType === "pi-herdsman-radar-message-rejected");
  assert.match(rejected?.data.reason, /different assignment/);
});

test("permanent rejection is recorded; missing identity remains pending until recoverable", async (t) => {
  const r = await recipient(t);
  const wrong: CompletionMessage = { ...r.message, id: randomUUID(), producer: { ...r.message.producer, subject_id: randomUUID() } };
  const pending = [wrong.id, r.message.id];
  const received: string[] = [];
  r.services.communication = {
    publish: async () => ({ ok: false, code: "refused", message: "recipient only" }),
    page: async () => ({ ok: true, value: { message_ids: [...pending], next: null } }),
    get: async (id) => ({ ok: true, value: { message: id === wrong.id ? wrong : r.message, receipt: null } }),
    receive: async (id) => {
      received.push(id);
      pending.splice(pending.indexOf(id), 1);
      return { ok: true, value: { created: true, receipt: {
        version: 1, message_id: id, recipient: r.message.producer, received_at_unix_ms: 456,
      } } };
    },
  };
  resetAgentMailbox(r.mailbox);
  await r.start();
  await t.waitFor(() => assert.ok(received.includes(wrong.id)));
  assert.deepEqual(received, [wrong.id]);
  assert.equal(readCompletion(LEAD_SESSION_ID, wrong.id), undefined);
  const rejections = r.entries.filter((entry) => entry.customType === "pi-herdsman-radar-message-rejected");
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].data.messageId, wrong.id);
  assert.equal(readAgentState(r.mailbox), undefined);
  writeAgentState(r.mailbox, r.state);
  r.hint();
  await t.waitFor(() => assert.ok(received.includes(r.message.id)));
  assert.equal(readCompletion(LEAD_SESSION_ID, r.message.id)?.summary, "Ready for review.");
});
