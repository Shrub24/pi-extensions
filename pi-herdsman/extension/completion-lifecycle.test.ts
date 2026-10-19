import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import {
  LEAD_SESSION_ID, PI_AGENT_ROOT, WORKSPACE, agentMailboxPath,
  fakeContext, fakePi, managedState, nativeSessions, radarDaemon,
  readAgentState, realFs, registerExtension, setLeadEnvironment,
  startRadarSession, writeAgentState,
} from "./support.ts";
import { persistCompletion, readCompletion, saveCompletion, writePreparationResult } from "./completions.ts";
import { updateConfig } from "./config.ts";

async function worker(t: any) {
  setLeadEnvironment();
  const id = randomUUID();
  const path = join(PI_AGENT_ROOT, `${id}.jsonl`);
  realFs.writeFileSync(path, "{}");
  nativeSessions.set(id, { id, path, cwd: "/tmp", entries: [{
    type: "custom", customType: "pi-herdsman-agent-definition",
    data: { sessionId: id, definition: "agent", label: "completion-worker" },
  }] });
  const entries: unknown[] = [];
  const fixture = fakePi({ entries, persistMessages: true });
  registerExtension!(fixture.pi as never);
  const ctx = fakeContext(entries);
  await startRadarSession(fixture, ctx);
  t.after(async () => {
    for (const handler of fixture.events.get("session_shutdown") ?? []) await handler(undefined, ctx);
  });
  const state = {
    ...managedState("completion-worker", undefined, { paneId: "startup-pane", piSessionId: id, piSessionFile: path }),
    completedRequestId: randomUUID(),
  };
  const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
  radarDaemon.childSession = () => ({ id, file: path });
  const launch = await radarDaemon.adoptRetainedChild({
    label: state.agentLabel, runId: state.runId, ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE, mailbox, pane: state.paneId,
  });
  entries.push({ type: "custom", customType: "pi-herdsman-radar-spawn", data: launch });
  writeAgentState(mailbox, { ...state, startupAck: readAgentState(mailbox)?.startupAck });
  const completion = persistCompletion({
    version: 5, runId: state.runId, requestId: state.completedRequestId,
    ownerSessionId: state.ownerSessionId, workspaceId: WORKSPACE,
    agentLabel: state.agentLabel, paneId: state.paneId,
    status: "completed", text: "Ready for review.\n\nPRIVATE FULL HANDOFF", completedAt: Date.now(),
  }, { cwd: state.cwd, definition: "agent", piSessionId: id, piSessionFile: path });
  const execute = async (name: string, args: unknown) =>
    (await fixture.tools.find((tool) => tool.name === `agent_${name}`)!.execute("call", args, undefined, undefined, ctx)).details;
  const complete = (disposition?: string) => execute("complete", {
    completion_id: completion.requestId, ...(disposition ? { disposition } : {}),
  });
  const preparation = (outcome: any = { status: "success" }) => {
    const saved = readCompletion(LEAD_SESSION_ID, completion.requestId)!;
    saved.preparationId = randomUUID();
    saveCompletion(saved);
    writePreparationResult(LEAD_SESSION_ID, saved.preparationId, outcome);
  };
  return { fixture, ctx, state, mailbox, completion, execute, complete, preparation };
}

test("agent_complete defaults to park, returns a path, and repeats without repeating close or wrapup", async (t) => {
  const w = await worker(t);
  w.preparation();
  const first = await w.complete();
  assert.equal(first.disposition, "park");
  assert.equal(first.closed, true);
  assert.equal(first.wrapup.status, "success");
  assert.match(realFs.readFileSync(first.handoff_path, "utf8"), /PRIVATE FULL HANDOFF/);
  assert.equal(readAgentState(w.mailbox), undefined);
  const again = await w.complete();
  assert.equal(again.repeated, true);
  assert.equal(again.handoff_path, first.handoff_path);
  assert.equal((await w.complete("keep")).error.category, "invalid_request");
  const roster = await w.execute("list", {});
  assert.ok(roster.saved_sessions.some((row: any) => row.pi_session_id === w.state.piSessionId));
  assert.ok(realFs.existsSync(w.state.piSessionFile));
});

test("keep leaves the generation live; changing to park closes that same completed assignment", async (t) => {
  const w = await worker(t);
  const kept = await w.complete("keep");
  assert.equal(kept.disposition, "keep");
  assert.ok(readAgentState(w.mailbox));
  assert.equal((await w.complete("keep")).repeated, true);
  w.preparation();
  const parked = await w.complete();
  assert.equal(parked.disposition, "park");
  assert.match(parked.notice, /Previously keep/);
  assert.equal(readAgentState(w.mailbox), undefined);
});

test("a historical completion cannot park or retire a worker that accepted newer work", async (t) => {
  const w = await worker(t);
  await w.complete("keep");
  const newer = randomUUID();
  writeAgentState(w.mailbox, { ...managedState(w.state.agentLabel, newer, {
    paneId: w.state.paneId, piSessionId: w.state.piSessionId, piSessionFile: w.state.piSessionFile,
  }), startupAck: readAgentState(w.mailbox)?.startupAck });
  assert.equal((await w.complete()).error.category, "agent_busy");
  assert.equal((await w.complete("retire")).error.category, "agent_busy");
  assert.equal(readAgentState(w.mailbox)?.activeRequestId, newer);
  assert.equal((await w.complete("keep")).repeated, true);
});

test("park can become retire without another close, retirement is final, and the report remains", async (t) => {
  const w = await worker(t);
  w.preparation();
  const parked = await w.complete();
  const retired = await w.complete("retire");
  assert.equal(retired.disposition, "retire");
  assert.equal((await w.complete("retire")).repeated, true);
  assert.equal((await w.complete()).error.category, "invalid_request");
  assert.equal((await w.execute("list", {})).saved_sessions.length, 0);
  const resumed = await w.execute("continue", { session: w.state.piSessionId, task: "unused" });
  assert.equal(resumed.error.category, "invalid_request");
  assert.match(resumed.error.message, /explicitly retired/);
  assert.ok(realFs.existsSync(parked.handoff_path));
  assert.ok(realFs.existsSync(w.state.piSessionFile));
});

test("failed wrapup leaves the worker live and the completion retryable", async (t) => {
  const w = await worker(t);
  w.preparation({ status: "failed", reason: "historian error" });
  const failed = await w.complete();
  assert.equal(failed.action_outcome, "unresolved");
  assert.equal(failed.disposition, null);
  assert.equal(failed.closed, false);
  assert.equal(failed.wrapup.status, "failed");
  assert.ok(readAgentState(w.mailbox));
  assert.ok(realFs.existsSync(failed.handoff_path));

  const retryState = readCompletion(LEAD_SESSION_ID, w.completion.requestId)!;
  retryState.wrapup = undefined;
  retryState.preparationId = undefined;
  saveCompletion(retryState);
  w.preparation({ status: "success" });
  const retried = await w.complete();
  assert.equal(retried.disposition, "park");
  assert.equal(retried.closed, true);
  assert.equal(retried.wrapup.status, "success");
});

test("another ongoing wrapup keeps the worker live and the completion retryable", async (t) => {
  const w = await worker(t);
  w.preparation({ status: "skipped", reason: "wrapup-in-progress" });
  const result = await w.complete();
  assert.equal(result.action_outcome, "unresolved");
  assert.equal(result.closed, false);
  assert.ok(readAgentState(w.mailbox));
  assert.ok(realFs.existsSync(result.handoff_path));
  w.preparation();
  assert.equal((await w.complete()).disposition, "park");
});

test("completion previews disclose neither the handoff path nor full report; roster cap does not retire sessions", async (t) => {
  const w = await worker(t);
  const before = await w.execute("list", {});
  assert.equal(before.completions[0].summary, "Ready for review.");
  assert.doesNotMatch(JSON.stringify(before), /PRIVATE FULL HANDOFF|handoff\.md/);
  w.preparation();
  await w.complete();
  updateConfig("savedSessionLimit", 0);
  assert.equal((await w.execute("list", {})).saved_sessions.length, 0);
  updateConfig("savedSessionLimit", 10);
  assert.ok((await w.execute("list", {})).saved_sessions.some((row: any) => row.pi_session_id === w.state.piSessionId));
});
