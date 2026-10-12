import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { beforeEach, mock, test } from "node:test";
import { Value } from "typebox/value";
import { DELEGATION_BRIEF_EXAMPLES } from "./briefs.ts";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import { RADAR_SUBJECT_SOURCE } from "./radar-execution.ts";
import type { ExecHandler, FixtureIdentity } from "./support.ts";
import { claimProcessLock } from "./lock.ts";
import { resultPath, resultRef } from "./storage.ts";
import { IDLE_WAKE_PROMPT } from "./idle-wake.ts";
import { WAKE_CONSUMER_OFFER } from "./advisory-wake.ts";
import support, {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  PARENT_SESSION_ID,
  PI_AGENTS_DIR,
  REQUEST_ID,
  LEAD_SESSION_ID,
  AGENT_ID,
  WORKSPACE,
  cascadeExecutor,
  defaultFixtureIdentity,
  delegatedLifecycleExecutor,
  delegationLockPathForTest,
  assignmentLockPathForTest,
  fakeContext,
  fakePi,
  fakeAgentContext,
  isAgentList,
  isApiSnapshot,
  isHerdrList,
  isPaneClose,
  isPaneList,
  isPreservePaneStop,
  isTabClose,
  isTabList,
  listResponse,
  managedState,
  nativeSessions,
  openedSessionPaths,
  agentControllerExecutor,
  readPendingAsk,
  readRequest,
  readResult,
  readAgentState,
  realFs,
  watchedResultPaths,
  recoveryIdentity,
  radarDaemon,
  radarObservedFleet,
  radarSpawnRecords,
  registerExtension,
  removeAsk,
  removeRequest,
  removeResult,
  resetAgentMailbox,
  resultEntryDetails,
  leadExec,
  runScopedHerdrAlias,
  setLeadEnvironment,
  setAgentEnvironment,
  ensureRadarDaemon,
  delegateRadarChild,
  listAgentStates,
  startRadarSession,
  startupExecutor,
  testChildCommand,
  testTmpRoot,
  truncateModelText,
  agentMailboxPath,
  writeAsk,
  writeRequest,
  writeResult,
  writeAgentState,
} from "./support.ts";
const { updateConfig } = await import("./config.ts");
// These suites cover the one-shot lifecycle; retained workers are the default,
// and the tests that exercise retention opt in or out explicitly.
beforeEach(() => updateConfig("retainWorkers", false));
const agentTool = (pi: ReturnType<typeof fakePi>, name: string) => {
  const tool = pi.tools.find(
    (candidate) => candidate.name === `agent_${name}`,
  )!;
  if (name !== "delegate" && name !== "continue") return tool;
  return {
    ...tool,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      const params = args[1] as Record<string, unknown> | undefined;
      if (
        typeof params?.task !== "string" ||
        params.task.trimStart().startsWith("---")
      )
        return tool.execute(...args);
      const next = [...args] as Parameters<typeof tool.execute>;
      next[1] = {
        ...params,
        task: `${DELEGATION_BRIEF_EXAMPLES.common.trimEnd()}\n\nAssignment-specific detail:\n${params.task}`,
      } as never;
      return tool.execute(...next);
    },
  };
};

test("combined status reports a completed agent as pending, not active", async () => {
  setAgentEnvironment("status-pending-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("status-pending-parent");
  const triggerRequestId = randomUUID();
  const pendingRequestId = triggerRequestId;
  const trigger = {
    ...managedState(
      "status-trigger-child",
      undefined,
      recoveryIdentity("status-trigger-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/status-trigger-child.jsonl",
    completedRequestId: triggerRequestId,
  };
  const pending = {
    ...managedState(
      "status-pending-child",
      undefined,
      recoveryIdentity("status-pending-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "22222222-2222-4222-8222-222222222222",
    piSessionFile: "/tmp/status-pending-child.jsonl",
    completedRequestId: pendingRequestId,
  };
  const settling = {
    ...managedState(
      "status-settling-child",
      undefined,
      recoveryIdentity("status-settling-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/status-settling-child.jsonl",
  };
  const states = [parent, trigger, pending, settling];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  for (const [index, state] of states.entries())
    writeAgentState(mailboxes[index], state);
  const writeChildResult = (
    state: ManagedAgentState,
    mailbox: string,
    requestId: string,
    text: string,
  ) =>
    writeResult(mailbox, {
      version: 5,
      runId: state.runId,
      requestId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      status: "completed",
      text,
      completedAt: Date.now(),
    });
  writeChildResult(trigger, mailboxes[1], triggerRequestId, "trigger");
  writeChildResult(pending, mailboxes[2], pendingRequestId, "pending");
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
  ];
  const pi = fakePi({
    entries,
    exec: agentControllerExecutor(parent, [trigger, pending, settling]),
    sendMessage: (message) => entries.push(message),
  });
  registerExtension!(pi.pi as never);
  try {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, fakeAgentContext(entries));
    const resultMessages = pi.sentMessageCalls.filter(
      ({ message }) =>
        (message as any).customType === "pi-herdsman-agent-result",
    );
    assert.equal(resultMessages.length, 2);
    const statuses = resultMessages.map(
      ({ message }) => (message as any).details,
    );
    assert.deepEqual(
      new Set(statuses.map((details) => details.agentLabel)),
      new Set(["status-trigger-child", "status-pending-child"]),
    );
    assert.deepEqual(
      Object.fromEntries(
        statuses.map((details) => [details.agentLabel, details.resultIndex]),
      ),
      {
        "status-trigger-child": 1,
        "status-pending-child": 1,
      },
      "result indexes are scoped to each logical agent label",
    );
    assert.equal(
      statuses.filter(
        (details) =>
          details.activeDirectChildCount === 0 &&
          details.pendingDirectResultCount === 1 &&
          details.unresolvedDirectChildCount === 1,
      ).length,
      1,
      "the sibling sharing a request ID remains counted while the exact current child is excluded",
    );
    assert.equal(
      statuses.filter(
        (details) =>
          details.activeDirectChildCount === 0 &&
          details.pendingDirectResultCount === 0 &&
          details.unresolvedDirectChildCount === 0,
      ).length,
      1,
      "the exact current child is excluded once its sibling result is delivered",
    );
    assert.equal(
      resultMessages.some(({ message }) => {
        const content = String((message as any).content);
        const status = content.slice(content.lastIndexOf("Delegation status:"));
        return (
          (message as any).details.activeDirectChildCount === 0 &&
          (message as any).details.pendingDirectResultCount === 1 &&
          (message as any).details.unresolvedDirectChildCount === 1 &&
          status.startsWith(
            "Delegation status: 0 active direct agents; 1 pending direct result; 1 direct agent assignment remains unresolved.",
          ) &&
          status.includes("physical disappearance is not completion")
        );
      }),
      true,
    );
    assert.equal(
      pi.sentMessageCalls.some(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ),
      false,
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  }
});

test("conflicting same-request entries do not suppress an exact combined result", async (t) => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const childMailbox = agentMailboxPath(WORKSPACE, "queued-child");
  resetAgentMailbox(childMailbox);
  const childLaunch = await radarDaemon.adoptRetainedChild({
    label: "queued-child",
    runId: randomUUID(),
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    mailbox: childMailbox,
    pane: "queued-child-pane",
  });
  const child = {
    ...readAgentState(childMailbox)!,
    completedRequestId: REQUEST_ID,
  };
  writeAgentState(childMailbox, child);
  writeResult(childMailbox, {
    version: 5,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    status: "completed",
    text: "queued child result",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: childLaunch,
    },
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "agent",
        label: process.env.PI_HERDSMAN_LABEL ?? "agent",
      },
    },
    {
      customType: "pi-herdsman-agent-result",
      details: {
        ...resultEntryDetails(child, REQUEST_ID),
        runId: "11111111-1111-4111-8111-111111111111",
        ownerSessionId: "22222222-2222-4222-8222-222222222222",
        agentLabel: "different-agent",
        paneId: "different-pane",
        piSessionId: "33333333-3333-4333-8333-333333333333",
        piSessionFile: "/tmp/different-agent.jsonl",
      },
    },
    {
      customType: "unrelated-custom-message",
      details: {
        ...resultEntryDetails(child, REQUEST_ID),
        paneId: "conflicting-pane",
        piSessionFile: "/tmp/conflicting-agent.jsonl",
      },
    },
  ];
  let queued = 0;
  const pi = fakePi({
    entries,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result") queued++;
      else entries.push(message);
    },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    assert.equal(queued, 1);
    assert.ok(readResult(childMailbox, REQUEST_ID));
    assert.deepEqual(
      Object.fromEntries(
        Object.entries((pi.sent[0] as any).details).filter(([key]) =>
          [
            "runId",
            "requestId",
            "ownerSessionId",
            "workspaceId",
            "agentLabel",
            "paneId",
            "cwd",
            "piSessionId",
            "piSessionFile",
          ].includes(key),
        ),
      ),
      resultEntryDetails(child, REQUEST_ID),
      "result persistence details must carry the complete child identity",
    );

    await pi.events.get("agent_settled")![0](undefined, context);
    assert.equal(queued, 2, "a conflicting entry must not suppress redelivery");
    assert.ok(readResult(childMailbox, REQUEST_ID));

    entries.push({
      message: {
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(child, REQUEST_ID),
      },
    });
    await pi.events.get("agent_settled")![0](undefined, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(
      String((pi.sent[0] as any).content).endsWith(
        "Delegation status: 0 active direct agents; 0 pending direct results; all direct agent assignments are resolved.",
      ),
    );
    assert.equal((pi.sent[0] as any).details.unresolvedDirectChildCount, 0);
    assert.equal((pi.sent[0] as any).details.activeDirectChildCount, 0);
    assert.equal((pi.sent[0] as any).details.pendingDirectResultCount, 0);
    await pi.events.get("agent_settled")![0](undefined, context);
    await t.waitFor(() =>
      assert.equal(
        readResult(childMailbox, REQUEST_ID),
        undefined,
        "exact persisted result did not clean up",
      ),
    );
    assert.equal(
      pi.sentMessageCalls.some(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(childMailbox);
  }
});

test("reload result recovery rejects wrong owners and replacement identities", async () => {
  const label = "reload-proof-child";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const resultFor = (state: ManagedAgentState): ResultRecord => ({
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "must not replay",
    completedAt: Date.now(),
  });

  setLeadEnvironment();
  const wrongOwner = {
    ...managedState(label, undefined, identity),
    ownerSessionId: "11111111-1111-4111-8111-111111111111",
    completedRequestId: REQUEST_ID,
  };
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, wrongOwner);
  writeResult(mailbox, resultFor(wrongOwner));
  const noLive = cascadeExecutor([]);
  const wrongOwnerPi = fakePi({ exec: noLive.exec });
  registerExtension!(wrongOwnerPi.pi as never);
  try {
    await wrongOwnerPi.events.get("session_start")![0](
      undefined,
      fakeContext(wrongOwnerPi.entries),
    );
    assert.equal(
      wrongOwnerPi.sent.some(
        (message: any) => message.customType === "pi-herdsman-agent-result",
      ),
      false,
    );
    assert.ok(readResult(mailbox, REQUEST_ID));
  } finally {
    wrongOwnerPi.events.get("session_shutdown")?.[0]();
  }

  setLeadEnvironment();
  const oldState = {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  };
  const replacement = {
    ...managedState(label, undefined, {
      paneId: `${label}-replacement-pane`,
      tabId: `${label}-replacement-tab`,
      piSessionId: "22222222-2222-4222-8222-222222222222",
      piSessionFile: `/tmp/${label}-replacement.jsonl`,
    }),
    runId: "33333333-3333-4333-8333-333333333333",
  };
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, oldState);
  writeResult(mailbox, resultFor(oldState));
  // The daemon reports the replacement generation's pane, so the generation the
  // mailbox records is not the one it is holding.
  observeFleet([{ state: replacement }]);
  const replacementPi = fakePi({
    persistMessages: true,
  });
  registerExtension!(replacementPi.pi as never);
  try {
    await replacementPi.events.get("session_start")![0](
      undefined,
      fakeContext(replacementPi.entries),
    );
    assert.equal(
      replacementPi.sent.some(
        (message: any) => message.customType === "pi-herdsman-agent-result",
      ),
      true,
    );
    assert.deepEqual([...radarDaemon.closes.values()], []);
    assert.equal(readResult(mailbox, REQUEST_ID), undefined);
    assert.equal(readAgentState(mailbox), undefined);
  } finally {
    replacementPi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("an unresolved Radar launch retains its durable evidence and closes nothing", async () => {
  setLeadEnvironment();
  const label = "rollback-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  // The child registers with the launch's own token and then never acknowledges
  // its generation: the daemon created the pane, the child is not ready, and the
  // outcome is unknown. Nothing may be closed, replayed or handed an assignment.
  radarDaemon.options.acknowledge = false;
  // The launch's own readiness wait is what decides this, so the test bounds it
  // instead of waiting out the production default.
  const previousTimeout = process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS;
  process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS = "400";
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "keep the launch accountable" },
      undefined,
      undefined,
      fakeContext(),
    );
    const error = result.details.error as any;
    assert.equal(error.category, "pane_not_ready");
    assert.equal(error.rollbackOccurred, false);
    assert.equal(error.details.radarSpawn.unresolved, true);
    assert.match(error.details.radarSpawn.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(typeof error.details.radarSpawn.generation, "string");
    // One request id authored one pane, and an unknown outcome is never read as
    // a failure to retry: the daemon's record is the only record of this spawn.
    assert.equal(radarDaemon.spawns.length, 1);
    assert.equal(
      radarDaemon.spawns[0]!.request_id,
      error.details.radarSpawn.requestId,
    );
    assert.equal(radarDaemon.closes.size, 0);
    // The launch record is written before the daemon is dialed, and the daemon's
    // own binding is written before the launch waits for readiness: a reload reads
    // this one request id, its subject and its pane back out of the session
    // instead of the runtime cache. A failure payload is not evidence; these
    // entries are.
    const records = radarSpawnRecords(pi);
    assert.deepEqual(
      records.map((entry: any) => entry.data.stage),
      ["requested", "bound"],
    );
    const record = (records.at(-1) as any).data;
    assert.equal(record.requestId, error.details.radarSpawn.requestId);
    assert.equal(record.generation, error.details.radarSpawn.generation);
    assert.equal(record.agentId, radarDaemon.spawns[0]!.agent_id);
    assert.equal(record.paneId, radarDaemon.spawns[0]!.pane);
    assert.equal(typeof record.mailbox, "string");
    assert.equal(typeof record.runId, "string");
    // The child registered and wrote its own state, and the launch is still
    // unresolved: a registered child is not a ready one, and nothing may be
    // closed, replayed or handed the assignment for it.
    assert.equal(readAgentState(mailbox)?.agentLabel, label);
  } finally {
    radarDaemon.options.acknowledge = true;
    if (previousTimeout === undefined)
      delete process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS;
    else process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS = previousTimeout;
    resetAgentMailbox(mailbox);
  }
});

test("a refused Radar spawn rolls back nothing and leaves no phantom child", async () => {
  setLeadEnvironment();
  const label = "persistent-close-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  // A daemon-side refusal happens before any pane effect, so there is nothing to
  // close, no edge to read back, and no child to hand work to.
  radarDaemon.options.refuseSpawn = {
    code: "refused",
    message: "no pane was created for this launch",
  };
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "leave no phantom child" },
      undefined,
      undefined,
      fakeContext(),
    );
    const error = result.details.error as any;
    assert.equal(error.category, "pane_not_ready");
    assert.equal(error.rollbackOccurred, false);
    assert.match(error.message, /no pane was created for this launch/);
    // The refusal names the launch it authored without calling the outcome
    // unknown, and no pane may have been closed to "clean up" a launch that never
    // created one.
    assert.match(error.details.radarSpawn.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(error.details.radarSpawn.unresolved, undefined);
    assert.equal(error.details.radarSpawn.agentId, undefined);
    assert.equal(radarDaemon.closes.size, 0);
    assert.equal(readAgentState(mailbox), undefined);
  } finally {
    radarDaemon.options.refuseSpawn = undefined;
    resetAgentMailbox(mailbox);
  }
});

test("a lost Radar spawn reply reuses the same request id instead of spawning twice", async () => {
  setLeadEnvironment();
  const label = "rollback-detail-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  // The reply to the spawn never arrives. The durable record authored one request
  // id and the daemon recorded exactly one edge under it, so the launch has to
  // resolve from that edge rather than asking for a second pane and child.
  radarDaemon.options.dropSpawnReply = true;
  try {
    const result = await agentTool(pi, "delegate").execute(
      "id",
      { definition: "agent", label, task: "resolve from the daemon's record" },
      undefined,
      undefined,
      fakeContext(),
    );
    // The lost reply resolved to the same launch: one request id made one pane
    // and one child, so the launch is ready rather than retried under a new id.
    assert.equal(result.details.ok, true);
    assert.equal(radarDaemon.spawns.length, 1);
    assert.match(radarDaemon.spawns[0]!.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(radarDaemon.closes.size, 0);
    // The durable records carry one request id - the one authored before the
    // reply was lost - and the launch's final stage, so a reload rebuilds this
    // child from the session rather than from the runtime cache.
    const records = radarSpawnRecords(pi);
    assert.ok(records.length >= 1);
    assert.equal(
      new Set(records.map((entry: any) => entry.data.requestId)).size,
      1,
    );
    assert.equal(
      (records.at(-1) as any).data.requestId,
      radarDaemon.spawns[0]!.request_id,
    );
    assert.equal((records.at(-1) as any).data.stage, "bound");
    assert.equal(readAgentState(mailbox)?.agentLabel, label);
  } finally {
    radarDaemon.options.dropSpawnReply = false;
    resetAgentMailbox(mailbox);
  }
});

test("recovery retries one failed delivery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  setLeadEnvironment();
  await ensureRadarDaemon();
  const label = "recovery-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const launch = await radarDaemon.adoptRetainedChild({
    label,
    runId: randomUUID(),
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    mailbox,
    pane: `${label}-pane`,
  });
  const retryState = {
    ...readAgentState(mailbox)!,
    completedRequestId: REQUEST_ID,
  };
  writeAgentState(mailbox, retryState);
  const identity = {
    piSessionId: retryState.piSessionId,
    paneId: retryState.paneId,
  };
  const scoutText = "scout discovered SECRET implementation details";
  const scoutPresentation = truncateModelText(scoutText, {
    keep: "head",
    sessionId: identity.piSessionId,
    key: REQUEST_ID,
    requestId: REQUEST_ID,
    persist: "completion",
  });
  assert.equal(scoutPresentation.resultRef, `result:${REQUEST_ID}`);
  assert.equal(readFileSync(resultPath(REQUEST_ID), "utf8"), scoutText);
  const result: ResultRecord = {
    version: 5,
    runId: retryState.runId,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: identity.paneId,
    status: "completed",
    text: scoutText,
    completedAt: Date.now(),
  };
  writeResult(mailbox, result);

  const removalState = {
    ...readAgentState(mailbox)!,
    completedRequestId: REQUEST_ID,
  };
  writeAgentState(mailbox, removalState);
  writeResult(mailbox, result);
  let attempts = 0;
  let delivered = "";
  let deliveredDetails: any;
  const transientFailures = 5;
  let successful = 0;
  const previousRequestId = randomUUID();
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: launch,
    },
    {
      customType: "pi-herdsman-agent-result",
      details: {
        ...resultEntryDetails(removalState, previousRequestId),
        status: "completed",
        resultIndex: 1,
        resultRef: resultRef(previousRequestId),
      },
    },
  ];
  const recovering = fakePi({
    entries,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result") {
        delivered = String((message as any).content ?? "");
        deliveredDetails = (message as any).details;
        attempts++;
        if (attempts <= transientFailures) throw new Error("transient");
        successful++;
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(removalState, REQUEST_ID),
        });
      } else entries.push(message);
    },
  });
  registerExtension!(recovering.pi as never);
  await recovering.events.get("session_start")![0](
    undefined,
    fakeContext(entries),
  );
  assert.equal(attempts, 1);
  assert.ok(
    readResult(mailbox, REQUEST_ID),
    "a rejected send must retain the durable result for retry",
  );
  for (let index = 0; index < transientFailures; index++) {
    t.mock.timers.tick(250);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(attempts, index + 2);
  }
  assert.equal(attempts, transientFailures + 1);
  assert.equal(successful, 1);
  for (let index = 0; index < 5; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(recovering.sentUsers, [IDLE_WAKE_PROMPT]);
  assert.match(
    delivered,
    new RegExp(
      `^Agent result · agent=${label} · definition=agent · session=${identity.piSessionId} · status=completed`,
    ),
  );
  assert.match(delivered, new RegExp(`Result ref: result:${label}#2`));
  assert.doesNotMatch(delivered, /Agent result source:/);
  assert.equal(
    readFileSync(resultPath(REQUEST_ID), "utf8"),
    [
      `Agent result source: ${JSON.stringify({
        agent: label,
        definition: "agent",
        cwd: removalState.cwd,
        piSessionId: identity.piSessionId,
      })}`,
      scoutText,
    ].join("\n\n"),
  );
  assert.equal(deliveredDetails.agentLabel, label);
  assert.equal(deliveredDetails.agentDefinition, "agent");
  assert.equal(deliveredDetails.resultIndex, 2);
  assert.equal(deliveredDetails.resultRef, `result:${REQUEST_ID}`);
  // The durable result is retained until the assignment settles; the cleanup is
  // what the redelivery tests cover. This test is about the retry.
  assert.ok(readResult(mailbox, REQUEST_ID));
  recovering.events.get("session_shutdown")?.[0]();
});

test("in-place branch history does not reuse a result index", async () => {
  setLeadEnvironment();
  const label = "branched-result-agent";
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(testTmpRoot, `${label}.jsonl`),
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const state = {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  };
  realFs.writeFileSync(identity.piSessionFile, "{}", "utf8");
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
  writeResult(mailbox, {
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "new branch result",
    completedAt: Date.now(),
  });
  const firstRequestId = randomUUID();
  const secondRequestId = randomUUID();
  const first = {
    customType: "pi-herdsman-agent-result",
    details: {
      ...resultEntryDetails(state, firstRequestId),
      status: "completed",
      resultIndex: 1,
      resultRef: resultRef(firstRequestId),
    },
  };
  const abandoned = {
    customType: "pi-herdsman-agent-result",
    details: {
      ...resultEntryDetails(state, secondRequestId),
      status: "completed",
      resultIndex: 2,
      resultRef: resultRef(secondRequestId),
    },
  };
  const entries: unknown[] = [first, abandoned];
  let delivered: any;
  const lifecycle = cascadeExecutor([state]);
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result")
        delivered = message;
      entries.push(message);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](
      undefined,
      fakeContext(entries, [first]),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(delivered?.details.resultIndex, 3);
    assert.match(
      String(delivered?.content),
      /Result ref: result:branched-result-agent#3/,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(identity.piSessionFile, { force: true });
    realFs.rmSync(resultPath(REQUEST_ID), { force: true });
  }
});

test("completed and failed one-shot agents converge after durable delivery", async (t) => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const specs = [
    { label: "converge-child-one", requestId: REQUEST_ID, status: "completed" as const },
    { label: "converge-child-two", requestId: randomUUID(), status: "failed" as const },
  ];
  const entries: unknown[] = [];
  const children = [];
  for (const spec of specs) {
    const mailbox = agentMailboxPath(WORKSPACE, spec.label);
    resetAgentMailbox(mailbox);
    const launch = await radarDaemon.adoptRetainedChild({
      label: spec.label,
      runId: randomUUID(),
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      mailbox,
      pane: `${spec.label}-pane`,
    });
    entries.push({
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: launch,
    });
    const state = readAgentState(mailbox)!;
    realFs.writeFileSync(state.piSessionFile!, "{}", "utf8");
    writeAgentState(mailbox, { ...state, completedRequestId: spec.requestId });
    writeResult(mailbox, {
      version: 5,
      runId: state.runId,
      requestId: spec.requestId,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      status: spec.status,
      ...(spec.status === "completed"
        ? { text: spec.label }
        : {
            error: {
              code: "empty_result" as const,
              message: "agent returned no result",
            },
          }),
      completedAt: Date.now(),
    });
    children.push({ state, mailbox, requestId: spec.requestId, pane: `${spec.label}-pane` });
  }
  entries.push({
    customType: "pi-herdsman-agent-result",
    details: resultEntryDetails(children[0]!.state, children[0]!.requestId),
  });
  let deliveries = 0;
  const pi = fakePi({
    entries,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result")
        deliveries++;
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  registerExtension!(pi.pi as never);
  const closedPanes = () =>
    [...radarDaemon.closes.values()].map((close) => close.pane);
  try {
    await startRadarSession(pi, fakeContext(entries));
    await settleUntil(() => closedPanes().length === 1);
    assert.equal(deliveries, 1);
    assert.deepEqual(closedPanes(), [children[0]!.pane]);
    assert.ok(readResult(children[1]!.mailbox, children[1]!.requestId));

    entries.push({
      customType: "pi-herdsman-agent-result",
      details: resultEntryDetails(children[1]!.state, children[1]!.requestId),
    });
    t.mock.timers.tick(1000);
    await settleUntil(() => readAgentState(children[1]!.mailbox) === undefined);

    assert.deepEqual(
      new Set(closedPanes()),
      new Set(children.map((child) => child.pane)),
      JSON.stringify({
        closes: [...radarDaemon.closes.values()],
        states: children.map((child) => readAgentState(child.mailbox)),
      }),
    );
    for (const child of children)
      assert.equal(readAgentState(child.mailbox), undefined);
    assert.equal(deliveries, 1);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const child of children) resetAgentMailbox(child.mailbox);
  }
});

test("one-shot close failure retains the result for exact cleanup retry", async () => {
  const label = "close-retry-child";
  let deliveries = 0;
  const { pi, mailbox, requestId } = await radarChildFixture(label, {
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result")
        deliveries++;
    },
  });
  try {
    const launched = readAgentState(mailbox)!;
    writeResult(mailbox, {
      version: 5,
      runId: launched.runId,
      requestId,
      ownerSessionId: launched.ownerSessionId,
      workspaceId: launched.workspaceId,
      agentLabel: launched.agentLabel,
      paneId: launched.paneId,
      status: "completed",
      text: "retry close",
      completedAt: Date.now(),
    });
    // The training assignment is still live, so the result waits for its
    // resolution rather than resolving the assignment by delivery.
    watchedResultPaths.get(`${mailbox}/result-${requestId}.json`)?.({}, {});
    await settleUntil(() => deliveries === 1);
    assert.equal(deliveries, 1);
    assert.ok(readResult(mailbox, requestId), "an unresolved result stays put");

    // The daemon refuses the first close, which is the failure the retry exists
    // for: the result stays exactly where the lead can still read it.
    radarDaemon.options.refuseChildClose = true;
    writeAgentState(mailbox, {
      ...launched,
      activeRequestId: undefined,
      completedRequestId: requestId,
    });
    const recover = async () => {
      for (const handler of pi.events.get("session_start") ?? [])
        await handler(undefined, fakeContext(pi.entries));
    };
    await recover();
    await settleUntil(() => radarDaemon.closes.size === 1);
    assert.ok(
      readResult(mailbox, requestId),
      "a refused close keeps the result for an exact retry",
    );

    radarDaemon.options.refuseChildClose = false;
    await recover();
    await settleUntil(() => readResult(mailbox, requestId) === undefined);
    assert.equal(readResult(mailbox, requestId), undefined);
    assert.equal(deliveries, 1, "the retry does not deliver the result twice");
    assert.equal(readAgentState(mailbox), undefined);
    assert.equal(radarDaemon.closes.size, 2);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
    resetAgentMailbox(mailbox);
  }
});
test("delivered-result cascade retries descendant mailbox cleanup failure", async (t) => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const parentMailbox = agentMailboxPath(WORKSPACE, "cascade-mailbox-retry-parent");
  const childMailbox = agentMailboxPath(WORKSPACE, "cascade-mailbox-retry-child");
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  const obstruction = join(childMailbox, "stubborn-directory");
  realFs.mkdirSync(obstruction);
  const parentLaunch = await radarDaemon.adoptRetainedChild({
    label: "cascade-mailbox-retry-parent",
    runId: randomUUID(),
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    mailbox: parentMailbox,
    pane: "cascade-mailbox-retry-parent-pane",
  });
  const childLaunch = await radarDaemon.adoptRetainedChild({
    label: "cascade-mailbox-retry-child",
    runId: randomUUID(),
    ownerSessionId: readAgentState(parentMailbox)!.piSessionId,
    workspaceId: WORKSPACE,
    mailbox: childMailbox,
    pane: "cascade-mailbox-retry-child-pane",
  });
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: parentLaunch,
    },
    {
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: childLaunch,
    },
  ];
  const parent = readAgentState(parentMailbox)!;
  const child = readAgentState(childMailbox)!;
  realFs.writeFileSync(parent.piSessionFile!, "{}", "utf8");
  realFs.writeFileSync(child.piSessionFile!, "{}", "utf8");
  writeAgentState(parentMailbox, {
    ...parent,
    completedRequestId: REQUEST_ID,
  });
  writeResult(parentMailbox, {
    version: 5,
    runId: parent.runId,
    requestId: REQUEST_ID,
    ownerSessionId: parent.ownerSessionId,
    workspaceId: parent.workspaceId,
    agentLabel: parent.agentLabel,
    paneId: parent.paneId,
    status: "completed",
    text: "delivered parent result",
    completedAt: Date.now(),
  });
  const pi = fakePi({
    entries,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result")
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(parent, REQUEST_ID),
        });
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  registerExtension!(pi.pi as never);
  const closedPanes = () =>
    [...radarDaemon.closes.values()].map((close) => close.pane);
  try {
    await startRadarSession(pi, fakeContext(entries));
    await settleUntil(() => closedPanes().length === 1);

    assert.deepEqual(closedPanes(), ["cascade-mailbox-retry-child-pane"]);
    assert.ok(readAgentState(parentMailbox), "root must remain anchored");
    assert.deepEqual(
      readAgentState(childMailbox),
      child,
      "failed mailbox cleanup must preserve the durable identity anchor",
    );
    assert.ok(readResult(parentMailbox, REQUEST_ID));
    assert.ok(
      realFs.existsSync(obstruction),
      "failed descendant mailbox remains",
    );
    assert.equal(
      entries.filter(
        (entry: any) =>
          entry.customType === "pi_herdsman_cleanup_error" &&
          /stubborn-directory/.test(String(entry.data?.error)),
      ).length,
      1,
    );

    realFs.rmSync(obstruction, { recursive: true, force: true });
    t.mock.timers.tick(250);
    await settleUntil(() => readAgentState(parentMailbox) === undefined);
    assert.deepEqual(closedPanes(), [
      "cascade-mailbox-retry-child-pane",
      "cascade-mailbox-retry-parent-pane",
    ]);
    assert.equal(readResult(parentMailbox, REQUEST_ID), undefined);
    assert.equal(readAgentState(childMailbox), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("recovery redelivers an unpersisted child result and then cleans it safely", async () => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const childMailbox = agentMailboxPath(WORKSPACE, "reload-result-child");
  const siblingMailbox = agentMailboxPath(WORKSPACE, "reload-result-sibling");
  resetAgentMailbox(childMailbox);
  resetAgentMailbox(siblingMailbox);
  const childLaunch = await radarDaemon.adoptRetainedChild({
    label: "reload-result-child",
    runId: randomUUID(),
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    mailbox: childMailbox,
    pane: "reload-result-child-pane",
  });
  const child = {
    ...readAgentState(childMailbox)!,
    completedRequestId: REQUEST_ID,
  };
  writeAgentState(childMailbox, child);
  const sibling = {
    ...managedState("reload-result-sibling", randomUUID(), {
      ...recoveryIdentity("reload-result-sibling"),
      piSessionId: "11111111-1111-4111-8111-111111111111",
    }),
  };
  writeAgentState(siblingMailbox, sibling);
  const result: ResultRecord = {
    version: 5,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    status: "completed",
    text: "durable child result",
    completedAt: Date.now(),
  };
  writeResult(childMailbox, result);
  const spawnEntry = {
    type: "custom",
    customType: "pi-herdsman-radar-spawn",
    data: childLaunch,
  };
  const firstEntries: unknown[] = [spawnEntry];
  let queued = 0;
  const first = fakePi({
    entries: firstEntries,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result") queued++;
      else firstEntries.push(message);
    },
  });
  registerExtension!(first.pi as never);
  try {
    await first.events.get("session_start")![0](
      undefined,
      fakeContext(firstEntries),
    );
    assert.equal(queued, 1);
    assert.ok(
      readResult(childMailbox, REQUEST_ID),
      "an accepted but not-yet-persisted message must retain its result file",
    );
  } finally {
    first.events.get("session_shutdown")?.[0]();
  }
  const recoveredEntries: unknown[] = [spawnEntry];
  let redeliveries = 0;
  const recovered = fakePi({
    entries: recoveredEntries,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result") {
        redeliveries++;
        recoveredEntries.push({
          message: {
            role: "custom",
            customType: "pi-herdsman-agent-result",
            details: (message as any).details,
          },
        });
      } else recoveredEntries.push(message);
    },
  });
  registerExtension!(recovered.pi as never);
  const context = fakeContext(recoveredEntries);
  try {
    await recovered.events.get("session_start")![0](undefined, context);
    assert.equal(redeliveries, 1);
    assert.equal(
      recoveredEntries.filter(
        (entry: any) =>
          entry.message?.customType === "pi-herdsman-agent-result" &&
          entry.message.details?.requestId === REQUEST_ID,
      ).length,
      1,
    );
    assert.equal(
      recovered.sentMessageCalls.some(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ),
      false,
    );
    assert.equal(
      (recovered.sentMessageCalls[0]?.message as any).details
        .unresolvedDirectChildCount,
      1,
    );
    const recoveredContent = String(
      (recovered.sentMessageCalls[0]?.message as any).content,
    );
    const recoveredStatus = recoveredContent.slice(
      recoveredContent.lastIndexOf("Delegation status:"),
    );
    assert.ok(
      recoveredStatus.startsWith(
        "Delegation status: 1 active direct agent; 0 pending direct results; 1 direct agent assignment remains unresolved.",
      ),
    );
    assert.ok(
      recoveredStatus.includes("physical disappearance is not completion"),
    );
    assert.equal(
      (recovered.sentMessageCalls[0]?.message as any).details
        .activeDirectChildCount,
      1,
    );
    assert.equal(
      (recovered.sentMessageCalls[0]?.message as any).details
        .pendingDirectResultCount,
      0,
    );
    assert.equal(readResult(childMailbox, REQUEST_ID), undefined);
    assert.equal(readAgentState(childMailbox), undefined);
  } finally {
    recovered.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(childMailbox);
    resetAgentMailbox(siblingMailbox);
  }
});

test("settlement redelivers an unpersisted child result in the same session", async (t) => {
  setLeadEnvironment();
  await ensureRadarDaemon();

  const label = "settled-redelivery-child";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const childLaunch = await radarDaemon.adoptRetainedChild({
    label,
    runId: randomUUID(),
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    mailbox,
    pane: `${label}-pane`,
  });
  const child = {
    ...readAgentState(mailbox)!,
    completedRequestId: REQUEST_ID,
  };
  writeAgentState(mailbox, child);
  writeResult(mailbox, {
    version: 5,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    status: "completed",
    text: "durable child result",
    completedAt: Date.now(),
  });

  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: childLaunch,
    },
  ];
  let deliveries = 0;

  const pi = fakePi({
    entries,
    sendMessage: (message) => {
      if ((message as any).customType !== "pi-herdsman-agent-result") return;

      deliveries++;
      if (deliveries === 1) return;

      entries.push({
        message: {
          role: "custom",
          customType: "pi-herdsman-agent-result",
          details: (message as any).details,
        },
      });
    },
  });

  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);

  try {
    await pi.events.get("session_start")![0](undefined, context);

    assert.equal(deliveries, 1);
    assert.ok(readResult(mailbox, REQUEST_ID));
    assert.equal(
      entries.some(
        (entry: any) =>
          entry.message?.customType === "pi-herdsman-agent-result",
      ),
      false,
    );

    await pi.events.get("agent_settled")![0](undefined, context);

    await t.waitFor(() =>
      assert.equal(
        deliveries,
        2,
        "settlement did not redeliver the lost child result",
      ),
    );

    await t.waitFor(() =>
      assert.equal(
        readResult(mailbox, REQUEST_ID),
        undefined,
        "redelivered child result did not clean up",
      ),
    );

    assert.equal(deliveries, 2);
    assert.deepEqual(
      [...radarDaemon.closes.values()].map((close) => close.pane),
      [child.paneId],
    );

    await pi.events.get("agent_settled")![0](undefined, context);
    await Promise.resolve();
    assert.equal(deliveries, 2);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("recovered no-live result removal retry leaves a replacement's durable state alone", async (t) => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const label = "no-live-removal-retry-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const launch = await radarDaemon.adoptRetainedChild({
    label,
    runId: randomUUID(),
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    mailbox,
    pane: `${label}-pane`,
  });
  const state = {
    ...readAgentState(mailbox)!,
    completedRequestId: REQUEST_ID,
    // Past the startup window with no pane reported: lost, not merely unproved.
    updatedAt: Date.now() - 11 * 60_000,
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  writeAgentState(mailbox, state);
  writeResult(mailbox, {
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "no live agent",
    completedAt: Date.now(),
  });
  // The daemon reports no pane for this generation.
  observeFleet([]);
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: launch,
    },
  ];
  const pi = fakePi({
    entries,
    sendMessage: (message) => {
      entries.push({
        customType: "pi-herdsman-agent-result",
        details: (message as any).details,
      });
    },
  });
  const replacement = {
    ...state,
    runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    piSessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    piSessionFile: `/tmp/${label}-replacement.jsonl`,
  };
  replacement.startupAck = {
    ...state.startupAck!,
    runId: replacement.runId,
    piSessionId: replacement.piSessionId,
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const removalAttemptsBefore = support.resultRemovalAttempts;
  support.failNextResultRemoval = true;
  try {
    registerExtension!(pi.pi as never);
    await startRadarSession(pi, fakeContext(entries));
    assert.equal(support.failNextResultRemoval, false);
    assert.equal(support.resultRemovalAttempts, removalAttemptsBefore + 1);
    assert.equal(readResult(mailbox, REQUEST_ID)?.runId, state.runId);
    assert.ok(
      entries.some(
        (entry: any) =>
          entry.customType === "pi_herdsman_cleanup_error" &&
          /injected result removal failure/.test(String(entry.data?.error)),
      ),
      "the initial removal must fail before the retry is exercised",
    );

    const unresolved = await agentTool(pi, "list").execute(
      "list-unresolved",
      {},
      undefined,
      undefined,
      fakeContext(entries),
    );
    const listed = unresolved.details.agents.find(
      (agent: any) => agent.agent === label,
    );
    assert.match(listed.cleanup_error, /injected result removal failure/);
    assert.equal(unresolved.details.cleanup_errors, undefined);

    const callsBeforeRetry = pi.calls.length;
    // A replacement generation takes the label *and its pane*: another run,
    // another session, the same physical pane.
    observeFleet([{ state: replacement }]);
    assert.notEqual(replacement.runId, state.runId);
    assert.equal(replacement.paneId, state.paneId);
    assert.notEqual(replacement.piSessionId, state.piSessionId);
    assert.deepEqual(readAgentState(mailbox), state);
    t.mock.timers.tick(250);
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    await settleUntil(() => readResult(mailbox, REQUEST_ID) === undefined);
    // The generation is lost, so its own durable state goes with it. The lead
    // closes only the pane its own launch record names; whether that pane is now
    // held by someone else is the daemon's call, which holds the spawn record and
    // the pane evidence.
    assert.deepEqual(
      [...radarDaemon.closes.values()].map((close) => close.pane),
      [state.paneId],
    );
    assert.equal(
      readAgentState(mailbox),
      undefined,
      "a lost generation's own mailbox goes with it",
    );
    const removalsAfterRetry = support.resultRemovalAttempts;
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(support.resultRemovalAttempts, removalsAfterRetry);
    assert.equal(readResult(mailbox, REQUEST_ID), undefined);

    writeAgentState(mailbox, replacement);
    const replacementListed = await agentTool(pi, "list").execute(
      "list-after-label-reuse",
      {},
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(
      replacementListed.details.agents.find(
        (agent: any) => agent.agent === label,
      ).cleanup_error,
      undefined,
    );
  } finally {
    support.failNextResultRemoval = false;
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("controller reply submits the normal request and preserves the assignment", async () => {
  setLeadEnvironment();
  const label = "reply-controller-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const waiting = {
    ...managedState(label, REQUEST_ID, identity),
    pendingAskId: "99999999-9999-4999-8999-999999999999",
  };
  writeAgentState(mailbox, waiting);
  writeAsk(mailbox, {
    version: 5,
    askId: waiting.pendingAskId!,
    requestId: REQUEST_ID,
    runId: waiting.runId,
    ownerSessionId: waiting.ownerSessionId,
    workspaceId: waiting.workspaceId,
    agentLabel: waiting.agentLabel,
    paneId: waiting.paneId,
    piSessionId: waiting.piSessionId,
    question: "Choose ALPHA or BETA",
    createdAt: Date.now(),
  });
  const replyFile = join(testTmpRoot, `${label}-decision.md`);
  realFs.writeFileSync(replyFile, "decision evidence");
  let submitted: RequestRecord | undefined;
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      (requestMailbox, marker) => {
        const requestId = marker.slice("__PI_HERDSMAN_AGENT_V5__:".length);
        submitted = readRequest(requestMailbox, requestId);
        const current = readAgentState(requestMailbox)!;
        writeAgentState(requestMailbox, {
          ...current,
          ...(submitted?.kind === "reply" ? { pendingAskId: undefined } : {}),
          lastAck: {
            requestId,
            accepted: true,
            acknowledgedAt: Date.now(),
          },
          updatedAt: Date.now(),
        });
        if (submitted?.kind === "reply") removeAsk(requestMailbox);
      },
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext();
  const waitingList = await agentTool(pi, "list").execute(
    "list",
    {},
    undefined,
    undefined,
    context,
  );
  assert.deepEqual(waitingList.details.agents[0].available_tools, [
    "agent_inspect",
    "agent_reply",
    "agent_close",
  ]);
  const result = await agentTool(pi, "reply").execute(
    "reply",
    {
      agent: label,
      message: "Use ALPHA.",
      files: [replyFile],
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(result.details.action, "reply");
  assert.doesNotMatch((result.content[0] as { text: string }).text, /Next:/);
  assert.equal(result.terminate, undefined);
  assert.equal(submitted?.kind, "reply");
  assert.equal(submitted?.askId, waiting.pendingAskId);
  assert.match(submitted?.text ?? "", /decision evidence/);
  assert.equal(submitted?.requestId, result.details.request_id);
  assert.notEqual(result.details.request_id, REQUEST_ID);
  assert.equal(result.details.ask_id, waiting.pendingAskId);
  assert.equal(result.details.assignment_request_id, REQUEST_ID);
  assert.equal(result.details.session_id, identity.piSessionId);
  assert.equal(result.details.truncated, false);
  assert.match((result.content[0] as { text: string }).text, /Request: /);
  assert.ok(
    (result.content[0] as { text: string }).text.includes(
      `Ask: ${waiting.pendingAskId}`,
    ),
  );
  assert.match(
    (result.content[0] as { text: string }).text,
    /Assignment request: /,
  );
  const rendered = agentTool(pi, "reply").renderResult(
    { content: result.content, details: result.details },
    { expanded: true, isPartial: false },
    { fg: (_color: string, text: string) => text },
    { args: { agent: label, message: "Use ALPHA." } },
  );
  assert.match(
    rendered.text,
    new RegExp(`request: ${result.details.request_id}`),
  );
  assert.match(rendered.text, new RegExp(`ask: ${waiting.pendingAskId}`));
  assert.match(rendered.text, new RegExp(`session: ${identity.piSessionId}`));
  assert.match(rendered.text, /assignment request: /);
  assert.equal(readAgentState(mailbox)?.activeRequestId, REQUEST_ID);
  assert.equal(readAgentState(mailbox)?.pendingAskId, undefined);
  assert.equal(readRequest(mailbox, submitted!.requestId), undefined);
  const afterReply = await agentTool(pi, "list").execute(
    "list",
    {},
    undefined,
    undefined,
    context,
  );
  assert.deepEqual(afterReply.details.agents[0].available_tools, [
    "agent_inspect",
    "agent_steer",
    "agent_interrupt",
    "agent_close",
  ]);
  const missingAsk = await agentTool(pi, "reply").execute(
    "reply-without-ask",
    { agent: label, message: "No question is pending." },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(missingAsk.details.error.category, "agent_busy");
  assert.match(
    missingAsk.details.error.nextAction,
    /Use agent_reply only for an outstanding ask_owner question/,
  );
  resetAgentMailbox(mailbox);
  realFs.rmSync(replyFile, { force: true });
});

test("controller cleanup barrier blocks newer work until stale acknowledgement cleanup succeeds", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  const label = "cleanup-barrier-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const staleRequestId = randomUUID();
  const staleState = {
    ...managedState(label, staleRequestId, identity),
    lastAck: {
      requestId: staleRequestId,
      accepted: true,
      acknowledgedAt: Date.now(),
    },
  };
  writeAgentState(mailbox, staleState);
  const stalePath = join(mailbox, `request-${staleRequestId}.json`);
  writeRequest(mailbox, {
    version: 5,
    runId: staleState.runId,
    requestId: staleRequestId,
    ownerSessionId: staleState.ownerSessionId,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: identity.paneId,
    kind: "task",
    text: "already accepted",
    createdAt: Date.now(),
  });
  let submitted: RequestRecord | undefined;
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      (requestMailbox, marker) => {
        const requestId = marker.slice("__PI_HERDSMAN_AGENT_V5__:".length);
        submitted = readRequest(requestMailbox, requestId);
        const current = readAgentState(requestMailbox)!;
        writeAgentState(requestMailbox, {
          ...current,
          lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
          updatedAt: Date.now(),
        });
      },
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(pi.entries);
  (context as any).isIdle = () => false;
  try {
    support.failNextRequestRemoval = true;
    const blocked = await agentTool(pi, "steer").execute(
      "id",
      { agent: label, message: "must wait" },
      undefined,
      undefined,
      context,
    );
    assert.equal(blocked.details.error.category, "internal_failure");
    assert.equal(realFs.existsSync(stalePath), true);
    const failedList = await agentTool(pi, "list").execute(
      "list-after-cleanup-failure",
      {},
      undefined,
      undefined,
      context,
    );
    assert.match(
      failedList.details.agents[0].cleanup_error,
      /Acknowledged request could not be removed/,
    );

    const result = await agentTool(pi, "steer").execute(
      "id",
      { agent: label, message: "proceed now" },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(submitted?.kind, "steer");
    assert.equal(realFs.existsSync(stalePath), false);
    const recoveredList = await agentTool(pi, "list").execute(
      "list-after-cleanup-recovery",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(recoveredList.details.agents[0].cleanup_error, undefined);
  } finally {
    support.failNextRequestRemoval = false;
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(stalePath, { recursive: true, force: true });
    resetAgentMailbox(mailbox);
  }
});

test("parent close cascades child-first and reports a structured child failure", async () => {
  for (const failed of [false, true]) {
    setLeadEnvironment();
    await ensureRadarDaemon();
    const parentMailbox = agentMailboxPath(WORKSPACE, "cascade-parent");
    const childMailbox = agentMailboxPath(WORKSPACE, "cascade-child");
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    const parent = await radarDaemon.adoptRetainedChild({
      label: "cascade-parent",
      runId: randomUUID(),
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      mailbox: parentMailbox,
      pane: "cascade-parent-pane",
    });
    // The child's owner is the parent's own session, which is what makes it a
    // descendant of the parent rather than a direct child of the lead.
    const child = await radarDaemon.adoptRetainedChild({
      label: "cascade-child",
      runId: randomUUID(),
      ownerSessionId: readAgentState(parentMailbox)!.piSessionId,
      workspaceId: WORKSPACE,
      mailbox: childMailbox,
      pane: "cascade-child-pane",
    });
    const entries = [
      { type: "custom", customType: "pi-herdsman-radar-spawn", data: parent },
      { type: "custom", customType: "pi-herdsman-radar-spawn", data: child },
    ];
    radarDaemon.options.refuseChildClose = failed;
    const pi = fakePi({});
    registerExtension!(pi.pi as never);
    try {
      const result = await agentTool(pi, "close").execute(
        "id",
        { agent: "cascade-parent" },
        undefined,
        undefined,
        fakeContext(entries),
      );
      const completed = [...radarDaemon.closes.values()].filter(
        (close) => close.outcome === "completed",
      );
      if (!failed) {
        assert.equal(result.details.ok, true, JSON.stringify(result.details));
        assert.equal(result.details.action, "close");
        assert.equal(result.details.agent, "cascade-parent");
        assert.deepEqual(
          completed.map((close) => close.pane),
          ["cascade-child-pane", "cascade-parent-pane"],
        );
        assert.equal(readAgentState(parentMailbox), undefined);
        assert.equal(readAgentState(childMailbox), undefined);
      } else {
        assert.equal(result.details.error.category, "target_ambiguous");
        assert.equal(result.details.error.ids.label, "cascade-child");
        assert.equal(
          result.details.error.details.parentLabel,
          "cascade-parent",
        );
        assert.deepEqual(completed, []);
        assert.ok(readAgentState(parentMailbox));
        assert.ok(readAgentState(childMailbox));
      }
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      radarDaemon.options.refuseChildClose = false;
      resetAgentMailbox(parentMailbox);
      resetAgentMailbox(childMailbox);
    }
  }
});

test("close returns a structured nonfatal mailbox cleanup warning", async () => {
  setLeadEnvironment();
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  await startRadarSession(pi);
  const label = "cleanup-warning-child";
  const child = await delegateRadarChild(pi, label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  realFs.mkdirSync(join(mailbox, "stubborn"));
  try {
    const result = await agentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.match(result.details.cleanup_error, /mailbox cleanup failed/);
    assert.equal(result.details.cleanup_errors, undefined);
    assert.equal(radarDaemon.closes.size, 1);
    assert.deepEqual(
      readAgentState(mailbox),
      child,
      "incomplete mailbox cleanup must preserve its durable identity anchor",
    );
    assert.ok(
      pi.entries.some(
        (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
      ),
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(mailbox, { recursive: true, force: true });
  }
});

test("lost parent pane absence preserves durable child ancestry", async () => {
  for (const parentPresent of [false, true]) {
    setLeadEnvironment();
    const parent = {
      ...managedState(
        "missing-parent",
        undefined,
        recoveryIdentity("missing-parent"),
      ),
      piSessionId: PARENT_SESSION_ID,
      piSessionFile: join(testTmpRoot, "missing-parent.jsonl"),
    };
    const child = {
      ...managedState(
        "missing-parent-child",
        undefined,
        recoveryIdentity("missing-parent-child"),
      ),
      ownerSessionId: parent.piSessionId,
      piSessionId: CHILD_SESSION_ID,
      piSessionFile: join(testTmpRoot, "missing-parent-child.jsonl"),
    };
    const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
    const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    writeAgentState(parentMailbox, parent);
    writeAgentState(childMailbox, child);
    const lifecycle = cascadeExecutor(
      parentPresent ? [parent, child] : [child],
    );
    const pi = fakePi({ exec: lifecycle.exec });
    registerExtension!(pi.pi as never);
    try {
      const listed = await agentTool(pi, "list").execute(
        "id",
        {},
        undefined,
        undefined,
        fakeContext(),
      );
      const listedChild = (listed.details.agents as any[]).find(
        (agent) => agent.agent === child.agentLabel,
      );
      assert.equal(listedChild?.parent_label, parent.agentLabel);
      assert.deepEqual(listedChild?.available_tools, []);
      const result = await agentTool(pi, "close").execute(
        "id",
        { agent: child.agentLabel },
        undefined,
        undefined,
        fakeContext(),
      );
      assert.equal(result.details.error.category, "target_not_found");
      assert.deepEqual(lifecycle.closeOrder, []);
      assert.ok(readAgentState(childMailbox));
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(parentMailbox);
      resetAgentMailbox(childMailbox);
    }
  }
});

test("lead list excludes another lead's durable subtree", async () => {
  setLeadEnvironment();
  const foreignLeadSessionId = PARENT_SESSION_ID;
  const child = {
    ...managedState(
      "foreign-lead-agent",
      undefined,
      recoveryIdentity("foreign-lead-agent"),
    ),
    ownerSessionId: foreignLeadSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: join(testTmpRoot, "foreign-lead-agent.jsonl"),
  };
  const grandchild = {
    ...managedState(
      "foreign-lead-descendant",
      undefined,
      recoveryIdentity("foreign-lead-descendant"),
    ),
    ownerSessionId: child.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: join(testTmpRoot, "foreign-lead-descendant.jsonl"),
  };
  const mailboxes = [child, grandchild].map((state) => ({
    path: agentMailboxPath(WORKSPACE, state.agentLabel),
    state,
  }));
  for (const { path, state } of mailboxes) {
    resetAgentMailbox(path);
    writeAgentState(path, state);
  }
  const lifecycle = cascadeExecutor([child, grandchild]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    const listed = result.details.agents as any[];
    for (const label of [child.agentLabel, grandchild.agentLabel]) {
      assert.equal(
        listed.some((candidate) => candidate.agent === label),
        false,
        `${label} belongs to another lead`,
      );
    }
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const { path } of mailboxes) resetAgentMailbox(path);
  }
});

test("lead list excludes cyclic unrooted durable ancestry", async () => {
  setLeadEnvironment();
  const cycleA = {
    ...managedState(
      "cycle-ancestry-a",
      undefined,
      recoveryIdentity("cycle-ancestry-a"),
    ),
    ownerSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionId: "22222222-2222-4222-8222-222222222222",
  };
  const cycleB = {
    ...managedState(
      "cycle-ancestry-b",
      undefined,
      recoveryIdentity("cycle-ancestry-b"),
    ),
    ownerSessionId: cycleA.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
  };
  const descendant = {
    ...managedState(
      "cycle-ancestry-descendant",
      undefined,
      recoveryIdentity("cycle-ancestry-descendant"),
    ),
    ownerSessionId: cycleA.piSessionId,
    piSessionId: "33333333-3333-4333-8333-333333333333",
  };
  const states = [cycleA, cycleB, descendant];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const [mailbox, state] of mailboxes.map(
    (mailbox, index) => [mailbox, states[index]] as const,
  )) {
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
  }
  const pi = fakePi({ exec: cascadeExecutor(states).exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    const listed = result.details.agents as any[];
    for (const label of [
      cycleA.agentLabel,
      cycleB.agentLabel,
      descendant.agentLabel,
    ]) {
      assert.equal(
        listed.some((candidate) => candidate.agent === label),
        false,
        label,
      );
    }
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  }
});

test("lead list excludes descendants with ambiguous durable parents", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "duplicate-ancestry-parent",
      undefined,
      recoveryIdentity("duplicate-ancestry-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const duplicateParent = {
    ...managedState(
      "duplicate-ancestry-parent-copy",
      undefined,
      recoveryIdentity("duplicate-ancestry-parent-copy"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "duplicate-ancestry-child",
      undefined,
      recoveryIdentity("duplicate-ancestry-child"),
    ),
    ownerSessionId: PARENT_SESSION_ID,
    piSessionId: CHILD_SESSION_ID,
  };
  const states = [parent, duplicateParent, child];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const [mailbox, state] of mailboxes.map(
    (mailbox, index) => [mailbox, states[index]] as const,
  )) {
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
  }
  const pi = fakePi({ exec: cascadeExecutor(states).exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(
      (result.details.agents as any[]).some(
        (agent) => agent.agent === child.agentLabel,
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  }
});

test("lead cannot mutate a child owned by a live parent", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "owned-parent",
      undefined,
      recoveryIdentity("owned-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: "/tmp/owned-parent.jsonl",
  };
  const child = {
    ...managedState("owned-child", undefined, recoveryIdentity("owned-child")),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/owned-child.jsonl",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  const lifecycle = cascadeExecutor([parent, child]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "close").execute(
      "id",
      { agent: child.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_not_found");
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "prompt"),
      false,
    );
    assert.ok(readAgentState(childMailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("manual close omits malformed and absent agents", async () => {
  setLeadEnvironment();
  const label = "close-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const pi = fakePi({
    exec: leadExec(
      label,
      "idle",
      identity.piSessionId,
      undefined,
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  writeAgentState(mailbox, managedState(label, undefined, identity));
  await pi.events.get("session_start")![0](undefined, fakeContext());
  writeFileSync(join(mailbox, "state.json"), "{malformed", "utf8");
  const tool = pi.tools.find((candidate) => candidate.name === "agent_close");
  assert.ok(tool);
  const malformed = await tool.execute(
    "id",
    { agent: label },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(malformed.details.error.category, "target_not_found");
  resetAgentMailbox(mailbox);
  const absent = await tool.execute(
    "id",
    { agent: label },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(absent.details.error.category, "target_not_found");
  pi.events.get("session_shutdown")?.[0]();
});

test("result cleanup retains durable delivery across agent identity changes", async () => {
  setLeadEnvironment();
  const label = "identity-change-result-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const initial = {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  };
  const changed = {
    ...initial,
    piSessionId: "22222222-2222-4222-8222-222222222222",
    piSessionFile: "/tmp/identity-change-result-agent.jsonl",
  };
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, initial);
  writeResult(mailbox, {
    version: 5,
    runId: initial.runId,
    requestId: REQUEST_ID,
    ownerSessionId: initial.ownerSessionId,
    workspaceId: initial.workspaceId,
    agentLabel: initial.agentLabel,
    paneId: initial.paneId,
    status: "completed",
    text: "retain this result",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [];
  const lifecycle = cascadeExecutor([initial]);
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result") {
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(initial, REQUEST_ID),
        });
        writeAgentState(mailbox, changed);
      } else entries.push(message);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-result",
      ).length,
      1,
    );
    assert.ok(
      readResult(mailbox, REQUEST_ID),
      "changed agent identity must retain the durable result",
    );
    assert.deepEqual(lifecycle.closeOrder, []);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("delivered result remains while agent state is active", async () => {
  setLeadEnvironment();
  const label = "active-result-anchor-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const parent = {
    ...managedState("active-result-anchor-parent"),
    piSessionId: LEAD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(mailbox);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const activeState = managedState(label, REQUEST_ID);
  writeAgentState(mailbox, activeState);
  writeResult(mailbox, {
    version: 5,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: "registered-pane",
    status: "completed",
    text: "anchor",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [];
  const pi = fakePi({
    entries,
    exec: leadExec(label, "working", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    sendMessage: () => {
      entries.push({
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(activeState, REQUEST_ID),
      });
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    assert.ok(readResult(mailbox, REQUEST_ID));
    assert.equal(
      pi.sentMessageCalls.some(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ),
      false,
    );
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    assert.equal(
      pi.sentMessageCalls.some(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-delegation-guidance",
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(mailbox);
  }
});

test("result delivery identifies retired sessions and honors the disabled setting", async () => {
  setLeadEnvironment();
  const deliver = async (
    label: string,
    marker: boolean,
    enabled: boolean,
  ): Promise<any> => {
    const identity = recoveryIdentity(label);
    const child = {
      ...managedState(label, undefined, identity),
      completedRequestId: REQUEST_ID,
    };
    const mailbox = agentMailboxPath(WORKSPACE, label);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, child);
    writeResult(mailbox, {
      version: 5,
      runId: child.runId,
      requestId: REQUEST_ID,
      ownerSessionId: child.ownerSessionId,
      workspaceId: child.workspaceId,
      agentLabel: child.agentLabel,
      paneId: child.paneId,
      status: "completed",
      text: "completed child work",
      completedAt: Date.now(),
    });
    nativeSessions.set(identity.piSessionFile!, {
      id: identity.piSessionId,
      path: identity.piSessionFile!,
      cwd: identity.piSessionFile ? "/tmp" : undefined,
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: identity.piSessionId,
            definition: "agent",
            label,
          },
        },
        ...(marker
          ? [
              {
                type: "custom",
                customType: "pi-herdsman-agent-context-retired",
                data: { sessionId: identity.piSessionId },
              },
            ]
          : []),
      ],
    });
    const lifecycle = cascadeExecutor([child]);
    const entries: unknown[] = [];
    let delivered: any;
    const pi = fakePi({
      entries,
      exec: lifecycle.exec,
      sendMessage: (message) => {
        if ((message as any).customType !== "pi-herdsman-agent-result") return;
        delivered = message;
        entries.push({
          message: {
            customType: "pi-herdsman-agent-result",
            details: (message as any).details,
          },
        });
      },
    });
    registerExtension!(pi.pi as never);
    try {
      updateConfig("contextRetirement", enabled);
      await pi.events.get("session_start")![0](undefined, fakeContext(entries));
      return delivered;
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
      nativeSessions.delete(identity.piSessionFile!);
    }
  };

  try {
    const retired = await deliver("retired-delivery-agent", true, true);
    assert.match(
      retired.content,
      /Session retired after context pressure\. Do not continue this session\./,
    );
    assert.equal(retired.details.sessionRetired, true);

    const disabled = await deliver("disabled-delivery-agent", true, false);
    assert.doesNotMatch(
      disabled.content,
      /Session retired after context pressure/,
    );
    assert.equal(disabled.details.sessionRetired, false);

    const ordinary = await deliver("ordinary-delivery-agent", false, true);
    assert.doesNotMatch(
      ordinary.content,
      /Session retired after context pressure/,
    );
    assert.equal(ordinary.details.sessionRetired, false);
  } finally {
    updateConfig("contextRetirement", undefined);
  }
});

test("accepted result delivery survives session identity failure in status guidance", async (t) => {
  setLeadEnvironment();
  const label = "status-identity-failure-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const parent = {
    ...managedState("status-identity-failure-parent"),
    piSessionId: LEAD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  resetAgentMailbox(mailbox);
  resetAgentMailbox(parentMailbox);
  writeAgentState(parentMailbox, parent);
  const resultState = {
    ...managedState(label),
    completedRequestId: REQUEST_ID,
  };
  writeAgentState(mailbox, resultState);
  writeResult(mailbox, {
    version: 5,
    runId: AGENT_ID,
    requestId: REQUEST_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: "registered-pane",
    status: "completed",
    text: "accepted before status failure",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [];
  const context = fakeContext(entries);
  let identityLookupFailed = false;
  context.sessionManager.getSessionId = () => {
    if (identityLookupFailed) throw new Error("session identity unavailable");
    return LEAD_SESSION_ID;
  };
  let resultAttempts = 0;
  const pi = fakePi({
    entries,
    exec: leadExec(label, "working", DEFAULT_PI_SESSION_ID),
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result") {
        resultAttempts++;
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(resultState, REQUEST_ID),
        });
        identityLookupFailed = true;
      } else entries.push(message);
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resultAttempts, 1);
    assert.equal((pi.sent[0] as any).details.status, "completed");
    assert.ok(readResult(mailbox, REQUEST_ID));

    t.mock.timers.tick(250);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resultAttempts, 1);
    assert.equal(
      pi.sent.some(
        (message: any) =>
          message.customType === "pi-herdsman-agent-result" &&
          message.details?.status === "failed",
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(mailbox);
  }
});

test("result is removed after agent state reaches completed", async (t) => {
  setLeadEnvironment();
  const label = "completed-result-anchor-agent";
  const pi = fakePi({
    sendMessage: () => {
      entries.push({
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(state, requestId),
      });
    },
  });
  const entries = pi.entries;
  let state!: any;
  let requestId!: string;
  registerExtension!(pi.pi as never);
  await startRadarSession(pi);
  const child = await delegateRadarChild(pi, label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  state = child;
  requestId = child.activeRequestId!;
  writeResult(mailbox, {
    version: 5,
    runId: child.runId,
    requestId,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: label,
    paneId: child.paneId,
    status: "completed",
    text: "complete",
    completedAt: Date.now(),
  });
  try {
    const delivered = () =>
      pi.sentMessageCalls.filter(
        ({ message }) =>
          (message as any).customType === "pi-herdsman-agent-result",
      ).length;
    const settleWatch = () =>
      watchedResultPaths.get(`${mailbox}/result-${requestId}.json`)?.({}, {});
    settleWatch();
    await settleUntil(() => delivered() === 1);
    assert.equal(delivered(), 1);
    assert.equal(readAgentState(mailbox)?.activeRequestId, requestId);
    assert.ok(readResult(mailbox, requestId));

    writeAgentState(mailbox, {
      ...readAgentState(mailbox)!,
      activeRequestId: undefined,
      completedRequestId: requestId,
    });
    // The delivery stops watching its own result, so the settled state is
    // picked up by the next recovery pass, which is what a restarted lead does.
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, fakeContext(entries));
    await settleUntil(() => readResult(mailbox, requestId) === undefined);
    assert.equal(readResult(mailbox, requestId), undefined);
    assert.equal(readAgentState(mailbox), undefined);
    assert.equal(radarDaemon.closes.size, 1);
    assert.equal(delivered(), 1, "a settled result is delivered once");
    const settled = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(settled.details.cleanup_errors?.[label], undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
    resetAgentMailbox(mailbox);
  }
});

test("retained delivery keeps the worker, pane, and mailbox without the result", async () => {
  let deliveries = 0;
  const label = "retained-delivery-agent";
  const { pi, mailbox, requestId } = await radarChildFixture(label, {
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result")
        deliveries++;
    },
    retainWorkers: true,
  });
  try {
    const launched = readAgentState(mailbox)!;
    writeResult(mailbox, {
      version: 5,
      runId: launched.runId,
      requestId,
      ownerSessionId: launched.ownerSessionId,
      workspaceId: launched.workspaceId,
      agentLabel: launched.agentLabel,
      paneId: launched.paneId,
      status: "completed",
      text: "complete",
      completedAt: Date.now(),
    });
    watchedResultPaths.get(`${mailbox}/result-${requestId}.json`)?.({}, {});
    await settleUntil(() => deliveries === 1);
    writeAgentState(mailbox, {
      ...launched,
      activeRequestId: undefined,
      completedRequestId: requestId,
    });
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, fakeContext(pi.entries));
    await settleUntil(() => readResult(mailbox, requestId) === undefined);
    assert.equal(readResult(mailbox, requestId), undefined);
    const retained = readAgentState(mailbox);
    assert.equal(retained?.agentLabel, label);
    assert.equal(retained?.completedRequestId, requestId);
    assert.equal(retained?.activeRequestId, undefined);
    assert.equal(
      radarDaemon.closes.size,
      0,
      "a retained worker keeps its pane",
    );
    assert.equal(deliveries, 1);
    assert.equal(
      pi.entries.some(
        (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
      ),
      false,
    );
  } finally {
    updateConfig("retainWorkers", undefined);
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
    resetAgentMailbox(mailbox);
  }
});

test("disabled retention still tears the delivered worker down", async () => {
  let deliveries = 0;
  const label = "unretained-delivery-agent";
  const { pi, mailbox, requestId } = await radarChildFixture(label, {
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result")
        deliveries++;
    },
    retainWorkers: false,
  });
  try {
    const launched = readAgentState(mailbox)!;
    writeResult(mailbox, {
      version: 5,
      runId: launched.runId,
      requestId,
      ownerSessionId: launched.ownerSessionId,
      workspaceId: launched.workspaceId,
      agentLabel: launched.agentLabel,
      paneId: launched.paneId,
      status: "completed",
      text: "complete",
      completedAt: Date.now(),
    });
    watchedResultPaths.get(`${mailbox}/result-${requestId}.json`)?.({}, {});
    await settleUntil(() => deliveries === 1);
    writeAgentState(mailbox, {
      ...launched,
      activeRequestId: undefined,
      completedRequestId: requestId,
    });
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, fakeContext(pi.entries));
    await settleUntil(() => readAgentState(mailbox) === undefined);
    assert.equal(readResult(mailbox, requestId), undefined);
    assert.equal(readAgentState(mailbox), undefined);
    assert.equal(radarDaemon.closes.size, 1);
    assert.equal(deliveries, 1);
    const delivered = pi.sentMessageCalls.find(
      (call: any) => call.message?.customType === "pi-herdsman-agent-result",
    )?.message as { content?: unknown } | undefined;
    assert.ok(delivered, "retention-off delivery publishes the result");
    assert.match(
      String(delivered?.content),
      new RegExp(
        `Worker ${label} was closed at delivery; its Pi session stays resumable\\. ` +
          `Continue it with agent_continue and session ${DEFAULT_PI_SESSION_ID} for related work\\.`,
      ),
      "a closed generation names its exact saved session",
    );
  } finally {
    updateConfig("retainWorkers", undefined);
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
    resetAgentMailbox(mailbox);
  }
});

// Durable discovery of a deliberately closed generation: retention-off delivery
// removes the mailbox and result file, leaving only the controller's own durable
// result entry and the saved Pi session.
const emptyInventory = (): ExecHandler => (command, args) =>
  command === "herdr" && isApiSnapshot(args)
    ? {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: { snapshot: { agents: [], panes: [] } },
        }),
        stderr: "",
        code: 0,
      }
    : { stdout: "{}", stderr: "", code: 0 };

const deliveredResultFixture = (
  label: string,
  overrides: {
    ownerSessionId?: string;
    definition?: string;
    status?: "completed" | "failed";
    sessionRetired?: boolean;
    sessionId?: string;
    sessionPath?: string;
    recordSessionPath?: boolean;
  } = {},
) => {
  const sessionId = overrides.sessionId ?? randomUUID();
  const sessionPath =
    overrides.sessionPath ?? join(testTmpRoot, `${label}-${sessionId}.jsonl`);
  if (overrides.recordSessionPath !== false)
    realFs.writeFileSync(sessionPath, "{}", "utf8");
  const requestId = randomUUID();
  const state = {
    ...managedState(label, undefined, recoveryIdentity(label)),
    piSessionId: sessionId,
    piSessionFile: sessionPath,
  };
  return {
    sessionId,
    sessionPath,
    requestId,
    entry: {
      type: "custom_message",
      message: {
        customType: "pi-herdsman-agent-result",
        details: {
          ...resultEntryDetails(state, requestId),
          ...(overrides.recordSessionPath === false
            ? { piSessionFile: undefined }
            : {}),
          ownerSessionId: overrides.ownerSessionId ?? LEAD_SESSION_ID,
          agentDefinition: overrides.definition ?? "child",
          status: overrides.status ?? "completed",
          sessionRetired: overrides.sessionRetired ?? false,
        },
      },
    },
  };
};

const listAgentState = async (
  pi: ReturnType<typeof fakePi>,
  entries: unknown[],
) =>
  (
    await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(entries),
    )
  ).details;

test("a closed generation is advertised as a saved session without reopening it", async () => {
  setLeadEnvironment();
  const label = "saved-session-agent";
  const delivered = deliveredResultFixture(label);
  const pi = fakePi({ exec: emptyInventory() });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    openedSessionPaths.length = 0;
    const listed = await listAgentState(pi, [delivered.entry]);
    assert.deepEqual(listed.saved_sessions, [
      {
        state: "saved",
        agent: label,
        agent_definition: "child",
        pi_session_id: delivered.sessionId,
        pi_session_path: realFs.realpathSync(delivered.sessionPath),
        last_result: {
          request_id: delivered.requestId,
          status: "completed",
        },
      },
    ]);
    assert.equal(
      listed.agents.some((agent: any) => agent.agent === label),
      false,
      "a closed generation must not be advertised as a live agent",
    );
    assert.deepEqual(
      openedSessionPaths,
      [],
      "listing a saved session must not reopen its child transcript",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(delivered.sessionPath, { force: true });
  }
});

test("saved sessions are listed only for this controller's own results", async () => {
  setLeadEnvironment();
  const owned = deliveredResultFixture("owned-saved-agent");
  const foreign = deliveredResultFixture("foreign-saved-agent", {
    ownerSessionId: randomUUID(),
  });
  const pi = fakePi({ exec: emptyInventory() });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    const listed = await listAgentState(pi, [owned.entry, foreign.entry]);
    assert.deepEqual(
      listed.saved_sessions.map((session: any) => session.agent),
      ["owned-saved-agent"],
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(owned.sessionPath, { force: true });
    realFs.rmSync(foreign.sessionPath, { force: true });
  }
});

test("a mailbox representation anywhere suppresses the saved session", async () => {
  setLeadEnvironment();
  const elsewhere = deliveredResultFixture("elsewhere-saved-agent");
  const elsewhereWorkspace = `${WORKSPACE}-elsewhere`;
  const elsewhereMailbox = agentMailboxPath(
    elsewhereWorkspace,
    "elsewhere-saved-agent",
  );
  resetAgentMailbox(elsewhereMailbox);
  writeAgentState(elsewhereMailbox, {
    ...managedState("elsewhere-saved-agent"),
    workspaceId: elsewhereWorkspace,
    piSessionId: elsewhere.sessionId,
    piSessionFile: elsewhere.sessionPath,
  });

  const occupantLabel = "uncertain-occupant-agent";
  const occupant = deliveredResultFixture(occupantLabel);
  const occupantMailbox = agentMailboxPath(WORKSPACE, occupantLabel);
  resetAgentMailbox(occupantMailbox);
  const occupantState = {
    ...managedState(occupantLabel, undefined, recoveryIdentity(occupantLabel)),
    piSessionId: occupant.sessionId,
    piSessionFile: occupant.sessionPath,
  };
  writeAgentState(occupantMailbox, occupantState);
  // The daemon reports the occupant's pane under a session that is not the one
  // its mailbox records, so its presence cannot be proved.
  observeFleet([
    {
      state: occupantState,
      sessionId: "11111111-1111-4111-8111-111111111111",
    },
  ]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    const listed = await listAgentState(pi, [elsewhere.entry, occupant.entry]);
    assert.deepEqual(
      listed.saved_sessions,
      [],
      "a represented session must never also be advertised as saved",
    );
    const row = listed.agents.find(
      (agent: any) => agent.agent === occupantLabel,
    );
    assert.equal(row?.state, "unknown");
    assert.equal(row?.recovery_only, true);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(elsewhereMailbox);
    resetAgentMailbox(occupantMailbox);
    realFs.rmSync(elsewhere.sessionPath, { force: true });
    realFs.rmSync(occupant.sessionPath, { force: true });
  }
});

test("a retired session is not advertised for continuation", async () => {
  setLeadEnvironment();
  const retired = deliveredResultFixture("retired-saved-agent", {
    sessionRetired: true,
  });
  const pi = fakePi({ exec: emptyInventory() });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    const listed = await listAgentState(pi, [retired.entry]);
    assert.deepEqual(listed.saved_sessions, []);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(retired.sessionPath, { force: true });
  }
});

test("a newer delivery decides the session's saved row", async () => {
  setLeadEnvironment();
  const label = "newest-delivery-agent";
  const first = deliveredResultFixture(label);
  const second = deliveredResultFixture(label, {
    sessionId: first.sessionId,
    sessionPath: first.sessionPath,
  });
  const retired = deliveredResultFixture(label, {
    sessionId: first.sessionId,
    sessionPath: first.sessionPath,
    sessionRetired: true,
  });
  const pi = fakePi({ exec: emptyInventory() });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    const current = await listAgentState(pi, [first.entry, second.entry]);
    assert.deepEqual(current.saved_sessions, [
      {
        state: "saved",
        agent: label,
        agent_definition: "child",
        pi_session_id: first.sessionId,
        pi_session_path: realFs.realpathSync(first.sessionPath),
        last_result: {
          request_id: second.requestId,
          status: "completed",
        },
      },
    ]);
    assert.deepEqual(
      (await listAgentState(pi, [first.entry, second.entry, retired.entry]))
        .saved_sessions,
      [],
      "a newer retired delivery retires the older row",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(first.sessionPath, { force: true });
  }
});

test("a newer delivery without a usable session record retires the row", async () => {
  setLeadEnvironment();
  const label = "unusable-delivery-agent";
  const usable = deliveredResultFixture(label);
  const unusable = deliveredResultFixture(label, {
    sessionId: usable.sessionId,
    sessionPath: usable.sessionPath,
    recordSessionPath: false,
  });
  const pi = fakePi({ exec: emptyInventory() });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    assert.equal(
      (await listAgentState(pi, [usable.entry])).saved_sessions.length,
      1,
      "the usable delivery alone advertises the saved session",
    );
    assert.deepEqual(
      (await listAgentState(pi, [usable.entry, unusable.entry])).saved_sessions,
      [],
      "an unusable newer delivery must not leave the stale row behind",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(usable.sessionPath, { force: true });
  }
});

test("unresolved background work remains active with retention enabled or disabled", async (t) => {
  setLeadEnvironment();
  t.mock.timers.enable({ apis: ["setTimeout"] });

  for (const retainWorkers of [true, false]) {
    updateConfig("retainWorkers", retainWorkers);
    const label = `waiting-retention-${retainWorkers}`;
    const mailbox = agentMailboxPath(WORKSPACE, label);
    resetAgentMailbox(mailbox);
    const activeState = managedState(label, REQUEST_ID);
    const provider = { id: "test-background-provider", version: 1 };
    activeState.backgroundWorkProvider = provider;
    activeState.backgroundWaiting = {
      sessionId: activeState.piSessionId,
      requestId: REQUEST_ID,
      provider,
      revision: 1,
      taskIds: ["bg-1"],
    };
    writeAgentState(mailbox, activeState);
    const entries: unknown[] = [];
    const lifecycle = cascadeExecutor([activeState]);
    const pi = fakePi({ entries, exec: lifecycle.exec });
    registerExtension!(pi.pi as never);

    try {
      await startRadarSession(pi, fakeContext(entries));
      const listed = await agentTool(pi, "list").execute(
        "id",
        {},
        undefined,
        undefined,
        fakeContext(entries),
      );
      t.mock.timers.tick(250);
      for (let index = 0; index < 5; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(listed.details.agents[0]?.state, "waiting");
      assert.equal(readAgentState(mailbox)?.activeRequestId, REQUEST_ID);
      assert.deepEqual(readAgentState(mailbox)?.backgroundWaiting?.taskIds, [
        "bg-1",
      ]);
      assert.equal(readResult(mailbox, REQUEST_ID), undefined);
      assert.equal(lifecycle.live.has(label), true);
      assert.deepEqual(lifecycle.closeOrder, []);
      assert.equal(
        pi.calls.some((args) => isPaneClose(args)),
        false,
      );
    } finally {
      updateConfig("retainWorkers", undefined);
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
    }
  }
});

test("repeated delivered-result cleanup after recovery retains and never closes", async (t) => {
  setLeadEnvironment();
  updateConfig("retainWorkers", true);
  const label = "retained-recovery-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const state = managedState(label);
  state.completedRequestId = REQUEST_ID;
  writeAgentState(mailbox, state);
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-agent-result",
      details: resultEntryDetails(state, REQUEST_ID),
    },
  ];
  const lifecycle = cascadeExecutor([state]);
  const pi = fakePi({ entries, exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(readAgentState(mailbox), state);
    assert.equal(lifecycle.live.has(label), true);
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.equal(
      entries.some(
        (entry: any) => entry.customType === "pi_herdsman_recovery_error",
      ),
      false,
    );
    assert.equal(
      entries.some(
        (entry: any) => entry.customType === "pi_herdsman_cleanup_error",
      ),
      false,
    );
  } finally {
    updateConfig("retainWorkers", undefined);
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("a delivered worker with a live pane projects idle with its exact tools", async (t) => {
  setLeadEnvironment();
  updateConfig("retainWorkers", true);
  const label = "retained-idle-listed";
  const identity = recoveryIdentity(label);
  writeFileSync(identity.piSessionFile, "{}", "utf8");
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const state = managedState(label, undefined, identity);
  state.completedRequestId = REQUEST_ID;
  writeAgentState(mailbox, state);
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-agent-result",
      details: resultEntryDetails(state, REQUEST_ID),
    },
  ];
  const lifecycle = cascadeExecutor([state]);
  const pi = fakePi({ entries, exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await startRadarSession(pi, fakeContext(entries));
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const listed = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(entries),
    );
    const record = listed.details.agents.find(
      (agent: any) => agent.agent === label,
    );
    assert.ok(record, "the retained worker stays listed");
    assert.equal(record.state, "idle");
    assert.deepEqual(record.available_tools, [
      "agent_inspect",
      "agent_transcript",
      "agent_close",
    ]);
    assert.equal(record.active_request_id, undefined);
    assert.equal(record.stale, undefined, "an idle worker is never stale");
    assert.equal(record.recovery_only, undefined);
    assert.equal(listed.details.cleanup_errors, undefined);
  } finally {
    updateConfig("retainWorkers", undefined);
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(identity.piSessionFile, { force: true });
  }
});

test("a restart reuses a retained worker in its existing process", async (t) => {
  setLeadEnvironment();
  updateConfig("retainWorkers", true);
  const name = `recovered-${randomUUID().slice(0, 8)}`;
  const label = `${name}-agent`;
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  const sessionPath = join(testTmpRoot, `${name}-session.jsonl`);
  writeFileSync(definitionPath, `---\nname: ${name}\n---\nrecovered body\n`);
  writeFileSync(sessionPath, "{}", "utf8");
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
          label,
        },
      },
    ],
  });
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const state = managedState(label, undefined, {
    paneId: "startup-pane",
    tabId: "startup-tab",
    piSessionId: DEFAULT_PI_SESSION_ID,
    piSessionFile: sessionPath,
  });
  const { agentLaunchFingerprint, resolveAgentLaunchInputs } =
    await import("./agent-definitions.ts");
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-agent-result",
      details: resultEntryDetails(state, REQUEST_ID),
    },
    {
      type: "custom_message",
      message: {
        customType: "pi-herdsman-agent-result",
        details: {
          piSessionId: DEFAULT_PI_SESSION_ID,
          piSessionFile: sessionPath,
          ownerSessionId: LEAD_SESSION_ID,
          runId: state.runId,
          requestId: REQUEST_ID,
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
              body: "recovered body",
            },
            { cwd: "/tmp", launchCommand: testChildCommand },
          ),
        ),
      },
    },
  ];
  const delivered: string[] = [];
  // A retained child is consumed by the daemon that launched it, so this
  // fixture's own stand-in must not be a second consumer of the same request.
  const worker = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    (text) => {
      delivered.push(text);
    },
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    true,
    false,
    undefined,
    sessionPath,
  );
  worker.stopMailboxConsumer();
  const pi = fakePi({ entries, exec: worker.exec });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);
  // The daemon this process registers against is the one whose store already
  // holds the retained child's edge, so it comes up before the child is adopted.
  await ensureRadarDaemon();
  // The worker was launched through Radar before the restart, delivered its
  // result and was retained: the daemon still holds the edge it bound, and the
  // child's own mailbox keeps the generation it acknowledged.
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
    completedRequestId: REQUEST_ID,
  });
  entries.push({
    type: "custom",
    customType: "pi-herdsman-radar-spawn",
    data: launch,
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await startRadarSession(pi, context);
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const listed = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    const record = listed.details.agents.find(
      (agent: any) => agent.agent === label,
    );
    assert.ok(record, "the restart restores the retained worker");
    assert.equal(record.state, "idle");
    const starts = () =>
      pi.calls.filter((args) => args[0] === "agent" && args[1] === "start")
        .length;
    const startsBefore = starts();
    const continued = await agentTool(pi, "continue").execute(
      "id",
      { session: sessionPath, task: "continue after restart" },
      undefined,
      undefined,
      context,
    );
    assert.equal(continued.details.ok, true, JSON.stringify(continued.details));
    assert.equal(continued.details.reused, true);
    assert.equal(continued.details.agent, label);
    assert.equal(continued.details.session_id, DEFAULT_PI_SESSION_ID);
    assert.equal(starts(), startsBefore, "reuse must not start a process");
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /continue after restart/);
    const after = readAgentState(mailbox);
    assert.equal(after?.activeRequestId, continued.details.request_id);
    assert.equal(after?.completedRequestId, undefined);
    assert.equal(after?.runId, state.runId);
    // The assignment was addressed to the process the daemon's record of the
    // launch names, and the worker's acceptance echoed that exact address: the
    // restart's reuse is that agreement, not the startup acknowledgment left
    // behind in the mailbox.
    assert.deepEqual(after?.lastAck?.identity, {
      subject: launch.agentId,
      source: RADAR_SUBJECT_SOURCE,
      incarnation: radarDaemon.spawns.at(-1)!.incarnation,
      generation: launch.generation,
    });
  } finally {
    updateConfig("retainWorkers", undefined);
    pi.events.get("session_shutdown")?.[0]();
    radarDaemon.reset();
    nativeSessions.delete(DEFAULT_PI_SESSION_ID);
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(sessionPath, { force: true });
  }
});

test("an idle retained worker produces no attention or digest while it waits", async (t) => {
  setLeadEnvironment();
  updateConfig("retainWorkers", true);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const label = "retained-idle-quiet";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const state = managedState(label, undefined, identity);
  state.completedRequestId = REQUEST_ID;
  state.lastActivityAt = now - 1_800_000;
  writeAgentState(mailbox, state);
  const entries: unknown[] = [
    {
      customType: "pi-herdsman-agent-result",
      details: resultEntryDetails(state, REQUEST_ID),
    },
  ];
  const pi = fakePi({
    entries,
    exec: leadExec(
      label,
      "idle",
      identity.piSessionId,
      undefined,
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readAgentState(mailbox)?.completedRequestId, REQUEST_ID);

    now += 1_800_000;
    for (const _ of [0, 1]) {
      t.mock.timers.tick(30_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(softDigests(pi).length, 0);
    assert.equal(
      pi.sent.some((message: any) =>
        [
          "pi-herdsman-agent-attention",
          "pi-herdsman-agent-stale",
          "pi-herdsman-agent-lost",
          "pi-herdsman-agent-soft-deadline",
        ].includes(message.customType),
      ),
      false,
      "an idle retained worker must not wake its owner",
    );
  } finally {
    updateConfig("retainWorkers", undefined);
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("live result cleanup keeps a later request owned by the mailbox", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const durableSecondResult of [false, true]) {
    setLeadEnvironment();
    await ensureRadarDaemon();
    const label = `root-result-race-${durableSecondResult ? "result" : "request"}`;
    const mailbox = agentMailboxPath(WORKSPACE, label);
    const secondRequestId = randomUUID();
    resetAgentMailbox(mailbox);
    const launch = await radarDaemon.adoptRetainedChild({
      label,
      runId: randomUUID(),
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      mailbox,
      pane: `${label}-pane`,
    });
    // The later request is one this worker never accepts: a request left in the
    // mailbox is the durable work the cleanup must not close over.
    radarDaemon.options.acceptAssignments = false;
    // The child was launched, accepted an assignment and delivered a result
    // while the assignment was still unresolved: the durable shape the cleanup
    // acts on.
    const template = managedState(label, REQUEST_ID);
    const state = {
      ...readAgentState(mailbox)!,
      activeRequestId: template.activeRequestId,
      acceptedAssignment: template.acceptedAssignment,
      briefProfile: template.briefProfile,
    };
    writeAgentState(mailbox, state);
    writeResult(mailbox, {
      version: 5,
      runId: state.runId,
      requestId: REQUEST_ID,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      status: "completed",
      text: "delivered root result",
      completedAt: Date.now(),
    });
    const entries: unknown[] = [
      { type: "custom", customType: "pi-herdsman-radar-spawn", data: launch },
    ];
    let secondRequestWritten = false;
    const pi = fakePi({
      entries,
      sendMessage: (message) => {
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(state, REQUEST_ID),
        });
        if (
          !secondRequestWritten &&
          (message as any).customType === "pi-herdsman-agent-result"
        ) {
          secondRequestWritten = true;
          writeRequest(mailbox, {
            version: 5,
            runId: state.runId,
            requestId: secondRequestId,
            ownerSessionId: state.ownerSessionId,
            workspaceId: state.workspaceId,
            agentLabel: state.agentLabel,
            paneId: state.paneId,
            kind: "task",
            text: "later request",
            createdAt: Date.now(),
          });
          if (durableSecondResult)
            writeResult(mailbox, {
              version: 5,
              runId: state.runId,
              requestId: secondRequestId,
              ownerSessionId: state.ownerSessionId,
              workspaceId: state.workspaceId,
              agentLabel: state.agentLabel,
              paneId: state.paneId,
              status: "completed",
              text: "later result",
              completedAt: Date.now(),
            });
        }
      },
    });
    registerExtension!(pi.pi as never);
    const closedPanes = () =>
      [...radarDaemon.closes.values()].map((close) => close.pane);
    try {
      await startRadarSession(pi, fakeContext(entries));
      // The assignment resolved: the acceptance record goes with it, which is
      // the durable shape a delivered result leaves.
      writeAgentState(mailbox, {
        ...state,
        activeRequestId: undefined,
        acceptedAssignment: undefined,
        briefProfile: undefined,
        completedRequestId: REQUEST_ID,
      });
      t.mock.timers.tick(250);
      for (let index = 0; index < 5; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(readAgentState(mailbox));
      assert.ok(readResult(mailbox, REQUEST_ID));
      assert.ok(readRequest(mailbox, secondRequestId));
      assert.deepEqual(closedPanes(), []);

      removeRequest(mailbox, secondRequestId);
      if (durableSecondResult) removeResult(mailbox, secondRequestId);
      t.mock.timers.tick(250);
      await settleUntil(() => readAgentState(mailbox) === undefined);
      assert.equal(readResult(mailbox, REQUEST_ID), undefined);
      assert.deepEqual(closedPanes(), [`${label}-pane`]);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
    }
  }
});

test("lost result cleanup keeps a later request owned by the mailbox", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const durableSecondResult of [false, true]) {
    setLeadEnvironment();
    const label = `lost-result-race-${durableSecondResult ? "result" : "request"}`;
    const state = {
      ...managedState(label, undefined, recoveryIdentity(label)),
      completedRequestId: REQUEST_ID,
    };
    const mailbox = agentMailboxPath(WORKSPACE, label);
    const secondRequestId = randomUUID();
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
    writeResult(mailbox, {
      version: 5,
      runId: state.runId,
      requestId: REQUEST_ID,
      ownerSessionId: state.ownerSessionId,
      workspaceId: state.workspaceId,
      agentLabel: state.agentLabel,
      paneId: state.paneId,
      status: "completed",
      text: "delivered root result",
      completedAt: Date.now(),
    });
    const entries: unknown[] = [];
    let secondRequestWritten = false;
    const pi = fakePi({
      entries,
      exec: cascadeExecutor([]).exec,
      sendMessage: (message) => {
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(state, REQUEST_ID),
        });
        if (
          !secondRequestWritten &&
          (message as any).customType === "pi-herdsman-agent-result"
        ) {
          secondRequestWritten = true;
          writeRequest(mailbox, {
            version: 5,
            runId: state.runId,
            requestId: secondRequestId,
            ownerSessionId: state.ownerSessionId,
            workspaceId: state.workspaceId,
            agentLabel: state.agentLabel,
            paneId: state.paneId,
            kind: "task",
            text: "later request",
            createdAt: Date.now(),
          });
          if (durableSecondResult)
            writeResult(mailbox, {
              version: 5,
              runId: state.runId,
              requestId: secondRequestId,
              ownerSessionId: state.ownerSessionId,
              workspaceId: state.workspaceId,
              agentLabel: state.agentLabel,
              paneId: state.paneId,
              status: "completed",
              text: "later result",
              completedAt: Date.now(),
            });
        }
      },
    });
    // The daemon reports no pane this mailbox was recorded in: the generation is
    // gone, and only its durable facts remain.
    observeFleet([]);
    registerExtension!(pi.pi as never);
    try {
      await pi.events.get("session_start")![0](undefined, fakeContext(entries));
      t.mock.timers.tick(250);
      for (let index = 0; index < 8; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(readAgentState(mailbox));
      assert.ok(readResult(mailbox, REQUEST_ID));
      assert.ok(readRequest(mailbox, secondRequestId));
      assert.deepEqual(
        (
          await agentTool(pi, "list").execute(
            "id",
            {},
            undefined,
            undefined,
            fakeContext(entries),
          )
        ).details.agents.find((agent: any) => agent.agent === label).state,
        "settling",
      );

      removeRequest(mailbox, secondRequestId);
      if (durableSecondResult) removeResult(mailbox, secondRequestId);
      t.mock.timers.tick(250);
      for (let index = 0; index < 8; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(readAgentState(mailbox), undefined);
      assert.equal(readResult(mailbox, REQUEST_ID), undefined);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
    }
  }
});

test("parent cascade keeps a later parent request during result cleanup", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "cascade-result-race-parent",
      undefined,
      recoveryIdentity("cascade-result-race-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    piSessionFile: join(testTmpRoot, "cascade-result-race-parent.jsonl"),
    completedRequestId: REQUEST_ID,
  };
  writeFileSync(parent.piSessionFile, "{}", "utf8");
  const child = {
    ...managedState(
      "cascade-result-race-child",
      undefined,
      recoveryIdentity("cascade-result-race-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: randomUUID(),
    piSessionFile: join(testTmpRoot, "cascade-result-race-child.jsonl"),
  };
  writeFileSync(child.piSessionFile, "{}", "utf8");
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  const secondRequestId = randomUUID();
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  writeResult(parentMailbox, {
    version: 5,
    runId: parent.runId,
    requestId: REQUEST_ID,
    ownerSessionId: parent.ownerSessionId,
    workspaceId: parent.workspaceId,
    agentLabel: parent.agentLabel,
    paneId: parent.paneId,
    status: "completed",
    text: "delivered parent result",
    completedAt: Date.now(),
  });
  const lifecycle = cascadeExecutor([child]);
  const entries: unknown[] = [];
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      entries.push({
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(parent, REQUEST_ID),
      });
      if ((message as any).customType === "pi-herdsman-agent-result")
        writeRequest(parentMailbox, {
          version: 5,
          runId: parent.runId,
          requestId: secondRequestId,
          ownerSessionId: parent.ownerSessionId,
          workspaceId: parent.workspaceId,
          agentLabel: parent.agentLabel,
          paneId: parent.paneId,
          kind: "task",
          text: "later parent request",
          createdAt: Date.now(),
        });
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext(entries));
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readResult(parentMailbox, REQUEST_ID));
    assert.ok(readRequest(parentMailbox, secondRequestId));
    assert.deepEqual(lifecycle.closeOrder, []);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    realFs.rmSync(parent.piSessionFile!, { force: true });
    realFs.rmSync(child.piSessionFile!, { force: true });
  }
});

test("completed lost parent cleanup resolves descendants before its mailbox", async () => {
  for (const childLive of [true, false]) {
    setLeadEnvironment();
    await ensureRadarDaemon();
    const suffix = childLive ? "live-child" : "lost-child";
    const parentLabel = `completed-lost-parent-${suffix}`;
    const childLabel = `completed-lost-child-${suffix}`;
    const parentMailbox = agentMailboxPath(WORKSPACE, parentLabel);
    const childMailbox = agentMailboxPath(WORKSPACE, childLabel);
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    const parent = {
      ...managedState(parentLabel, undefined, recoveryIdentity(parentLabel)),
      piSessionId: PARENT_SESSION_ID,
      piSessionFile: join(testTmpRoot, `${parentLabel}.jsonl`),
      completedRequestId: REQUEST_ID,
    };
    writeFileSync(parent.piSessionFile, "{}", "utf8");
    writeAgentState(parentMailbox, parent);
    // A live child is one the daemon launched; a lost one is a mailbox whose
    // process is gone, which the cascade still resolves by ancestry.
    const childLaunch = childLive
      ? await radarDaemon.adoptRetainedChild({
          label: childLabel,
          runId: randomUUID(),
          ownerSessionId: PARENT_SESSION_ID,
          workspaceId: WORKSPACE,
          mailbox: childMailbox,
          pane: `${childLabel}-pane`,
        })
      : undefined;
    if (!childLive) {
      writeAgentState(childMailbox, {
        ...managedState(childLabel, undefined, recoveryIdentity(childLabel)),
        runId: randomUUID(),
        ownerSessionId: PARENT_SESSION_ID,
        piSessionId: CHILD_SESSION_ID,
      });
    }
    writeResult(parentMailbox, {
      version: 5,
      runId: parent.runId,
      requestId: REQUEST_ID,
      ownerSessionId: parent.ownerSessionId,
      workspaceId: parent.workspaceId,
      agentLabel: parent.agentLabel,
      paneId: parent.paneId,
      status: "completed",
      text: "completed before the parent pane disappeared",
      completedAt: Date.now(),
    });
    const entries: unknown[] = childLaunch
      ? [
          {
            type: "custom",
            customType: "pi-herdsman-radar-spawn",
            data: childLaunch,
          },
        ]
      : [];
    const pi = fakePi({
      entries,
      sendMessage: (message) => {
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: resultEntryDetails(parent, REQUEST_ID),
        });
        void message;
      },
    });
    // No pane the parent was recorded in is reported: the parent is gone.
    radarDaemon.options.inventory = {
      workspaces: [],
      tabs: [],
      panes: [],
      agents: [],
    };
    registerExtension!(pi.pi as never);
    const closedPanes = () =>
      [...radarDaemon.closes.values()].map((close) => close.pane);
    try {
      await startRadarSession(pi, fakeContext(entries));
      await settleUntil(
        () =>
          readAgentState(parentMailbox) === undefined &&
          readAgentState(childMailbox) === undefined,
      );
      assert.equal(readResult(parentMailbox, REQUEST_ID), undefined);
      assert.deepEqual(
        closedPanes(),
        childLive ? [`${childLabel}-pane`] : [],
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(parentMailbox);
      resetAgentMailbox(childMailbox);
    }
  }
});

test("automatic close invokes the exact lifecycle only after live identity proof", async () => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const label = "automatic-close-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const launch = await radarDaemon.adoptRetainedChild({
    label,
    runId: randomUUID(),
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    mailbox,
    pane: "automatic-close-pane",
  });
  const state = readAgentState(mailbox)!;
  const resultState = { ...state, completedRequestId: REQUEST_ID };
  writeAgentState(mailbox, resultState);
  writeResult(mailbox, {
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "close me",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [
    { type: "custom", customType: "pi-herdsman-radar-spawn", data: launch },
  ];
  const pi = fakePi({
    entries,
    sendMessage: () => {
      entries.push({
        customType: "pi-herdsman-agent-result",
        details: resultEntryDetails(resultState, REQUEST_ID),
      });
    },
  });
  try {
    registerExtension!(pi.pi as never);
    await startRadarSession(pi, fakeContext(entries));
    await settleUntil(() => readAgentState(mailbox) === undefined);
    assert.deepEqual(
      [...radarDaemon.closes.values()].map((close) => close.pane),
      [state.paneId],
    );
    assert.equal(
      readAgentState(mailbox),
      undefined,
      JSON.stringify(pi.entries),
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});
test("managed child automatic cleanup respects the parent delegation lock", async () => {
  setAgentEnvironment("cleanup-parent", ["child"]);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parent = managedState("cleanup-parent");
  const child = {
    ...managedState(
      "cleanup-child",
      undefined,
      recoveryIdentity("cleanup-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    piSessionFile: "/tmp/cleanup-child.jsonl",
    completedRequestId: REQUEST_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  writeResult(childMailbox, {
    version: 5,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    status: "completed",
    text: "close the child",
    completedAt: Date.now(),
  });
  const entries: unknown[] = [
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
  ];
  const lifecycle = delegatedLifecycleExecutor(parent, [child]);
  const pi = fakePi({
    entries,
    exec: lifecycle.exec,
    sendMessage: (message) => {
      if ((message as any).customType === "pi-herdsman-agent-result")
        entries.push({
          customType: "pi-herdsman-agent-result",
          details: (message as any).details,
        });
    },
  });
  const release = claimProcessLock(
    delegationLockPathForTest(WORKSPACE, parent.piSessionId),
    {
      name: "test delegation lifecycle",
    },
  );
  const context = fakeAgentContext(entries);
  try {
    registerExtension!(pi.pi as never);
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);

    assert.deepEqual(lifecycle.closeOrder, []);
    assert.ok(readAgentState(childMailbox));
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi_herdsman_cleanup_error" &&
          String(entry.data?.error).includes("Delegation lifecycle"),
      ),
    );
  } finally {
    for (const handler of pi.events.get("session_shutdown") ?? []) handler();
    release();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("stale scanner starts immediately, reschedules, deduplicates, and retries failed publication", async (t) => {
  setLeadEnvironment();
  const label = "scanner-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const staleAt = now - 10 * 60_000 - 1_000;
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, defaultFixtureIdentity),
    lastActivityAt: staleAt,
  });
  let attempts = 0;
  const baseExec = leadExec(label, "working", DEFAULT_PI_SESSION_ID);
  const pi = fakePi({
    exec: (command, args, options) => {
      const result = baseExec(command, args, options);
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        const payload = JSON.parse(result.stdout);
        payload.result.agent.agent_status = "working";
        return { ...result, stdout: JSON.stringify(payload) };
      }
      return result;
    },
    sendMessage: () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
    },
  });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await settleUntil(() => attempts === 1);
  assert.equal(attempts, 1, "the controller performs an immediate scan");

  t.mock.timers.tick(30_000);
  await settleUntil(() => attempts === 2);
  assert.equal(attempts, 2, "a failed advisory is retried on the next scan");
  t.mock.timers.tick(30_000);
  await settleUntil(() => attempts === 2);
  assert.equal(attempts, 2, "a successful episode waits for its reminder");

  now += 5 * 60_000;
  t.mock.timers.tick(30_000);
  await settleUntil(() => attempts === 3);
  assert.equal(attempts, 3);
  assert.equal(pi.sent.at(-1)?.details?.nextReminderMs, 5 * 60_000);

  now += 5 * 60_000;
  t.mock.timers.tick(30_000);
  await settleUntil(() => attempts === 4);
  assert.equal(attempts, 4);
  assert.equal(pi.sent.at(-1)?.details?.nextReminderMs, 5 * 60_000);

  now += 5 * 60_000;
  t.mock.timers.tick(30_000);
  await settleUntil(() => attempts === 5);
  assert.equal(attempts, 5);
  assert.equal(pi.sent.at(-1)?.details?.nextReminderMs, 5 * 60_000);

  writeAgentState(mailbox, {
    ...readAgentState(mailbox)!,
    lastActivityAt: now,
    updatedAt: now,
  });
  writeAgentState(mailbox, {
    ...readAgentState(mailbox)!,
    lastActivityAt: now - 10 * 60_000 - 1_000,
    updatedAt: now,
  });
  t.mock.timers.tick(30_000);
  await settleUntil(() => attempts === 6);
  assert.equal(
    attempts,
    6,
    "a changed activity timestamp starts a new episode",
  );
  pi.events.get("session_shutdown")?.[0]();
  t.mock.timers.tick(60_000);
  assert.equal(attempts, 6, "shutdown removes the recurring scanner");
});

test("stale scanner skips completion or identity changes before publication", async () => {
  setLeadEnvironment();
  const label = "scanner-race-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID),
    lastActivityAt: Date.now() - 11 * 60_000,
  });
  let resolveList!: () => void;
  const listPending = new Promise<void>((resolve) => (resolveList = resolve));
  let sendCount = 0;
  const pi = fakePi({
    exec: async (command, args) => {
      if (command === "herdr" && isApiSnapshot(args)) {
        await listPending;
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: JSON.parse(listResponse(label, "working")),
          }),
          stderr: "",
          code: 0,
        };
      }
      return leadExec(label, "working", DEFAULT_PI_SESSION_ID)(command, args);
    },
    sendMessage: () => {
      sendCount++;
    },
  });
  registerExtension!(pi.pi as never);
  const startup = pi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  writeAgentState(mailbox, {
    ...readAgentState(mailbox)!,
    activeRequestId: undefined,
    completedRequestId: REQUEST_ID,
  });
  resolveList();
  await startup;
  await Promise.resolve();
  assert.equal(sendCount, 0, "completion invalidates the pending advisory");
  pi.events.get("session_shutdown")?.[0]();
});

test("stale scanner skips every replaced identity field before publication", async () => {
  for (const field of [
    "runId",
    "ownerSessionId",
    "workspaceId",
    "agentLabel",
    "paneId",
    "piSessionId",
  ] as const) {
    setLeadEnvironment();
    const label = `identity-race-${field}`;
    const mailbox = agentMailboxPath(WORKSPACE, label);
    writeAgentState(mailbox, {
      ...managedState(label, REQUEST_ID),
      lastActivityAt: Date.now() - 11 * 60_000,
    });
    let resolveList!: () => void;
    const pending = new Promise<void>((resolve) => (resolveList = resolve));
    let sends = 0;
    const pi = fakePi({
      exec: async (command, args) => {
        if (command === "herdr" && isApiSnapshot(args)) {
          await pending;
          return {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: {
                  agents: JSON.parse(listResponse(label, "working")).agents,
                  panes: [
                    {
                      pane_id: `${label}-pane`,
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
        }
        return leadExec(label, "working", DEFAULT_PI_SESSION_ID)(command, args);
      },
      sendMessage: () => {
        sends++;
      },
    });
    registerExtension!(pi.pi as never);
    const startup = pi.events.get("session_start")![0](
      undefined,
      fakeContext(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const replacements = {
      runId: "99999999-9999-4999-8999-999999999999",
      ownerSessionId: "88888888-8888-4888-8888-888888888888",
      workspaceId: `${WORKSPACE}-replacement`,
      agentLabel: `${label}-replacement`,
      paneId: "replacement-pane",
      piSessionId: "77777777-7777-4777-8777-777777777777",
    };
    const replacement = {
      ...readAgentState(mailbox)!,
      [field]: replacements[field],
    };
    writeAgentState(mailbox, replacement);
    resolveList();
    await startup;
    assert.equal(sends, 0, field);
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("delegation parent notifies only its direct stale child", async (t) => {
  setAgentEnvironment("stale-parent", ["agent"]);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = managedState("stale-parent");
  // Each state is its own delegation run: two live children under one run id are
  // ambiguous by design, not a shape a stale advisory can build on.
  const child = {
    ...managedState("stale-child", REQUEST_ID, recoveryIdentity("stale-child")),
    runId: randomUUID(),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    lastActivityAt: now - 11 * 60_000,
  };
  const unrelated = {
    ...managedState(
      "unrelated-child",
      REQUEST_ID,
      recoveryIdentity("unrelated-child"),
    ),
    runId: randomUUID(),
    ownerSessionId: PARENT_SESSION_ID,
    lastActivityAt: now - 11 * 60_000,
  };
  for (const state of [parent, child, unrelated])
    writeAgentState(agentMailboxPath(WORKSPACE, state.agentLabel), state);
  nativeSessions.set(parent.piSessionFile!, {
    id: parent.piSessionId!,
    path: parent.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: parent.piSessionId,
          definition: "parent",
          label: parent.agentLabel,
        },
      },
    ],
  });
  nativeSessions.set(child.piSessionFile!, {
    id: child.piSessionId!,
    path: child.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: child.piSessionId,
          definition: "agent",
          label: child.agentLabel,
        },
      },
    ],
  });
  nativeSessions.set(unrelated.piSessionFile!, {
    id: unrelated.piSessionId!,
    path: unrelated.piSessionFile!,
    entries: [
      {
        type: "custom",
        customType: "pi-herdsman-agent-definition",
        data: {
          sessionId: unrelated.piSessionId,
          definition: "agent",
          label: unrelated.agentLabel,
        },
      },
    ],
  });
  const sent: unknown[] = [];
  const baseExec = agentControllerExecutor(parent, [child, unrelated]);
  let diagnosticReads = 0;
  let resumeOnDiagnostic = false;
  const exec = (command: string, args: string[], options?: any) => {
    if (
      command === "herdr" &&
      args[0] === "agent" &&
      args[1] === "read" &&
      args[2] === child.paneId
    ) {
      diagnosticReads++;
      if (resumeOnDiagnostic) {
        const current = readAgentState(
          agentMailboxPath(WORKSPACE, child.agentLabel),
        )!;
        writeAgentState(agentMailboxPath(WORKSPACE, child.agentLabel), {
          ...current,
          lastActivityAt: now,
          updatedAt: now,
        });
        return { stdout: "work resumed", stderr: "", code: 0 };
      }
      return {
        stdout: "npm test\n42 passed, still running",
        stderr: "",
        code: 0,
      };
    }
    if (
      command === "herdr" &&
      args[0] === "pane" &&
      args[1] === "process-info" &&
      args.at(-1) === child.paneId
    )
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            process_info: {
              pane_id: child.paneId,
              shell_pid: 100,
              foreground_process_group_id: 101,
              foreground_processes: [
                { pid: 101, argv0: "node", cmdline: "npm test" },
              ],
            },
          },
        }),
        stderr: "",
        code: 0,
      };
    return baseExec(command, args, options);
  };
  process.env.PI_HERDSMAN_RUN_ID = parent.runId;
  process.env.PI_HERDSMAN_OWNER_SESSION_ID = LEAD_SESSION_ID;
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "parent";
  const parentPi = fakePi({
    exec,
    sendMessage: (message) => sent.push(message),
  });
  registerExtension!(parentPi.pi as never);
  const parentContext = fakeAgentContext([
    {
      type: "custom",
      customType: "pi-herdsman-agent-definition",
      data: {
        sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        definition: "parent",
        label: process.env.PI_HERDSMAN_LABEL ?? "parent",
      },
    },
  ]);
  for (const handler of parentPi.events.get("session_start") ?? [])
    await handler(undefined, parentContext);
  await settleUntil(() => sent.length === 1);
  assert.equal(
    sent.length,
    1,
    `parent publishes one direct-child advisory: ${JSON.stringify(parentPi.calls)}`,
  );
  const advisory = sent[0] as any;
  assert.equal(advisory.customType, "pi-herdsman-agent-stale");
  assert.match(
    advisory.content,
    /Agent stale-child has had no qualifying execution progress/,
  );
  assert.match(
    advisory.content,
    /Streaming tool output does not count as qualifying progress/,
  );
  assert.match(advisory.content, /not proof of a hang/);
  assert.doesNotMatch(
    advisory.content,
    /Use agent_transcript when .*; use agent_inspect only/,
  );
  assert.match(advisory.content, /Bounded live diagnostic/);
  assert.match(advisory.content, /npm test/);
  assert.match(advisory.content, /42 passed/);
  assert.match(advisory.content, /untrusted observation/);
  assert.equal(diagnosticReads, 1);
  assert.equal(
    advisory.details.recent_output,
    "npm test\n42 passed, still running",
  );
  assert.equal(
    advisory.details.process.foreground_processes[0].cmdline,
    "npm test",
  );
  assert.match(
    advisory.content,
    /Available tools: agent_inspect, agent_steer, agent_interrupt, agent_close/,
  );
  assert.match(advisory.content, /agent_steer queues a cooperative correction/);
  assert.match(
    advisory.content,
    /interrupt.*current operation.*continues the same assignment/,
  );
  assert.match(advisory.content, /Next reminder if unresolved/);
  assert.equal(advisory.details.agentLabel, child.agentLabel);
  assert.equal(advisory.details.ownerSessionId, parent.piSessionId);
  assert.equal(advisory.details.requestId, REQUEST_ID);
  assert.equal(advisory.details.lastActivityAt, child.lastActivityAt);

  parentPi.sent.length = 0;
  now += 5 * 60_000;
  t.mock.timers.tick(5 * 60_000);
  // Each scan crosses the daemon, so the reminder arrives on the socket's
  // schedule, not the tick's.
  await settleUntil(() =>
    parentPi.sent.some(
      (message: any) => message.customType === "pi-herdsman-agent-stale",
    ),
  );
  const reminder = parentPi.sent.find(
    (message: any) => message.customType === "pi-herdsman-agent-stale",
  ) as any;
  assert.ok(reminder);
  assert.equal(diagnosticReads, 1);
  assert.match(reminder.content, /same stale episode/i);
  assert.match(reminder.content, /additional elapsed time.*recovery evidence/i);
  assert.match(reminder.content, /no qualifying execution boundary/i);
  assert.match(reminder.content, /steer.*cannot have taken effect/i);
  assert.match(
    reminder.content,
    /do not repeat agent_inspect or agent_transcript/i,
  );
  assert.match(reminder.content, /otherwise use agent_interrupt/i);
  assert.match(
    reminder.content,
    /Continue waiting only while existing evidence still positively supports a legitimate long-running operation/,
  );
  assert.doesNotMatch(reminder.content, /appears healthy.*leave it alone/i);
  assert.equal(diagnosticReads, 1);

  const nextEpisode = {
    ...readAgentState(agentMailboxPath(WORKSPACE, child.agentLabel))!,
    lastActivityAt: now - 11 * 60_000,
  };
  writeAgentState(agentMailboxPath(WORKSPACE, child.agentLabel), nextEpisode);
  now += 30_000;
  t.mock.timers.tick(30_000);
  // A new episode means a new first-attention diagnostic read, which the scan
  // reaches only after a daemon round trip.
  await settleUntil(() => diagnosticReads === 2);
  const raceEpisode = {
    ...readAgentState(agentMailboxPath(WORKSPACE, child.agentLabel))!,
    lastActivityAt: now - 12 * 60_000,
  };
  writeAgentState(agentMailboxPath(WORKSPACE, child.agentLabel), raceEpisode);
  parentPi.sent.length = 0;
  resumeOnDiagnostic = true;
  now += 30_000;
  t.mock.timers.tick(30_000);
  await settleUntil(() => diagnosticReads === 3);
  for (let index = 0; index < 5; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    parentPi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-stale",
    ).length,
    0,
  );
  parentPi.events.get("session_shutdown")?.[0]();

  setLeadEnvironment();
  for (const state of [parent, child, unrelated])
    writeAgentState(agentMailboxPath(WORKSPACE, state.agentLabel), state);
  const rootSent: unknown[] = [];
  const rootPi = fakePi({
    exec: agentControllerExecutor(parent, [child, unrelated]),
    sendMessage: (message) => rootSent.push(message),
  });
  registerExtension!(rootPi.pi as never);
  await rootPi.events.get("session_start")![0](undefined, fakeContext());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    rootSent
      .filter(
        (message: any) => message.customType === "pi-herdsman-agent-stale",
      )
      .map((message: any) => message.details.agentLabel),
    [],
    "lead must not steal a parent's child advisory",
  );
  rootPi.events.get("session_shutdown")?.[0]();
  for (const state of [parent, child, unrelated])
    resetAgentMailbox(agentMailboxPath(WORKSPACE, state.agentLabel));
  for (const state of [parent, child, unrelated])
    nativeSessions.delete(state.piSessionFile!);
});

test("stale diagnostic failure still publishes advisory without recovery", async () => {
  setLeadEnvironment();
  const label = "stale-diagnostic-failure";
  const state = {
    ...managedState(label, REQUEST_ID, recoveryIdentity(label)),
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, state);
  const calls: [string, string[]][] = [];
  const baseExec = agentControllerExecutor(state);
  const pi = fakePi({
    exec: (command, args, options) => {
      calls.push([command, args]);
      if (command === "herdr" && args[0] === "agent" && args[1] === "read")
        return { stdout: "", stderr: "inspection unavailable", code: 1 };
      return baseExec(command, args, options);
    },
  });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    await settleUntil(() =>
      pi.sent.some(
        (message: any) => message.customType === "pi-herdsman-agent-stale",
      ),
    );
    const staleMessages = pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-stale",
    ) as any[];
    assert.equal(staleMessages.length, 1);
    assert.match(
      staleMessages[0].content,
      /Automatic live diagnostic evidence was unavailable/,
    );
    assert.match(
      staleMessages[0].content,
      /at most one currently available diagnostic read/,
    );
    assert.equal(
      calls.some(
        ([, args]) =>
          args[0] === "agent" && ["prompt", "close", "stop"].includes(args[1]!),
      ),
      false,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("stale working parents remain visible while waiting parents project blocked", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = {
    ...managedState(
      "stale-working-parent",
      REQUEST_ID,
      recoveryIdentity("stale-working-parent"),
    ),
    lastActivityAt: now - 11 * 60_000,
  };
  const child = {
    ...managedState("active-parent-child", randomUUID(), {
      ...recoveryIdentity("active-parent-child"),
      piSessionId: CHILD_SESSION_ID,
    }),
    // Its own run, as a real launch has: two children under one run id are
    // candidate claimants of each other's pane.
    runId: randomUUID(),
    ownerSessionId: parent.piSessionId,
  };
  for (const state of [parent, child])
    writeAgentState(agentMailboxPath(WORKSPACE, state.agentLabel), state);

  // The daemon reports both panes, the parent's as a working pane.
  observeFleet([{ state: parent }, { state: child }]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    await startRadarSession(pi, fakeContext());
    await settleUntil(
      () =>
        pi.sent.filter(
          (message: any) => message.customType === "pi-herdsman-agent-stale",
        ).length === 1,
    );
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-stale",
      ).length,
      1,
      "a stale working parent must notify its own owner even with an active child",
    );
    const stale = pi.sent.find(
      (message: any) => message.customType === "pi-herdsman-agent-stale",
    ) as any;
    assert.equal(stale.details.agentLabel, parent.agentLabel);
    assert.equal(stale.details.ownerSessionId, LEAD_SESSION_ID);

    pi.sent.length = 0;
    // The parent's pane stops reporting work while it waits on the child.
    observeFleet([{ state: parent, status: "idle" }, { state: child }]);
    t.mock.timers.tick(30_000);
    await new Promise((resolve) => setImmediate(resolve));
    const waiting = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(
      waiting.details.agents.find(
        (agent: any) => agent.agent === parent.agentLabel,
      )?.state,
      "blocked",
      "an idle parent waiting on an unresolved child projects blocked",
    );
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-stale",
      ).length,
      0,
      "a waiting parent must not receive a stale advisory",
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const state of [parent, child])
      resetAgentMailbox(agentMailboxPath(WORKSPACE, state.agentLabel));
  }
});

test("health scanner alerts true runtime blocking", async () => {
  setLeadEnvironment();
  const label = "runtime-blocked";
  const state = {
    ...managedState(label, REQUEST_ID, recoveryIdentity(label)),
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, state);
  const sent: any[] = [];
  // The daemon reports the pane with the lifecycle that is the blocking fact.
  observeFleet([{ state, status: "blocked" }]);
  const pi = fakePi({
    sendMessage: (message) => sent.push(message),
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await settleUntil(() => sent.length === 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "pi-herdsman-agent-attention");
  assert.equal(sent[0].details.reason, "blocked");
  assert.match(sent[0].content, /no Herdsman ask_owner question exists/);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("settling alone does not trigger generic health attention", async () => {
  setLeadEnvironment();
  const label = "settling-health-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: Date.now() - 11 * 60_000,
  });
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      DEFAULT_PI_SESSION_ID,
      undefined,
      DEFAULT_PI_SESSION_ID,
      identity,
      true,
      "settling",
    ),
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await settleUntil(
    () =>
      pi.sent.some(
        (message: any) => message.customType === "pi-herdsman-agent-attention",
      ) === false,
  );
  assert.equal(
    pi.sent.some(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ),
    false,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("health attention stays idle-only and does not queue resolved stale work", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const label = "busy-health-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: now - 11 * 60_000,
  });
  const sent: any[] = [];
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      DEFAULT_PI_SESSION_ID,
      undefined,
      DEFAULT_PI_SESSION_ID,
      identity,
    ),
    sendMessage: (message) => sent.push(message),
  });
  const context = fakeContext();
  (context as any).isIdle = () => false;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  writeAgentState(mailbox, {
    ...readAgentState(mailbox)!,
    lastActivityAt: now,
    updatedAt: now,
  });
  (context as any).isIdle = () => true;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("result errors wake the direct owner with durable recovery evidence", async () => {
  setLeadEnvironment();
  const label = "result-error-health-agent";
  const identity = recoveryIdentity(label);
  const state = {
    ...managedState(label, undefined, identity),
    resultError: {
      code: "write_failure" as const,
      message: "result write failed",
      requestId: REQUEST_ID,
      runId: AGENT_ID,
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      agentLabel: label,
      paneId: identity.paneId,
      originalStatus: "completed" as const,
      attempts: 8,
      failedAt: Date.now() - 1_000,
      retrySafe: false,
      cleanupSafe: true,
      nextAction:
        "Resolve the mailbox persistence failure described by result_error, then use agent_close before starting another assignment.",
    },
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, state);
  const pi = fakePi({
    exec: leadExec(
      label,
      "idle",
      DEFAULT_PI_SESSION_ID,
      undefined,
      DEFAULT_PI_SESSION_ID,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await settleUntil(() =>
    pi.sent.some(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ),
  );
  const attention = pi.sent.find(
    (message: any) => message.customType === "pi-herdsman-agent-attention",
  ) as any;
  assert.equal(attention?.details.reason, "result_error");
  assert.equal(attention?.details.requestId, REQUEST_ID);
  assert.equal(attention?.details.nextReminderMs, 5 * 60_000);
  assert.doesNotMatch(attention.details.nextAction, /\bagent_inspect\b/);
  assert.match(attention.details.nextAction, /\bagent_close\b/);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("physical unknown attention is one-shot and fail-closed", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const label = "unknown-health-agent";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  // The daemon cannot serve the observation that would prove this child's
  // physical identity, which is the canonical shape of "unknown".
  radarDaemon.options.observeUnavailable = true;
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await settleUntil(
    () =>
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-attention",
      ).length === 1,
  );
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ).length,
    1,
  );
  const attention = pi.sent.find(
    (message: any) => message.customType === "pi-herdsman-agent-attention",
  ) as any;
  assert.equal(attention.details.reason, "unknown");
  assert.deepEqual(attention.details.availableActions, []);
  now += 20 * 60_000;
  t.mock.timers.tick(30_000);
  await settleUntil(
    () =>
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-attention",
      ).length === 1,
  );
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ).length,
    1,
  );
  pi.events.get("session_shutdown")?.[0]();
  radarDaemon.options.observeUnavailable = false;
  resetAgentMailbox(mailbox);
});

test("delivered owner asks repeat without duplicating first delivery", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const label = "repeat-owner-ask";
  const identity = recoveryIdentity(label);
  const state = {
    ...managedState(label, REQUEST_ID, identity),
    pendingAskId: "99999999-9999-4999-8999-999999999999",
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, state);
  const ask = {
    version: 5 as const,
    askId: state.pendingAskId!,
    requestId: REQUEST_ID,
    runId: state.runId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    piSessionId: state.piSessionId,
    question: "Choose ALPHA or BETA",
    createdAt: now,
  };
  writeAsk(mailbox, ask);
  const entries = [{ customType: "pi-herdsman-agent-ask", details: ask }];
  const pi = fakePi({
    entries,
    persistMessages: true,
  });
  registerExtension!(pi.pi as never);
  const reminders = () =>
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-ask",
    ) as any[];
  await startRadarSession(pi, fakeContext(entries));
  await settleUntil(() => reminders().length === 0);
  assert.equal(reminders().length, 0);
  // The registering scan reads the clock on whichever side of this advance it
  // reaches, so each step advances a full reminder interval and scans again:
  // either way the reminder is due within two steps.
  for (let step = 0; step < 2 && reminders().length === 0; step++) {
    now += 5 * 60_000;
    t.mock.timers.tick(30_000);
    await settleUntil(() => reminders().length === 1);
  }
  assert.equal(reminders().length, 1);
  assert.equal(reminders()[0].details.askId, ask.askId);
  assert.equal(reminders()[0].details.requestId, ask.requestId);
  assert.equal(reminders()[0].details.nextReminderMs, 150_000);
  assert.match(reminders()[0].content, /still waiting/);
  assert.match(
    reminders()[0].content,
    /Use agent_reply to reply to this exact pending ask/,
  );
  writeAgentState(mailbox, { ...state, pendingAskId: undefined });
  removeAsk(mailbox, ask.askId);
  now += 3 * 60_000;
  t.mock.timers.tick(30_000);
  await settleUntil(
    () =>
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-ask",
      ).length === 1,
  );
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-ask",
    ).length,
    1,
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("old unacknowledged requests get attention without being resubmitted", async () => {
  setLeadEnvironment();
  const label = "old-handoff-health";
  const identity = recoveryIdentity(label);
  const state = managedState(label, REQUEST_ID, identity);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const request: RequestRecord = {
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text: "retain this exact intent",
    createdAt: Date.now() - 11 * 60_000,
  };
  writeAgentState(mailbox, state);
  writeRequest(mailbox, request);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  // The daemon observes the mailboxes this session owns, which is the only
  // evidence that can prove this child's physical identity.
  radarDaemon.observeInventory = radarObservedFleet;
  await startRadarSession(pi, fakeContext());
  await settleUntil(() =>
    pi.sent.some(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ),
  );
  const attention = pi.sent.find(
    (message: any) => message.customType === "pi-herdsman-agent-attention",
  ) as any;
  assert.equal(attention?.details.reason, "handoff");
  assert.equal(attention?.details.requestId, REQUEST_ID);
  assert.match(attention.content, /Do not submit the same intent again/);
  assert.ok(readRequest(mailbox, REQUEST_ID));
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("health reconciliation publishes at most one attention per scan", async (t) => {
  setLeadEnvironment();
  const states = ["first-health-error", "second-health-error"].map((label) => {
    const identity = recoveryIdentity(label);
    return {
      ...managedState(label, undefined, identity),
      resultError: {
        code: "write_failure" as const,
        message: `${label} failed`,
        requestId: REQUEST_ID,
        runId: AGENT_ID,
        ownerSessionId: LEAD_SESSION_ID,
        workspaceId: WORKSPACE,
        agentLabel: label,
        paneId: identity.paneId,
        originalStatus: "completed" as const,
        attempts: 8,
        failedAt: Date.now() - 1_000,
        retrySafe: false,
        cleanupSafe: true,
        nextAction:
          "Use agent_inspect to inspect the stored result error, then use agent_close to close this agent.",
      },
    };
  });
  states[1]!.runId = randomUUID();
  states[1]!.resultError!.runId = states[1]!.runId;
  for (const state of states)
    writeAgentState(agentMailboxPath(WORKSPACE, state.agentLabel), state);
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: { agents: [], panes: [] } },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await startRadarSession(pi, fakeContext());
  await settleUntil(
    () =>
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-attention",
      ).length === 1,
  );
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ).length,
    1,
  );
  t.mock.timers.tick(30_000);
  await settleUntil(
    () =>
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-attention",
      ).length === 2,
  );
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-attention",
    ).length,
    2,
  );
  pi.events.get("session_shutdown")?.[0]();
  for (const state of states)
    resetAgentMailbox(agentMailboxPath(WORKSPACE, state.agentLabel));
});

test("lost managed agents remain visible and repeatedly notify their owner", async (t) => {
  setLeadEnvironment();
  const label = "lost-controller-agent";
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(testTmpRoot, `${label}.jsonl`),
  };
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const state = {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: Date.now(),
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  realFs.writeFileSync(
    identity.piSessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: identity.piSessionId,
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
    })}\n`,
  );
  nativeSessions.set(state.piSessionId, {
    id: state.piSessionId,
    path: state.piSessionFile!,
    contextEntries: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "last persisted work" }],
        },
      },
    ],
  });
  realFs.appendFileSync(
    identity.piSessionFile,
    `${JSON.stringify({
      type: "message",
      id: "entry-0",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "last persisted work" }],
      },
    })}\n`,
  );
  writeAgentState(mailbox, state);
  const lifecycle = cascadeExecutor([state]);
  const pi = fakePi({
    persistMessages: true,
    exec: lifecycle.exec,
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    // The daemon stops reporting the pane the child was recorded in.
    observeFleet([]);
    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));

    const listed = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    const agent = listed.details.agents.find(
      (candidate: any) => candidate.agent === label,
    );
    assert.equal(agent.state, "lost");
    assert.deepEqual(agent.available_tools, [
      "agent_transcript",
      "agent_close",
    ]);
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-lost",
      ).length,
      1,
    );

    const transcript = await agentTool(pi, "transcript").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(
      transcript.details.ok,
      true,
      JSON.stringify(transcript.details),
    );
    assert.match(transcript.details.transcript, /last persisted work/);

    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-lost",
      ).length,
      1,
    );
    now += 5 * 60_000;
    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-lost",
      ).length,
      2,
    );
    assert.ok(readAgentState(mailbox));

    const closed = await agentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.equal(readAgentState(mailbox), undefined);
    now += 5 * 60_000;
    t.mock.timers.tick(30_000);
    await settleUntil(
      () =>
        pi.sent.filter(
          (message: any) => message.customType === "pi-herdsman-agent-lost",
        ).length === 2,
    );
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-lost",
      ).length,
      2,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    nativeSessions.delete(state.piSessionId);
    realFs.rmSync(identity.piSessionFile, { force: true });
    resetAgentMailbox(mailbox);
  }
});

test("a worker exited by hand leaves a shell pane that reads unknown, then lost after the startup window", async (t) => {
  // The process is gone and the pane survives as a plain shell: Herdr reports the
  // pane with no agent and no session. Inside the startup window that is
  // indistinguishable from a pane whose agent has not registered yet, so it stays
  // unknown. Past the longest startup the owner would wait, nothing can still be
  // starting, so the generation is lost and the owner can close it.
  setLeadEnvironment();
  const label = "shell-pane-agent";
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(testTmpRoot, `${label}.jsonl`),
  };
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const state = {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: Date.now(),
    updatedAt: Date.now(),
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
  // The pane survives as a plain shell: the daemon reports it with no occupant.
  observeFleet([], [state]);
  const pi = fakePi({ persistMessages: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  registerExtension!(pi.pi as never);
  const listState = async () => {
    const listed = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    return listed.details.agents.find(
      (candidate: any) => candidate.agent === label,
    );
  };
  try {
    await startRadarSession(pi, fakeContext());
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await listState()).state, "unknown");

    now += 6 * 60_000;
    t.mock.timers.tick(30_000);
    for (let index = 0; index < 8; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const lost = await listState();
    assert.equal(lost.state, "lost");
    assert.ok(lost.available_tools.includes("agent_close"));

    const closed = await agentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(pi.entries),
    );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.equal(readAgentState(mailbox), undefined);
    // The pane belongs to whoever is using the shell now; closing the lost
    // generation must not close it.
    assert.deepEqual([...radarDaemon.closes.values()], []);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});
test("lost parent health attention omits close when a descendant has an unread durable result", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "lost-health-result-parent",
      undefined,
      recoveryIdentity("lost-health-result-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "lost-health-result-child",
      undefined,
      recoveryIdentity("lost-health-result-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    completedRequestId: REQUEST_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  writeResult(childMailbox, {
    version: 5,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    status: "completed",
    text: "child durable result",
    completedAt: Date.now(),
  });
  // The daemon reports the child and not the parent, so the parent is gone.
  observeFleet([{ state: child }]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, fakeContext());
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));

    const attention = pi.sent.find(
      (message: any) => message.customType === "pi-herdsman-agent-lost",
    ) as any;
    assert.equal(attention?.details.agentLabel, parent.agentLabel);
    assert.equal(attention?.details.availableActions.includes("close"), false);
    assert.match(
      String(attention?.content),
      /agent_close is not currently available/,
    );
    assert.match(
      String(attention?.content),
      /Continuing its saved session with agent_continue does not depend on it\./,
    );
    assert.doesNotMatch(
      String(attention?.content),
      /Close this lost generation|Use close/,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("live agents with an unread durable result do not advertise close", async () => {
  setLeadEnvironment();
  const label = "live-result-agent";
  const state = {
    ...managedState(label, undefined, recoveryIdentity(label)),
    completedRequestId: REQUEST_ID,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
  writeResult(mailbox, {
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "durable result",
    completedAt: Date.now(),
  });
  const pi = fakePi({ exec: cascadeExecutor([state]).exec });
  registerExtension!(pi.pi as never);
  try {
    const listed = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    const agent = listed.details.agents.find(
      (candidate: any) => candidate.agent === label,
    );
    assert.equal(agent.state, "settling");
    assert.equal(agent.available_tools.includes("agent_close"), false);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("lead list hides close when a descendant has an unread durable result", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "cascade-result-parent",
      undefined,
      recoveryIdentity("cascade-result-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "cascade-result-child",
      undefined,
      recoveryIdentity("cascade-result-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    completedRequestId: REQUEST_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  writeResult(childMailbox, {
    version: 5,
    runId: child.runId,
    requestId: REQUEST_ID,
    ownerSessionId: child.ownerSessionId,
    workspaceId: child.workspaceId,
    agentLabel: child.agentLabel,
    paneId: child.paneId,
    status: "completed",
    text: "child durable result",
    completedAt: Date.now(),
  });
  const pi = fakePi({
    exec: cascadeExecutor([parent, child]).exec,
  });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    const listedParent = result.details.agents.find(
      (agent: any) => agent.agent === parent.agentLabel,
    );
    assert.equal(listedParent.available_tools.includes("agent_close"), false);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("lost agents with an unread durable result cannot be closed", async () => {
  setLeadEnvironment();
  const label = "lost-result-agent";
  const state = {
    ...managedState(label, undefined, recoveryIdentity(label)),
    completedRequestId: REQUEST_ID,
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, state);
  writeResult(mailbox, {
    version: 5,
    runId: state.runId,
    requestId: REQUEST_ID,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    status: "completed",
    text: "durable result",
    completedAt: Date.now(),
  });
  // The daemon reports no pane this mailbox was recorded in.
  observeFleet([]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const listed = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    const agent = listed.details.agents.find(
      (candidate: any) => candidate.agent === label,
    );
    assert.equal(agent.state, "settling");
    assert.deepEqual(agent.available_tools, []);

    const closed = await agentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(closed.details.error.category, "target_ambiguous");
    assert.ok(readAgentState(mailbox));
    assert.ok(readResult(mailbox, REQUEST_ID));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("cascade preflight keeps descendants when a lost parent has a pending result", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "lost-result-parent",
      undefined,
      recoveryIdentity("lost-result-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "lost-result-child",
      REQUEST_ID,
      recoveryIdentity("lost-result-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, {
    ...parent,
    completedRequestId: REQUEST_ID,
  });
  writeAgentState(childMailbox, child);
  writeResult(parentMailbox, {
    version: 5,
    runId: parent.runId,
    requestId: REQUEST_ID,
    ownerSessionId: parent.ownerSessionId,
    workspaceId: parent.workspaceId,
    agentLabel: parent.agentLabel,
    paneId: parent.paneId,
    status: "completed",
    text: "parent durable result",
    completedAt: Date.now(),
  });
  const lifecycle = cascadeExecutor([child]);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const closed = await agentTool(pi, "close").execute(
      "id",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(closed.details.error.category, "target_ambiguous");
    assert.deepEqual(lifecycle.closeOrder, []);
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readAgentState(childMailbox));
    assert.ok(readResult(parentMailbox, REQUEST_ID));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("lost close fails closed when a result appears during its final proof", async () => {
  setLeadEnvironment();
  const label = "racing-lost-result";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const state = managedState(label, REQUEST_ID, recoveryIdentity(label));
  writeAgentState(mailbox, state);
  // The assignment resolves while the close is still proving the child: the
  // delivered result is the durable fact that has to abort the close.
  const {
    activeRequestId: _active,
    acceptedAssignment: _accepted,
    briefProfile: _profile,
    ...unassigned
  } = state;
  const delivered = { ...unassigned, completedRequestId: REQUEST_ID };
  // No pane this mailbox was recorded in is reported, so the child is gone and
  // its close is the mailbox cleanup a lost generation gets.
  const absent = { workspaces: [], tabs: [], panes: [], agents: [] };
  let reads = 0;
  radarDaemon.observeInventory = () => {
    if (++reads === 2) {
      writeAgentState(mailbox, delivered);
      writeResult(mailbox, {
        version: 5,
        runId: state.runId,
        requestId: REQUEST_ID,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        agentLabel: state.agentLabel,
        paneId: state.paneId,
        status: "completed",
        text: "raced durable result",
        completedAt: Date.now(),
      });
    }
    return absent;
  };
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const listed = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    assert.deepEqual(listed.details.agents[0].available_tools, ["agent_close"]);
    const closed = await agentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(closed.details.error.category, "target_ambiguous");
    assert.deepEqual(readAgentState(mailbox), delivered);
    assert.ok(readResult(mailbox, REQUEST_ID));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("a lost parent retains its live child ancestry and closes child-first", async () => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const parentMailbox = agentMailboxPath(WORKSPACE, "lost-parent");
  const childMailbox = agentMailboxPath(WORKSPACE, "lost-parent-child");
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, {
    ...managedState("lost-parent", undefined, recoveryIdentity("lost-parent")),
    piSessionId: PARENT_SESSION_ID,
  });
  const childLaunch = await radarDaemon.adoptRetainedChild({
    label: "lost-parent-child",
    runId: randomUUID(),
    ownerSessionId: PARENT_SESSION_ID,
    workspaceId: WORKSPACE,
    mailbox: childMailbox,
    pane: "lost-parent-child-pane",
  });
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: childLaunch,
    },
  ];
  // The daemon's observation reports no pane the parent was recorded in: the
  // parent is gone, and only its Radar-launched child is still there.
  radarDaemon.options.inventory = {
    workspaces: [],
    tabs: [],
    panes: [],
    agents: [],
  };
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const listed = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(entries),
    );
    const parentRow = listed.details.agents.find(
      (agent: any) => agent.agent === "lost-parent",
    );
    const childRow = listed.details.agents.find(
      (agent: any) => agent.agent === "lost-parent-child",
    );
    assert.equal(parentRow?.state, "lost");
    assert.equal(parentRow?.available_tools.includes("agent_close"), true);
    assert.equal(childRow?.parent_label, "lost-parent");

    const closed = await agentTool(pi, "close").execute(
      "id",
      { agent: "lost-parent" },
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.deepEqual(
      [...radarDaemon.closes.values()].map((close) => close.pane),
      ["lost-parent-child-pane"],
    );
    assert.equal(readAgentState(parentMailbox), undefined);
    assert.equal(readAgentState(childMailbox), undefined);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});
test("unknown descendants refuse a lost-parent cascade", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "unknown-child-parent",
      undefined,
      recoveryIdentity("unknown-child-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
    // Past the startup window with no pane reported: lost, not merely unproved.
    updatedAt: Date.now() - 11 * 60_000,
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  const child = {
    ...managedState(
      "unknown-child",
      undefined,
      recoveryIdentity("unknown-child"),
    ),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  // The parent's pane is not reported (lost) and the child's is reported under a
  // session that is not the one its mailbox records (unknown).
  observeFleet([
    { state: child, sessionId: "11111111-1111-4111-8111-111111111111" },
  ]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "close").execute(
      "id",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual([...radarDaemon.closes.values()], []);
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readAgentState(childMailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("mixed live and unknown descendants preflight before closing", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "mixed-live-unknown-parent",
      undefined,
      recoveryIdentity("mixed-live-unknown-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const liveChild = {
    ...managedState(
      "mixed-live-child",
      undefined,
      recoveryIdentity("mixed-live-child"),
    ),
    // Each child owns its own run, as a real launch does: two children under one
    // run id are candidate claimants of each other's pane.
    runId: randomUUID(),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const unknownChild = {
    ...managedState(
      "mixed-unknown-child",
      undefined,
      recoveryIdentity("mixed-unknown-child"),
    ),
    runId: randomUUID(),
    ownerSessionId: parent.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const liveMailbox = agentMailboxPath(WORKSPACE, liveChild.agentLabel);
  const unknownMailbox = agentMailboxPath(WORKSPACE, unknownChild.agentLabel);
  for (const mailbox of [parentMailbox, liveMailbox, unknownMailbox])
    resetAgentMailbox(mailbox);
  for (const [mailbox, state] of [
    [parentMailbox, parent],
    [liveMailbox, liveChild],
    [unknownMailbox, unknownChild],
  ] as const)
    writeAgentState(mailbox, state);
  // The parent's pane is not reported (unknown), one descendant is proved live and
  // the other is reported under a session that is not the one its mailbox records.
  observeFleet([
    { state: liveChild },
    {
      state: unknownChild,
      sessionId: "22222222-2222-4222-8222-222222222222",
    },
  ]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "close").execute(
      "id",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual([...radarDaemon.closes.values()], []);
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readAgentState(liveMailbox));
    assert.ok(readAgentState(unknownMailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of [parentMailbox, liveMailbox, unknownMailbox])
      resetAgentMailbox(mailbox);
  }
});

test("mixed lost and unknown descendants preflight before removing mailboxes", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "mixed-lost-unknown-parent",
      undefined,
      recoveryIdentity("mixed-lost-unknown-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const lostChild = {
    ...managedState(
      "mixed-lost-child",
      undefined,
      recoveryIdentity("mixed-lost-child"),
    ),
    runId: randomUUID(),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
    // Past the startup window with no pane reported: lost, not merely unproved.
    updatedAt: Date.now() - 11 * 60_000,
    lastActivityAt: Date.now() - 11 * 60_000,
  };
  const unknownChild = {
    ...managedState(
      "mixed-lost-unknown-child",
      undefined,
      recoveryIdentity("mixed-lost-unknown-child"),
    ),
    runId: randomUUID(),
    ownerSessionId: parent.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const lostMailbox = agentMailboxPath(WORKSPACE, lostChild.agentLabel);
  const unknownMailbox = agentMailboxPath(WORKSPACE, unknownChild.agentLabel);
  for (const mailbox of [parentMailbox, lostMailbox, unknownMailbox])
    resetAgentMailbox(mailbox);
  for (const [mailbox, state] of [
    [parentMailbox, parent],
    [lostMailbox, lostChild],
    [unknownMailbox, unknownChild],
  ] as const)
    writeAgentState(mailbox, state);
  // The parent's pane is not reported (unknown), one descendant's is not reported
  // and is past the startup window (lost), and the other is reported under a
  // session that is not the one its mailbox records.
  observeFleet([
    {
      state: unknownChild,
      sessionId: "22222222-2222-4222-8222-222222222222",
    },
  ]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "close").execute(
      "id",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual([...radarDaemon.closes.values()], []);
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readAgentState(lostMailbox));
    assert.ok(readAgentState(unknownMailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of [parentMailbox, lostMailbox, unknownMailbox])
      resetAgentMailbox(mailbox);
  }
});

test("nested cascades resolve every descendant deepest-first", async () => {
  for (const childLive of [true, false]) {
    setLeadEnvironment();
    await ensureRadarDaemon();
    const suffix = childLive ? "live-child" : "lost-child";
    const parentLabel = `nested-cascade-parent-${suffix}`;
    const childLabel = `nested-cascade-child-${suffix}`;
    const grandchildLabel = `nested-cascade-grandchild-${suffix}`;
    const parentMailbox = agentMailboxPath(WORKSPACE, parentLabel);
    const childMailbox = agentMailboxPath(WORKSPACE, childLabel);
    const grandchildMailbox = agentMailboxPath(WORKSPACE, grandchildLabel);
    for (const mailbox of [parentMailbox, childMailbox, grandchildMailbox])
      resetAgentMailbox(mailbox);
    writeAgentState(parentMailbox, {
      ...managedState(parentLabel, undefined, recoveryIdentity(parentLabel)),
      piSessionId: PARENT_SESSION_ID,
    });
    // A live child is one the daemon launched; a lost one is a mailbox whose
    // process is gone, which the cascade still resolves by ancestry.
    const childLaunch = childLive
      ? await radarDaemon.adoptRetainedChild({
          label: childLabel,
          runId: randomUUID(),
          ownerSessionId: PARENT_SESSION_ID,
          workspaceId: WORKSPACE,
          mailbox: childMailbox,
          pane: `${childLabel}-pane`,
        })
      : undefined;
    if (!childLive) {
      writeAgentState(childMailbox, {
        ...managedState(childLabel, undefined, recoveryIdentity(childLabel)),
        runId: randomUUID(),
        ownerSessionId: PARENT_SESSION_ID,
        piSessionId: CHILD_SESSION_ID,
      });
    }
    const childSessionId = readAgentState(childMailbox)!.piSessionId;
    const grandchildLaunch = await radarDaemon.adoptRetainedChild({
      label: grandchildLabel,
      runId: randomUUID(),
      ownerSessionId: childSessionId,
      workspaceId: WORKSPACE,
      mailbox: grandchildMailbox,
      pane: `${grandchildLabel}-pane`,
    });
    const entries = [childLaunch, grandchildLaunch]
      .filter((launch) => launch !== undefined)
      .map((data) => ({
        type: "custom",
        customType: "pi-herdsman-radar-spawn",
        data,
      }));
    // No pane this parent was recorded in is reported, so the parent is gone;
    // the Radar-launched descendants are proved by their own launch records.
    radarDaemon.options.inventory = {
      workspaces: [],
      tabs: [],
      panes: [],
      agents: [],
    };
    const pi = fakePi({});
    registerExtension!(pi.pi as never);
    try {
      const result = await agentTool(pi, "close").execute(
        "id",
        { agent: parentLabel },
        undefined,
        undefined,
        fakeContext(entries),
      );
      assert.equal(result.details.ok, true, JSON.stringify(result.details));
      assert.deepEqual(
        [...radarDaemon.closes.values()].map((close) => close.pane),
        [
          `${grandchildLabel}-pane`,
          ...(childLive ? [`${childLabel}-pane`] : []),
        ],
      );
      for (const mailbox of [parentMailbox, childMailbox, grandchildMailbox])
        assert.equal(readAgentState(mailbox), undefined);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      for (const mailbox of [parentMailbox, childMailbox, grandchildMailbox])
        resetAgentMailbox(mailbox);
    }
  }
});
test("nested unknown descendants refuse the cascade before any mutation", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "nested-unknown-parent",
      undefined,
      recoveryIdentity("nested-unknown-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "nested-unknown-child",
      undefined,
      recoveryIdentity("nested-unknown-child"),
    ),
    runId: randomUUID(),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const grandchild = {
    ...managedState(
      "nested-unknown-grandchild",
      undefined,
      recoveryIdentity("nested-unknown-grandchild"),
    ),
    runId: randomUUID(),
    ownerSessionId: child.piSessionId,
    piSessionId: "11111111-1111-4111-8111-111111111111",
  };
  const states = [parent, child, grandchild];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  for (const [mailbox, state] of mailboxes.map(
    (mailbox, index) => [mailbox, states[index]] as const,
  ))
    writeAgentState(mailbox, state);
  // The parent's pane is not reported, and both descendants are reported under a
  // session that is not the one their mailboxes record.
  observeFleet([
    { state: child, sessionId: "22222222-2222-4222-8222-222222222222" },
    { state: grandchild, sessionId: "33333333-3333-4333-8333-333333333333" },
  ]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "close").execute(
      "id",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual([...radarDaemon.closes.values()], []);
    for (const mailbox of mailboxes) assert.ok(readAgentState(mailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  }
});

test("duplicate durable parent identities refuse cascade before mutation", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "duplicate-cascade-parent",
      undefined,
      recoveryIdentity("duplicate-cascade-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const duplicateParent = {
    ...managedState(
      "duplicate-cascade-parent-copy",
      undefined,
      recoveryIdentity("duplicate-cascade-parent-copy"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "duplicate-cascade-child",
      undefined,
      recoveryIdentity("duplicate-cascade-child"),
    ),
    ownerSessionId: PARENT_SESSION_ID,
    piSessionId: CHILD_SESSION_ID,
  };
  const states = [parent, duplicateParent, child];
  const mailboxes = states.map((state) =>
    agentMailboxPath(WORKSPACE, state.agentLabel),
  );
  for (const [mailbox, state] of mailboxes.map(
    (mailbox, index) => [mailbox, states[index]] as const,
  )) {
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, state);
  }
  const lifecycle = cascadeExecutor(states);
  const pi = fakePi({ exec: lifecycle.exec });
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "close").execute(
      "id",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual(lifecycle.closeOrder, []);
    for (const mailbox of mailboxes) assert.ok(readAgentState(mailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  }
});

test("cascade preflights the parent before closing descendants", async () => {
  setLeadEnvironment();
  const parent = {
    ...managedState(
      "unresolved-cascade-parent",
      undefined,
      recoveryIdentity("unresolved-cascade-parent"),
    ),
    piSessionId: PARENT_SESSION_ID,
  };
  const child = {
    ...managedState(
      "unresolved-cascade-child",
      undefined,
      recoveryIdentity("unresolved-cascade-child"),
    ),
    runId: randomUUID(),
    ownerSessionId: parent.piSessionId,
    piSessionId: CHILD_SESSION_ID,
  };
  const parentMailbox = agentMailboxPath(WORKSPACE, parent.agentLabel);
  const childMailbox = agentMailboxPath(WORKSPACE, child.agentLabel);
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  writeAgentState(parentMailbox, parent);
  writeAgentState(childMailbox, child);
  // The parent's pane is reported under a session that is not the one its mailbox
  // records, so it cannot be proved; the descendant is proved live and must
  // survive the refusal untouched.
  observeFleet([
    { state: parent, sessionId: "22222222-2222-4222-8222-222222222222" },
    { state: child },
  ]);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "close").execute(
      "id",
      { agent: parent.agentLabel },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual([...radarDaemon.closes.values()], []);
    assert.ok(readAgentState(parentMailbox));
    assert.ok(readAgentState(childMailbox));
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("cascade revalidates a live descendant mailbox before closing it", async () => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const parentMailbox = agentMailboxPath(WORKSPACE, "changed-live-cascade");
  const childMailbox = agentMailboxPath(
    WORKSPACE,
    "changed-live-cascade-child",
  );
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  const parentLaunch = await radarDaemon.adoptRetainedChild({
    label: "changed-live-cascade",
    runId: randomUUID(),
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    mailbox: parentMailbox,
    pane: "changed-live-cascade-pane",
  });
  const childLaunch = await radarDaemon.adoptRetainedChild({
    label: "changed-live-cascade-child",
    runId: randomUUID(),
    ownerSessionId: readAgentState(parentMailbox)!.piSessionId,
    workspaceId: WORKSPACE,
    mailbox: childMailbox,
    pane: "changed-live-cascade-child-pane",
  });
  const entries = [parentLaunch, childLaunch].map((data) => ({
    type: "custom",
    customType: "pi-herdsman-radar-spawn",
    data,
  }));
  // The descendant is replaced between the plan and its own close: the mailbox
  // the cascade planned on is no longer the one it would be closing.
  const changedChild = {
    ...readAgentState(childMailbox)!,
    cwd: "/tmp/replaced-descendant",
  };
  const fleet = radarObservedFleet;
  let reads = 0;
  radarDaemon.observeInventory = () => {
    if (++reads === 2) writeAgentState(childMailbox, changedChild);
    return fleet();
  };
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const result = await agentTool(pi, "close").execute(
      "id",
      { agent: "changed-live-cascade" },
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.equal(result.details.error.category, "target_ambiguous");
    assert.deepEqual([...radarDaemon.closes.values()], []);
    assert.ok(readAgentState(parentMailbox));
    assert.deepEqual(readAgentState(childMailbox), changedChild);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});
test("a canonical row that contradicts the mailbox never projects a child live", async () => {
  setLeadEnvironment();
  const label = "contradicted-child";
  const identity = recoveryIdentity(label);
  const state = managedState(label, REQUEST_ID, identity);
  writeAgentState(agentMailboxPath(WORKSPACE, label), state);
  const row = (overrides: { sessionId?: string; managedLabel?: string }) => ({
    workspace_id: WORKSPACE,
    tab_id: `${label}-tab`,
    pane_id: state.paneId,
    name: runScopedHerdrAlias(WORKSPACE, label, state.runId),
    status: "working",
    facts: { label: overrides.managedLabel ?? label, run: state.runId },
    session: { kind: "uuid", value: overrides.sessionId ?? state.piSessionId },
  });
  const fleet = (agent: ReturnType<typeof row>) => ({
    workspaces: [{ workspace_id: WORKSPACE }],
    tabs: [{ tab_id: `${label}-tab`, workspace_id: WORKSPACE }],
    panes: [
      {
        location: {
          workspace_id: WORKSPACE,
          tab_id: `${label}-tab`,
          pane_id: state.paneId,
        },
      },
    ],
    agents: [
      {
        location: {
          workspace_id: WORKSPACE,
          tab_id: `${label}-tab`,
          pane_id: state.paneId,
        },
        ...agent,
      },
    ],
  });
  const contradictions = {
    "a different session": fleet(row({ sessionId: randomUUID() })),
    "a different managed label": fleet(row({ managedLabel: "someone-else" })),
  };
  for (const [name, inventory] of Object.entries(contradictions)) {
    radarDaemon.observeInventory = () => inventory;
    const pi = fakePi({ entries: [] });
    registerExtension!(pi.pi as never);
    const listed = await agentTool(pi, "list").execute(
      "contradiction",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    const child = listed.details.agents.find(
      (agent: any) => agent.agent === label,
    );
    assert.equal(child.recovery_only, true, `${name} must not project live`);
    assert.equal(child.state, "unknown", name);
    assert.deepEqual(child.available_tools, [], name);
  }
});

test("list derives inactivity without changing public state", async () => {
  setLeadEnvironment();
  const now = Date.now();
  const cases = [
    { label: "old-working", status: "working" as const, at: now - 11 * 60_000 },
    { label: "fresh-working", status: "working" as const, at: now - 1_000 },
    { label: "missing-working", status: "working" as const },
    { label: "future-working", status: "working" as const, at: now + 1_000 },
  ];
  for (const item of cases) {
    const identity = recoveryIdentity(item.label);
    identity.piSessionId = randomUUID();
    // Each child is its own delegation run: two live children under one run id
    // are ambiguous by design, not a shape a list assertion can build on.
    const state = {
      ...managedState(item.label, REQUEST_ID, identity),
      runId: randomUUID(),
    };
    if (item.at !== undefined) state.lastActivityAt = item.at;
    writeAgentState(agentMailboxPath(WORKSPACE, item.label), state);
  }
  const pi = fakePi({
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "api" && args[1] === "snapshot") {
        const agents = cases.map((item) => {
          const state = readAgentState(
            agentMailboxPath(WORKSPACE, item.label),
          )!;
          const identity = recoveryIdentity(item.label);
          identity.paneId = state.paneId;
          identity.piSessionId = state.piSessionId;
          return {
            ...JSON.parse(
              listResponse(
                item.label,
                item.status,
                state.piSessionId,
                identity,
              ),
            ).agents[0],
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "id",
              value: state.piSessionId,
            },
            workspace_id: state.workspaceId,
            pane_id: state.paneId,
            cwd: state.cwd,
          };
        });
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              snapshot: {
                agents,
                panes: agents.map((agent) => ({
                  pane_id: agent.pane_id,
                  workspace_id: agent.workspace_id,
                  cwd: agent.cwd,
                  agent_session: agent.agent_session,
                })),
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      return leadExec(
        "old-working",
        "working",
        DEFAULT_PI_SESSION_ID,
      )(command, args);
    },
  });
  registerExtension!(pi.pi as never);
  const result = await agentTool(pi, "list").execute(
    "id",
    {},
    undefined,
    undefined,
    fakeContext(),
  );
  const agents = result.details.agents as any[];
  assert.equal(
    agents.find((agent) => agent.agent === "old-working")?.stale,
    true,
  );
  assert.equal(
    agents.find((agent) => agent.agent === "old-working")?.state,
    "working",
  );
  assert.ok(
    agents.find((agent) => agent.agent === "old-working")?.inactive_ms >=
      11 * 60_000,
  );
  assert.equal(
    typeof agents.find((agent) => agent.agent === "old-working")
      ?.last_activity_at,
    "number",
  );
  for (const label of ["fresh-working", "missing-working", "future-working"]) {
    assert.equal(
      agents.find((agent) => agent.agent === label)?.stale,
      undefined,
    );
    const agent = agents.find((candidate) => candidate.agent === label);
    if (label === "missing-working")
      assert.equal(agent?.last_activity_at, undefined);
    else assert.equal(typeof agent?.last_activity_at, "number");
    assert.equal(agent?.inactive_ms, undefined);
  }
  pi.events.get("session_shutdown")?.[0]();
});

const softWindowEntry = (
  label: string,
  requestId: string,
  armedAt: number,
  windowMs: number,
  watcherGuidance?: string,
) => ({
  type: "custom",
  customType: "pi-herdsman-soft-window",
  data: {
    requestId,
    label,
    runId: AGENT_ID,
    armedAt,
    windowMs,
    ...(watcherGuidance === undefined ? {} : { watcherGuidance }),
  },
});

// The fake daemon answers over a real socket, so a scan that reads the fleet
// takes several event-loop turns. Yield until the observable outcome holds; the
// fixed budget makes a missing outcome fail rather than hang.
async function settleUntil(done: () => boolean, budget = 500): Promise<void> {
  for (let turn = 0; turn < budget && !done(); turn++)
    await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The fleet the daemon observes for this test, as a live daemon reports it. A
 * generation left out is one the daemon does not report, which is what a child
 * whose pane is gone looks like; a generation listed in `panesOnly` is reported
 * as the bare pane it left behind.
 */
function observeFleet(
  reported: Array<{
    state: ManagedAgentState;
    name?: string;
    sessionId?: string;
    status?: string;
  }>,
  panesOnly: ManagedAgentState[] = [],
): void {
  const rows = [...panesOnly, ...reported.map(({ state }) => state)].map(
    (state) => ({
      workspaceId: state.workspaceId,
      tabId: `${state.agentLabel}-tab`,
      paneId: state.paneId,
    }),
  );
  radarDaemon.options.inventory = {
    workspaces: rows.map((row) => ({ workspace_id: row.workspaceId })),
    tabs: rows.map((row) => ({
      tab_id: row.tabId,
      workspace_id: row.workspaceId,
    })),
    panes: rows.map((row) => ({
      location: {
        workspace_id: row.workspaceId,
        tab_id: row.tabId,
        pane_id: row.paneId,
      },
    })),
    agents: reported.map(({ state, name, sessionId, status }) => ({
      location: {
        workspace_id: state.workspaceId,
        tab_id: `${state.agentLabel}-tab`,
        pane_id: state.paneId,
      },
      name:
        name ??
        runScopedHerdrAlias(state.workspaceId, state.agentLabel, state.runId),
      status: status ?? (state.activeRequestId ? "working" : "idle"),
      session: { kind: "uuid", value: sessionId ?? state.piSessionId },
    })),
  };
}

/** The delivered-result provenance the lead keeps for a Radar child's result. */
const recordResultEntry = (entries: unknown[]) => (message: unknown) => {
  const value = message as any;
  if (value?.customType !== "pi-herdsman-agent-result") return;
  entries.push({
    customType: "pi-herdsman-agent-result",
    details: { ...value.details },
  });
};

/**
 * A lead session with one child launched through the production Radar edge.
 * Every lifecycle a test drives continues from the state that launch wrote.
 */
async function radarChildFixture(
  label: string,
  options: {
    sendMessage?: (message: unknown) => void;
    retainWorkers?: boolean;
  } = {},
) {
  setLeadEnvironment();
  if (options.retainWorkers !== undefined)
    updateConfig("retainWorkers", options.retainWorkers);
  let entries: unknown[] = [];
  const pi = fakePi({
    sendMessage: (message) => {
      recordResultEntry(entries)(message);
      options.sendMessage?.(message);
    },
  });
  entries = pi.entries;
  registerExtension!(pi.pi as never);
  await startRadarSession(pi);
  const child = await delegateRadarChild(pi, label);
  return {
    pi,
    entries,
    child,
    mailbox: agentMailboxPath(WORKSPACE, label),
    requestId: child.activeRequestId!,
    /** One recovery pass, as a restarted lead performs. */
    async recover() {
      for (const handler of pi.events.get("session_start") ?? [])
        await handler(undefined, fakeContext(entries));
    },
  };
}

const softDigests = (pi: ReturnType<typeof fakePi>) =>
  pi.sent.filter(
    (message: any) => message.customType === "pi-herdsman-agent-soft-deadline",
  );

// Drive one live working agent with an armed soft window through the real
// controller startup, recovery, and health-scan path.
function softWindowFixture(
  label: string,
  options: { armedAt: number; windowMs?: number; entries?: unknown[] } = {
    armedAt: Date.now(),
  },
) {
  setLeadEnvironment();
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: Date.now(),
    lastAck: {
      requestId: REQUEST_ID,
      accepted: true,
      acknowledgedAt: options.armedAt,
    },
  });
  const entries = [
    ...(options.entries ?? []),
    softWindowEntry(
      label,
      REQUEST_ID,
      options.armedAt,
      options.windowMs ?? 300_000,
    ),
  ];
  const pi = fakePi({
    entries,
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      undefined,
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  return { pi, mailbox, identity, entries, label };
}

test("agent_list offers agent_extend only for a windowed live assignment", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const requestId = randomUUID();
  const { pi, fixtures, entries } = softDeadlineFixture([
    { label: "soft-extend-listed", requestId, armedAt: now - 10_000 },
  ]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  for (let index = 0; index < 4; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  const listed = () =>
    agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
  const tools = async () =>
    ((await listed()).details.agents.find(
      (agent: any) => agent.agent === "soft-extend-listed",
    )?.available_tools ?? []) as string[];
  assert.deepEqual(await tools(), [
    "agent_inspect",
    "agent_steer",
    "agent_interrupt",
    "agent_extend",
    "agent_close",
  ]);

  // The same live record without a configured window offers no extension.
  updateConfig("softTimeoutMs", 0);
  assert.equal(
    (await tools()).includes("agent_extend"),
    false,
    "a disabled soft timeout leaves nothing to extend",
  );
  const refusedWhileDisabled = await agentTool(pi, "extend").execute(
    "id",
    { agent: "soft-extend-listed", windowMs: 900_000 },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(refusedWhileDisabled.details.ok, false);
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.customType === "pi-herdsman-soft-window" &&
        entry.data.extended === true,
    ).length,
    0,
    "a refused extension records no window",
  );
  updateConfig("softTimeoutMs", undefined);
  assert.equal((await tools()).includes("agent_extend"), true);

  pi.events.get("session_shutdown")?.[0]();
  for (const fixture of fixtures) resetAgentMailbox(fixture.mailbox);
});

test("a proven lost assignment drops agent_extend from available_tools", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const label = "soft-extend-lost";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: now,
    lastAck: {
      requestId: REQUEST_ID,
      accepted: true,
      acknowledgedAt: now - 10_000,
    },
  });
  const entries = [softWindowEntry(label, REQUEST_ID, now - 10_000, 300_000)];
  // The daemon reports no pane this mailbox was recorded in.
  observeFleet([]);
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await startRadarSession(pi, fakeContext(entries));
  for (let index = 0; index < 4; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  const listed = await agentTool(pi, "list").execute(
    "id",
    {},
    undefined,
    undefined,
    fakeContext(),
  );
  const agent = listed.details.agents.find(
    (candidate: any) => candidate.agent === label,
  );
  assert.equal(agent.state, "lost");
  assert.equal(
    (agent.available_tools as string[]).includes("agent_extend"),
    false,
    `lost records extend nothing: ${JSON.stringify(agent.available_tools)}`,
  );
  const attempted = await agentTool(pi, "extend").execute(
    "id",
    { agent: label, windowMs: 900_000 },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(attempted.details.ok, false);
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.customType === "pi-herdsman-soft-window" &&
        entry.data.extended === true,
    ).length,
    0,
    "a refused lost-worker extension records no window",
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("agent_extend refuses a non-live worker's recovered window", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const label = "soft-extend-nonlive";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const state = {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: now,
    lastAck: {
      requestId: REQUEST_ID,
      accepted: true,
      acknowledgedAt: now - 10_000,
    },
  };
  writeAgentState(mailbox, state);
  const entries = [softWindowEntry(label, REQUEST_ID, now - 10_000, 300_000)];
  // The daemon reports the pane held by a session that is not this worker's, so
  // its physical identity cannot be proved even though the official integration
  // still reports the exact session and runtime resolution succeeds.
  const otherSession = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  observeFleet([
    {
      state,
      name: runScopedHerdrAlias(WORKSPACE, label, state.runId),
      sessionId: otherSession,
    },
  ]);
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await startRadarSession(pi, fakeContext(entries));
  for (let index = 0; index < 4; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));

  const listed = await agentTool(pi, "list").execute(
    "id",
    {},
    undefined,
    undefined,
    fakeContext(),
  );
  const agent = listed.details.agents.find(
    (candidate: any) => candidate.agent === label,
  );
  assert.equal(agent.state, "unknown");
  assert.equal(
    (agent.available_tools as string[]).includes("agent_extend"),
    false,
    "a non-live record advertises no extension",
  );

  const attempted = await agentTool(pi, "extend").execute(
    "id",
    { agent: label, windowMs: 900_000 },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(attempted.details.ok, false);
  // An identity that cannot be proved is ambiguity, not absence: the mailbox
  // record exists and something may be holding the pane.
  assert.equal(
    attempted.details.error.category,
    "target_ambiguous",
    `extend refuses an unprovable worker: ${JSON.stringify(attempted.details)}`,
  );
  assert.match(
    attempted.details.error.message,
    /cannot be proved uniquely/,
    "the category names the doubt the message states",
  );
  assert.equal(
    pi.entries.filter(
      (entry: any) =>
        entry.customType === "pi-herdsman-soft-window" &&
        entry.data.extended === true,
    ).length,
    0,
    "a refused non-live extension records no window",
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);

  // The tool's own liveness guard is reachable, so it is not dead code: a
  // Radar-launched child whose launch and acknowledgment prove this generation
  // resolves without proving presence, and the guard is what refuses it.
  {
    const radarLabel = "soft-extend-unreported";
    const radarMailbox = agentMailboxPath(WORKSPACE, radarLabel);
    resetAgentMailbox(radarMailbox);
    const launch = await radarDaemon.adoptRetainedChild({
      label: radarLabel,
      runId: randomUUID(),
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      mailbox: radarMailbox,
      pane: `${radarLabel}-pane`,
    });
    writeAgentState(radarMailbox, {
      ...readAgentState(radarMailbox)!,
      activeRequestId: REQUEST_ID,
      lastActivityAt: now,
      lastAck: {
        requestId: REQUEST_ID,
        accepted: true,
        acknowledgedAt: now - 10_000,
      },
    });
    const radarEntries = [
      { type: "custom", customType: "pi-herdsman-radar-spawn", data: launch },
      softWindowEntry(radarLabel, REQUEST_ID, now - 10_000, 300_000),
    ];
    // The daemon's own inventory does not report the pane it recorded, so this
    // generation's current read is unproved while its binding still stands.
    radarDaemon.options.locationEvidence = "absent";
    const radarPi = fakePi({ entries: radarEntries });
    registerExtension!(radarPi.pi as never);
    await startRadarSession(radarPi, fakeContext(radarEntries));
    const refused = await agentTool(radarPi, "extend").execute(
      "id",
      { agent: radarLabel, windowMs: 900_000 },
      undefined,
      undefined,
      fakeContext(radarEntries),
    );
    assert.equal(refused.details.ok, false);
    assert.equal(
      refused.details.error.category,
      "agent_busy",
      `the liveness guard refuses an unproved Radar generation: ${JSON.stringify(refused.details)}`,
    );
    radarPi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(radarMailbox);
  }
});

test("a restart mid-window keeps the remaining soft deadline", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { pi, mailbox, entries } = softWindowFixture("soft-window-mid", {
    armedAt: now - 120_000,
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await settleUntil(() => softDigests(pi).length === 0);
  assert.equal(softDigests(pi).length, 0, "120s into a 300s window is not due");

  now += 180_000;
  t.mock.timers.tick(30_000);
  await settleUntil(() => softDigests(pi).length === 1);
  const digests = softDigests(pi);
  assert.equal(
    digests.length,
    1,
    "the window expires about 180s after restart",
  );
  assert.equal((digests[0] as any).details.entries.length, 1);
  assert.equal(
    (digests[0] as any).details.entries[0].agentLabel,
    "soft-window-mid",
  );
  assert.equal((digests[0] as any).details.entries[0].elapsedMs, 300_000);
  assert.equal((digests[0] as any).details.entries[0].windowMs, 300_000);
  assert.deepEqual((digests[0] as any).details.entries[0].availableActions, [
    "inspect",
    "steer",
    "interrupt",
    "extend",
    "close",
  ]);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("a restart after a delivered window continues from its recorded arming", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { pi, mailbox, entries } = softWindowFixture("soft-window-after", {
    armedAt: now - 10_000,
  });
  // Simulate the durable delivery entry the previous process wrote.
  (entries[0] as any).data = {
    requestId: REQUEST_ID,
    deliveredAt: now - 10_000,
    nextArmedAt: now - 10_000,
    windowMs: 300_000,
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await new Promise((resolve) => setImmediate(resolve));
  await settleUntil(() => softDigests(pi).length === 0);
  assert.equal(
    softDigests(pi).length,
    0,
    "a delivered window is not redelivered",
  );

  t.mock.timers.tick(30_000);
  await settleUntil(() => softDigests(pi).length === 0);
  assert.equal(softDigests(pi).length, 0);

  now += 290_000;
  t.mock.timers.tick(30_000);
  await settleUntil(() => softDigests(pi).length === 1);
  assert.equal(
    softDigests(pi).length,
    1,
    "the next window continues from its arming",
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("a window that expired while the lead was down is due at the first scan", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { pi, mailbox, entries } = softWindowFixture("soft-window-expired", {
    armedAt: now - 400_000,
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await settleUntil(() => softDigests(pi).length === 1);
  const digests = softDigests(pi);
  assert.equal(digests.length, 1);
  assert.equal((digests[0] as any).details.entries[0].elapsedMs, 400_000);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("an unrecorded window falls back to the durable acknowledgement time", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const label = "soft-window-fallback";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: now,
    lastAck: {
      requestId: REQUEST_ID,
      accepted: true,
      acknowledgedAt: now - 400_000,
    },
  });
  const pi = fakePi({
    exec: leadExec(
      label,
      "working",
      identity.piSessionId,
      undefined,
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext());
  await settleUntil(() => softDigests(pi).length === 1);
  const digests = softDigests(pi);
  assert.equal(digests.length, 1);
  assert.equal((digests[0] as any).details.entries[0].elapsedMs, 400_000);
  assert.equal((digests[0] as any).details.entries[0].windowMs, 300_000);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("softTimeoutMs of zero delivers no digest for an overdue window", async (t) => {
  setLeadEnvironment();
  updateConfig("softTimeoutMs", 0);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { pi, mailbox, entries } = softWindowFixture("soft-window-off", {
    armedAt: now - 400_000,
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  now += 300_000;
  t.mock.timers.tick(30_000);
  await settleUntil(() => softDigests(pi).length === 0);
  assert.equal(softDigests(pi).length, 0);
  updateConfig("softTimeoutMs", undefined);
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

type SoftWindowSpec = {
  label: string;
  requestId: string;
  armedAt?: number;
  windowMs?: number;
  lastActivityAt?: number;
  waiting?: boolean;
  lifecycle?: "idle" | "working";
  watcherGuidance?: string;
};

// Build a live multi-agent controller fixture whose snapshot lists every spec,
// so the soft-deadline pass and the health ladder see the same reality.
function softDeadlineFixture(specs: SoftWindowSpec[]) {
  setLeadEnvironment();
  const fixtures = specs.map((spec) => {
    const identity = recoveryIdentity(spec.label);
    // Distinct durable identities; a shared session would make presence
    // ambiguous and neither worker live.
    identity.piSessionId = randomUUID();
    const mailbox = agentMailboxPath(WORKSPACE, spec.label);
    resetAgentMailbox(mailbox);
    const state = managedState(spec.label, spec.requestId, identity);
    if (spec.waiting) {
      const provider = {
        id: `soft-deadline-provider-${spec.label}`,
        version: 1,
      };
      state.backgroundWorkProvider = provider;
      state.backgroundWaiting = {
        sessionId: identity.piSessionId,
        requestId: spec.requestId,
        provider,
        revision: 1,
        taskIds: ["background-task"],
      };
    }
    // A shared runId would make every worker here a candidate claimant of every
    // other one's pane, so presence could not be proved uniquely for any of
    // them. Each child owns its own run, as a real launch does.
    state.runId = randomUUID();
    writeAgentState(mailbox, {
      ...state,
      lastActivityAt: spec.lastActivityAt ?? Date.now(),
      ...(spec.armedAt === undefined
        ? {}
        : {
            lastAck: {
              requestId: spec.requestId,
              accepted: true,
              acknowledgedAt: spec.armedAt,
            },
          }),
    });
    const entries = specs
      .filter((candidate) => candidate.armedAt !== undefined)
      .map((candidate) => {
        const target = specs.find((value) => value.label === candidate.label)!;
        return softWindowEntry(
          target.label,
          target.requestId,
          target.armedAt!,
          target.windowMs ?? 300_000,
          target.watcherGuidance,
        );
      });
    return {
      spec,
      identity,
      mailbox,
      label: spec.label,
      entries,
      // `useAgentStatus` keeps `agent get` reporting the working lifecycle the
      // stale-attention ladder requires; without it the diagnostic check
      // treats the pane as unknown and skips the episode.
      exec: leadExec(
        spec.label,
        spec.lifecycle ?? "working",
        identity.piSessionId,
        undefined,
        identity.piSessionId,
        identity,
        true,
        spec.lifecycle ?? "working",
      ),
    };
  });
  const entries = fixtures[0]?.entries ?? [];
  const snapshot = () => ({
    stdout: JSON.stringify({
      id: AGENT_ID,
      result: {
        snapshot: {
          agents: fixtures.map(
            (fixture) =>
              JSON.parse(
                listResponse(
                  fixture.label,
                  fixture.spec.lifecycle ?? "working",
                  fixture.identity.piSessionId,
                  fixture.identity,
                ),
              ).agents[0],
          ),
          panes: fixtures.map((fixture) => ({
            pane_id: fixture.identity.paneId,
            workspace_id: WORKSPACE,
            cwd: "/tmp",
            agent: fixture.label,
            agent_status: fixture.spec.lifecycle ?? "working",
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "id",
              value: fixture.identity.piSessionId,
            },
          })),
        },
      },
    }),
    stderr: "",
    code: 0,
  });
  const exec = (command: string, args: string[], options?: any) => {
    const paneId = args[2];
    const fixture = fixtures.find(
      (candidate) => candidate.identity.paneId === paneId,
    );
    if (fixture) return fixture.exec(command, args, options);
    if (command === "herdr" && isApiSnapshot(args)) return snapshot();
    return fixtures[0]!.exec(command, args, options);
  };
  const pi = fakePi({ entries, exec });
  registerExtension!(pi.pi as never);
  // Each fixture's own exec installs the fleet its rows describe, so with more
  // than one child the last installation would hide every other child. The
  // daemon observes the mailboxes this session owns, which proves all of them.
  radarDaemon.observeInventory = radarObservedFleet;
  return { pi, fixtures, entries };
}

test("two overdue workers produce one digest covering both", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { pi, fixtures, entries } = softDeadlineFixture([
    {
      label: "soft-multi-one",
      requestId: randomUUID(),
      armedAt: now - 400_000,
    },
    {
      label: "soft-multi-two",
      requestId: randomUUID(),
      armedAt: now - 350_000,
    },
  ]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await settleUntil(() => softDigests(pi).length === 1);
  const digests = softDigests(pi);
  assert.equal(digests.length, 1, "one digest covers every due worker");
  const details = (digests[0] as any).details;
  assert.deepEqual(
    details.entries
      .map((entry: any) => [entry.agentLabel, entry.elapsedMs])
      .sort((left: string[], right: string[]) =>
        left[0]!.localeCompare(right[0]!),
      ),
    [
      ["soft-multi-one", 400_000],
      ["soft-multi-two", 350_000],
    ],
  );
  assert.deepEqual(details.entries[0].availableActions, [
    "inspect",
    "steer",
    "interrupt",
    "extend",
    "close",
  ]);
  assert.match(
    String((digests[0] as any).content),
    /no Agent was aborted, steered, or closed/i,
  );
  pi.events.get("session_shutdown")?.[0]();
  for (const fixture of fixtures) resetAgentMailbox(fixture.mailbox);
});

test("a one-Agent checkpoint offers that assignment's watcher instruction", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { pi, fixtures, entries } = softDeadlineFixture([
    {
      label: "soft-guided-one",
      requestId: randomUUID(),
      armedAt: now - 400_000,
      watcherGuidance: "Only wake me if this is blocked.",
    },
  ]);
  const offers: any[] = [];
  (pi.pi as any).events.on(WAKE_CONSUMER_OFFER, (offer: any) =>
    offers.push(offer),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await settleUntil(() => softDigests(pi).length === 1);
  // A consumer that claims nothing leaves the checkpoint on the path it always
  // had: the instruction travels beside the wake, it never replaces it.
  assert.equal(softDigests(pi).length, 1, "the checkpoint is still delivered");
  assert.deepEqual(
    offers.map((offer) => [offer.source, offer.kind, offer.dispatchGuidance]),
    [["pi-herdsman", "soft-deadline", "Only wake me if this is blocked."]],
  );
  pi.events.get("session_shutdown")?.[0]();
  for (const fixture of fixtures) resetAgentMailbox(fixture.mailbox);
});

test("a checkpoint covering several Agents offers no single instruction", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { pi, fixtures, entries } = softDeadlineFixture([
    {
      label: "soft-guided-mixed",
      requestId: randomUUID(),
      armedAt: now - 400_000,
      watcherGuidance: "Only wake me if this is blocked.",
    },
    {
      label: "soft-guided-plain",
      requestId: randomUUID(),
      armedAt: now - 350_000,
    },
  ]);
  const offers: any[] = [];
  (pi.pi as any).events.on(WAKE_CONSUMER_OFFER, (offer: any) =>
    offers.push(offer),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await settleUntil(() => softDigests(pi).length === 1);
  const digests = softDigests(pi);
  assert.equal(digests.length, 1, "one digest still covers both workers");
  assert.equal(
    (digests[0] as any).details.entries.length,
    2,
    "and it still names both",
  );
  // One instruction describes one assignment, so the batch carries none rather
  // than borrowing the first Agent's.
  assert.equal(offers.length, 1);
  assert.equal(offers[0].dispatchGuidance, undefined);
  pi.events.get("session_shutdown")?.[0]();
  for (const fixture of fixtures) resetAgentMailbox(fixture.mailbox);
});

test("a delegate records its watcher instruction, and extend replaces or keeps it", async () => {
  setLeadEnvironment();
  const label = "guided-delegate";
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const pi = fakePi({ exec: startup.exec });
  registerExtension!(pi.pi as never);
  // The instruction a consumer would receive is the one recorded on the
  // assignment's window, so the recording is where the plumbing is checked.
  const recorded = (requestId: string) =>
    (pi.entries as any[])
      .filter(
        (entry) =>
          entry.customType === "pi-herdsman-soft-window" &&
          entry.data.requestId === requestId,
      )
      .at(-1)?.data.watcherGuidance;
  try {
    const delegated = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        label,
        task: "water the migration",
        watcherGuidance: "Only wake me if the migration stalls.",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(delegated.details.ok, true, JSON.stringify(delegated.details));
    const requestId = delegated.details.request_id;
    assert.equal(recorded(requestId), "Only wake me if the migration stalls.");
    const kept = await agentTool(pi, "extend").execute(
      "id",
      { agent: label, windowMs: 60_000 },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(kept.details.ok, true, JSON.stringify(kept.details));
    assert.equal(
      recorded(requestId),
      "Only wake me if the migration stalls.",
      "an extend without an instruction keeps the assignment's",
    );
    const replaced = await agentTool(pi, "extend").execute(
      "id",
      {
        agent: label,
        windowMs: 60_000,
        watcherGuidance: "Only wake me if the review is refused.",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(replaced.details.ok, true, JSON.stringify(replaced.details));
    assert.equal(recorded(requestId), "Only wake me if the review is refused.");
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    startup.stopMailboxConsumer();
    resetAgentMailbox(startup.mailbox);
  }
});

test("background-waiting workers keep digest/extend eligibility but reject interrupt", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const label = "soft-waiting-worker";
  const requestId = randomUUID();
  const { pi, fixtures, entries } = softDeadlineFixture([
    {
      label,
      requestId,
      armedAt: now - 400_000,
      waiting: true,
      lifecycle: "idle",
    },
  ]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await new Promise((resolve) => setImmediate(resolve));

  const listed = await agentTool(pi, "list").execute(
    "waiting-list",
    {},
    undefined,
    undefined,
    fakeContext(entries),
  );
  const worker = listed.details.agents.find(
    (agent: any) => agent.agent === label,
  );
  assert.equal(worker?.state, "waiting");
  assert.ok(worker?.available_tools.includes("agent_inspect"));
  assert.ok(worker?.available_tools.includes("agent_steer"));
  assert.ok(worker?.available_tools.includes("agent_extend"));
  assert.equal(worker?.available_tools.includes("agent_interrupt"), false);
  assert.equal(worker?.available_tools.includes("agent_continue"), false);
  // Explicit close remains the cancellation/abandon path; it is not Clear idle.
  assert.ok(worker?.available_tools.includes("agent_close"));

  const digest = softDigests(pi)[0] as any;
  const entry = digest.details.entries.find(
    (candidate: any) => candidate.agentLabel === label,
  );
  assert.deepEqual(entry.availableActions, [
    "inspect",
    "steer",
    "extend",
    "close",
  ]);
  const refused = await agentTool(pi, "interrupt").execute(
    "waiting-interrupt",
    { agent: label, message: "Stop the waiting assignment." },
    undefined,
    undefined,
    fakeContext(entries),
  );
  assert.equal(refused.details.error.category, "agent_busy");
  assert.equal(
    readAgentState(fixtures[0]!.mailbox)?.activeRequestId,
    requestId,
  );

  pi.events.get("session_shutdown")?.[0]();
  for (const fixture of fixtures) resetAgentMailbox(fixture.mailbox);
});

test("a busy lead receives no digest until it is idle", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { pi, fixtures, entries } = softDeadlineFixture([
    { label: "soft-busy", requestId: randomUUID(), armedAt: now - 400_000 },
  ]);
  const context = fakeContext(entries);
  let idle = false;
  context.isIdle = () => idle;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, context);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(30_000);
  await settleUntil(() => softDigests(pi).length === 0);
  assert.equal(softDigests(pi).length, 0, "a busy owner is never interrupted");
  assert.equal(
    pi.sent.some(
      (message: any) =>
        message.customType === "pi-herdsman-agent-attention" ||
        message.customType === "pi-herdsman-agent-stale",
    ),
    false,
    "no other attention is delivered while the owner is busy",
  );

  idle = true;
  now += 30_000;
  t.mock.timers.tick(30_000);
  await settleUntil(() => softDigests(pi).length === 1);
  assert.equal(softDigests(pi).length, 1, "the digest arrives after idling");
  pi.events.get("session_shutdown")?.[0]();
  for (const fixture of fixtures) resetAgentMailbox(fixture.mailbox);
});

test("stale attention and a soft-deadline digest are both delivered in one scan", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { pi, fixtures, entries } = softDeadlineFixture([
    {
      label: "soft-coexist-stale",
      requestId: randomUUID(),
      lastActivityAt: now - 11 * 60_000,
    },
    {
      label: "soft-coexist-due",
      requestId: randomUUID(),
      armedAt: now - 400_000,
    },
  ]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await settleUntil(
    () =>
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-stale",
      ).length === 1,
  );
  assert.equal(
    pi.sent.filter(
      (message: any) => message.customType === "pi-herdsman-agent-stale",
    ).length,
    1,
    "stale attention is still delivered",
  );
  const digests = softDigests(pi);
  assert.equal(
    digests.length,
    1,
    "the digest is not suppressed by stale attention",
  );
  assert.deepEqual(
    (digests[0] as any).details.entries.map((entry: any) => entry.agentLabel),
    ["soft-coexist-due"],
  );
  pi.events.get("session_shutdown")?.[0]();
  for (const fixture of fixtures) resetAgentMailbox(fixture.mailbox);
});

test("a digest entry for a worker awaiting an answer lists reply, not interrupt", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const label = "soft-ask-controls";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const ask = {
    version: 5 as const,
    askId: randomUUID(),
    requestId: REQUEST_ID,
    runId: AGENT_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: identity.paneId,
    piSessionId: identity.piSessionId,
    question: "Keep waiting or change direction?",
    createdAt: now - 60_000,
  };
  writeAgentState(mailbox, {
    ...managedState(label, REQUEST_ID, identity),
    lastActivityAt: now,
    pendingAskId: ask.askId,
    lastAck: {
      requestId: REQUEST_ID,
      accepted: true,
      acknowledgedAt: now - 400_000,
    },
  });
  writeAsk(mailbox, ask);
  const entries = [
    { customType: "pi-herdsman-agent-ask", details: ask },
    softWindowEntry(label, REQUEST_ID, now - 400_000, 300_000),
  ];
  const pi = fakePi({
    entries,
    exec: leadExec(
      label,
      "blocked",
      identity.piSessionId,
      undefined,
      identity.piSessionId,
      identity,
    ),
  });
  registerExtension!(pi.pi as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  for (let index = 0; index < 4; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  const digests = softDigests(pi);
  assert.equal(
    digests.length,
    1,
    "an assignment awaiting an answer still gets a digest",
  );
  const [entry] = (digests[0] as any).details.entries;
  assert.equal(entry.agentLabel, label);
  assert.ok(
    entry.availableActions.includes("reply"),
    `reply is listed: ${JSON.stringify(entry.availableActions)}`,
  );
  assert.equal(
    entry.availableActions.includes("interrupt"),
    false,
    "interrupt is withheld while the worker awaits an answer",
  );
  pi.events.get("session_shutdown")?.[0]();
  resetAgentMailbox(mailbox);
});

test("soft-deadline listeners annotate the digest before delivery", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { pi, fixtures, entries } = softDeadlineFixture([
    {
      label: "soft-annotated",
      requestId: randomUUID(),
      armedAt: now - 400_000,
    },
  ]);
  const payloads: any[] = [];
  const off = (pi.pi as any).events.on(
    "pi-herdsman:soft-deadline",
    (payload: any) => {
      payloads.push(payload);
      payload.annotations.push("peer extension: budget window closes soon");
    },
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await settleUntil(() => payloads.length === 1);
  assert.equal(payloads.length, 1, "the digest is published before delivery");
  assert.deepEqual(
    payloads[0].entries.map((entry: any) => entry.agentLabel),
    ["soft-annotated"],
  );
  const digest = softDigests(pi)[0] as any;
  assert.deepEqual(digest.details.annotations, [
    "peer extension: budget window closes soon",
  ]);
  assert.match(
    String(digest.content),
    /peer extension: budget window closes soon/,
  );
  assert.doesNotMatch(
    String(digest.content),
    /budget window closes soon.*undefined/,
  );
  off();
  pi.events.get("session_shutdown")?.[0]();
  for (const fixture of fixtures) resetAgentMailbox(fixture.mailbox);
});

test("a throwing soft-deadline listener never blocks the digest", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { pi, fixtures, entries } = softDeadlineFixture([
    {
      label: "soft-throwing-listener",
      requestId: randomUUID(),
      armedAt: now - 400_000,
    },
  ]);
  let deliveries = 0;
  (pi.pi as any).events.on("pi-herdsman:soft-deadline", () => {
    deliveries++;
    throw new Error("listener failure");
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await settleUntil(() => deliveries === 1);
  assert.equal(deliveries, 1, "the failing listener was invoked");
  const digests = softDigests(pi);
  assert.equal(digests.length, 1, "the digest is still delivered");
  assert.deepEqual((digests[0] as any).details.annotations, []);
  pi.events.get("session_shutdown")?.[0]();
  for (const fixture of fixtures) resetAgentMailbox(fixture.mailbox);
});

test("three consecutive windows produce three digests", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const requestId = randomUUID();
  const label = "soft-periodic";
  const { pi, fixtures, entries } = softDeadlineFixture([
    { label, requestId, armedAt: now - 300_000 },
  ]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await pi.events.get("session_start")![0](undefined, fakeContext(entries));
  await settleUntil(() => softDigests(pi).length === 1);
  assert.equal(softDigests(pi).length, 1);
  for (let round = 1; round < 3; round++) {
    now += 300_000;
    writeAgentState(fixtures[0]!.mailbox, {
      ...readAgentState(fixtures[0]!.mailbox)!,
      lastActivityAt: now,
      updatedAt: now,
    });
    t.mock.timers.tick(30_000);
    await settleUntil(() => softDigests(pi).length === round + 1);
    assert.equal(
      softDigests(pi).length,
      round + 1,
      `window ${round + 1} delivers exactly one more digest`,
    );
    assert.equal(
      (softDigests(pi).at(-1) as any).details.entries[0].windowMs,
      300_000,
      "later windows use the configured length again",
    );
  }
  pi.events.get("session_shutdown")?.[0]();
  for (const fixture of fixtures) resetAgentMailbox(fixture.mailbox);
});

test("a resolved assignment is never included in a later digest", async (t) => {
  setLeadEnvironment();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);

  // Result delivered: recovery arms the window, then the child's durable
  // result is delivered through the exact controller delivery path.
  {
    const label = "soft-resolved-delivered";
    const identity = recoveryIdentity(label);
    const mailbox = agentMailboxPath(WORKSPACE, label);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, {
      ...managedState(label, REQUEST_ID, identity),
      lastActivityAt: now,
      lastAck: {
        requestId: REQUEST_ID,
        accepted: true,
        acknowledgedAt: now,
      },
    });
    const entries: unknown[] = [];
    const pi = fakePi({
      entries,

      persistMessages: true,
    });
    registerExtension!(pi.pi as never);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await startRadarSession(pi, fakeContext(entries));
      for (let index = 0; index < 4; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(softDigests(pi).length, 0, "a fresh window is not due");
      const armed = readAgentState(mailbox)!;
      assert.equal(armed.activeRequestId, REQUEST_ID);
      writeAgentState(mailbox, {
        ...armed,
        activeRequestId: undefined,
        completedRequestId: REQUEST_ID,
        updatedAt: Date.now(),
      });
      writeResult(mailbox, {
        version: 5,
        runId: armed.runId,
        requestId: REQUEST_ID,
        ownerSessionId: armed.ownerSessionId,
        workspaceId: armed.workspaceId,
        agentLabel: armed.agentLabel,
        paneId: armed.paneId,
        status: "completed",
        text: "delivered",
        completedAt: Date.now(),
      });
      watchedResultPaths.get(`${mailbox}/result-${REQUEST_ID}.json`)?.({}, {});
      for (let index = 0; index < 12; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        pi.sent.filter(
          (message: any) => message.customType === "pi-herdsman-agent-result",
        ).length,
        1,
        "the terminal result was delivered",
      );
      now += 400_000;
      t.mock.timers.tick(30_000);
      for (let index = 0; index < 4; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        softDigests(pi).length,
        0,
        "a delivered assignment produces no later digest",
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
      t.mock.timers.reset();
    }
  }

  // Explicit close after the window would already be due.
  {
    const label = "soft-resolved-closed";
    const mailbox = agentMailboxPath(WORKSPACE, label);
    resetAgentMailbox(mailbox);
    const launch = await radarDaemon.adoptRetainedChild({
      label,
      runId: randomUUID(),
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      mailbox,
      pane: `${label}-pane`,
    });
    writeAgentState(mailbox, {
      ...readAgentState(mailbox)!,
      activeRequestId: REQUEST_ID,
      lastActivityAt: now,
      lastAck: {
        requestId: REQUEST_ID,
        accepted: true,
        acknowledgedAt: now,
      },
    });
    const entries: unknown[] = [
      {
        type: "custom",
        customType: "pi-herdsman-radar-spawn",
        data: launch,
      },
    ];
    const pi = fakePi({ entries });
    registerExtension!(pi.pi as never);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await startRadarSession(pi, fakeContext(entries));
      for (let index = 0; index < 4; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(softDigests(pi).length, 0, "a fresh window is not due");
      const closed = await agentTool(pi, "close").execute(
        "id",
        { agent: label },
        undefined,
        undefined,
        fakeContext(entries),
      );
      assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
      assert.equal(readAgentState(mailbox), undefined);
      now += 400_000;
      t.mock.timers.tick(30_000);
      for (let index = 0; index < 4; index++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        softDigests(pi).length,
        0,
        "a closed assignment produces no later digest",
      );
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(mailbox);
      t.mock.timers.reset();
    }
  }

  // Proven lost with an already-overdue window.
  {
    const label = "soft-resolved-lost";
    const identity = recoveryIdentity(label);
    const mailbox = agentMailboxPath(WORKSPACE, label);
    resetAgentMailbox(mailbox);
    writeAgentState(mailbox, {
      ...managedState(label, REQUEST_ID, identity),
      // Past the startup window with no pane reported: lost, not merely unproved.
      updatedAt: now - 400_000,
      lastActivityAt: now - 400_000,
      lastAck: {
        requestId: REQUEST_ID,
        accepted: true,
        acknowledgedAt: now - 400_000,
      },
    });
    // The daemon reports no pane for this generation.
    observeFleet([]);
    const pi = fakePi({});
    registerExtension!(pi.pi as never);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await startRadarSession(pi, fakeContext());
    for (let index = 0; index < 4; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      pi.sent.filter(
        (message: any) => message.customType === "pi-herdsman-agent-lost",
      ).length,
      1,
      "loss still receives its dedicated attention",
    );
    now += 30_000;
    t.mock.timers.tick(30_000);
    for (let index = 0; index < 4; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      softDigests(pi).length,
      0,
      "a proven-lost assignment produces no digest",
    );
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    t.mock.timers.reset();
  }
});

/**
 * A pane whose registered agent never reports the run-scoped alias. The pane
 * still resolves the generation by id, while `agent get <alias>` — the lookup
 * every destructive control closes through — answers `agent_not_found`.
 * `unclaim()` switches the pane to that shape, so a test can change the
 * evidence between two inventory reads of the same generation.
 */
/**
 * The daemon's observation of a pane held by an occupant that claims nothing of
 * the generation recorded there: the shape a pane taken over by another process
 * leaves, and the evidence every control has to refuse on.
 */
function foreignOccupantFleet(paneId: string) {
  const location = {
    workspace_id: WORKSPACE,
    tab_id: "foreign-occupant-tab",
    pane_id: paneId,
  };
  return {
    workspaces: [{ workspace_id: WORKSPACE }],
    tabs: [{ tab_id: location.tab_id, workspace_id: WORKSPACE }],
    panes: [{ location }],
    agents: [
      {
        location,
        name: "foreign-occupant",
        session: {
          kind: "uuid",
          value: "99999999-9999-4999-8999-999999999999",
        },
      },
    ],
  };
}

test("an unclaimed managed alias is unknown rather than idle and closable", async () => {
  setLeadEnvironment();
  updateConfig("retainWorkers", true);
  const label = "unclaimed-alias";
  const identity = recoveryIdentity(label);
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, {
    ...managedState(label, undefined, identity),
    completedRequestId: REQUEST_ID,
  });
  // Another process holds the pane this mailbox recorded and claims nothing of
  // it, so this generation's physical identity cannot be proved.
  radarDaemon.observeInventory = () => foreignOccupantFleet(identity.paneId);
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const listed = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      fakeContext(),
    );
    const record = listed.details.agents.find(
      (candidate: any) => candidate.agent === label,
    );
    assert.ok(record, "the generation stays listed");
    assert.equal(record.state, "unknown");
    assert.deepEqual(record.available_tools, []);

    const closed = await agentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.ok(
      readAgentState(mailbox),
      "an unprovable generation is never retired",
    );
    assert.equal(closed.details.error.category, "target_ambiguous");
  } finally {
    updateConfig("retainWorkers", undefined);
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("a close that loses its alias claim between reads refuses without retiring the mailbox", async () => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const parentMailbox = agentMailboxPath(WORKSPACE, "alias-loss-parent");
  const childMailbox = agentMailboxPath(WORKSPACE, "alias-loss-child");
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  const parent = await radarDaemon.adoptRetainedChild({
    label: "alias-loss-parent",
    runId: randomUUID(),
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    mailbox: parentMailbox,
    pane: "alias-loss-parent-pane",
  });
  const child = await radarDaemon.adoptRetainedChild({
    label: "alias-loss-child",
    runId: randomUUID(),
    ownerSessionId: readAgentState(parentMailbox)!.piSessionId,
    workspaceId: WORKSPACE,
    mailbox: childMailbox,
    pane: "alias-loss-child-pane",
  });
  const entries = [parent, child].map((data) => ({
    type: "custom",
    customType: "pi-herdsman-radar-spawn",
    data,
  }));
  // Pin the seam by evidence rather than call order: a descendant is closed
  // after that generation's own assignment lock is claimed, so the daemon loses
  // its evidence for the child's pane on the first read taken while the lock is
  // held.
  const childStatePath = join(childMailbox, "state.json");
  const childLock = assignmentLockPathForTest(childMailbox);
  support.agentStateReadHook = (readPath) => {
    if (readPath === childStatePath && existsSync(childLock))
      radarDaemon.options.locationEvidence = "absent";
  };
  const pi = fakePi({});
  registerExtension!(pi.pi as never);
  try {
    const closed = await agentTool(pi, "close").execute(
      "id",
      { agent: "alias-loss-parent" },
      undefined,
      undefined,
      fakeContext(entries),
    );
    assert.ok(
      readAgentState(childMailbox),
      "an unprovable generation is never retired",
    );
    assert.equal(closed.details.error.category, "target_ambiguous");
    assert.equal(closed.details.error.ids.label, "alias-loss-child");
    assert.equal(closed.details.error.ids.paneId, "alias-loss-child-pane");
    assert.deepEqual(
      [...radarDaemon.closes.values()].filter(
        (close) => close.outcome === "completed",
      ),
      [],
      "the cascade closes nothing",
    );
    assert.ok(readAgentState(parentMailbox), "the parent survives");
  } finally {
    support.agentStateReadHook = undefined;
    radarDaemon.options.locationEvidence = "present";
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
  }
});

test("a restart finishes the cleanup of a close the daemon already confirmed", async () => {
  setLeadEnvironment();
  const label = `confirmed-close-${randomUUID().slice(0, 8)}`;
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  const state = managedState(label);
  const entries: unknown[] = [];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries);
  // The daemon this process registers against is the one that already confirmed
  // the close, so it comes up before the child is adopted.
  await ensureRadarDaemon();
  const launch = await radarDaemon.adoptRetainedChild({
    label,
    runId: state.runId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: WORKSPACE,
    mailbox,
    pane: state.paneId,
    definition: "agent",
  });
  entries.push({
    type: "custom",
    customType: "pi-herdsman-radar-spawn",
    data: launch,
  });
  // The process that closed the pane recorded its completion, but its own local
  // cleanup never ran: the mailbox still holds the assignment it was carrying.
  writeRequest(mailbox, {
    version: 5,
    runId: state.runId,
    requestId: randomUUID(),
    ownerSessionId: state.ownerSessionId,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: state.paneId,
    kind: "task",
    text: "the assignment the unfinished cleanup left",
    createdAt: Date.now(),
  });
  entries.push({
    type: "custom",
    customType: "pi-herdsman-radar-close",
    data: {
      stage: "completed",
      requestId: randomUUID(),
      spawnRequestId: launch.requestId,
      source: RADAR_SUBJECT_SOURCE,
      incarnation: radarDaemon.spawns.at(-1)!.incarnation,
      intent: "complete",
      runId: state.runId,
      label,
      ownerSessionId: state.ownerSessionId,
      mailbox,
    },
  });
  await startRadarSession(pi, context);
  try {
    const closed = await agentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(closed.details.ok, true, JSON.stringify(closed.details));
    assert.equal(readAgentState(mailbox), undefined);
    assert.equal(existsSync(mailbox), false);
    // The pane was closed once, by the process that recorded it: a restart
    // resumes that cleanup instead of sending a second close.
    assert.equal(radarDaemon.closes.size, 0);
    assert.equal(
      entries.filter(
        (entry: any) => entry.customType === "pi-herdsman-radar-close",
      ).length,
      1,
    );
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});
