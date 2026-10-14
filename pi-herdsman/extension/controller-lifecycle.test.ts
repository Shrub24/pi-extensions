import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRadarClient } from "pi-radar/client";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { beforeEach, mock, test } from "node:test";
import { Value } from "typebox/value";
import type {
  AskRecord,
  RequestAddress,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import { RADAR_SUBJECT_SOURCE } from "pi-radar/execution";
import {
  FIXTURE_LEAD_PANE,
  FIXTURE_TMUX_SERVER,
  type FakeRadarDaemon,
} from "./support-radar.ts";
import { claimProcessLock } from "./lock.ts";
import support from "./support.ts";
import { DELEGATION_BRIEF_EXAMPLES, briefFormatHint } from "./briefs.ts";
import {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  MAILBOX_PROTOCOL_LIMIT_BYTES,
  PARENT_SESSION_ID,
  PI_AGENTS_DIR,
  PI_AGENT_ROOT,
  REQUEST_ID,
  LEAD_SESSION_ID,
  AGENT_ID,
  WORKSPACE,
  consumeMailboxRequest,
  ensureRadarDaemon,
  delegationLockPathForTest,
  assignmentLockPathForTest,
  fakeContext,
  fakePi,
  fakeAgentContext,
  listResponse,
  managedState,
  nativeSessions,
  promptLaunchContents,
  promptLaunchPaths,
  readRequest,
  readResult,
  readAgentState,
  realFs,
  recoveryIdentity,
  registerExtension,
  requestRecordBytes,
  resetAgentMailbox,
  resultEntryDetails,
  setLeadEnvironment,
  setAgentEnvironment,
  radarDaemon,
  radarObservedFleet,
  spawnedArgvs,
  spawnedEnvironmentAssignments,
  spawnedLabels,
  startRadarSession,
  testBrief,
  testChildCommand,
  watchedResultPaths,
  agentMailboxPath,
  writePromptDefinition,
  writeRequest,
  writeResult,
  writeAgentState,
  testTmpRoot,
} from "./support.ts";
const ownedSessionContext = (
  id: string,
  label: string,
  recordedSessionPath?: string,
) =>
  fakeContext([
    {
      type: "custom_message",
      message: {
        customType: "pi-herdsman-agent-result",
        details: {
          piSessionId: id,
          piSessionFile: recordedSessionPath ?? nativeSessions.get(id)?.path,
          ownerSessionId: LEAD_SESSION_ID,
          runId: randomUUID(),
          requestId: randomUUID(),
          agentLabel: label,
          agentDefinition:
            (
              nativeSessions
                .get(id)
                ?.entries?.find(
                  (entry: any) =>
                    entry?.customType === "pi-herdsman-agent-definition",
                ) as any
            )?.data?.definition ?? "agent",
          status: "completed",
        },
      },
    },
  ]);


function writePlacementSetting(placement: "tab" | "subtree" | "split") {
  realFs.mkdirSync(join(PI_AGENT_ROOT, "pi-herdsman"), { recursive: true });
  realFs.writeFileSync(
    join(PI_AGENT_ROOT, "pi-herdsman", "config.json"),
    JSON.stringify({ spawnPlacement: placement }),
  );
}

function registerNativeAgentSession(state: ManagedAgentState): void {
  nativeSessions.set(state.piSessionId, {
    id: state.piSessionId,
    path: state.piSessionFile!,
    cwd: state.cwd,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: state.piSessionId,
          definition: "agent",
          label: state.agentLabel,
        },
      },
    ],
  });
}


// These lifecycle tests predate typed briefs; keep their task labels as body text.
const registeredAgentTool = (
  pi: ReturnType<typeof fakePi>,
  operation: string,
) => {
  const tool = pi.tools.find(
    (candidate) => candidate.name === `agent_${operation}`,
  )!;
  if (operation !== "delegate" && operation !== "continue") return tool;
  return {
    ...tool,
    execute: (...args: any[]) => {
      const params = args[1];
      if (
        params &&
        typeof params === "object" &&
        typeof params.task === "string" &&
        params.task.trim() &&
        !params.task.trimStart().startsWith("---")
      ) {
        args[1] = { ...params, task: testBrief(params.task) };
      }
      return tool.execute(...args);
    },
  };
};
const { updateConfig } = await import("./config.ts");
// These suites cover the one-shot lifecycle; retained workers are the default,
// and the tests that exercise retention opt in or out explicitly.
beforeEach(() => updateConfig("retainWorkers", false));
const { agentLaunchFingerprint, resolveAgentLaunchInputs } =
  await import("./agent-definitions.ts");


test("a Radar-launched child is proved live and its pane closed through its own launch", async (t) => {
  setLeadEnvironment();
  const label = "close-child";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const runId = randomUUID();
  // The launch takes its owner session from the session that asks for it, which
  // is also what makes the child visible to that controller's list.
  const ownerSessionId = LEAD_SESSION_ID;
  const generation = randomUUID();
  const requestId = randomUUID();
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  // The context reads the session the launch writes its durable record to, which
  // is the only place a Radar child's edge can be resolved from.
  const context = fakeContext(pi.entries);
  try {
    await startRadarSession(pi, context);
    // A launch this process did not perform, at the point where it has an edge,
    // a child that wrote its own binding, and the record the launch persists
    // before it dials the daemon.
    const client = createRadarClient({ env: process.env });
    const spawned = await client.spawn({
      request_id: requestId,
      generation,
      parent: randomUUID(),
      parent_session_id: LEAD_SESSION_ID,
      executable: "/usr/bin/pi",
      argv: [],
      cwd: "/tmp",
      env: {
        PI_HERDSMAN_LAUNCH_GENERATION: generation,
        PI_HERDSMAN_MAILBOX: mailbox,
        PI_HERDSMAN_RUN_ID: runId,
        PI_HERDSMAN_OWNER_SESSION_ID: ownerSessionId,
        PI_HERDSMAN_WORKSPACE_ID: WORKSPACE,
        PI_HERDSMAN_LABEL: label,
        PI_HERDSMAN_AGENT_DEFINITION: "agent",
      },
    });
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    if (!spawned.ok) return;
    const paneId = spawned.value.location?.pane;
    assert.ok(paneId, JSON.stringify(spawned.value));
    // The launch reads its edge back until the child has bound to it, which is
    // the agent identity the durable record carries.
    let agentId: string | undefined;
    await t.waitFor(async () => {
      const edge = await client.spawnGet(requestId);
      assert.equal(edge.ok, true, JSON.stringify(edge));
      if (edge.ok) agentId = edge.value.edge.bound?.agent_id;
      assert.ok(agentId, "the child never bound to its launch");
    });
    pi.entries.push({
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: {
        stage: "bound",
        requestId,
        generation,
        runId,
        label,
        ownerSessionId,
        workspaceId: WORKSPACE,
        mailbox,
        agentId,
        paneId,
      },
    });

    // The daemon's own current read of that edge is what makes this child live:
    // nothing here reads a mux record the child never had.
    const listed = await registeredAgentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    const row = (listed.details.agents as any[]).find(
      (entry: any) => entry.agent === label,
    );
    assert.ok(row, JSON.stringify(listed.details));
    assert.notEqual(row.state, "unknown");
    // The listing shows the mailbox's raw pane; Radar targets the full handle.
    assert.equal(row.pane_id, paneId.slice(paneId.lastIndexOf(":") + 1));

    const closed = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    // Pane closure is the whole effect: one durable close request, one pane
    // effect, the mailbox retired, and the edge left exactly as it stood.
    assert.equal(readAgentState(mailbox), undefined);
    assert.equal(radarDaemon.closes.size, 1);
    assert.equal([...radarDaemon.closes.values()][0]!.outcome, "completed");
    assert.equal(radarDaemon.spawns[0]!.closed, true);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    // The daemon's simulated child is held until its own reset, which the next
    // test's fixture would otherwise perform on this test's account.
    radarDaemon.reset();
    resetAgentMailbox(mailbox);
  }
});

test("a retained pane the daemon cleaned up is a confirmed cleanup, not a process exit", async (t) => {
  setLeadEnvironment();
  const label = "exited-child";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const runId = randomUUID();
  const ownerSessionId = LEAD_SESSION_ID;
  const generation = randomUUID();
  const requestId = randomUUID();
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  try {
    await startRadarSession(pi, context);
    const client = createRadarClient({ env: process.env });
    const spawned = await client.spawn({
      request_id: requestId,
      generation,
      parent: randomUUID(),
      parent_session_id: LEAD_SESSION_ID,
      executable: "/usr/bin/pi",
      argv: [],
      cwd: "/tmp",
      env: {
        PI_HERDSMAN_LAUNCH_GENERATION: generation,
        PI_HERDSMAN_MAILBOX: mailbox,
        PI_HERDSMAN_RUN_ID: runId,
        PI_HERDSMAN_OWNER_SESSION_ID: ownerSessionId,
        PI_HERDSMAN_WORKSPACE_ID: WORKSPACE,
        PI_HERDSMAN_LABEL: label,
        PI_HERDSMAN_AGENT_DEFINITION: "agent",
      },
    });
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    if (!spawned.ok) return;
    const paneId = spawned.value.location?.pane;
    assert.ok(paneId, JSON.stringify(spawned.value));
    let agentId: string | undefined;
    await t.waitFor(async () => {
      const edge = await client.spawnGet(requestId);
      if (edge.ok) agentId = edge.value.edge.bound?.agent_id;
      assert.ok(agentId, "the child never bound to its launch");
    });
    pi.entries.push({
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: {
        stage: "bound",
        requestId,
        generation,
        runId,
        label,
        ownerSessionId,
        workspaceId: WORKSPACE,
        mailbox,
        agentId,
        paneId,
      },
    });
    // The edge records the pane command's exit before this close, which is what
    // makes the daemon clean up the retained pane rather than a live occupant.
    // This fixture's own exec answers no mux read at all, so the listing and the
    // close below both prove the ordinary path: a Radar child's provenance comes
    // from its launch record, not from a mux inventory that has to be consulted.
    const listed = await registeredAgentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    const row = (listed.details.agents as any[]).find(
      (entry: any) => entry.agent === label,
    );
    assert.ok(row, JSON.stringify(listed.details));
    assert.notEqual(row.state, "unknown", JSON.stringify(row));
    // The pane command exits as the close is served - the read that proved the
    // child and the close that removes its pane are separate instants - so the
    // daemon cleans up the retained pane and answers with the exit it holds.
    radarDaemon.options.closeOutcome = "already_exited";
    // The daemon's half succeeds and this process's own mailbox removal is the
    // half that fails, which is the state a later attempt has to be able to
    // finish. The mailbox holds one unrelated artifact for that removal to hit.
    writeRequest(mailbox, {
      version: 5,
      runId,
      requestId: REQUEST_ID,
      ownerSessionId,
      workspaceId: WORKSPACE,
      agentLabel: label,
      // The mailbox identity holds the raw pane, as the child's own state does.
      paneId: paneId.slice(paneId.lastIndexOf(":") + 1),
      kind: "task",
      text: "unrelated cleanup artifact",
      createdAt: Date.now(),
    });
    // The child must leave the artifact unaccepted: an accepted task would be a
    // durable result, which correctly blocks close before any removal runs.
    radarDaemon.options.acceptAssignments = false;
    support.failNextRequestRemoval = true;

    const closed = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.match(
      String(closed.details.cleanup_error),
      /injected request removal failure/,
    );
    // The pane is cleaned up and the mailbox is not, which is exactly what the
    // confirmed record has to carry forward.
    assert.equal(radarDaemon.closes.size, 1);
    assert.equal([...radarDaemon.closes.values()][0]!.outcome, "already_exited");
    assert.equal(radarDaemon.spawns[0]!.closed, true);
    assert.ok(readAgentState(mailbox));
    // The record keeps the daemon's own word and the exit the edge held: this is
    // a pane fact, so nothing here reads it as the registered process exiting or
    // as permission to launch a replacement in that pane.
    const record = pi.entries
      .filter(
        (entry: any) =>
          entry?.customType === "pi-herdsman-radar-close" &&
          (entry.data as any)?.mailbox === mailbox,
      )
      .pop() as any;
    assert.equal(record.data.stage, "already_exited");
    assert.equal(record.data.exitObservation.state, "exited");
    // Nothing was relaunched in the cleaned-up pane: the close is the only
    // launch-side effect, and the cleaned-up child never became a replacement.
    assert.equal(radarDaemon.spawns.length, 1);

    // The pane is gone from the mux now, so the retry cannot prove the child's
    // presence at all: what admits it is the close this process already holds.
    radarDaemon.options.locationEvidence = "absent";
    const retried = await registeredAgentTool(pi, "close").execute(
      "retry",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(retried.details.ok, true, JSON.stringify(retried.details));
    assert.equal(readAgentState(mailbox), undefined);
    // No second close: the pane was already cleaned up, so the retry replayed
    // nothing and finished only the local work.
    assert.equal(radarDaemon.closes.size, 1);
    assert.equal(radarDaemon.spawns.length, 1);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
    resetAgentMailbox(mailbox);
  }
});

test("an unreadable mux inventory leaves a child unproved instead of absent", async () => {
  setLeadEnvironment();
  const label = "unreadable-inventory-child";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const state = {
    ...managedState(label),
    ownerSessionId: LEAD_SESSION_ID,
  };
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
  // The daemon's own observation cannot be read: the inventory is not empty, it
  // is unavailable, and the two must not be confused.
  radarDaemon.options.observeUnavailable = true;
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  try {
    await startRadarSession(pi, context);
    const listed = await registeredAgentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    const row = (listed.details.agents as any[]).find(
      (entry: any) => entry.agent === label,
    );
    assert.ok(row, JSON.stringify(listed.details));
    // Nothing was read, so nothing is claimed: the child is unproved rather than
    // reported gone, which is what a close would otherwise be allowed to act on.
    assert.equal(row.state, "unknown");
    const refused = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(refused.details.ok, false, JSON.stringify(refused.details));
    assert.equal(refused.details.error.category, "target_ambiguous");
    assert.equal(readAgentState(mailbox) !== undefined, true);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("a fresh launch refuses when no daemon answers for this process", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "absent-daemon-pane";
  const label = "absent-daemon-child";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  // A socket that is not there: no backend is substituted for it, and the launch
  // has nothing to place a worker beside.
  process.env.RADAR_CONTROL_SOCKET = join(testTmpRoot, "absent-radar.sock");
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  try {
    const refused = await registeredAgentTool(pi, "delegate").execute(
      "absent-daemon",
      { definition: "agent", label, task: "no daemon answers" },
      undefined,
      undefined,
      context,
    );
    assert.equal(refused.details.ok, false, JSON.stringify(refused.details));
    assert.equal(refused.details.error.category, "invalid_request");
    assert.equal(readAgentState(mailbox), undefined);
    assert.equal(radarDaemon.spawns.length, 0);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
    resetAgentMailbox(mailbox);
  }
});

test("a fresh launch refuses when the daemon does not serve the spawn contract", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "no-spawn-contract-pane";
  const label = "no-spawn-contract-child";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  process.env.RADAR_CONTROL_SOCKET = radarDaemon.socketPath;
  // A daemon that answers, but is not a build that serves managed spawn: the
  // client refuses locally before dialing, so nothing is created for it either.
  radarDaemon.options.contracts = ["registry.v1"];
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  try {
    const refused = await registeredAgentTool(pi, "delegate").execute(
      "no-spawn-contract",
      { definition: "agent", label, task: "no spawn contract" },
      undefined,
      undefined,
      context,
    );
    assert.equal(refused.details.ok, false, JSON.stringify(refused.details));
    assert.equal(readAgentState(mailbox), undefined);
    assert.equal(radarDaemon.spawns.length, 0);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
    resetAgentMailbox(mailbox);
  }
});

test("fixture mailbox consumer retries a failed acknowledgement callback", async (t) => {
  const mailbox = setAgentEnvironment("fixture-retry-agent");
  const state = managedState("fixture-retry-agent");
  writeAgentState(mailbox, state);
  const request: RequestRecord = {
    version: 5,
    runId: state.runId,
    requestId: randomUUID(),
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text: "retry fixture acknowledgement",
    createdAt: Date.now(),
  };
  let attempts = 0;
  const stop = consumeMailboxRequest(mailbox, (observed) => {
    attempts++;
    if (attempts === 1) throw new Error("injected fixture callback failure");
    const current = readAgentState(mailbox)!;
    writeAgentState(mailbox, {
      ...current,
      activeRequestId: observed.requestId,
      lastAck: {
        requestId: observed.requestId,
        accepted: true,
        acknowledgedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
  });
  try {
    writeRequest(mailbox, request);
    await t.waitFor(() =>
      assert.equal(
        readAgentState(mailbox)?.lastAck?.requestId,
        request.requestId,
        "fixture mailbox consumer did not retry acknowledgement",
      ),
    );
    assert.equal(attempts, 2);
  } finally {
    stop();
    resetAgentMailbox(mailbox);
  }
});

test("fresh path sessions remain controllable after controller cache loss", async (t) => {
  setLeadEnvironment();
  // The daemon observes the fleet this session's own mailboxes model.
  radarDaemon.observeInventory = radarObservedFleet;
  const label = "agent";
  const sessionPath = join(testTmpRoot, "registered-agent.jsonl");
  realFs.rmSync(sessionPath, { force: true });
  realFs.writeFileSync(
    sessionPath,
    JSON.stringify({ type: "session", id: DEFAULT_PI_SESSION_ID }),
    "utf8",
  );
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pathSession = (result: { stdout: string; [key: string]: unknown }) => {
    const payload = JSON.parse(result.stdout);
    const agents = [payload.result?.agent, ...(payload.result?.agents ?? [])];
    for (const agent of agents)
      if (agent?.agent_session)
        agent.agent_session = {
          source: "herdr:pi",
          agent: "pi",
          kind: "path",
          value: sessionPath,
        };
    return { ...result, stdout: JSON.stringify(payload) };
  };
  const pi = fakePi({
    exec: async (command, args, options) => {
      const result = await startup.exec(command, args, options);
      return command === "herdr" && args[0] === "agent"
        ? pathSession(result)
        : result;
    },
  });
  registerExtension!(pi.pi as never);
  // The context reads the session this extension writes: a durable Radar launch
  // record reaches recovery only through those entries.
  const context = fakeContext(pi.entries);
  for (const handler of pi.events.get("session_start") ?? [])
    await handler(undefined, context);
  try {
    const delegated = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "fresh path" },
      undefined,
      undefined,
      context,
    );
    assert.equal(delegated.details.ok, true, JSON.stringify(delegated.details));
    assert.equal(delegated.details.action, "delegate");
    assert.equal(
      pi.calls.some(
        (args) =>
          args[0] === "agent" && args[1] === "start" && args.includes("--fork"),
      ),
      false,
    );
    // The daemon's child accepts the submitted assignment on its own poll, so
    // the acknowledgment is waited for rather than read as already landed.
    await t.waitFor(() =>
      assert.equal(
        readAgentState(startupMailbox)?.lastAck?.accepted,
        true,
        "the child never accepted its assignment",
      ),
    );
    assert.equal(readAgentState(startupMailbox)?.agentDefinition, "agent");
    realFs.rmSync(sessionPath, { force: true });
    assert.equal(realFs.existsSync(sessionPath), false);

    support.sessionOpenError = new Error("child session is not materialized");
    for (const handler of pi.events.get("session_shutdown") ?? [])
      await handler(undefined, context);
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const recovered = readAgentState(startupMailbox)!;
    assert.ok(recovered.activeRequestId);
    assert.ok(
      watchedResultPaths.has(
        `${startupMailbox}/result-${recovered.activeRequestId}.json`,
      ),
    );
    const listed = await pi.tools
      .find((tool) => tool.name === "agent_list")!
      .execute("list", {}, undefined, undefined, context);
    assert.equal(
      listed.details.agents[0]?.agent,
      label,
      JSON.stringify(listed.details),
    );

    const inspected = await registeredAgentTool(pi, "inspect").execute(
      "inspect",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(inspected.details.ok, true, JSON.stringify(inspected.details));

    const closed = await registeredAgentTool(pi, "close").execute(
      "close",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.equal(readAgentState(startupMailbox), undefined);
    assert.equal(realFs.existsSync(startupMailbox), false);
    // The close acted on this launch's own edge: the daemon refuses one whose
    // binding or pane evidence disagrees, so a completed close over the
    // recovered pane is the Radar proof that the restored runtime still holds
    // the exact child this session started rather than a pane beside it.
    const closes = [...radarDaemon.closes.values()];
    assert.equal(closes.length, 1);
    assert.equal(closes[0]!.outcome, "completed");
    // The daemon closes by its full handle; the recovered runtime holds the raw
    // pane of that same handle.
    assert.ok(
      closes[0]!.pane.endsWith(`:${recovered.paneId}`),
      `${closes[0]!.pane} must address pane ${recovered.paneId}`,
    );
  } finally {
    support.sessionOpenError = undefined;
    // Every handler, not just the launch one: the controller is what this test
    // restarted mid-run, and a failed assertion before that leaves it unstopped.
    for (const handler of pi.events.get("session_shutdown") ?? [])
      await handler(undefined, context);
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("lead herd runs start once and stay open through intermediate settlement", async () => {
  setLeadEnvironment();
  // The daemon observes the fleet this session's own mailboxes model.
  radarDaemon.observeInventory = radarObservedFleet;
  const label = "agent";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({});
  const context = fakeContext(pi.entries);
  const herdEntries = () =>
    pi.entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-herd-run",
    ) as any[];
  const emit = async (name: string) => {
    for (const handler of pi.events.get(name) ?? [])
      await handler(undefined, context);
  };
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await emit("agent_start");
    const first = await registeredAgentTool(pi, "delegate").execute(
      "first-delegate",
      { definition: "agent", label, task: "first task" },
      undefined,
      undefined,
      context,
    );
    assert.equal(first.details.ok, true, JSON.stringify(first.details));
    const started = herdEntries().filter(
      (entry) => entry.data?.phase === "started",
    );
    assert.equal(started.length, 1);
    assert.equal(started[0].data.sessionId, LEAD_SESSION_ID);
    assert.equal(Number.isFinite(started[0].data.startedAt), true);

    await emit("agent_settled");
    assert.equal(
      herdEntries().filter((entry) => entry.data?.phase === "finished").length,
      0,
    );
    resetAgentMailbox(startupMailbox);
    await emit("agent_start");
    const second = await registeredAgentTool(pi, "delegate").execute(
      "second-delegate",
      { definition: "agent", label, task: "second task" },
      undefined,
      undefined,
      context,
    );
    assert.equal(second.details.ok, true, JSON.stringify(second.details));
    assert.equal(
      herdEntries().filter((entry) => entry.data?.phase === "started").length,
      1,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
  }

  const invalidPi = fakePi();
  registerExtension!(invalidPi.pi as never);
  for (const invalidLabel of [
    "Ainvalid",
    "invalid.label",
    "a" + "b".repeat(32),
  ]) {
    const result = await registeredAgentTool(invalidPi, "delegate").execute(
      "id",
      {
        definition: "agent",
        label: invalidLabel,
        task: "reject invalid label",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.ok(
      invalidPi.calls.every(
        (args) =>
          (args[0] === "status" && args[1] === "--json") || isApiSnapshot(args),
      ),
      `invalid label made unexpected calls: ${JSON.stringify(invalidPi.calls)}`,
    );
  }
});

test("restored herd run keeps its start and closes after settlement", async (t) => {
  setLeadEnvironment();
  // The daemon observes the fleet this session's own mailboxes model.
  radarDaemon.observeInventory = radarObservedFleet;
  const startedAt = 1_700_000_000_000;
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: {
        phase: "started",
        sessionId: LEAD_SESSION_ID,
        startedAt,
      },
    },
  ];
  const label = "agent";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({ entries });
  const context = fakeContext(entries);
  const herdEntries = () =>
    entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-herd-run",
    ) as any[];
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    for (const handler of pi.events.get("agent_settled") ?? [])
      await handler(undefined, context);
    await t.waitFor(() =>
      assert.equal(
        herdEntries().filter((entry) => entry.data?.phase === "finished")
          .length,
        1,
        "restored herd run did not finish after settlement",
      ),
    );
    const finished = herdEntries().find(
      (entry) => entry.data?.phase === "finished",
    );
    assert.equal(finished.data.startedAt, startedAt);
    assert.ok(finished.data.completedAt >= startedAt);
    for (const handler of pi.events.get("agent_start") ?? [])
      await handler(undefined, context);
    const second = await registeredAgentTool(pi, "delegate").execute(
      "second-run",
      { definition: "agent", label, task: "second run" },
      undefined,
      undefined,
      context,
    );
    assert.equal(second.details.ok, true, JSON.stringify(second.details));
    assert.equal(
      herdEntries().filter((entry) => entry.data?.phase === "started").length,
      2,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
  }
});

test("worker launches store one launch fingerprint of the resolved definition", async (t) => {
  setLeadEnvironment();
  // The daemon observes the fleet this session's own mailboxes model.
  radarDaemon.observeInventory = radarObservedFleet;
  const definition = "fingerprinted";
  const referenced = join(testTmpRoot, "fingerprint-body.txt");
  const writeDefinition = (model: string) =>
    realFs.writeFileSync(
      join(PI_AGENTS_DIR, `${definition}.md`),
      `---\nname: ${definition}\nmodel: ${model}\n---\nFollow the notes.\n@${referenced}\n`,
      "utf8",
    );
  const launches: {
    label: string;
    runId: string;
    entries: any[];
  }[] = [];
  const launchOnce = async (model: string, body: string) => {
    realFs.writeFileSync(referenced, body, "utf8");
    writeDefinition(model);
    const label = `fingerprinted-${randomUUID().slice(0, 8)}`;
    const startupMailbox = agentMailboxPath(WORKSPACE, label);
    const pi = fakePi({});
    const context = fakeContext(pi.entries);
    registerExtension!(pi.pi as never);
    try {
      await pi.events.get("session_start")![0](undefined, context);
      const delegated = await registeredAgentTool(pi, "delegate").execute(
        "delegate",
        { definition, label, task: `task for ${label}` },
        undefined,
        undefined,
        context,
      );
      assert.equal(
        delegated.details.ok,
        true,
        JSON.stringify(delegated.details),
      );
      const entries = pi.entries.filter(
        (entry: any) => entry.customType === "pi-herdsman-worker-launch",
      );
      launches.push({
        label,
        runId: readAgentState(startupMailbox)!.runId,
        entries,
      });
    } finally {
      pi.events.get("session_shutdown")?.[0](undefined, context);
      resetAgentMailbox(startupMailbox);
    }
  };
  try {
    await launchOnce("probe-model-a", "first body");
    await launchOnce("probe-model-b", "first body");
    await launchOnce("probe-model-b", "second body");
    await launchOnce("probe-model-b", "second body");

    const fingerprints = launches.map((launch) => {
      assert.equal(
        launch.entries.length,
        1,
        `one launch entry per launch: ${JSON.stringify(launch.entries)}`,
      );
      const data = launch.entries[0].data;
      assert.equal(data.label, launch.label);
      assert.equal(data.runId, launch.runId);
      assert.match(data.fingerprint, /^[0-9a-f]{64}$/);
      return data.fingerprint as string;
    });
    assert.notEqual(
      fingerprints[0],
      fingerprints[1],
      "a definition model change must change the fingerprint",
    );
    assert.notEqual(
      fingerprints[1],
      fingerprints[2],
      "a referenced body file change must change the fingerprint",
    );
    assert.equal(
      fingerprints[2],
      fingerprints[3],
      "an unchanged definition must keep the fingerprint",
    );
  } finally {
    realFs.rmSync(referenced, { force: true });
    realFs.rmSync(join(PI_AGENTS_DIR, `${definition}.md`), { force: true });
  }
});

test("continuation reuses an idle retained worker in its existing process", async () => {
  setLeadEnvironment();
  updateConfig("retainWorkers", true);
  const name = `warm-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  realFs.writeFileSync(definitionPath, `---\nname: ${name}\n---\nwarm body\n`);
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: DEFAULT_PI_SESSION_ID, definition: name, label },
      },
    ],
  };
  nativeSessions.set(session.id, session);
  // The retained child reports the warm worker's own session file, which is
  // what its acknowledgment and session_path must carry.
  radarDaemon.childSession = () => ({ id: session.id, file: sessionPath });
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const delivered: string[] = [];
  // A retained child is consumed by the daemon that launched it, so this
  // fixture's own stand-in must not be a second consumer of the same request.
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const accepted: string[] = [];
  radarDaemon.onChildRequest = (_spawn, request) => {
    delivered.push(request.text);
  };
  radarDaemon.onChildAccepted = (request) => {
    accepted.push(request.requestId);
  };
  const entries: unknown[] = [];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);
  const state = managedState(label, undefined, {
    paneId: "startup-pane",
    tabId: "startup-tab",
    piSessionId: session.id,
    piSessionFile: sessionPath,
  });
  const completedRequestId = randomUUID();
  const listedLabel = async () => {
    const listed = await registeredAgentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    return listed.details.agents.find((agent: any) => agent.agent === label);
  };
  const starts = () => radarDaemon.spawns.length;
  try {
    await startRadarSession(pi, context);
    // The worker was launched through Radar, delivered its result and was
    // retained: the daemon still holds the edge it bound, and the child's own
    // mailbox keeps the generation it acknowledged and no result file.
    const launch = await radarDaemon.adoptRetainedChild({
      label,
      runId: state.runId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: WORKSPACE,
      mailbox,
      pane: state.paneId,
      definition: name,
    });
    writeAgentState(mailbox, {
      ...readAgentState(mailbox)!,
      completedRequestId,
    });
    entries.push(
      {
        type: "custom_message",
        message: {
          customType: "pi-herdsman-agent-result",
          details: {
            piSessionId: session.id,
            piSessionFile: sessionPath,
            ownerSessionId: LEAD_SESSION_ID,
            runId: state.runId,
            requestId: completedRequestId,
            agentLabel: label,
            agentDefinition: name,
            status: "completed",
          },
        },
      },
      {
        type: "custom",
        customType: "pi-herdsman-worker-launch",
        data: {
          runId: state.runId,
          label,
          fingerprint: agentLaunchFingerprint(
            resolveAgentLaunchInputs(
              {
                name,
                path: definitionPath,
                frontmatter: { name },
                body: "warm body",
              },
              { cwd: "/tmp", launchCommand: testChildCommand },
            ),
          ),
        },
      },
      {
        type: "custom",
        customType: "pi-herdsman-radar-spawn",
        data: launch,
      },
    );
    assert.equal((await listedLabel())?.state, "idle");
    const startsBefore = starts();

    const continued = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: sessionPath, task: "second assignment" },
      undefined,
      undefined,
      context,
    );
    assert.equal(continued.details.ok, true, JSON.stringify(continued.details));
    assert.equal(continued.details.reused, true);
    assert.equal(continued.details.agent, label);
    assert.equal(continued.details.pane_id, "startup-pane");
    assert.equal(continued.details.session_id, session.id);
    assert.equal(continued.details.session_path, sessionPath);
    assert.equal(
      starts(),
      startsBefore,
      "reuse must not start another process",
    );
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /second assignment/);
    const after = readAgentState(mailbox);
    assert.equal(after?.activeRequestId, continued.details.request_id);
    assert.equal(after?.completedRequestId, undefined);
    assert.equal(after?.runId, state.runId);
    assert.equal(after?.lastAck?.accepted, true);
    // The assignment carried the daemon's own statement of which process the
    // launch bound, and the worker's acceptance echoed that exact address back:
    // the reuse is that agreement, not the startup acknowledgment left behind.
    assert.deepEqual(after?.lastAck?.identity, retainedLaunchAddress(launch));
    assert.equal((await listedLabel())?.state, "working");
  } finally {
    updateConfig("retainWorkers", undefined);
    pi.events.get("session_shutdown")?.[0](undefined, context);
    radarDaemon.reset();
    nativeSessions.delete(session.id);
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

/**
 * A retained Radar worker whose next assignment is the test's: the daemon that
 * launched it still holds the edge it bound, the mailbox holds the generation it
 * acknowledged, and the owner's session holds the launch record and the
 * retrieved result that make it idle. `link` is how a test makes the process
 * answering that mailbox something other than the one the launch bound.
 */
async function retainedRadarWorker(
  prefix: string,
  link: (daemon: FakeRadarDaemon) => void = () => undefined,
) {
  setLeadEnvironment();
  updateConfig("retainWorkers", true);
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  realFs.writeFileSync(definitionPath, `---\nname: ${name}\n---\nwarm body\n`);
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: DEFAULT_PI_SESSION_ID, definition: name, label },
      },
    ],
  };
  nativeSessions.set(session.id, session);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const delivered: string[] = [];
  const accepted: string[] = [];
  // A retained child is consumed by the daemon that launched it, so this
  // fixture's own stand-in must not be a second consumer of the same request.
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const entries: unknown[] = [];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);
  const state = managedState(label, undefined, {
    paneId: "startup-pane",
    tabId: "startup-tab",
    piSessionId: session.id,
    piSessionFile: sessionPath,
  });
  const completedRequestId = randomUUID();
  const listedLabel = async () => {
    const listed = await registeredAgentTool(pi, "list").execute(
      "list",
      {},
      undefined,
      undefined,
      context,
    );
    return listed.details.agents.find((agent: any) => agent.agent === label);
  };
  const starts = () => radarDaemon.spawns.length;
  await startRadarSession(pi, context);
  const launch = await radarDaemon.adoptRetainedChild({
    label,
    runId: state.runId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: WORKSPACE,
    mailbox,
    pane: state.paneId,
    definition: name,
  });
  link(radarDaemon);
  const addresses: RequestAddress[] = [];
  radarDaemon.onChildRequest = (_spawn, request) => {
    if (request.address !== undefined) addresses.push(request.address);
  };
  writeAgentState(mailbox, {
    ...readAgentState(mailbox)!,
    completedRequestId,
  });
  entries.push(
    {
      type: "custom_message",
      message: {
        customType: "pi-herdsman-agent-result",
        details: {
          piSessionId: session.id,
          piSessionFile: sessionPath,
          ownerSessionId: LEAD_SESSION_ID,
          runId: state.runId,
          requestId: completedRequestId,
          agentLabel: label,
          agentDefinition: name,
          status: "completed",
        },
      },
    },
    {
      type: "custom",
      customType: "pi-herdsman-worker-launch",
      data: {
        runId: state.runId,
        label,
        fingerprint: agentLaunchFingerprint(
          resolveAgentLaunchInputs(
            {
              name,
              path: definitionPath,
              frontmatter: { name },
              body: "warm body",
            },
            { cwd: "/tmp", launchCommand: testChildCommand },
          ),
        ),
      },
    },
    {
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: launch,
    },
  );
  return {
    label,
    launch,
    mailbox,
    delivered,
    accepted,
    addresses,
    state,
    listedLabel,
    starts,
    continue: (task: string) =>
      registeredAgentTool(pi, "continue").execute(
        "id",
        { session: sessionPath, task },
        undefined,
        undefined,
        context,
      ),
    dispose: () => {
      radarDaemon.onChildRequest = undefined;
      updateConfig("retainWorkers", undefined);
      pi.events.get("session_shutdown")?.[0](undefined, context);
      radarDaemon.reset();
      nativeSessions.delete(session.id);
      resetAgentMailbox(mailbox);
      realFs.rmSync(definitionPath, { force: true });
      realFs.rmSync(sessionPath, { force: true });
    },
  };
}

/**
 * The answer to a continuation either way it arrives: an operation that reports
 * its own refusal resolves with `ok: false`, and a wait that never settles
 * rejects. Both are the same failure to a test that asserts fail-closed.
 */
const continueOutcome = async (
  call: Promise<any>,
): Promise<{ ok: boolean; category?: string; message: string }> => {
  try {
    const result = await call;
    return {
      ok: result.details.ok === true,
      category: result.details.error?.category,
      message: String(result.details.error?.message ?? ""),
    };
  } catch (error) {
    return { ok: false, category: "wait", message: String(error) };
  }
};

/**
 * The address an assignment to a retained child is written with: the subject the
 * launch bound, the source and incarnation the daemon's edge names for it, and
 * the generation the child acknowledged.
 */
const retainedLaunchAddress = (launch: {
  agentId: string;
  generation: string;
}): RequestAddress => ({
  subject: launch.agentId,
  source: RADAR_SUBJECT_SOURCE,
  incarnation: radarDaemon.spawns.at(-1)!.incarnation,
  generation: launch.generation,
});

test("a replaced process cannot accept an addressed retained continuation", async () => {
  const fixture = await retainedRadarWorker("replaced", (daemon) => {
    // The process answering this mailbox is not the one the launch bound: same
    // run, pane, label and session, another incarnation.
    daemon.options.responderIncarnation = randomUUID();
  });
  try {
    const startsBefore = fixture.starts();
    const outcome = await continueOutcome(
      fixture.continue("second assignment"),
    );
    assert.equal(
      outcome.ok,
      false,
      "a replaced process must not accept the addressed assignment",
    );
    assert.equal(outcome.category, "target_not_found");
    assert.match(
      outcome.message,
      /addressed to another Radar process incarnation/,
    );
    // The refusal names the process the launch bound, which is the address the
    // assignment was written with before the answering process was asked.
    assert.deepEqual(fixture.addresses, [
      retainedLaunchAddress(fixture.launch),
    ]);
    const after = readAgentState(fixture.mailbox);
    assert.equal(
      after?.activeRequestId,
      undefined,
      "a replaced process must not accept the addressed assignment",
    );
    assert.equal(after?.lastAck?.accepted, false);
    assert.equal(after?.lastAck?.code, "identity");
    assert.deepEqual(fixture.accepted, [], "the addressed task must not run");
    assert.equal(fixture.delivered.length, 0);
    assert.equal(
      fixture.starts(),
      startsBefore,
      "an unanswered assignment must not launch a process",
    );
  } finally {
    fixture.dispose();
  }
});

test("an acceptance that does not echo the addressed process is not a reuse", async () => {
  const fixture = await retainedRadarWorker("silent-echo", (daemon) => {
    daemon.options.acknowledgeIdentity = "omit";
  });
  try {
    const outcome = await continueOutcome(
      fixture.continue("second assignment"),
    );
    assert.equal(
      outcome.ok,
      false,
      "an echo that is missing must not be a reuse",
    );
    assert.equal(outcome.category, "target_not_found");
    assert.match(
      outcome.message,
      /acknowledged from a process other than the one this launch bound/,
    );
    assert.deepEqual(fixture.addresses, [
      retainedLaunchAddress(fixture.launch),
    ]);
  } finally {
    fixture.dispose();
  }
});

test("an acceptance that echoes another process is not a reuse", async () => {
  const fixture = await retainedRadarWorker("wrong-echo", (daemon) => {
    daemon.options.acknowledgeIdentity = "wrong";
  });
  try {
    const outcome = await continueOutcome(
      fixture.continue("second assignment"),
    );
    assert.equal(
      outcome.ok,
      false,
      "another process's echo must not be a reuse",
    );
    assert.equal(outcome.category, "target_not_found");
    assert.match(
      outcome.message,
      /acknowledged from a process other than the one this launch bound/,
    );
    assert.deepEqual(fixture.addresses, [
      retainedLaunchAddress(fixture.launch),
    ]);
  } finally {
    fixture.dispose();
  }
});

test("a stopped consumer cannot answer an addressed continuation", async () => {
  // Every historical artifact survives: the edge, the pane, the binding and the
  // startup acknowledgment. Nothing is there to answer the addressed request, so
  // the continuation stays unanswered and is never reported as a reuse.
  const fixture = await retainedRadarWorker("stopped", (daemon) => {
    daemon.options.acceptAssignments = false;
  });
  try {
    const outcome = await continueOutcome(
      fixture.continue("second assignment"),
    );
    // Nothing answers: the request stays unanswered and the owner's wait ends in
    // an explicit timeout rather than a successful reuse.
    assert.equal(
      outcome.ok,
      false,
      "an unanswered assignment must not be a reuse",
    );
    assert.match(outcome.message, /Timed out waiting for agent state/);
    assert.deepEqual(fixture.addresses, [
      retainedLaunchAddress(fixture.launch),
    ]);
    assert.deepEqual(fixture.accepted, []);
    assert.equal(fixture.delivered.length, 0);
  } finally {
    fixture.dispose();
  }
});

test("continuation rejects a retained worker whose result was not delivered", async () => {
  setLeadEnvironment();
  const name = `undelivered-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nundelivered body\n`,
  );
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: DEFAULT_PI_SESSION_ID, definition: name, label },
      },
    ],
  };
  nativeSessions.set(session.id, session);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({});
  const entries: unknown[] = [];
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);
  const state = {
    ...managedState(label, undefined, {
      paneId: "startup-pane",
      tabId: "startup-tab",
      piSessionId: session.id,
      piSessionFile: sessionPath,
    }),
    completedRequestId: randomUUID(),
  };
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    // A result file that is still present is pending delivery, not retention.
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
    writeResult(mailbox, {
      version: 5,
      runId: state.runId,
      requestId: state.completedRequestId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      status: "completed",
      text: "not yet delivered",
      completedAt: Date.now(),
    });
    entries.push({
      type: "custom_message",
      message: {
        customType: "pi-herdsman-agent-result",
        details: {
          piSessionId: session.id,
          piSessionFile: sessionPath,
          ownerSessionId: LEAD_SESSION_ID,
          runId: state.runId,
          requestId: state.completedRequestId,
          agentLabel: label,
          agentDefinition: name,
          status: "completed",
        },
      },
    });

    const result = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: sessionPath, task: "must wait for delivery" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error.category, "agent_busy");
    // A busy session is refused before any process is created for it.
    assert.equal(radarDaemon.spawns.length, 0);
    const after = readAgentState(mailbox);
    assert.equal(after?.activeRequestId, undefined);
    assert.equal(after?.completedRequestId, state.completedRequestId);
    assert.equal(
      readResult(mailbox, state.completedRequestId)?.text,
      "not yet delivered",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0](undefined, context);
    nativeSessions.delete(session.id);
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("completed and mismatched herd history does not resurrect", async () => {
  for (const history of [
    [
      {
        phase: "started",
        sessionId: LEAD_SESSION_ID,
        startedAt: 1_000,
      },
      {
        phase: "finished",
        sessionId: LEAD_SESSION_ID,
        startedAt: 1_000,
        completedAt: 2_000,
      },
    ],
    [
      {
        phase: "started",
        sessionId: "other-session",
        startedAt: 1_000,
      },
    ],
  ]) {
    setLeadEnvironment();
    const entries = history.map((data) => ({
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data,
    }));
    const pi = fakePi({ entries });
    const context = fakeContext(entries);
    registerExtension!(pi.pi as never);
    try {
      for (const handler of pi.events.get("session_start") ?? [])
        await handler(undefined, context);
      for (const handler of pi.events.get("agent_settled") ?? [])
        await handler(undefined, context);
      assert.equal(
        entries.filter(
          (entry: any) =>
            entry.customType === "pi-herdsman-herd-run" &&
            entry.data?.phase === "finished",
        ).length,
        history.filter((data) => data.phase === "finished").length,
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
    }
  }
});

test("restored herd waits for direct durable cleanup before finishing", async (t) => {
  setLeadEnvironment();
  const label = `recovered-herd-${randomUUID().slice(0, 8)}`;
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-herd-run",
      data: { phase: "started", sessionId: LEAD_SESSION_ID, startedAt: 1_000 },
    },
  ];
  const state = managedState(label);
  resetAgentMailbox(startupMailbox);
  writeAgentState(startupMailbox, state);
  const pi = fakePi({ entries });
  const context = fakeContext(entries);
  const herdEntries = () =>
    entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-herd-run",
    ) as any[];
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    for (const handler of pi.events.get("agent_settled") ?? [])
      await handler(undefined, context);
    assert.equal(
      herdEntries().filter((entry) => entry.data?.phase === "finished").length,
      0,
    );
    resetAgentMailbox(startupMailbox);
    for (const handler of pi.events.get("agent_settled") ?? [])
      await handler(undefined, context);
    await t.waitFor(() =>
      assert.equal(
        herdEntries().filter((entry) => entry.data?.phase === "finished")
          .length,
        1,
        "herd run did not finish after direct durable cleanup",
      ),
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
  }
});

test("exact requested session IDs remain busy when persisted paths are stale", async () => {
  setLeadEnvironment();
  const name = `stale-id-resume-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(PI_AGENT_ROOT, `${name}-session.jsonl`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: `${name}-agent`,
        },
      },
    ],
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nexact stale ID test\n`,
  );
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const staleLabel = `${name}-stale`;
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, {
    ...managedState(staleLabel),
    piSessionId: session.id,
    piSessionFile: join(PI_AGENT_ROOT, `${name}-deleted-session.jsonl`),
  });
  const startupMailbox = agentMailboxPath(WORKSPACE, `${name}-agent`);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: sessionPath, task: "must wait" },
      undefined,
      undefined,
      ownedSessionContext(session.id, `${name}-agent`),
    );
    assert.equal(result.details.error.category, "agent_busy");
    assert.equal(radarDaemon.spawns.length, 0);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(staleMailbox);
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("concurrent session activation permits one generation", async () => {
  setLeadEnvironment();
  const name = `concurrent-session-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: join(PI_AGENT_ROOT, `${name}-session.jsonl`),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: name,
        },
      },
    ],
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nconcurrent activation test\n`,
  );
  realFs.writeFileSync(session.path, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const startupMailbox = agentMailboxPath(WORKSPACE, name);
  let release!: () => void;
  let startEntered!: () => void;
  const entered = new Promise<void>((resolve) => (startEntered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  // The launch holds the session reservation from the moment it reaches the
  // daemon, so a second activation for the same session must be refused there.
  radarDaemon.onChildStart = async () => {
    startEntered();
    await gate;
  };
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  // A launch is created under this process's own registration, so the fixture
  // session starts first: the concurrent activation this proves is about the
  // session reservation, not about a process that never registered.
  await startRadarSession(pi);
  try {
    const first = registeredAgentTool(pi, "continue").execute(
      "first",
      { session: session.path, task: "first assignment" },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    await entered;
    const second = await registeredAgentTool(pi, "continue").execute(
      "second",
      { session: session.id, task: "duplicate assignment" },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    assert.equal(second.details.error.category, "agent_busy");
    release();
    const firstResult = await first;
    assert.equal(
      firstResult.details.ok,
      true,
      JSON.stringify(firstResult.details),
    );
  } finally {
    release();
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(session.path, { force: true });
  }
});

test("a failed continue releases the session activation reservation", async () => {
  setLeadEnvironment();
  const name = `released-session-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: join(PI_AGENT_ROOT, `${name}-session.jsonl`),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: name,
        },
      },
    ],
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nactivation release test\n`,
  );
  realFs.writeFileSync(session.path, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const startupMailbox = agentMailboxPath(WORKSPACE, name);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const failed = await registeredAgentTool(pi, "continue").execute(
      "first",
      {
        session: session.path,
        task: "must not start",
        files: [join(testTmpRoot, "missing-activation-preflight.md")],
      },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    assert.equal(failed.details.error.category, "invalid_request");
    assert.equal(
      failed.details.error.rollbackOccurred,
      false,
      "preflight rejection must precede launch",
    );
    assert.equal(radarDaemon.spawns.length, 0, "preflight must reject before launch");

    const retried = await registeredAgentTool(pi, "continue").execute(
      "second",
      {
        session: session.path,
        task: "start now",
      },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    assert.equal(
      retried.details.ok,
      true,
      `a released reservation must not refuse the retry: ${JSON.stringify(retried.details)}`,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(session.path, { force: true });
  }
});

test("fresh assignment transports automatic prompt snapshots and cleans them up", async () => {
  setLeadEnvironment();
  const name = `prompt-fresh-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  realFs.writeFileSync(promptPath, "automatic prompt snapshot");
  writePromptDefinition(definitionPath, name, promptPath);
  const launched: { args: string[]; contents: string[] }[] = [];
  let assignedText = "";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  radarDaemon.onChildRequest = (_spawn, request) => ((text) => {
      assignedText = text;
    })(request.text, request);
  radarDaemon.onChildStart = (spawn) => ((args) => {
      launched.push({ args: [...args], contents: promptLaunchContents(args) });
    })([...spawn.argv]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: name, label, task: "fresh task" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched.length, 1);
    assert.deepEqual(
      launched[0].args.filter(
        (arg) => arg === "--system-prompt" || arg === "--append-system-prompt",
      ),
      ["--system-prompt", "--append-system-prompt", "--append-system-prompt"],
    );
    assert.equal(launched[0].contents.length, 3);
    assert.match(launched[0].contents[0]!, /definition body/);
    assert.match(launched[0].contents[0]!, /automatic prompt snapshot/);
    assert.match(launched[0].contents[1]!, /ask_owner/);
    assert.match(
      launched[0].contents[1]!.replaceAll(/\s+/g, " ").trim(),
      /canonical result:<request-id> refs already supplied as file evidence exactly\s+when forwarding them/,
    );
    assert.match(
      launched[0].contents[1]!,
      /pass reusable direct-agent result refs through `files`/,
    );
    assert.match(
      launched[0].contents[1]!,
      /Do not overlap writers in a worktree or file-ownership boundary/,
    );
    assert.match(
      launched[0].contents[1]!,
      /Preserve\s+canonical result:<request-id> refs already supplied as file evidence exactly\s+when forwarding them/,
    );
    assert.match(assignedText, /fresh task/);
    assert.equal(realFs.existsSync(mailbox), true);
    for (const path of promptLaunchPaths(launched[0].args))
      assert.equal(realFs.existsSync(path), false, `prompt leaked: ${path}`);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
  }
});

test("a fresh delegation stores the child session under the operator cwd", async () => {
  setLeadEnvironment();
  const name = `child-dir-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\ndefinition body\n`,
    "utf8",
  );
  const targetCwd = join(
    tmpdir(),
    `pi-herdsman-target-${randomUUID().slice(0, 8)}`,
  );
  const launched: string[][] = [];
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  radarDaemon.onChildStart = (spawn) => ((args) => launched.push([...args]))([...spawn.argv]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const context = fakeContext();
    (context as any).cwd = targetCwd;
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: name, label, task: "fresh task" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched.length, 1);
    assert.deepEqual(
      launched[0]!.slice(
        launched[0]!.indexOf("--session-dir"),
        launched[0]!.indexOf("--session-dir") + 2,
      ),
      ["--session-dir", resolve(targetCwd, ".pi", "sessions", "children")],
    );
    assert.equal(
      launched[0]!.filter((arg) => arg === "--session-dir").length,
      1,
    );
    assert.equal(
      launched[0]!.includes("--session"),
      false,
      "a fresh launch has no saved session to continue",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(definitionPath, { force: true });
  }
});

/**
 * The environment overlay this test's launches carried. A launch used to pass
 * its overlay as `--env` on the pane it created; Radar spawn carries the same
 * overlay in the request, so this reads the spawn the daemon accepted.
 */
const paneEnvironmentAssignments = (
  _pi?: ReturnType<typeof fakePi>,
): string[] => spawnedEnvironmentAssignments(radarDaemon);

/** A real executable for `PI_HERDSMAN_CHILD_COMMAND`, outside the repository. */
const tempChildCommand = (suffix: string): string => {
  const path = join(
    tmpdir(),
    `pi-herdsman-child-command-${suffix}-${randomUUID().slice(0, 8)}`,
  );
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
  return path;
};

const childCommandAssignments = (pi: ReturnType<typeof fakePi>): string[] =>
  paneEnvironmentAssignments(pi).filter((assignment) =>
    assignment.startsWith("PI_HERDSMAN_CHILD_COMMAND="),
  );

test("a configured child command reaches the child pane environment exactly once", async () => {
  setLeadEnvironment();
  const command = tempChildCommand("configured");
  process.env.PI_HERDSMAN_CHILD_COMMAND = command;
  const name = `child-command-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\ndefinition body\n`,
    "utf8",
  );
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: name, label, task: "configured child command" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.deepEqual(childCommandAssignments(pi), [
      `PI_HERDSMAN_CHILD_COMMAND=${command}`,
    ]);
    // The rest of the child contract is untouched by the new assignment.
    const assignments = paneEnvironmentAssignments(pi);
    assert.ok(assignments.includes("PI_SUBAGENT_CHILD=1"));
    assert.equal(
      assignments.filter((assignment) =>
        assignment.startsWith("PI_SUBAGENT_PARENT_SESSION="),
      ).length,
      1,
    );
    assert.ok(assignments.includes("PI_OFFLINE=1"));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(command, { force: true });
    delete process.env.PI_HERDSMAN_CHILD_COMMAND;
  }
});

test("an unconfigured child command refuses a fresh launch before any effect", async () => {
  setLeadEnvironment();
  // Radar spawn execs an absolute path this process resolved. Without a
  // configured child command there is no executable to name, and inventing one
  // from the pane's shell is exactly the fallback the launch must not take.
  delete process.env.PI_HERDSMAN_CHILD_COMMAND;
  const name = `child-command-unset-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\ndefinition body\n`,
    "utf8",
  );
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: name, label, task: "no configured child command" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, false, JSON.stringify(result.details));
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(result.details.error.message, /PI_HERDSMAN_CHILD_COMMAND/);
    assert.equal(radarDaemon.spawns.length, 0);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("a worker's inherited child command serves its own delegation", async () => {
  setLeadEnvironment();
  const command = tempChildCommand("inherited");
  process.env.PI_HERDSMAN_CHILD_COMMAND = command;
  // The value arrived with the launch, not from a shell export; nothing in the
  // worker refuses it or falls back to a default.
  process.env.PI_SUBAGENT_CHILD = "1";
  const name = `child-command-inherited-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\ndefinition body\n`,
    "utf8",
  );
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: name, label, task: "nested delegation" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.deepEqual(childCommandAssignments(pi), [
      `PI_HERDSMAN_CHILD_COMMAND=${command}`,
    ]);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(command, { force: true });
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_HERDSMAN_CHILD_COMMAND;
  }
});

test("an invalid child command fails the launch before any pane is created", async () => {
  setLeadEnvironment();
  const nonExecutable = join(
    tmpdir(),
    `pi-herdsman-child-command-plain-${randomUUID().slice(0, 8)}`,
  );
  writeFileSync(nonExecutable, "", { mode: 0o644 });
  const name = `child-command-invalid-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\ndefinition body\n`,
    "utf8",
  );
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    for (const value of ["relative/child-command", nonExecutable]) {
      process.env.PI_HERDSMAN_CHILD_COMMAND = value;
      const result = await registeredAgentTool(pi, "delegate").execute(
        "id",
        { definition: name, label, task: "refused child command" },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.ok, false, value);
      assert.equal(result.details.error.category, "invalid_request", value);
      assert.match(result.details.error.message, /PI_HERDSMAN_CHILD_COMMAND/);
    }
    assert.equal(
      pi.calls.some(
        (args) =>
          (args[0] === "tab" && args[1] === "create") ||
          (args[0] === "pane" && args[1] === "split") ||
          (args[0] === "agent" && args[1] === "start"),
      ),
      false,
      "no pane or process is created for a refused command",
    );
    assert.equal(radarDaemon.spawns.length, 0);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(nonExecutable, { force: true });
    delete process.env.PI_HERDSMAN_CHILD_COMMAND;
  }
});

test("fresh assignment transports preloaded skill bodies and cleans them up", async () => {
  setLeadEnvironment();
  const name = `preload-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const skillPath = join(PI_AGENT_ROOT, `${name}-skill.md`);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  realFs.writeFileSync(
    skillPath,
    "---\nname: preload-probe\ndescription: probe skill\n---\n\nPreloaded method text.\n",
  );
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\npreloadedSkills: ["${skillPath}"]\n---\ndefinition body\n`,
  );
  const launched: { args: string[]; contents: string[] }[] = [];
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  radarDaemon.onChildStart = (spawn) => ((args) => {
      launched.push({ args: [...args], contents: promptLaunchContents(args) });
    })([...spawn.argv]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: name, label, task: "fresh task" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched.length, 1);
    assert.equal(launched[0]!.contents.length, 4);
    assert.match(launched[0]!.contents[1]!, /Preloaded method text\./);
    assert.doesNotMatch(launched[0]!.contents[1]!, /description: probe skill/);
    assert.doesNotMatch(launched[0]!.contents[0]!, /Preloaded method text\./);
    for (const path of promptLaunchPaths(launched[0]!.args))
      assert.equal(realFs.existsSync(path), false, `prompt leaked: ${path}`);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(skillPath, { force: true });
  }
});

test("startup failure cleans private prompt snapshots", async () => {
  setLeadEnvironment();
  const name = `failure-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  realFs.writeFileSync(promptPath, "startup failure prompt");
  writePromptDefinition(definitionPath, name, promptPath);
  const launched: string[][] = [];
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  radarDaemon.onChildStart = (spawn) => ((args) => launched.push(promptLaunchPaths(args)))([...spawn.argv]);
  // The launch cannot complete because the child it started never acknowledges
  // the launch, so the prompt snapshots it wrote are the only thing left.
  radarDaemon.options.acknowledge = false;
  process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS = "500";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const context = fakeContext();
    await startRadarSession(pi, context);
    await pi.events.get("agent_start")![0](undefined, context);
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      {
        definition: name,
        task: "must fail at startup",
      },
      undefined,
      undefined,
      context,
    );
    assert.notEqual(result.details.ok, true);
    assert.equal(
      pi.entries.filter(
        (entry: any) => entry.customType === "pi-herdsman-herd-run",
      ).length,
      0,
    );
    assert.equal(launched.length, 1);
    assert.ok(launched[0].length > 0);
    for (const path of launched[0])
      assert.equal(realFs.existsSync(path), false, `prompt leaked: ${path}`);
  } finally {
    delete process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
  }
});

test("caller assignment files suppress canonical-overlapping automatic prompts", async () => {
  setLeadEnvironment();
  const name = `prompt-overlap-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  const callerPath = join(PI_AGENT_ROOT, `${name}-caller.md`);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  realFs.writeFileSync(promptPath, "caller wins canonical overlap");
  realFs.symlinkSync(promptPath, callerPath);
  writePromptDefinition(definitionPath, name, promptPath);
  const launched: { args: string[]; contents: string[] }[] = [];
  let assignedText = "";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  radarDaemon.onChildRequest = (_spawn, request) => ((text) => {
      assignedText = text;
    })(request.text, request);
  radarDaemon.onChildStart = (spawn) => ((args) => {
      launched.push({ args: [...args], contents: promptLaunchContents(args) });
    })([...spawn.argv]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      {
        definition: name,
        files: [callerPath],
        task: "use caller context",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched[0].contents.length, 3);
    assert.match(launched[0].contents[0]!, /definition body/);
    assert.match(launched[0].contents[1]!, /ask_owner/);
    assert.deepEqual(
      launched[0].args.filter(
        (arg) => arg === "--system-prompt" || arg === "--append-system-prompt",
      ),
      ["--system-prompt", "--append-system-prompt", "--append-system-prompt"],
    );
    assert.match(assignedText, /caller wins canonical overlap/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
    realFs.rmSync(callerPath, { force: true });
  }
});

test("automatic prompt failures happen before topology or mailbox mutation", async () => {
  setLeadEnvironment();
  const name = `prompt-invalid-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const directoryPath = join(PI_AGENT_ROOT, `${name}-directory`);
  const invalidPath = join(PI_AGENT_ROOT, `${name}-invalid.md`);
  const nulPath = join(PI_AGENT_ROOT, `${name}-nul.md`);
  realFs.mkdirSync(directoryPath);
  realFs.writeFileSync(invalidPath, Buffer.from([0xff, 0xfe]));
  realFs.writeFileSync(nulPath, Buffer.from("prompt\0content"));
  const cases = [
    ["missing", join(PI_AGENT_ROOT, `${name}-missing.md`)],
    ["directory", directoryPath],
    ["invalid utf8", invalidPath],
    ["nul", nulPath],
  ] as const;
  try {
    for (const [kind, promptPath] of cases) {
      const label = `${name}-${kind.replaceAll(" ", "-")}`;
      const mailbox = agentMailboxPath(WORKSPACE, label);
      writePromptDefinition(definitionPath, name, promptPath);
      const startupMailbox = agentMailboxPath(WORKSPACE, label);
      const pi = fakePi({});
      registerExtension!(pi.pi as never);
      try {
        const result = await registeredAgentTool(pi, "delegate").execute(
          "id",
          { definition: name, label, task: "must fail" },
          undefined,
          undefined,
          fakeContext(),
        );
        assert.equal(result.details.error.category, "invalid_request", kind);
        assert.equal(radarDaemon.spawns.length, 0, kind);
        assert.equal(realFs.existsSync(mailbox), false, kind);
        assert.equal(
          pi.calls.some(
            (args) =>
              args[0] === "pane" ||
              (args[0] === "agent" &&
                ["start", "stop"].includes(args[1] ?? "")),
          ),
          false,
          kind,
        );
      } finally {
        pi.events.get("session_shutdown")?.[0]();
        resetAgentMailbox(mailbox);
      }
    }
  } finally {
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(directoryPath, { recursive: true, force: true });
    realFs.rmSync(invalidPath, { force: true });
    realFs.rmSync(nulPath, { force: true });
  }
});

test("fresh and non-live historical assignments reject disabled definitions", async () => {
  setLeadEnvironment();
  const freshName = `disabled-fresh-${randomUUID().slice(0, 8)}`;
  const freshLabel = `${freshName}-agent`;
  const freshDefinitionPath = join(PI_AGENTS_DIR, `${freshName}.md`);
  realFs.writeFileSync(
    freshDefinitionPath,
    `---\nname: ${freshName}\nenabled: false\n---\nfresh\n`,
  );
  const freshStartupMailbox = agentMailboxPath(WORKSPACE, freshLabel);
  const freshPi = fakePi({});
  registerExtension!(freshPi.pi as never);
  try {
    const result = await registeredAgentTool(freshPi, "delegate").execute(
      "id",
      {
        definition: freshName,
        task: "must remain disabled",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(result.details.error.message, /disabled/);
    assert.match(result.details.error.message, new RegExp(freshName));
    assert.equal(radarDaemon.spawns.length, 0);
    assert.equal(realFs.existsSync(freshStartupMailbox), false);
  } finally {
    freshPi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(freshDefinitionPath, { force: true });
  }

  setLeadEnvironment();
  const historicalName = `disabled-session-${randomUUID().slice(0, 8)}`;
  const historicalDefinitionPath = join(PI_AGENTS_DIR, `${historicalName}.md`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: join(PI_AGENT_ROOT, `${historicalName}-session.jsonl`),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: historicalName,
          label: `${historicalName}-agent`,
        },
      },
    ],
  };
  realFs.writeFileSync(
    historicalDefinitionPath,
    `---\nname: ${historicalName}\nenabled: false\n---\nhistorical\n`,
  );
  nativeSessions.set(session.id, session);
  const historicalStartupMailbox = agentMailboxPath(WORKSPACE, `${historicalName}-agent`);
  const historicalPi = fakePi({});
  registerExtension!(historicalPi.pi as never);
  try {
    const result = await registeredAgentTool(historicalPi, "continue").execute(
      "id",
      {
        session: session.path,
        task: "must remain disabled",
      },
      undefined,
      undefined,
      ownedSessionContext(session.id, `${historicalName}-agent`),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(result.details.error.message, /disabled/);
    assert.equal(radarDaemon.spawns.length, 0);
    assert.equal(realFs.existsSync(historicalStartupMailbox), false);
  } finally {
    historicalPi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    realFs.rmSync(historicalDefinitionPath, { force: true });
  }
});

test("assigning a parent with a disabled child fails with an explicit reason", async () => {
  setLeadEnvironment();
  const parentPath = join(PI_AGENTS_DIR, "disabled-child-parent.md");
  const childPath = join(PI_AGENTS_DIR, "disabled-child.md");
  realFs.writeFileSync(
    parentPath,
    '---\nname: disabled-child-parent\nagents: ["disabled-child"]\n---\nparent\n',
  );
  realFs.writeFileSync(
    childPath,
    "---\nname: disabled-child\nenabled: false\n---\nchild\n",
  );
  const pi = fakePi({
    exec: (command, args) =>
      command === "herdr" && args[0] === "--version"
        ? { stdout: "0.8.0", stderr: "", code: 0 }
        : command === "herdr" && isApiSnapshot(args)
          ? {
              stdout: JSON.stringify({
                id: AGENT_ID,
                result: { snapshot: { agents: [], panes: [] } },
              }),
              stderr: "",
              code: 0,
            }
          : {
              stdout: JSON.stringify({ id: AGENT_ID, result: { agents: [] } }),
              stderr: "",
              code: 0,
            },
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      {
        definition: "disabled-child-parent",
        task: "must reject disabled child",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(
      result.details.error.message,
      /references disabled agent definition disabled-child/,
    );
    assert.equal(
      radarDaemon.spawns.length > 0,
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(parentPath, { force: true });
    realFs.rmSync(childPath, { force: true });
  }
});

test("session continuation starts a new agent generation with current prompt contents", async () => {
  setLeadEnvironment();
  const name = `prompt-resume-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const promptPath = join(PI_AGENT_ROOT, `${name}-prompt.md`);
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: join(PI_AGENT_ROOT, `${name}-session.jsonl`),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: name,
        },
      },
    ],
  };
  realFs.writeFileSync(promptPath, "current saved-session prompt");
  realFs.writeFileSync(session.path, "{}", "utf8");
  writePromptDefinition(definitionPath, name, promptPath);
  nativeSessions.set(session.id, session);
  const staleLabel = `${name}-stale`;
  const staleMailbox = agentMailboxPath(WORKSPACE, staleLabel);
  radarDaemon.onChildStart = (spawn) => ((args) => {
      launched.push({ args: [...args], contents: promptLaunchContents(args) });
    })([...spawn.argv]);
  resetAgentMailbox(staleMailbox);
  writeAgentState(staleMailbox, {
    ...managedState(staleLabel),
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: join(PI_AGENT_ROOT, `${name}-deleted-session.jsonl`),
  });
  const launched: { args: string[]; contents: string[] }[] = [];
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "continue").execute(
      "id",
      {
        session: session.path,
        task: "resume current prompt",
      },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched[0].contents.length, 3);
    assert.equal(result.details.session_id, session.id);
    assert.equal(result.details.owner_session_id, LEAD_SESSION_ID);
    assert.equal(result.details.session_path, "/tmp/registered-agent.jsonl");
    assert.ok(
      !JSON.stringify(result.content).includes("/tmp/registered-agent.jsonl"),
    );
    assert.equal((result.details as any).reusable, undefined);
    assert.equal((result.details as any).keepAlive, undefined);
    const state = readAgentState(startupMailbox)!;
    assert.equal(state.version, 5);
    assert.equal(state.piSessionId, session.id);
    assert.match(launched[0].contents[0]!, /definition body/);
    assert.match(launched[0].contents[0]!, /current saved-session prompt/);
    assert.match(launched[0].contents[1]!, /ask_owner/);
    const sessionIndex = launched[0].args.indexOf("--session");
    assert.equal(
      launched[0].args[sessionIndex + 1],
      realFs.realpathSync(session.path),
    );
    assert.equal(
      launched[0].args.includes("--session-dir"),
      false,
      "a saved session is resumed by exact path and never rehomed",
    );
    for (const path of promptLaunchPaths(launched[0].args))
      assert.equal(realFs.existsSync(path), false, `prompt leaked: ${path}`);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(startupMailbox);
    resetAgentMailbox(staleMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(promptPath, { force: true });
    realFs.rmSync(session.path, { force: true });
  }
});

test("agent_list advertises a saved session until a generation represents it", async () => {
  setLeadEnvironment();
  const name = `saved-list-${randomUUID().slice(0, 8)}`;
  const sessionId = DEFAULT_PI_SESSION_ID;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const session = {
    id: sessionId,
    path: join(PI_AGENT_ROOT, `${name}-session.jsonl`),
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId,
          definition: name,
          label: name,
        },
      },
    ],
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nsaved session body\n`,
    "utf8",
  );
  realFs.writeFileSync(session.path, "{}", "utf8");
  nativeSessions.set(session.id, session);
  const startupMailbox = agentMailboxPath(WORKSPACE, name);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const list = async () =>
    (
      await registeredAgentTool(pi, "list").execute(
        "id",
        {},
        undefined,
        undefined,
        ownedSessionContext(session.id, name),
      )
    ).details;
  try {
    const [saved] = (await list()).saved_sessions as any[];
    assert.equal(saved.state, "saved");
    assert.equal(saved.agent, name);
    assert.equal(saved.agent_definition, name);
    assert.equal(saved.pi_session_id, session.id);
    assert.equal(saved.pi_session_path, realFs.realpathSync(session.path));
    assert.equal(saved.last_result.status, "completed");
    assert.ok(saved.last_result.request_id);

    const continued = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: saved.pi_session_id, task: "resume the saved session" },
      undefined,
      undefined,
      ownedSessionContext(session.id, name),
    );
    assert.equal(continued.details.ok, true, JSON.stringify(continued.details));
    assert.equal(continued.details.agent, name);
    assert.equal(continued.details.session_id, session.id);
    assert.equal(
      (continued.details as any).relaunched,
      undefined,
      "a closed generation relaunch reports no recovery reason",
    );

    assert.deepEqual(
      (await list()).saved_sessions,
      [],
      "the new generation's representation supersedes the advertisement",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(session.path, { force: true });
  }
});

test("an advertised saved session path continues when the recording was a symlink", async () => {
  setLeadEnvironment();
  const name = `saved-link-${randomUUID().slice(0, 8)}`;
  const sessionId = DEFAULT_PI_SESSION_ID;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const realPath = join(PI_AGENT_ROOT, `${name}-real-session.jsonl`);
  const linkPath = join(PI_AGENT_ROOT, `${name}-link-session.jsonl`);
  const session = {
    id: sessionId,
    path: realPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId,
          definition: name,
          label: name,
        },
      },
    ],
  };
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nsymlinked session body\n`,
    "utf8",
  );
  realFs.writeFileSync(realPath, "{}", "utf8");
  realFs.symlinkSync(realPath, linkPath);
  nativeSessions.set(sessionId, session);
  const startupMailbox = agentMailboxPath(WORKSPACE, name);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const callerContext = () => ownedSessionContext(sessionId, name, linkPath);
  try {
    const [saved] = (
      await registeredAgentTool(pi, "list").execute(
        "id",
        {},
        undefined,
        undefined,
        callerContext(),
      )
    ).details.saved_sessions as any[];
    assert.equal(saved.pi_session_path, realFs.realpathSync(linkPath));
    assert.notEqual(
      saved.pi_session_path,
      linkPath,
      "the recorded path really was a symlink",
    );

    const continued = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: saved.pi_session_path, task: "resume through the symlink" },
      undefined,
      undefined,
      callerContext(),
    );
    assert.equal(continued.details.ok, true, JSON.stringify(continued.details));
    assert.equal(continued.details.agent, name);
    assert.equal(continued.details.session_id, sessionId);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(sessionId);
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(linkPath, { force: true });
    realFs.rmSync(realPath, { force: true });
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("a local child session is continued by its exact path without rehoming", async () => {
  setLeadEnvironment();
  const name = `local-resume-${randomUUID().slice(0, 8)}`;
  const label = name;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const localDir = join(PI_AGENT_ROOT, ".pi", "sessions", "children");
  const sessionPath = join(localDir, `${name}-session.jsonl`);
  realFs.mkdirSync(localDir, { recursive: true });
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\ndefined local child\n`,
    "utf8",
  );
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  const session = {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: { sessionId: DEFAULT_PI_SESSION_ID, definition: name, label },
      },
    ],
  };
  nativeSessions.set(session.id, session);
  const launched: { args: string[]; contents: string[] }[] = [];
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  radarDaemon.onChildStart = (spawn) => ((args) => {
      launched.push({ args: [...args], contents: promptLaunchContents(args) });
    })([...spawn.argv]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: sessionPath, task: "resume the local child" },
      undefined,
      undefined,
      ownedSessionContext(session.id, label),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(launched.length, 1);
    const expected = realFs.realpathSync(sessionPath);
    assert.match(expected, /\.pi[/\\]sessions[/\\]children[/\\]/);
    assert.equal(
      launched[0]!.args[launched[0]!.args.indexOf("--session") + 1],
      expected,
      "the saved local file is resumed where it is",
    );
    assert.equal(
      launched[0]!.args.includes("--session-dir"),
      false,
      "the new-layout directory never rewrites a saved path",
    );
    assert.equal(result.details.session_id, session.id);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(session.id);
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("fabricated session metadata cannot authorize continuation", async () => {
  setLeadEnvironment();
  const name = `fabricated-owner-${randomUUID().slice(0, 8)}`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const localDir = join(PI_AGENT_ROOT, ".pi", "sessions", "children");
  const sessionPath = join(localDir, `${name}-session.jsonl`);
  realFs.mkdirSync(localDir, { recursive: true });
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${name}\n---\nunowned session\n`,
    "utf8",
  );
  realFs.writeFileSync(sessionPath, "{}", "utf8");
  nativeSessions.set(DEFAULT_PI_SESSION_ID, {
    id: DEFAULT_PI_SESSION_ID,
    path: sessionPath,
    cwd: "/tmp",
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: DEFAULT_PI_SESSION_ID,
          definition: name,
          label: name,
        },
      },
      // The file advertises the caller as its direct owner, but ownership is
      // decided by result provenance, never by this record.
      {
        type: "custom",
        customType: "pi-herdsman-session-metadata",
        data: {
          version: 1,
          sessionId: DEFAULT_PI_SESSION_ID,
          kind: "managed",
          role: name,
          parentSessionId: LEAD_SESSION_ID,
          definition: name,
          label: name,
        },
      },
    ],
  });
  const startupMailbox = agentMailboxPath(WORKSPACE, name);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "continue").execute(
      "id",
      { session: sessionPath, task: "claim an unowned session" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, false);
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(result.details.error.message, /proven session ownership tree/);
    assert.equal(
      radarDaemon.spawns.length > 0,
      false,
      "no generation is launched for an unowned session",
    );
    assert.equal(radarDaemon.spawns.length, 0);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(DEFAULT_PI_SESSION_ID);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("rejects known generated-label envelope overflow before startup", async () => {
  setLeadEnvironment();
  const label = "agent";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  realFs.rmSync(startupMailbox, { recursive: true, force: true });
  const mailboxLimit = 64 * 1024;
  realFs.mkdirSync(join(PI_AGENT_ROOT, "pi-herdsman"), { recursive: true });
  realFs.writeFileSync(
    join(PI_AGENT_ROOT, "pi-herdsman", "config.json"),
    JSON.stringify({ mailboxPayloadLimitBytes: mailboxLimit }),
  );
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const emptyEnvelope = requestRecordBytes(label, "", "");
  const task = "x".repeat(mailboxLimit - emptyEnvelope + 1);
  assert.equal(requestRecordBytes(label, "", task) > mailboxLimit, true);
  assert.equal(
    requestRecordBytes(label, "", task) <= MAILBOX_PROTOCOL_LIMIT_BYTES,
    true,
  );
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", task },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.notEqual(result.details.error.rollbackOccurred, true);
    assert.equal(radarDaemon.spawns.length, 0);
    assert.equal(realFs.existsSync(startupMailbox), false);
    assert.equal(
      radarDaemon.spawns.length > 0,
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
    realFs.rmSync(join(PI_AGENT_ROOT, "pi-herdsman", "config.json"), {
      force: true,
    });
  }
});

test("rejects an oversized assignment brief before lifecycle mutation", async () => {
  setLeadEnvironment();
  const label = "agent";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  realFs.rmSync(startupMailbox, { recursive: true, force: true });
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const task = testBrief("x".repeat(64 * 1024));
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.match(
      result.details.error.message,
      /exceeds the 65536-byte brief limit/,
    );
    assert.equal(
      radarDaemon.spawns.length,
      0,
      "oversized brief must fail before launch",
    );
    assert.equal(realFs.existsSync(startupMailbox), false);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
  }

  const reuseMailbox = agentMailboxPath(WORKSPACE, label);
  const reusePi = fakePi({});
  registerExtension!(reusePi.pi as never);
  try {
    const result = await registeredAgentTool(reusePi, "delegate").execute(
      "id",
      {
        definition: "agent",
        task: "retry after rollback",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
  } finally {
    reusePi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(reuseMailbox);
  }
});

test("plain task text and unavailable brief context are rejected before lifecycle mutation", async () => {
  setLeadEnvironment();
  const label = "agent";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  realFs.rmSync(startupMailbox, { recursive: true, force: true });
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  // Bypass registeredAgentTool, which wraps plain text into a valid brief.
  const delegate = pi.tools.find((tool) => tool.name === "agent_delegate")!;
  const missing = join(testTmpRoot, "absent-brief-input.md");
  const unavailableContext = DELEGATION_BRIEF_EXAMPLES.common.replace(
    "inputs: []",
    `inputs:\n    - reference: ${missing}\n      purpose: required background`,
  );
  assert.notEqual(unavailableContext, DELEGATION_BRIEF_EXAMPLES.common);
  try {
    for (const [task, expected] of [
      ["Just do the work", /schema/],
      [
        unavailableContext,
        new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      ],
    ] as const) {
      const result = await delegate.execute(
        "id",
        { definition: "agent", label, task },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.error.category, "invalid_request");
      assert.match(result.details.error.message, expected);
      assert.equal(radarDaemon.spawns.length, 0, "rejection must precede launch");
      assert.equal(realFs.existsSync(startupMailbox), false);
    }
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
  }
});

test("rejects invalid assignment prerequisites before lifecycle mutation", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const cases = [
    {
      operation: "delegate",
      params: {},
      message: "delegate requires definition",
    },
    {
      operation: "continue",
      params: { task: "missing session" },
      message: "continue requires session",
    },
    {
      operation: "delegate",
      params: { definition: " \t", task: " \t" },
      message: "Agent definition  \t was not found",
    },
    {
      operation: "delegate",
      params: { definition: "agent" },
      message: "delegate requires task",
    },
    {
      operation: "delegate",
      params: { definition: "agent", task: " \t" },
      message: "brief.schema: expected delegation-brief/v1",
    },
  ];

  for (const { operation, params, message } of cases) {
    const result = await registeredAgentTool(pi, operation).execute(
      "id",
      params,
      undefined,
      undefined,
      fakeContext(),
    );

    assert.equal(result.details.error.category, "invalid_request");
    if (message.startsWith("brief.")) {
      // A rejected brief carries the shape the role expects, so the caller can
      // correct it in one attempt instead of discovering fields one error at a time.
      assert.equal(
        result.details.error.message,
        `${message}\n${briefFormatHint("common")}`,
      );
    } else assert.equal(result.details.error.message, message);
    assert.ok(
      pi.calls.every(
        (args) =>
          (args[0] === "status" && args[1] === "--json") || isApiSnapshot(args),
      ),
      `invalid assignment prerequisite made unexpected calls: ${JSON.stringify(pi.calls)}`,
    );
  }
});

test("delegate keeps an explicit human-readable label", async () => {
  setLeadEnvironment();
  const label = "review-map";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "map" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.agent, label);
    assert.equal(readAgentState(startupMailbox)?.agentLabel, label);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
  }
});

test("rejects an invalid generated collision label after releasing its claim", async () => {
  setLeadEnvironment();
  const label = "a" + "b".repeat(31);
  const definitionPath = join(PI_AGENTS_DIR, `${label}.md`);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const visibleMailbox = agentMailboxPath(WORKSPACE, "other-agent");
  realFs.writeFileSync(
    definitionPath,
    `---\nname: ${label}\n---\nlong-name collision test\n`,
  );
  writeAgentState(visibleMailbox, managedState("other-agent"));
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              snapshot: {
                agents: JSON.parse(listResponse("other-agent")).agents,
                panes: [
                  {
                    pane_id: "registered-pane",
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: DEFAULT_PI_SESSION_ID,
                    },
                  },
                ],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  context.isProjectTrusted = () => {
    // Simulate the mailbox becoming visible after the assignment snapshot.
    writeAgentState(mailbox, managedState(label));
    return true;
  };

  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      {
        definition: label,
        task: "reject the oversized generated collision label",
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.error.category, "invalid_request");
    assert.equal(result.details.error.operation, "delegate");
    assert.equal(result.details.error.rollbackOccurred, false);
    assert.match(result.details.error.message, /Agent label must start/);
    assert.equal(realFs.existsSync(join(mailbox, ".starting")), false);
    // A rejected label is rejected before any effect: no Herdr topology is
    // created or closed, and the daemon is never asked to spawn.
    assert.deepEqual(
      pi.calls.filter(
        (args) =>
          (args[0] === "pane" &&
            ["split", "run", "close"].includes(args[1] ?? "")) ||
          (args[0] === "tab" && args[1] === "create") ||
          (args[0] === "agent" &&
            ["start", "rename", "close"].includes(args[1] ?? "")),
      ),
      [],
      "generated-label rejection must not mutate Herdr topology",
    );
    assert.equal(radarDaemon.spawns.length, 0);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(mailbox, { recursive: true, force: true });
    realFs.rmSync(visibleMailbox, { recursive: true, force: true });
    realFs.unlinkSync(definitionPath);
  }
});

test("a launched child's session identity comes from its own state, not a pane record", async () => {
  setLeadEnvironment();
  const label = "delayed-session-agent";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  await startRadarSession(pi);
  const result = await registeredAgentTool(pi, "delegate").execute(
    "id",
    { definition: "agent", label, task: "identity from the child" },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(result.details.ok, true, JSON.stringify(result.details));
  // The launch never asks a pane record for the child's session: the Radar
  // spawn is the one launch, binds the edge by token, and the child's own
  // startup state names the session it runs.
  assert.equal(radarDaemon.spawns.length, 1);
  const state = readAgentState(startupMailbox);
  assert.equal(state?.piSessionId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.equal(state?.piSessionFile, "/tmp/registered-agent.jsonl");
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(startupMailbox);
});
test("managed startup accepts a child whose own state arrives late", async (t) => {
  setLeadEnvironment();
  const label = "slow-startup-agent";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  radarDaemon.onChildState = async () => {
    // The child exists, but its startup acknowledgment is still to come: the
    // launch waits for the child rather than reading the wait as failure.
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  await startRadarSession(pi);
  const delegated = registeredAgentTool(pi, "delegate").execute(
    "id",
    { definition: "agent", label, task: "slow but present startup" },
    undefined,
    undefined,
    fakeContext(),
  );
  await t.waitFor(() =>
    assert.ok(
      radarDaemon.spawns.length > 0,
      "the launch did not reach the daemon",
    ),
  );
  const result = await delegated;
  assert.equal(result.details.ok, true, JSON.stringify(result.details));
  assert.ok(readAgentState(startupMailbox));
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(startupMailbox);
});
test(
  "a launch whose child never acknowledges keeps its record and closes nothing",
  { timeout: 40_000 },
  async () => {
    setLeadEnvironment();
    const label = "pane-not-ready-diagnostic";
    const startupMailbox = agentMailboxPath(WORKSPACE, label);
    // The daemon creates the pane and runs the command, and the child it starts
    // never acknowledges the launch: it can never become ready.
    radarDaemon.options.acknowledge = false;
    process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS = "500";
    const pi = fakePi({});
    registerExtension!(pi.pi as never);
    await startRadarSession(pi);
    try {
      const result = await registeredAgentTool(pi, "delegate").execute(
        "id",
        { definition: "agent", label, task: "capture the unresolved launch" },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(
        result.details.error.category,
        "pane_not_ready",
        JSON.stringify(result.details),
      );
      // The record is the diagnostic now: it names the one edge this process
      // may have created, so the launch stays accountable after it fails.
      const attempt = result.details.error.details.radarSpawn;
      assert.match(attempt.requestId, /^[0-9a-f-]{36}$/);
      assert.match(attempt.generation, /^[0-9a-f-]{36}$/);
      assert.equal(attempt.unresolved, true);
      assert.equal(result.details.error.rollbackOccurred, false);
      assert.equal(result.details.error.retryAttempted, false);
      // The durable record outlives the unknown outcome: it still names the one
      // edge this process authored, so nothing can be replayed under a new id.
      const recorded = pi.entries.filter(
        (entry: any) => entry.customType === "pi-herdsman-radar-spawn",
      );
      assert.equal(recorded.length, 2);
      assert.deepEqual(
        recorded.map((entry: any) => entry.data.stage),
        ["requested", "bound"],
      );
      assert.deepEqual(
        {
          requestId: recorded.at(-1)!.data.requestId,
          generation: recorded.at(-1)!.data.generation,
          // The daemon's own binding, recorded before the launch waited for
          // readiness: the subject it registered and the pane it created are what
          // a reload in this window holds the child by, not the child's mailbox.
          agentId: recorded.at(-1)!.data.agentId,
          paneId: recorded.at(-1)!.data.paneId,
        },
        {
          requestId: attempt.requestId,
          generation: attempt.generation,
          agentId: radarDaemon.spawns[0]!.agent_id,
          paneId: radarDaemon.spawns[0]!.pane,
        },
      );
      // Readiness stays separate from it: the child registered and wrote its own
      // state, and that state carries no acknowledgment for the launch that
      // created it.
      const state = readAgentState(startupMailbox);
      assert.equal(state?.piSessionId, DEFAULT_PI_SESSION_ID);
      assert.equal(state?.startupAck, undefined);
      assert.equal(radarDaemon.spawns.length, 1);
      // The binding outlives the reload this window ends in: the returning session
      // reads the daemon's own subject and pane out of its record rather than
      // inferring a location from the mailbox, and still closes nothing.
      for (const handler of pi.events.get("session_shutdown") ?? [])
        await handler(undefined, fakeContext());
      for (const handler of pi.events.get("session_start") ?? [])
        await handler(undefined, fakeContext());
      const reloaded = pi.entries.filter(
        (entry: any) => entry.customType === "pi-herdsman-radar-spawn",
      );
      assert.equal(reloaded.length, 2);
      assert.equal(reloaded.at(-1)!.data.stage, "bound");
      assert.equal(reloaded.at(-1)!.data.agentId, radarDaemon.spawns[0]!.agent_id);
      assert.equal(reloaded.at(-1)!.data.paneId, radarDaemon.spawns[0]!.pane);
      assert.equal(radarDaemon.closes.size, 0);
      // Nothing is closed and nothing is re-dispatched: the pane and the edge
      // belong to the daemon, and a second spawn would create a second child.
      assert.deepEqual(
        pi.calls.filter(
          (args) =>
            isPreservePaneStop(args) ||
            isPaneClose(args) ||
            isTabClose(args) ||
            (args[0] === "pane" && args[1] === "split") ||
            (args[0] === "agent" && args[1] === "start"),
        ),
        [],
      );
    } finally {
      delete process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS;
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startupMailbox);
    }
  },
);
test("a late daemon recovers a pending location without replacing the identity", async () => {
  setLeadEnvironment();
  // Nothing is listening on this socket yet, so this process cannot learn where
  // it is. That is a gap in the evidence, not a process without a pane: an
  // immutable registration written from it could never acquire one, and the
  // session would be unable to place a fresh worker for its whole life.
  process.env.RADAR_CONTROL_SOCKET = join(tmpdir(), "absent-radar-late.sock");
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  for (const handler of pi.events.get("session_start") ?? [])
    await handler(undefined, context);
  assert.equal(radarDaemon.registerCalls.length, 0);
  assert.equal(radarDaemon.spawns.length, 0);
  const refused = await registeredAgentTool(pi, "delegate").execute(
    "late",
    { definition: "agent", label: "late-child", task: "late" },
    undefined,
    undefined,
    context,
  );
  assert.equal(refused.details.ok, false, JSON.stringify(refused.details));
  assert.equal(refused.details.error.category, "invalid_request");
  assert.match(refused.details.error.message, /Radar daemon is unavailable/);
  // The daemon answers now, and the same process registers once, with the pane
  // the observation reports - no second incarnation and no rewritten record.
  await ensureRadarDaemon();
  const started = await registeredAgentTool(pi, "delegate").execute(
    "late",
    { definition: "agent", label: "late-child", task: "late" },
    undefined,
    undefined,
    context,
  );
  assert.equal(started.details.ok, true, JSON.stringify(started.details));
  const registrations = radarDaemon.registerCalls.filter(
    (call) => call.params.source === RADAR_SUBJECT_SOURCE,
  );
  assert.equal(registrations.length, 1, JSON.stringify(registrations));
  assert.equal(
    (registrations[0]!.params.location as { pane?: string }).pane,
    `tmux:${FIXTURE_TMUX_SERVER}:${FIXTURE_LEAD_PANE}`,
  );
  const incarnation = registrations[0]!.params.incarnation;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  assert.equal(
    radarDaemon.registerCalls.filter(
      (call) => call.params.source === RADAR_SUBJECT_SOURCE,
    ).length,
    1,
  );
  assert.equal(radarDaemon.registerCalls[0]!.params.incarnation, incarnation);
});

test("a launch whose binding cannot be recorded is unresolved and closes nothing", async () => {
  setLeadEnvironment();
  const label = "binding-record-refused";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS = "500";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  await startRadarSession(pi);
  // The session's own entry store refuses the daemon's binding. The launch has
  // then created a child it cannot hold: it reports that edge unresolved rather
  // than assigning work to a child no reload could prove.
  const appendEntry = pi.pi.appendEntry.bind(pi.pi);
  pi.pi.appendEntry = ((customType: string, data: any) => {
    if (customType === "pi-herdsman-radar-spawn" && data.stage === "bound")
      throw new Error("the session entry store refused the record");
    appendEntry(customType, data);
  }) as typeof pi.pi.appendEntry;
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "record the binding" },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(
      result.details.error.category,
      "pane_not_ready",
      JSON.stringify(result.details),
    );
    assert.equal(result.details.error.details.radarSpawn.unresolved, true);
    // No durable record names the child, so the failure names only the request
    // the daemon was handed.
    assert.equal(result.details.error.details.radarSpawn.agentId, undefined);
    assert.equal(result.details.error.details.radarSpawn.paneId, undefined);
    assert.deepEqual(
      pi.entries
        .filter((entry: any) => entry.customType === "pi-herdsman-radar-spawn")
        .map((entry: any) => entry.data.stage),
      ["requested"],
    );
    // The child the daemon bound is left alone: nothing here may close or
    // re-dispatch a child this process could not record.
    assert.equal(radarDaemon.closes.size, 0);
    assert.deepEqual(
      pi.calls.filter(
        (args) =>
          isPreservePaneStop(args) || isPaneClose(args) || isTabClose(args),
      ),
      [],
    );
  } finally {
    pi.pi.appendEntry = appendEntry;
    delete process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
  }
});
test("an unresolved launch cleans its own resources and a same-label retry reaches one child", async () => {
  setLeadEnvironment();
  const label = "agent";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  radarDaemon.options.bind = false;
  process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS = "1200";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  await startRadarSession(pi);
  const tool = registeredAgentTool(pi, "delegate");
  const context = fakeContext();
  try {
    const failed = await tool.execute(
      "id",
      { definition: "agent", label, task: "first attempt" },
      undefined,
      undefined,
      context,
    );
    assert.equal(
      failed.details.error.category,
      "pane_not_ready",
      JSON.stringify(failed.details),
    );
    assert.equal(readAgentState(startupMailbox), undefined);
    assert.equal(realFs.existsSync(join(startupMailbox, ".starting")), false);
    assert.equal(radarDaemon.spawns.length, 1);
    const listed = await registeredAgentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(listed.details.agents, []);

    radarDaemon.options.bind = true;
    const retried = await tool.execute(
      "id",
      { definition: "agent", task: "corrected attempt" },
      undefined,
      undefined,
      context,
    );
    assert.equal(retried.details.ok, true, JSON.stringify(retried.details));
    // The retry is its own launch: the failed one is never re-sent, and only
    // one child is bound across both attempts.
    assert.equal(radarDaemon.spawns.length, 2);
    assert.equal(
      radarDaemon.spawns.filter((spawn) => spawn.agent_id !== undefined).length,
      1,
    );
    assert.equal(readAgentState(startupMailbox)?.agentLabel, label);
    const afterRetry = await registeredAgentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(afterRetry.details.agents.length, 1);
  } finally {
    delete process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
  }
});
test("an aborted launch ends without a later lookup or timer", async () => {
  setLeadEnvironment();
  const controller = new AbortController();
  const label = "aborted-session-agent";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  radarDaemon.onChildState = () => new Promise<void>(() => undefined);
  process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS = "5000";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  await startRadarSession(pi);
  try {
    const startedAt = Date.now();
    const delegated = registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "abort the launch" },
      controller.signal,
      undefined,
      fakeContext(),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await delegated;
    assert.ok(Date.now() - startedAt < 2_500, "the abort did not end the wait");
    assert.equal(
      result.details.error.category,
      "pane_not_ready",
      JSON.stringify(result.details),
    );
    assert.match(
      result.details.error.details.radarSpawn.requestId,
      /^[0-9a-f-]{36}$/,
    );
    // One dispatch, and no further work after the abort: the daemon keeps the
    // edge it created, and the launch does not chase it.
    assert.equal(radarDaemon.spawns.length, 1);
    const callsAfterAbort = pi.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(pi.calls.length, callsAfterAbort);
  } finally {
    delete process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS;
    radarDaemon.onChildState = undefined;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
  }
});

type WaitFor = { waitFor: (fn: () => Promise<void>) => Promise<void> };

/**
 * A Radar child this process did not launch: an edge the daemon created, a child
 * that wrote its own binding and state, and the durable record a launch persists
 * before it dials the daemon. It is the shortest state in which a child is
 * closable without delegating a task to it.
 */
async function radarChildForClose(
  t: WaitFor,
  pi: ReturnType<typeof fakePi>,
  context: ReturnType<typeof fakeContext>,
  label: string,
): Promise<{ mailbox: string; paneId: string; agentId: string; requestId: string }> {
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const runId = randomUUID();
  const generation = randomUUID();
  const requestId = randomUUID();
  const client = createRadarClient({ env: process.env });
  const spawned = await client.spawn({
    request_id: requestId,
    generation,
    parent: randomUUID(),
    parent_session_id: LEAD_SESSION_ID,
    executable: "/usr/bin/pi",
    argv: [],
    cwd: "/tmp",
    env: {
      PI_HERDSMAN_LAUNCH_GENERATION: generation,
      PI_HERDSMAN_MAILBOX: mailbox,
      PI_HERDSMAN_RUN_ID: runId,
      PI_HERDSMAN_OWNER_SESSION_ID: LEAD_SESSION_ID,
      PI_HERDSMAN_WORKSPACE_ID: WORKSPACE,
      PI_HERDSMAN_LABEL: label,
      PI_HERDSMAN_AGENT_DEFINITION: "agent",
    },
  });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  if (!spawned.ok) throw new Error("the daemon refused the spawn");
  const paneId = spawned.value.location?.pane;
  assert.ok(paneId, JSON.stringify(spawned.value));
  let agentId: string | undefined;
  await t.waitFor(async () => {
    const edge = await client.spawnGet(requestId);
    assert.equal(edge.ok, true, JSON.stringify(edge));
    if (edge.ok) agentId = edge.value.edge.bound?.agent_id;
    assert.ok(agentId, "the child never bound to its launch");
  });
  pi.entries.push({
    type: "custom",
    customType: "pi-herdsman-radar-spawn",
    data: {
      stage: "bound",
      requestId,
      generation,
      runId,
      label,
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      mailbox,
      agentId,
      paneId,
    },
  });
  return { mailbox, paneId: paneId!, agentId: agentId!, requestId };
}

type RadarCloseRecord = { stage: string; requestId: string };

function closeEntries(pi: ReturnType<typeof fakePi>): RadarCloseRecord[] {
  return pi.entries
    .filter((entry) => entry.customType === "pi-herdsman-radar-close")
    .map((entry) => entry.data as RadarCloseRecord);
}

test("an unresolved launch holds its label against a second same-label delegation", async () => {
  setLeadEnvironment();
  // Each of these tests drives the fixture daemon directly, so it starts from a
  // daemon without the previous test's spawns and children.
  radarDaemon.reset();
  const label = "held-label";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS = "1200";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  // The durable launch record is a session entry, so the context has to be the
  // session this process appends to.
  const context = fakeContext(pi.entries);
  try {
    await startRadarSession(pi, context);
    // The unbound daemon is set once the session's own daemon exists: a setting
    // changed before that becomes part of the daemon's creation state, which a
    // later reset would restore for every test that follows.
    radarDaemon.options.bind = false;
    const tool = registeredAgentTool(pi, "delegate");
    const first = await tool.execute(
      "id",
      { definition: "agent", label, task: "first attempt" },
      undefined,
      undefined,
      context,
    );
    assert.equal(
      first.details.error.category,
      "pane_not_ready",
      JSON.stringify(first.details),
    );
    assert.equal(radarDaemon.spawns.length, 1);
    // The edge may have produced a child that has not registered or written state
    // yet, which is exactly what no read of the mailbox can rule out. The label
    // stays held by that launch, so the second attempt has to reconcile it
    // instead of starting a second child in the same mailbox.
    radarDaemon.options.bind = true;
    const second = await tool.execute(
      "id",
      { definition: "agent", label, task: "second attempt" },
      undefined,
      undefined,
      context,
    );
    assert.equal(second.details.ok, false, JSON.stringify(second.details));
    assert.equal(second.details.error.category, "agent_label_exists");
    assert.match(
      second.details.error.message,
      /unresolved Radar launch/,
      JSON.stringify(second.details),
    );
    assert.equal(radarDaemon.spawns.length, 1);
    // The record is the session's, not this process's memory: a reload reads the
    // same launch and still refuses to create a second child.
    pi.events.get("session_shutdown")?.[0]();
    await startRadarSession(pi, context);
    const third = await tool.execute(
      "id",
      { definition: "agent", label, task: "third attempt" },
      undefined,
      undefined,
      context,
    );
    assert.equal(third.details.error.category, "agent_label_exists");
    assert.equal(radarDaemon.spawns.length, 1);
  } finally {
    delete process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS;
    radarDaemon.options.bind = true;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
    radarDaemon.reset();
  }
});

test("a launch the daemon refused frees its label for the next attempt", async () => {
  setLeadEnvironment();
  radarDaemon.reset();
  const label = "refused-launch";
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  try {
    await startRadarSession(pi, context);
    // Set once the daemon exists, so the refusal is this test's and not a
    // creation setting a later reset would restore.
    radarDaemon.options.refuseSpawn = {
      code: "refused",
      message: "this daemon will not create that child",
    };
    const tool = registeredAgentTool(pi, "delegate");
    const refused = await tool.execute(
      "id",
      { definition: "agent", label, task: "first attempt" },
      undefined,
      undefined,
      context,
    );
    assert.equal(refused.details.ok, false, JSON.stringify(refused.details));
    assert.equal(radarDaemon.spawns.length, 0);
    // A refusal is the one ending that proves no child was created, so the label
    // is free: the next attempt is its own launch rather than a reconciliation of
    // an edge that may hold a child.
    delete radarDaemon.options.refuseSpawn;
    const retried = await tool.execute(
      "id",
      { definition: "agent", label, task: "second attempt" },
      undefined,
      undefined,
      context,
    );
    assert.equal(retried.details.ok, true, JSON.stringify(retried.details));
    assert.equal(radarDaemon.spawns.length, 1);
  } finally {
    delete radarDaemon.options.refuseSpawn;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startupMailbox);
    radarDaemon.reset();
  }
});

test("a fresh Radar assignment is addressed to the process its launch bound", async (t) => {
  setLeadEnvironment();
  radarDaemon.reset();
  const label = "fresh-addressed";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  await startRadarSession(pi, context);
  try {
    const result = await registeredAgentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "the first task is addressed" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    const state = readAgentState(mailbox);
    assert.ok(state?.activeRequestId, JSON.stringify(state));
    const spawn = radarDaemon.spawns[0]!;
    // The child's own acknowledgment is the durable record of what it accepted:
    // an identity echo exists only for an addressed request, and the fixture
    // child accepts one only when the address names its own incarnation.
    await t.waitFor(() => {
      const ack = readAgentState(mailbox)?.lastAck;
      assert.equal(ack?.requestId, state.activeRequestId);
      assert.equal(ack?.accepted, true, JSON.stringify(ack));
    });
    assert.deepEqual(readAgentState(mailbox)?.lastAck?.identity, {
      subject: spawn.agent_id,
      source: RADAR_SUBJECT_SOURCE,
      incarnation: spawn.incarnation,
      generation: spawn.env.PI_HERDSMAN_LAUNCH_GENERATION,
    });
  } finally {
    delete process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    radarDaemon.reset();
  }
});
test("a lost close reply reconciles the same request after the pane is gone", async (t) => {
  setLeadEnvironment();
  radarDaemon.reset();
  const label = "lost-close-child";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  try {
    await startRadarSession(pi, context);
    const { mailbox } = await radarChildForClose(t, pi, context, label);
    radarDaemon.options.dropCloseReply = true;
    const first = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(first.details.ok, false, JSON.stringify(first.details));
    const dispatched = closeEntries(pi).at(-1)!;
    assert.equal(dispatched.stage, "unknown");
    // The daemon applied the close and this process never learned it, so nothing
    // was torn down: a pane that is gone is not the close this process asked for.
    assert.notEqual(readAgentState(mailbox), undefined);
    radarDaemon.options.dropCloseReply = false;
    const retried = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(retried.details.ok, true, JSON.stringify(retried.details));
    const closes = closeEntries(pi);
    // One request, replayed: the daemon answered the close it already held, and
    // the mailbox was retired only after that answer.
    assert.deepEqual(
      [...new Set(closes.map((entry) => entry.requestId))],
      [dispatched.requestId],
    );
    assert.equal(closes.at(-1)!.stage, "completed");
    assert.equal(radarDaemon.closes.size, 1);
    assert.equal(readAgentState(mailbox), undefined);
  } finally {
    radarDaemon.options.dropCloseReply = false;
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
  }
});

test("a close whose completion could not be recorded stays reconcilable", async (t) => {
  setLeadEnvironment();
  radarDaemon.reset();
  const label = "unrecorded-close-child";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  const appendEntry = pi.pi.appendEntry.bind(pi.pi);
  try {
    await startRadarSession(pi, context);
    const { mailbox } = await radarChildForClose(t, pi, context, label);
    pi.pi.appendEntry = (customType: string, data: unknown) => {
      if (
        customType === "pi-herdsman-radar-close" &&
        (data as { stage?: string }).stage === "completed"
      )
        throw new Error("the session could not record the close");
      appendEntry(customType, data);
    };
    const first = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(first.details.ok, false, JSON.stringify(first.details));
    // The daemon applied the close; only this process's record of the outcome is
    // missing, which is what leaves the dispatched request the way back in.
    assert.equal(closeEntries(pi).at(-1)!.stage, "dispatched");
    assert.notEqual(readAgentState(mailbox), undefined);
    pi.pi.appendEntry = appendEntry;
    const retried = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(retried.details.ok, true, JSON.stringify(retried.details));
    assert.equal(closeEntries(pi).at(-1)!.stage, "completed");
    assert.equal(readAgentState(mailbox), undefined);
  } finally {
    pi.pi.appendEntry = appendEntry;
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
  }
});

test("a confirmed close resumes its own cleanup after a cleanup failure", async (t) => {
  setLeadEnvironment();
  radarDaemon.reset();
  const label = "confirmed-close-cleanup";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  try {
    await startRadarSession(pi, context);
    const { mailbox } = await radarChildForClose(t, pi, context, label);
    const state = readAgentState(mailbox)!;
    // The child is not consuming assignments, so the request this mailbox is
    // still carrying survives for local cleanup to remove.
    radarDaemon.options.acceptAssignments = false;
    writeRequest(mailbox, {
      version: 5,
      runId: state.runId,
      requestId: randomUUID(),
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      kind: "task",
      text: "the assignment this mailbox still owes",
      createdAt: Date.now(),
    });
    support.failNextRequestRemoval = true;
    const first = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    // The daemon closed the pane and this process recorded that; only its own
    // mailbox cleanup failed, so the label's state stays as cleanup left it.
    assert.equal(first.details.ok, true, JSON.stringify(first.details));
    assert.match(String(first.details.cleanup_error), /cleanup failed/);
    assert.equal(closeEntries(pi).at(-1)!.stage, "completed");
    assert.equal(radarDaemon.closes.size, 1);
    assert.ok(readAgentState(mailbox));
    const recorded = closeEntries(pi).at(-1)!.requestId;
    // Cache loss: the retry holds this session's durable entries and no runtime
    // for the launch whose pane is gone.
    for (const handler of pi.events.get("session_shutdown") ?? [])
      await handler(undefined, context);
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
    const retried = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(retried.details.ok, true, JSON.stringify(retried.details));
    assert.equal(retried.details.cleanup_error, undefined);
    assert.equal(readAgentState(mailbox), undefined);
    assert.equal(realFs.existsSync(mailbox), false);
    // One physical close, recorded once: the retry finished local cleanup.
    assert.equal(radarDaemon.closes.size, 1);
    assert.deepEqual(
      [...new Set(closeEntries(pi).map((entry) => entry.requestId))],
      [recorded],
    );
  } finally {
    support.failNextRequestRemoval = false;
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
  }
});

test("a confirmed close is never resumed over the generation that replaced it", async (t) => {
  setLeadEnvironment();
  radarDaemon.reset();
  const label = "confirmed-close-replaced";
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  try {
    await startRadarSession(pi, context);
    const gone = await radarChildForClose(t, pi, context, label);
    const goneState = readAgentState(gone.mailbox)!;
    // The generation before this one was closed and its completion recorded,
    // while its own cleanup never ran.
    pi.entries.push({
      type: "custom",
      customType: "pi-herdsman-radar-close",
      data: {
        stage: "completed",
        requestId: randomUUID(),
        spawnRequestId: gone.requestId,
        source: RADAR_SUBJECT_SOURCE,
        incarnation: radarDaemon.spawns.at(-1)!.incarnation,
        intent: "complete",
        runId: goneState.runId,
        label,
        ownerSessionId: goneState.ownerSessionId,
        mailbox: gone.mailbox,
      },
    });
    const recorded = closeEntries(pi).at(-1)!;
    // The label is now held by a new generation: its own run, its own bound
    // pane, and a state the previous run's record does not describe.
    const replacement = await radarChildForClose(t, pi, context, label);
    const replacedRun = readAgentState(replacement.mailbox)!.runId;
    assert.equal(replacement.mailbox, gone.mailbox);
    assert.notEqual(replacedRun, goneState.runId);
    // The replacement's own presence cannot be established, and the generation
    // that is gone is not evidence about this one: the close refuses and leaves
    // the replacement where it is.
    radarDaemon.options.locationEvidence = "absent";
    const refused = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(refused.details.ok, false, JSON.stringify(refused.details));
    assert.equal(refused.details.error.category, "target_ambiguous");
    assert.equal(radarDaemon.closes.size, 0);
    assert.equal(readAgentState(replacement.mailbox)!.runId, replacedRun);
    assert.equal(closeEntries(pi).length, 1);
    // With the replacement's own presence established, the close acts on its own
    // launch. The recorded close of the generation before it is still not the
    // authority for this one: resuming it would have retired the mailbox without
    // closing this pane.
    radarDaemon.options.locationEvidence = "present";
    const closed = await registeredAgentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.deepEqual(
      [...radarDaemon.closes.values()].map((close) => close.pane),
      [replacement.paneId],
    );
    assert.equal(closeEntries(pi)[0]!.requestId, recorded.requestId);
    assert.equal(closeEntries(pi)[0]!.stage, "completed");
    assert.equal(closeEntries(pi).at(-1)!.runId, replacedRun);
    assert.notEqual(closeEntries(pi).at(-1)!.requestId, recorded.requestId);
    assert.equal(readAgentState(replacement.mailbox), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
  }
});
