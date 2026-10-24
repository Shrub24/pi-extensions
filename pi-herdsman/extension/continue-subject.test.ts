import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import {
  DEFAULT_PI_SESSION_ID, LEAD_SESSION_ID, PI_AGENTS_DIR, PI_AGENT_ROOT, WORKSPACE,
  agentMailboxPath, fakeContext, fakePi, managedState, nativeSessions, radarDaemon,
  realFs, registerExtension, resetAgentMailbox, setLeadEnvironment, startRadarSession,
  testBrief, readAgentState, writeAgentState,
} from "./support.ts";
import { setConfigField } from "./support-config.ts";
import { readControlResult, controlDirectory, writeControlRequest } from "./control.ts";

beforeEach(() => setConfigField("retainWorkers", false));

/** A worker Radar released: its subject exists in the daemon, its mailbox is retired. */
async function releasedWorker(t: { after(fn: () => Promise<void>): void }, recordSubject: boolean, live = false, duplicate = false) {
  setLeadEnvironment();
  if (duplicate) radarDaemon.options.standing = "duplicate";
  const name = `continue-${randomUUID().slice(0, 8)}`;
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  realFs.writeFileSync(join(PI_AGENTS_DIR, `${name}.md`), `---\nname: ${name}\n---\nbody\n`);
  const session = {
    id: DEFAULT_PI_SESSION_ID, path: sessionPath, cwd: "/tmp",
    entries: [{ type: "custom", customType: "pi-herdsman-agent-definition",
      data: { sessionId: DEFAULT_PI_SESSION_ID, definition: name, label: name } }],
  };
  nativeSessions.set(session.id, session);
  radarDaemon.childSession = () => ({ id: session.id, file: sessionPath });
  const entries: unknown[] = [];
  const pi = fakePi({ entries, persistMessages: true });
  registerExtension!(pi.pi as never);
  const ctx = fakeContext(entries);
  await startRadarSession(pi, ctx);
  t.after(async () => {
    for (const handler of pi.events.get("session_shutdown") ?? []) await handler(undefined, ctx);
  });
  const mailbox = agentMailboxPath(WORKSPACE, name);
  const state = managedState(name, undefined, { paneId: "startup-pane", piSessionId: session.id, piSessionFile: sessionPath });
  const launch = await radarDaemon.adoptRetainedChild({
    label: name, runId: state.runId, ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE, mailbox, pane: state.paneId, definition: name,
  });
  // Radar released the child: the pane is closed and its mailbox is gone.
  const released = radarDaemon.spawns.at(-1)!;
  if (!live) {
    released.closed = true;
    resetAgentMailbox(mailbox);
  }
  if (recordSubject) {
    entries.push({ type: "custom", customType: "pi-herdsman-radar-spawn", data: launch });
    entries.push({ type: "custom", customType: "pi-herdsman-radar-spawn-outcome", data: {
      outcome: live ? "ready" : "closed", requestId: launch.requestId, runId: state.runId, mailbox } });
  }
  const completionId = randomUUID();
  if (live) writeAgentState(mailbox, { ...readAgentState(mailbox)!, completedRequestId: completionId });
  entries.push({ type: "custom_message", message: { customType: "pi-herdsman-agent-result", details: {
    piSessionId: session.id, piSessionFile: sessionPath, ownerSessionId: LEAD_SESSION_ID,
    runId: state.runId, requestId: completionId, agentLabel: name, agentDefinition: name, status: "completed",
  } } });
  const tool = pi.tools.find((candidate) => candidate.name === "agent_continue")!;
  return { subject: launch.subjectId, session, ctx, tool, pi, entries, mailbox, state, name };
}

test("agent_continue asks Radar to continue the released child by its subject", async (t) => {
  const worker = await releasedWorker(t, true);
  const before = radarDaemon.spawns.length;
  const result = await worker.tool.execute("call", { session: worker.session.path, task: testBrief("resume") },
    undefined, undefined, worker.ctx);
  assert.ok(radarDaemon.spawns.length > before, JSON.stringify(result.details));
  const launch = radarDaemon.spawns.at(-1)!;
  assert.equal(launch.continues, worker.subject);
  assert.ok(launch.argv.some((arg, index) => arg === "--extension" && launch.argv[index + 1]?.endsWith("/pi-radar/extension/baseline.ts")),
    "the child loads the shared Radar baseline, even when optional extensions are disabled");
});

test("agent_continue refuses a session whose subject this session never recorded", async (t) => {
  const worker = await releasedWorker(t, false);
  const before = radarDaemon.spawns.length;
  const result = await worker.tool.execute("call", { session: worker.session.path, task: testBrief("resume") },
    undefined, undefined, worker.ctx);
  assert.equal(result.details.ok, false);
  assert.match(result.details.error.message, /no Radar subject recorded/);
  assert.equal(radarDaemon.spawns.length, before, "no launch is attempted");
});


test("an idle worker restart uses Radar restart, never close or continue", async (t) => {
  const worker = await releasedWorker(t, true, true);
  const restart = radarDaemon.client.restart;
  let restartedSubject: string | undefined;
  radarDaemon.client.restart = async (request) => {
    restartedSubject = request.subject_id;
    return restart(request);
  };
  try {
    const requestId = randomUUID();
    const request = { version: 1 as const, requestId, operation: "restart" as const,
      agent: worker.name, runId: worker.state.runId,
      confirmation: { operation: "restart" as const, label: worker.name, runId: worker.state.runId },
      requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString(),
      requester: "agent-radar" };
    assert.ok(writeControlRequest(request, LEAD_SESSION_ID).ok);
    await t.waitFor(() => assert.ok(readControlResult(controlDirectory(LEAD_SESSION_ID), requestId)), { timeout: 5000 });
    const result = readControlResult(controlDirectory(LEAD_SESSION_ID), requestId)!;
    assert.equal(result.outcome, "restarted", JSON.stringify(result));
    assert.equal(restartedSubject, worker.subject);
    assert.equal(radarDaemon.closes.size, 0, "no pre-close");
    assert.equal(radarDaemon.spawns.at(-1)!.continues, undefined, "no continuation fallback");
    assert.equal(radarDaemon.spawns.at(-1)!.subject_id, worker.subject, "the subject survives restart");
  } finally { radarDaemon.client.restart = restart; }
});

test("roster refresh batches current children and ignores historical launches", async (t) => {
  const worker = await releasedWorker(t, true, true);
  worker.entries.push({ type: "custom", customType: "pi-herdsman-radar-spawn", data: {
    stage: "bound", requestId: randomUUID(), runId: randomUUID(), subjectId: randomUUID(),
    label: "old", mailbox: "/tmp/old-mailbox", ownerSessionId: LEAD_SESSION_ID, workspaceId: WORKSPACE,
  } });
  const list = radarDaemon.client.subjectChildren;
  let reads = 0;
  radarDaemon.client.subjectChildren = async (request) => { reads++; return list(request); };
  try {
    const tool = worker.pi.tools.find((candidate) => candidate.name === "agent_list")!;
    const result = await tool.execute("list", {}, undefined, undefined, worker.ctx);
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(reads, 1);
  } finally { radarDaemon.client.subjectChildren = list; }
});


test("a duplicate claim is refused before assignment launch preparation", async (t) => {
  const worker = await releasedWorker(t, true, false, true);
  const before = radarDaemon.spawns.length;
  const result = await worker.tool.execute("call", { session: worker.session.path, task: testBrief("resume") },
    undefined, undefined, worker.ctx);
  assert.equal(result.details.ok, false);
  assert.equal(result.details.error.category, "invalid_request");
  assert.match(result.details.error.message, /no managed Radar subject/);
  assert.equal(radarDaemon.spawns.length, before);
});
