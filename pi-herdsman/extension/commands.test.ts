import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { mock, test } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import { Value } from "typebox/value";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import { acquireProcessLock, claimProcessLock } from "./lock.ts";
import {
  claimChiefLease,
  listCoordinationMessagePaths,
  removeChiefMessage,
  readChiefMessage,
  listPeerLeadRecords,
  peerLeadLockPath,
  peerRuntime,
  readPeerLeadRecord,
  removePeerLeadRecord,
  supervisionRuntime,
  readLeadCoordinationState,
  sessionLeadRoleState,
  sessionOwnership,
  writeLeadCoordinationState,
  writeChiefMessage,
  writeCoordinationMessage,
  writePeerLeadRecord,
} from "./supervision.ts";
import { OperationError } from "./errors.ts";
import { resultPath } from "./storage.ts";
import support, {
  CHILD_SESSION_ID,
  DEFAULT_PI_SESSION_ID,
  NON_PI_AGENT,
  PARENT_SESSION_ID,
  PI_AGENTS_DIR,
  PI_AGENT_ROOT,
  REQUEST_ID,
  LEAD_SESSION_ID,
  StatusWidget,
  AGENT_ID,
  WORKSPACE,
  buildStatusRows,
  defaultFixtureIdentity,
  discoverAgent,
  ensureRadarDaemon,
  fakeContext,
  visibleAgentDefinitionMetadata,
  fakePi,
  fakeAgentContext,
  listResponse,
  managedState,
  nativeSessions,
  projectContextCwds,
  radarDaemon,
  readAgentState,
  readResult,
  realFs,
  recoveryIdentity,
  registerExtension,
  renderRunningOptions,
  resetAgentMailbox,
  resultEntryDetails,
  setLeadEnvironment,
  setAgentEnvironment,
  startRadarSession,
  stopSummary,
  testGate,
  visibleWidth,
  agentMailboxPath,
  writeResult,
  writeAgentState,
} from "./support.ts";
import { DELEGATION_BRIEF_EXAMPLES } from "./briefs.ts";
const { readConfig, updateConfig } = await import("./config.ts");
const agentTool = (pi: ReturnType<typeof fakePi>, name: string) =>
  pi.tools.find((candidate) => candidate.name === `agent_${name}`)!;
test("session stats sums Pi usage entries and proven nested sessions once", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const dir = mkdtempSync(join(tmpdir(), "herdsman-usage-"));
  const childPath = join(dir, "child.jsonl");
  const nestedPath = join(dir, "nested.jsonl");
  writeFileSync(childPath, "");
  writeFileSync(nestedPath, "");
  const childId = "22222222-2222-4222-8222-222222222222";
  const nestedId = "33333333-3333-4333-8333-333333333333";
  const usage = (
    input: number,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    total = 0,
  ) => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  });
  const edge = (owner: string, id: string, path: string, label: string) => ({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "agent_delegate",
      details: {
        ok: true,
        owner_session_id: owner,
        session_id: id,
        session_path: path,
        agent: label,
        definition: "scout",
      },
    },
  });
  const identity = (id: string, label: string) => ({
    type: "custom",
    customType: "pi-herdsman-agent-definition",
    data: { sessionId: id, label, definition: "scout" },
  });
  nativeSessions.set(childPath, {
    id: childId,
    path: childPath,
    entries: [
      identity(childId, "child"),
      {
        type: "usage",
        provider: "openai",
        model: "child-model",
        usage: usage(7),
      },
      edge(childId, nestedId, nestedPath, "nested"),
    ],
  });
  nativeSessions.set(nestedPath, {
    id: nestedId,
    path: nestedPath,
    entries: [
      identity(nestedId, "nested"),
      {
        type: "usage",
        provider: "openai",
        model: "child-model",
        usage: usage(9),
      },
    ],
  });
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "openai",
        model: "requested",
        responseModel: "actual",
        usage: usage(10, 2, 20, 3, 0.1),
      },
    },
    {
      type: "message",
      message: { role: "toolResult", usage: usage(4, 1, 0, 0, 0.02) },
    },
    {
      type: "usage",
      provider: "anthropic",
      model: "warm",
      usage: usage(1, 0, 5, 0, 0.01),
    },
    { type: "compaction", usage: usage(3, 1, 0, 0, 0.03) },
    { type: "branch_summary", usage: usage(2, 1, 0, 0, 0.02) },
    edge(LEAD_SESSION_ID, childId, childPath, "child"),
    edge(LEAD_SESSION_ID, childId, childPath, "child"),
    edge("other-owner", nestedId, nestedPath, "nested"),
  ];
  const context = fakeContext(entries) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.commandOptions.get("agents").handler("stats", context);
    assert.match(
      notices[0]!,
      /Current session[\s\S]*Input\s+48[\s\S]*Total\s+53[\s\S]*Cost\s+\$0\.180/,
    );
    assert.match(notices[0]!, /Managed agents · 2 sessions[\s\S]*Input\s+16/);
    assert.match(
      notices[0]!,
      /Models\n  openai\/actual  35  \$0\.100\n  Tools\/summaries  12  \$0\.070\n  anthropic\/warm  6  \$0\.010\n  openai\/child-model  16  \$0\.000/,
    );
    assert.doesNotMatch(notices[0]!, /openai\/requested/);
    assert.doesNotMatch(notices[0]!, /Coverage incomplete/);
    nativeSessions.get(nestedPath)!.entries = [
      identity(nestedId, "wrong"),
      {
        type: "usage",
        provider: "openai",
        model: "child-model",
        usage: usage(9),
      },
    ];
    await pi.commandOptions.get("herdsman").handler("stats", context);
    assert.match(notices[1]!, /Managed agents · 1 session/);
    assert.match(notices[1]!, /Coverage incomplete/);
  } finally {
    nativeSessions.delete(childPath);
    nativeSessions.delete(nestedPath);
    rmSync(dir, { recursive: true, force: true });
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("session stats marks malformed owned assignment receipts incomplete", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext([
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "agent_delegate",
        details: {
          ok: true,
          owner_session_id: LEAD_SESSION_ID,
          session_id: CHILD_SESSION_ID,
          session_path: 42,
          agent: "child",
          definition: "scout",
        },
      },
    },
  ]) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.commandOptions.get("agents").handler("stats", context);
    assert.match(notices[0]!, /Managed agents · 0 sessions/);
    assert.match(notices[0]!, /Coverage incomplete/);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("session stats marks malformed owned completed results incomplete", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext([
    {
      type: "custom_message",
      customType: "pi-herdsman-agent-result",
      details: {
        ownerSessionId: LEAD_SESSION_ID,
        piSessionId: CHILD_SESSION_ID,
        agentLabel: "child",
        agentDefinition: "scout",
        runId: "run",
        requestId: REQUEST_ID,
        status: "completed",
      },
    },
  ]) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.commandOptions.get("agents").handler("stats", context);
    assert.match(notices[0]!, /Managed agents · 0 sessions/);
    assert.match(notices[0]!, /Coverage incomplete/);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});
const leadTools = [
  "agent_list",
  "agent_delegate",
  "agent_continue",
  "agent_steer",
  "agent_interrupt",
  "agent_reply",
  "agent_complete",
  "agent_close",
  "agent_inspect",
  "agent_transcript",
  "agent_extend",
  "supervisor_message",
  "peer_list",
  "peer_message",
];
const chiefTools = [
  "staff_list",
  "staff_inspect",
  "staff_transcript",
  "staff_message",
];
function nonGitWorkspaceResponse() {
  return {
    stdout: JSON.stringify({
      id: AGENT_ID,
      error: {
        code: "not_git_worktree",
        message: "Workspace is not a Git worktree",
      },
    }),
    stderr: "",
    code: 1,
  };
}
function fakeChiefPi(options: Parameters<typeof fakePi>[0] = {}) {
  let fixture: ReturnType<typeof fakePi>;
  const initialTools = Array.isArray(options.activeTools)
    ? options.activeTools
    : [];
  fixture = fakePi({
    ...options,
    exec: async (command: string, args: string[], extra: any) => {
      const provided = await options.exec?.(command, args, extra);
      if (
        command === "herdr" &&
        args[0] === "worktree" &&
        args[1] === "list" &&
        (!provided || provided.stdout === "{}")
      )
        return nonGitWorkspaceResponse();
      if (
        provided &&
        !(
          command === "herdr" &&
          args[0] === "workspace" &&
          args[1] === "get" &&
          provided.stdout === "{}"
        )
      )
        return provided;
      return {
        stdout:
          command === "herdr" && args[0] === "workspace" && args[1] === "get"
            ? JSON.stringify({ id: AGENT_ID, result: { workspace: {} } })
            : command === "herdr" && isAgentList(args)
              ? JSON.stringify({ id: AGENT_ID, result: { agents: [] } })
              : command === "herdr" && isApiSnapshot(args)
                ? JSON.stringify({
                    id: AGENT_ID,
                    result: { snapshot: { agents: [], panes: [] } },
                  })
                : "{}",
        stderr: "",
        code: 0,
      };
    },
    allTools: () =>
      [
        ...new Set([
          ...initialTools,
          "read",
          "bash",
          "grep",
          "foreign_tool",
          "agent_list",
          "agent_delegate",
          "agent_continue",
          "agent_steer",
          "agent_interrupt",
          "agent_reply",
          "agent_complete",
          "agent_close",
          "agent_inspect",
          "agent_transcript",
          "agent_extend",
          "supervisor_message",
          "peer_list",
          "peer_message",
          "staff_list",
          "staff_inspect",
          "staff_transcript",
          "staff_message",
          ...fixture.tools.map((tool) => tool.name),
        ]),
      ].map((name) => ({ name })),
  });
  return fixture;
}

test("linked and non-project sessions derive ordinary Lead tools", async () => {
  for (const membership of ["linked", "non-project"] as const) {
    setLeadEnvironment();
    process.env.HERDR_PANE_ID = `pane-${membership}`;
    process.env.HERDR_TAB_ID = `tab-${membership}`;
    process.env.HERDR_SOCKET_PATH = join(
      tmpdir(),
      `structural-${membership}-${randomUUID()}.sock`,
    );
    const respond = (result: unknown) => ({
      stdout: JSON.stringify({ id: AGENT_ID, result }),
      stderr: "",
      code: 0,
    });
    const pi = fakeChiefPi({
      activeTools: ["read"],
      exec: (command, args) => {
        if (command === "herdr" && args[0] === "workspace" && args[1] === "get")
          return respond({
            workspace:
              membership === "linked"
                ? {
                    worktree: {
                      repo_key: "repo-key",
                      is_linked_worktree: true,
                    },
                  }
                : {},
          });
        if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
          return respond({
            source: {
              source_workspace_id: "root-workspace",
              repo_key: "repo-key",
              repo_name: "project",
            },
            worktrees: [{ open_workspace_id: WORKSPACE }],
          });
        if (command === "herdr" && isAgentList(args))
          return respond({ agents: [] });
        if (command === "herdr" && isApiSnapshot(args))
          return respond({ snapshot: { agents: [], panes: [] } });
        return respond({});
      },
    });
    registerExtension!(pi.pi as never);
    try {
      await pi.events.get("session_start")![0](undefined, fakeContext());
      assert.deepEqual(pi.pi.getActiveTools(), ["read", ...leadTools]);
      assert.equal(
        readLeadCoordinationState(supervisionRuntime(), LEAD_SESSION_ID)?.role,
        "lead",
      );
    } finally {
      await pi.events.get("session_shutdown")?.[0]();
      delete process.env.HERDR_SOCKET_PATH;
      delete process.env.HERDR_TAB_ID;
      delete process.env.HERDR_PANE_ID;
      setLeadEnvironment();
    }
  }
});

test("Chief staff and ambient supervision include unclaimed Leads", async () => {
  setLeadEnvironment();
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-leads-${randomUUID()}.sock`,
  );
  const independentLeadSession = randomUUID();
  writeLeadCoordinationState(supervisionRuntime(), {
    version: 1,
    role: "lead",
    instanceId: randomUUID(),
    piSessionId: independentLeadSession,
    updatedAt: Date.now(),
  });
  radarDaemon.options.inventory = observedFleet([
    observedAgent({
      paneId: "independent-pane",
      tabId: "independent-tab",
      session: { kind: "uuid", value: independentLeadSession },
    }),
  ]);
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  const chief = fakeChiefPi({ activeTools: ["read"] });
  const chiefCtx = fakeContext() as any;
  const chiefSession = `chief-${randomUUID()}`;
  chiefCtx.sessionManager.getSessionId = () => chiefSession;
  registerExtension!(chief.pi as never);
  try {
    await chief.events.get("session_start")![0](undefined, chiefCtx);
    await chief.commandOptions.get("chief").handler("", chiefCtx);
    assert.deepEqual(chief.pi.getActiveTools(), chiefTools);
    const chiefPrompt = await chief.events.get("before_agent_start")![0](
      { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
      chiefCtx,
    );
    assert.ok(
      JSON.stringify(chiefPrompt.message).includes(independentLeadSession),
    );
    const staff = chief.tools.find((tool) => tool.name === "staff_list")!;
    const listed = await staff.execute(
      "list",
      {},
      undefined,
      undefined,
      chiefCtx,
    );
    assert.equal(listed.details.self.role, "chief");
    assert.equal(listed.details.reports.length, 1);
    assert.equal(listed.details.reports[0].role, "lead");
    assert.equal(listed.details.reports[0].session, independentLeadSession);
    await assert.rejects(
      chief.tools
        .find((tool) => tool.name === "staff_message")!
        .execute(
          "message",
          {
            session: "unrelated-lead",
            message: "Not a direct report",
          },
          undefined,
          undefined,
          chiefCtx,
        ),
      /not a current direct report|Lead target was not found or is no longer eligible/,
    );
  } finally {
    await chief.events.get("session_shutdown")![0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("a Lead without a Manager routes upward to Chief and keeps peer presence", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-presence-health-${randomUUID()}.sock`,
  );
  const chiefId = `chief-${randomUUID()}`;
  const descriptorIdentity = {
    piSessionId: chiefId,
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  };
  const chiefAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: chiefId,
    },
    pane_id: descriptorIdentity.paneId,
    tab_id: descriptorIdentity.tabId,
    workspace_id: descriptorIdentity.workspaceId,
    cwd: "/tmp",
  };
  const lease = claimChiefLease(descriptorIdentity);
  const entries: unknown[] = [];
  const pi = fakeChiefPi({
    entries,
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: {
                source_workspace_id: "root-workspace",
                repo_key: "repo-key",
                repo_name: "project",
              },
              worktrees: [{ open_workspace_id: WORKSPACE }],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agents: [chiefAgent] },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agent: chiefAgent },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext(
    [],
    [
      {
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "supervisor_message" }],
        },
      },
    ],
  ) as any;
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);

    const sessionId = context.sessionManager.getSessionId();
    const initial = readPeerLeadRecord(peerRuntime(), sessionId);
    assert.ok(initial);

    const chief = pi.tools.find((tool) => tool.name === "supervisor_message");
    assert.ok(chief);
    const result = await chief.execute(
      "message",
      { message: "Which path?" },
      undefined,
      undefined,
      context,
    );
    assert.match(result.content[0].text, /Message sent to supervisor/);
    assert.equal(
      listCoordinationMessagePaths(supervisionRuntime(), chiefId).length,
      1,
    );
    assert.equal(
      readPeerLeadRecord(peerRuntime(), sessionId)?.claim.id,
      initial.claim.id,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    lease.release();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("ordinary Lead peer presence disappears in Chief mode and on shutdown", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-presence-lifecycle-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ entries, activeTools: ["read", "bash"] });
  const context = fakeContext(entries) as any;
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const first = readPeerLeadRecord(
      peerRuntime(),
      context.sessionManager.getSessionId(),
    );
    assert.ok(first);
    assert.equal(listPeerLeadRecords(peerRuntime()).length, 1);

    await pi.commandOptions.get("chief").handler("", context);
    assert.equal(
      readPeerLeadRecord(peerRuntime(), context.sessionManager.getSessionId()),
      undefined,
    );
    assert.deepEqual(listPeerLeadRecords(peerRuntime()), []);

    await pi.commandOptions.get("chief").handler("leave", context);
    const restored = readPeerLeadRecord(
      peerRuntime(),
      context.sessionManager.getSessionId(),
    );
    assert.ok(restored);
    assert.notEqual(restored.claim.id, first.claim.id);

    await pi.events.get("session_shutdown")![0]();
    assert.deepEqual(listPeerLeadRecords(peerRuntime()), []);
  } finally {
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("Chief message persistence failure can recover without withdrawing peer presence", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `peer-presence-health-${randomUUID()}.sock`,
  );
  const chiefId = `chief-${randomUUID()}`;
  const descriptorIdentity = {
    piSessionId: chiefId,
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  };
  const chiefAgent = {
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: chiefId,
    },
    pane_id: descriptorIdentity.paneId,
    tab_id: descriptorIdentity.tabId,
    workspace_id: descriptorIdentity.workspaceId,
    cwd: "/tmp",
  };
  const lease = claimChiefLease(descriptorIdentity);
  const entries: unknown[] = [];
  const pi = fakeChiefPi({
    entries,
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "worktree" && args[1] === "list")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              source: {
                source_workspace_id: "root-workspace",
                repo_key: "repo-key",
                repo_name: "project",
              },
              worktrees: [{ open_workspace_id: WORKSPACE }],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agents: [chiefAgent] },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agent: chiefAgent },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext(
    [],
    [
      {
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "supervisor_message" }],
        },
      },
    ],
  ) as any;
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  let obstruction: string | undefined;
  try {
    await pi.events.get("session_start")![0](undefined, context);

    const sessionId = context.sessionManager.getSessionId();
    const initial = readPeerLeadRecord(peerRuntime(), sessionId);
    assert.ok(initial);

    const runtime = supervisionRuntime();
    mkdirSync(runtime.inbox, { recursive: true });
    obstruction = join(
      runtime.inbox,
      createHash("sha256").update(chiefId).digest("hex"),
    );
    writeFileSync(obstruction, "block Chief inbox creation");

    const chief = pi.tools.find((tool) => tool.name === "supervisor_message");
    assert.ok(chief);
    await assert.rejects(
      chief.execute(
        "message",
        { message: "Which path?" },
        undefined,
        undefined,
        context,
      ),
      /EEXIST|not a directory/i,
    );
    assert.equal(
      readPeerLeadRecord(peerRuntime(), sessionId)?.claim.id,
      initial.claim.id,
    );
    rmSync(obstruction, { force: true });
    const result = await chief.execute(
      "message",
      { message: "Retry after inbox recovery" },
      undefined,
      undefined,
      context,
    );
    assert.match(result.content[0].text, /Message sent to supervisor/);
    assert.equal(listCoordinationMessagePaths(runtime, chiefId).length, 1);
    assert.equal(
      readPeerLeadRecord(peerRuntime(), sessionId)?.claim.id,
      initial.claim.id,
    );
  } finally {
    // A failed assertion before the retry must not leave the temporary obstacle.
    if (obstruction) rmSync(obstruction, { recursive: true, force: true });
    await pi.events.get("session_shutdown")?.[0]();
    lease.release();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  }
});

test("queued peer traffic stays durable through Chief mode and drains after leave", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `peer-chief-backpressure-${randomUUID()}.sock`);
  const receiverId = `receiver-${randomUUID()}`;
  const senderId = `sender-${randomUUID()}`;
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_PANE_ID = "receiver-pane";
  process.env.HERDR_TAB_ID = "receiver-tab";
  const delivered = testGate<void>();
  const receiver = fakeChiefPi({
    sendMessage: (message) => {
      if (String((message as any)?.content ?? "").includes("queued peer")) {
        const waitForRemoval = () =>
          listCoordinationMessagePaths(runtime, receiverId).length === 0
            ? delivered.resolve()
            : queueMicrotask(waitForRemoval);
        queueMicrotask(waitForRemoval);
      }
    },
    activeTools: ["read", "bash"],
  });
  const receiverContext = fakeContext() as any;
  receiverContext.sessionManager = {
    ...receiverContext.sessionManager,
    getSessionId: () => receiverId,
  };
  const runtime = peerRuntime();
  const senderLease = acquireProcessLock(peerLeadLockPath(runtime, senderId), {
    name: "Lead peer presence",
  });
  const senderRecord = {
    version: 1 as const,
    piSessionId: senderId,
    paneId: "sender-pane",
    tabId: "sender-tab",
    workspaceId: WORKSPACE,
    claim: senderLease.claim,
    updatedAt: Date.now(),
  };
  writePeerLeadRecord(runtime, senderRecord);
  registerExtension!(receiver.pi as never);
  try {
    await receiver.events.get("session_start")![0](undefined, receiverContext);
    assert.ok(readPeerLeadRecord(runtime, receiverId));
    const record = {
      version: 1 as const,
      id: randomUUID(),
      leaseId: senderRecord.claim.id,
      kind: "peer_message" as const,
      fromSessionId: senderId,
      toSessionId: receiverId,
      leadSessionId: senderId,
      text: "queued peer",
      createdAt: Date.now(),
    };
    writeCoordinationMessage(record, runtime);

    await receiver.commandOptions.get("chief").handler("", receiverContext);
    assert.equal(
      receiver.sentMessageCalls.filter((call) =>
        String((call.message as any)?.content ?? "").includes("queued peer"),
      ).length,
      0,
    );
    assert.equal(listCoordinationMessagePaths(runtime, receiverId).length, 1);

    await receiver.commandOptions
      .get("chief")
      .handler("leave", receiverContext);
    await delivered.promise;
    await Promise.resolve();
    const peerDeliveries = receiver.sentMessageCalls.filter((call) =>
      String((call.message as any)?.content ?? "").includes("queued peer"),
    );
    assert.equal(peerDeliveries.length, 1);
    assert.deepEqual(listCoordinationMessagePaths(runtime, receiverId), []);
  } finally {
    await receiver.events.get("session_shutdown")?.[0]();
    removePeerLeadRecord(runtime, senderId);
    senderLease.release();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("peer delivery survives sender shutdown and is accepted exactly once", async () => {
  setLeadEnvironment();
  const socket = join(tmpdir(), `peer-sender-shutdown-${randomUUID()}.sock`);
  const senderId = `sender-${randomUUID()}`;
  const targetId = `target-${randomUUID()}`;
  process.env.HERDR_SOCKET_PATH = socket;
  process.env.HERDR_PANE_ID = "sender-pane";
  process.env.HERDR_TAB_ID = "sender-tab";
  const sender = fakeChiefPi({ activeTools: ["read", "bash"] });
  const senderContext = fakeContext() as any;
  senderContext.sessionManager = {
    ...senderContext.sessionManager,
    getSessionId: () => senderId,
  };
  registerExtension!(sender.pi as never);
  const runtime = peerRuntime();
  const targetLease = acquireProcessLock(peerLeadLockPath(runtime, targetId), {
    name: "Lead peer presence",
  });
  const targetRecord = {
    version: 1 as const,
    piSessionId: targetId,
    paneId: "target-pane",
    tabId: "target-tab",
    workspaceId: WORKSPACE,
    claim: targetLease.claim,
    updatedAt: Date.now(),
  };
  writePeerLeadRecord(runtime, targetRecord);
  try {
    await sender.events.get("session_start")![0](undefined, senderContext);
    const peer = sender.tools.find((tool) => tool.name === "peer_message");
    assert.ok(peer);
    const queued = await peer.execute(
      "message",
      { session: targetId, message: "sender survived" },
      undefined,
      undefined,
      senderContext,
    );
    assert.equal(queued.details?.session, targetId);
    await sender.events.get("session_shutdown")![0]();
    assert.equal(readPeerLeadRecord(runtime, senderId), undefined);

    targetLease.release();
    process.env.HERDR_PANE_ID = "target-pane";
    process.env.HERDR_TAB_ID = "target-tab";
    const delivered = testGate<void>();
    const receiver = fakeChiefPi({
      sendMessage: (message) => {
        if (
          String((message as any)?.content ?? "").includes("sender survived")
        ) {
          const waitForRemoval = () =>
            listCoordinationMessagePaths(runtime, targetId).length === 0
              ? delivered.resolve()
              : queueMicrotask(waitForRemoval);
          queueMicrotask(waitForRemoval);
        }
      },
      activeTools: ["read", "bash"],
    });
    const receiverContext = fakeContext() as any;
    receiverContext.sessionManager = {
      ...receiverContext.sessionManager,
      getSessionId: () => targetId,
    };
    registerExtension!(receiver.pi as never);
    try {
      await receiver.events.get("session_start")![0](
        undefined,
        receiverContext,
      );
      await delivered.promise;
      await Promise.resolve();
      const deliveries = receiver.sentMessageCalls.filter((call) =>
        String((call.message as any)?.content ?? "").includes(
          "sender survived",
        ),
      );
      assert.equal(deliveries.length, 1);
      assert.deepEqual(listCoordinationMessagePaths(runtime, targetId), []);
    } finally {
      await receiver.events.get("session_shutdown")?.[0]();
    }
  } finally {
    removePeerLeadRecord(runtime, senderId);
    removePeerLeadRecord(runtime, targetId);
    try {
      targetLease.release();
    } catch {}
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("competing Lead focuses Chief with an absent prospective session path", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-focus-${randomUUID()}.sock`,
  );
  const descriptor = {
    piSessionId: randomUUID(),
    piSessionFile: join(tmpdir(), `prospective-chief-${randomUUID()}.jsonl`),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  };
  const chiefAgent = {
    pane_id: descriptor.paneId,
    tab_id: descriptor.tabId,
    workspace_id: descriptor.workspaceId,
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: descriptor.piSessionFile,
    },
  };
  const lease = claimChiefLease(descriptor);
  // The daemon normalizes the path-form session record Herdr reports for this
  // chief, so its focus proof stays the path equality the Herdr proof used.
  const daemon = await serveFakeRadar([
    observedAgent({
      paneId: descriptor.paneId,
      tabId: descriptor.tabId,
      session: {
        kind: "reported",
        value: { source: "herdr:pi", value: descriptor.piSessionFile },
      },
    }),
  ]);
  const pi = fakeChiefPi({
    exec: (command, args) => {
      if (command === "herdr" && isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agents: [chiefAgent] },
          }),
          stderr: "",
          code: 0,
        };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { agent: chiefAgent },
          }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.select = async (title: string, choices: string[]) => {
    assert.equal(title, "chief");
    assert.deepEqual(choices, ["Focus chief", "Cancel"]);
    return "Focus chief";
  };
  registerExtension!(pi.pi as never);
  try {
    assert.equal(realFs.existsSync(descriptor.piSessionFile), false);
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("chief").handler("", context);
    assert.deepEqual(
      pi.calls.filter((args) => args[0] === "agent" && args[1] === "focus"),
      [],
    );
    assert.deepEqual(
      daemon.requests
        .filter((request) => request.method === "mux.focus")
        .map((request) => request.params),
      [
        {
          target: descriptor.paneId,
          target_kind: "pane",
          requester: "pi-herdsman",
        },
      ],
    );
    assert.equal(realFs.existsSync(descriptor.piSessionFile), false);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    lease.release();
    await ensureRadarDaemon();
    await daemon.close();
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("Chief shutdown releases its lease when ordinary tool restoration fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-suspend-failure-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.includes("read")) {
      failRestore = false;
      throw new Error("tool restoration failed");
    }
    setActiveTools(next);
  };

  await pi.events.get("session_shutdown")![0]();

  assert.deepEqual(pi.pi.getActiveTools(), [
    "staff_list",
    "staff_inspect",
    "staff_transcript",
    "staff_message",
  ]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi-herdsman-role" && entry.data.role === "chief",
    ),
  );
  const lease = claimChiefLease({
    piSessionId: context.sessionManager.getSessionId(),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  lease.release();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("Chief activation keeps its durable baseline when rollback restoration fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-activation-rollback-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  const baseline = pi.pi.getActiveTools();
  const setActiveTools = pi.pi.setActiveTools;
  let activationAttempted = false;
  let failures = 1;
  pi.pi.setActiveTools = (next: string[]) => {
    if (next.includes("staff_list")) {
      activationAttempted = true;
      throw new Error("Chief activation failed");
    }
    if (
      activationAttempted &&
      failures > 0 &&
      next.join("|") === baseline.join("|")
    ) {
      failures--;
      throw new Error("Chief baseline restoration failed");
    }
    setActiveTools(next);
  };

  await pi.commandOptions.get("chief").handler("", context);

  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  assert.deepEqual(notices, ["Chief activation failed"]);
  const lease = claimChiefLease({
    piSessionId: context.sessionManager.getSessionId(),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  lease.release();
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("Chief leave cancellation preserves Chief tools", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  const pi = fakeChiefPi({ activeTools: ["read", "bash"] });
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.confirm = async () => false;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("chief").handler("", context);
    const chiefToolsNow = pi.pi.getActiveTools();

    const notices: string[] = [];
    context.ui.notify = (message: string) => notices.push(message);
    await pi.commandOptions.get("chief").handler("leave", context);
    assert.deepEqual(notices, ["Chief leave cancelled."]);
    assert.deepEqual(pi.pi.getActiveTools(), chiefToolsNow);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("Chief tool activation failure restores ordinary Lead tools", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-tool-activation-failure-${randomUUID()}.sock`,
  );
  const pi = fakeChiefPi({
    activeTools: ["read", "bash"],
    exec: (command, args) =>
      command === "herdr" && args[0] === "worktree" && args[1] === "list"
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                source: {
                  source_workspace_id: "root-workspace",
                  repo_key: "repo-key",
                  repo_name: "project",
                },
                worktrees: [{ open_workspace_id: WORKSPACE }],
              },
            }),
            stderr: "",
            code: 0,
          }
        : undefined,
  });
  const context = fakeContext() as any;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const ordinaryTools = pi.pi.getActiveTools();
    const setActiveTools = pi.pi.setActiveTools;
    pi.pi.setActiveTools = (next: string[]) => {
      if (next.includes("staff_list"))
        throw new Error("Chief tool activation failed");
      setActiveTools(next);
    };

    await pi.commandOptions.get("chief").handler("", context);

    assert.deepEqual(pi.pi.getActiveTools(), ordinaryTools);
    assert.deepEqual(notices, ["Chief tool activation failed"]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("selecting a pre-Chief branch restores the Lead lifecycle", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-start-restore-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  const baseline = pi.pi.getActiveTools();
  const preChiefBranch = [...entries];
  assert.equal(
    sessionLeadRoleState(preChiefBranch, sessionOwnership(context.sessionManager)),
    undefined,
  );
  await pi.commandOptions.get("chief").handler("", context);
  assert.equal(
    readPeerLeadRecord(peerRuntime(), context.sessionManager.getSessionId()),
    undefined,
  );
  context.sessionManager.getBranch = () => preChiefBranch;
  const appendEntry = pi.pi.appendEntry;
  pi.pi.appendEntry = (type: string, data: unknown) => {
    appendEntry(type, data);
    preChiefBranch.push({ type: "custom", customType: type, data });
  };
  pi.pi.setActiveTools(baseline);
  await pi.events.get("session_tree")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  const replacement = claimChiefLease({
    piSessionId: "replacement-session",
    paneId: "replacement-pane",
    tabId: "replacement-tab",
    workspaceId: WORKSPACE,
  });
  replacement.release();
  assert.equal(
    sessionLeadRoleState(
      context.sessionManager.getBranch(),
      sessionOwnership(context.sessionManager),
    )?.role,
    "lead",
  );
  assert.ok(
    readPeerLeadRecord(peerRuntime(), context.sessionManager.getSessionId()),
  );
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
});

test("selecting a historical Chief branch activates its lease and staff tools", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `chief-branch-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    const baseline = pi.pi.getActiveTools();
    const chiefBranch = [
      {
        type: "custom",
        customType: "pi-herdsman-role",
        data: { role: "chief", leadTools: baseline },
      },
    ];
    context.sessionManager.getBranch = () => chiefBranch;
    await pi.events.get("session_tree")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), [
      "staff_list",
      "staff_inspect",
      "staff_transcript",
      "staff_message",
    ]);
    assert.equal(
      readPeerLeadRecord(peerRuntime(), context.sessionManager.getSessionId()),
      undefined,
    );
    assert.throws(() =>
      claimChiefLease({
        piSessionId: "replacement-session",
        paneId: "replacement-pane",
        tabId: "replacement-tab",
        workspaceId: WORKSPACE,
      }),
    );
    assert.equal(
      sessionLeadRoleState(entries, sessionOwnership(context.sessionManager))
        ?.role,
      "chief",
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
  }
});

test("malformed selected branch withdraws stale Chief authority", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `malformed-branch-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  try {
    await pi.events.get("session_start")![0](undefined, context);
    await pi.commandOptions.get("chief").handler("", context);
    context.sessionManager.getBranch = () => [
      {
        type: "custom",
        customType: "pi-herdsman-role",
        data: { role: "chief" },
      },
    ];
    pi.pi.setActiveTools(["read", "bash"]);
    await pi.events.get("session_tree")![0](undefined, context);
    assert.equal(pi.pi.getActiveTools().includes("staff_list"), false);
    assert.ok(
      entries.some(
        (entry: any) => entry.customType === "pi_herdsman_role_error",
      ),
    );
    const replacement = claimChiefLease({
      piSessionId: "replacement-session",
      paneId: "replacement-pane",
      tabId: "replacement-tab",
      workspaceId: WORKSPACE,
    });
    replacement.release();
    assert.equal(
      readPeerLeadRecord(peerRuntime(), context.sessionManager.getSessionId()),
      undefined,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
  }
});

test("manual chief leave completes lead cleanup when tool restoration fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-leave-restore-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  const baseline = pi.pi.getActiveTools();
  await pi.commandOptions.get("chief").handler("", context);
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.join("|") === baseline.join("|")) {
      failRestore = false;
      throw new Error("manual leave restoration failed");
    }
    setActiveTools(next);
  };

  await pi.commandOptions.get("chief").handler("leave", context);

  assert.deepEqual(pi.pi.getActiveTools(), [
    "staff_list",
    "staff_inspect",
    "staff_transcript",
    "staff_message",
  ]);
  assert.deepEqual(
    entries
      .filter((entry: any) => entry.customType === "pi-herdsman-role")
      .at(-1)?.data,
    {
      role: "lead",
      leadTools: baseline,
      sessionId: context.sessionManager.getSessionId(),
    },
  );
  const lease = claimChiefLease({
    piSessionId: context.sessionManager.getSessionId(),
    paneId: "chief-pane",
    tabId: "chief-tab",
    workspaceId: WORKSPACE,
  });
  lease.release();
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("lead session-start retries an exact baseline after restoration fails", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-lead-restore-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    setLeadEnvironment();
  });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  const start = pi.events.get("session_start")![0];
  await start(undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  const baseline = [
    "read",
    "bash",
    "agent_list",
    "agent_delegate",
    "agent_continue",
    "agent_steer",
    "agent_interrupt",
    "agent_reply",
    "agent_complete",
    "agent_close",
    "agent_inspect",
    "agent_transcript",
    "agent_extend",
    "supervisor_message",
    "peer_list",
    "peer_message",
  ];
  entries.push({
    type: "custom",
    customType: "pi-herdsman-role",
    data: { role: "lead", leadTools: baseline },
  });
  const setActiveTools = pi.pi.setActiveTools;
  let failRestore = true;
  pi.pi.setActiveTools = (next: string[]) => {
    if (failRestore && next.join("|") === baseline.join("|")) {
      failRestore = false;
      throw new Error("lead session-start restoration failed");
    }
    setActiveTools(next);
  };

  await start(undefined, context);

  assert.deepEqual(pi.pi.getActiveTools(), [
    "staff_list",
    "staff_inspect",
    "staff_transcript",
    "staff_message",
  ]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi_herdsman_role_error" &&
        entry.data.error.includes("lead session-start restoration failed"),
    ),
  );
  await start(undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), baseline);
});

test("lead session-start continues when chief lease release fails", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-release-failure-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const pi = fakeChiefPi({ activeTools: ["read", "bash"], entries });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  const start = pi.events.get("session_start")![0];
  await start(undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  entries.push({
    type: "custom",
    customType: "pi-herdsman-role",
    data: {
      role: "lead",
      leadTools: [
        "read",
        "bash",
        "agent_list",
        "agent_delegate",
        "agent_continue",
        "agent_steer",
        "agent_interrupt",
        "agent_reply",
        "agent_complete",
        "agent_close",
        "agent_inspect",
        "agent_transcript",
        "agent_extend",
        "supervisor_message",
        "peer_list",
        "peer_message",
      ],
    },
  });
  const runtime = supervisionRuntime();
  const owner = realFs.readdirSync(runtime.lock)[0];
  assert.ok(owner);
  realFs.writeFileSync(join(runtime.lock, owner), "{}");

  await start(undefined, context);

  assert.deepEqual(pi.pi.getActiveTools(), [
    "read",
    "bash",
    "agent_list",
    "agent_delegate",
    "agent_continue",
    "agent_steer",
    "agent_interrupt",
    "agent_reply",
    "agent_complete",
    "agent_close",
    "agent_inspect",
    "agent_transcript",
    "agent_extend",
    "supervisor_message",
    "peer_list",
    "peer_message",
  ]);
  assert.ok(
    entries.some(
      (entry: any) =>
        entry.customType === "pi_herdsman_role_error" &&
        entry.data.error.includes(
          "Unable to verify Chief supervision lease ownership",
        ),
    ),
  );
  await pi.events.get("session_shutdown")?.[0]();
  realFs.rmSync(runtime.root, { recursive: true, force: true });
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
});

test("Chief activation rejects owned work outside the current workspace", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const foreignWorkspace = `foreign-${randomUUID()}`;
  const mailbox = agentMailboxPath(foreignWorkspace, "foreign-agent");
  writeAgentState(mailbox, {
    ...managedState("foreign-agent"),
    workspaceId: foreignWorkspace,
    ownerSessionId: LEAD_SESSION_ID,
  });
  const pi = fakePi({
    exec: (_command, args) =>
      isAgentList(args)
        ? {
            stdout: JSON.stringify({ id: AGENT_ID, result: { agents: [] } }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  const context = fakeContext() as any;
  const notices: string[] = [];
  context.ui.notify = (message: string) => notices.push(message);
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  assert.ok(notices.some((message) => /owned agent work exists/.test(message)));
  realFs.rmSync(mailbox, { recursive: true, force: true });
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  setLeadEnvironment();
});

test("lead agents command uses native completion and exact human grammar", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  assert.deepEqual(
    pi.entryRenderers.map((entry) => entry.customType),
    ["pi-herdsman-agent-definitions", "pi-herdsman-herd-run"],
  );
  assert.ok(
    pi.messageRenderers.some(
      (message) => message.customType === "pi-herdsman-stop-summary",
    ),
  );
  const command = pi.commandOptions.get("agents");
  assert.ok(command);
  const alias = pi.commandOptions.get("herdsman");
  assert.ok(alias);
  assert.equal(alias.description, "Alias for /agents");
  assert.equal(alias.handler, command.handler);
  assert.equal(alias.getArgumentCompletions, command.getArgumentCompletions);
  assert.deepEqual(command.getArgumentCompletions(""), [
    { value: "stats", label: "stats" },
    { value: "definitions", label: "definitions" },
    { value: "placement", label: "placement" },
    { value: "stop", label: "stop" },
  ]);
  assert.deepEqual(
    alias.getArgumentCompletions(""),
    command.getArgumentCompletions(""),
  );
  assert.deepEqual(command.getArgumentCompletions("placement "), [
    { value: "placement tab", label: "tab" },
    { value: "placement subtree", label: "subtree" },
    { value: "placement split", label: "split" },
  ]);
  assert.deepEqual(command.getArgumentCompletions("placement s"), [
    { value: "placement subtree", label: "subtree" },
    { value: "placement split", label: "split" },
  ]);
  const context = fakeContext([]) as any;
  context.hasUI = true;
  const notices: string[] = [];
  context.ui.select = async () => undefined;
  context.ui.notify = (message: string) => notices.push(message);
  await command.handler("", context);
  await command.handler("agents extra", context);
  await command.handler("placement invalid", context);
  assert.deepEqual(notices, [
    "Usage: /agents stats | definitions | placement [tab|subtree|split] | stop",
    "Usage: /agents placement [tab|subtree|split]",
  ]);
});

test("a configured disable list removes a definition from the offered roster", async () => {
  setLeadEnvironment();
  const configDir = join(PI_AGENT_ROOT, "pi-herdsman");
  realFs.mkdirSync(configDir, { recursive: true });
  realFs.writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ disabledDefinitions: ["scout"] }),
  );
  try {
    const roster = await visibleAgentDefinitionMetadata(
      fakeContext() as any,
      { kind: "lead" },
    );
    assert.equal(
      roster.some((definition) => definition.name === "scout"),
      false,
    );
    assert.equal(
      roster.some((definition) => definition.name === "researcher"),
      true,
    );
  } finally {
    realFs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("/agents placement subtree writes flat config outside project settings", async () => {
  setLeadEnvironment();
  const projectRoot = join(PI_AGENT_ROOT, "placement-project");
  const configPath = join(PI_AGENT_ROOT, "pi-herdsman", "config.json");
  realFs.mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.cwd = projectRoot;
  context.hasUI = true;
  try {
    await pi.commandOptions.get("agents").handler("placement subtree", context);
    assert.equal(
      JSON.parse(realFs.readFileSync(configPath, "utf8")).spawnPlacement,
      "subtree",
    );
    assert.equal(
      realFs.existsSync(join(projectRoot, ".pi", "settings.json")),
      false,
    );
  } finally {
    realFs.rmSync(projectRoot, { recursive: true, force: true });
    realFs.rmSync(join(PI_AGENT_ROOT, "pi-herdsman"), {
      recursive: true,
      force: true,
    });
  }
});

test("Chief activation replaces the lead widget and overview selection is interactive", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const lead = {
    agent: "pi",
    pane_id: "lead-pane",
    tab_id: "lead-tab",
    workspace_id: WORKSPACE,
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: PARENT_SESSION_ID,
    },
    tokens: { pi_herdsman_role: "lead" },
  };
  const leads = [lead];
  const entries: unknown[] = [];
  const pi = fakeChiefPi({
    activeTools: ["read"],
    autoActivateRegisteredTools: true,
    entries,
    exec: (_command, args) => {
      if (args[0] === "worktree" && args[1] === "list")
        return nonGitWorkspaceResponse();
      if (isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: { agents: leads, panes: leads } },
          }),
          stderr: "",
          code: 0,
        };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result: { agents: leads } }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result: { agent: lead } }),
          stderr: "",
          code: 0,
        };
      return {
        stdout: JSON.stringify({ id: AGENT_ID, result: {} }),
        stderr: "",
        code: 0,
      };
    },
  });
  const context = fakeContext(entries) as any;
  context.hasUI = true;
  const widgetKeys: string[] = [];
  const notices: string[] = [];
  let overview: any;
  let overviewDone = 0;
  let customCalls = 0;
  context.ui = {
    setStatus: () => undefined,
    setWidget: (key: string) => widgetKeys.push(key),
    notify: (message: string) => notices.push(message),
    confirm: async () => false,
    select: async () => undefined,
    custom: async (factory: any) => {
      customCalls++;
      overview = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        () => overviewDone++,
      );
    },
  };
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: TimerHandler) => {
    const timer = originalSetInterval(callback as () => void, 60_000);
    timer.unref?.();
    return timer;
  }) as typeof setInterval;
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
    globalThis.setInterval = originalSetInterval;
    delete process.env.HERDR_SOCKET_PATH;
    setLeadEnvironment();
  });
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), ["read", ...leadTools]);
  await pi.commandOptions.get("chief").handler("", context);
  assert.deepEqual(pi.pi.getActiveTools(), chiefTools);
  assert.ok(widgetKeys.includes("pi-herdsman"));
  assert.ok(widgetKeys.includes("pi-herdsman-staff"));
  assert.equal(
    pi.commandOptions.get("chief").description,
    "Activate chief mode, or open its overview when already active",
  );
  assert.equal(customCalls, 0);
  await pi.commandOptions.get("chief").handler("", context);
  assert.deepEqual(pi.pi.getActiveTools(), chiefTools);
  assert.equal(customCalls, 1);
  assert.ok(overview);
  assert.match(overview.render(120).join("\n"), /Pi Herdsman ·/);
  assert.doesNotMatch(overview.render(120).join("\n"), /Pi Chief/);
  assert.doesNotMatch(overview.render(120).join("\n"), /├─|└─/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(overview.render(120).every((line: string) => line.length <= 120));
  const customCallsBeforePeek = customCalls;
  overview.handleInput(" ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(customCalls, customCallsBeforePeek);
  overview.handleInput("\u001b");
  assert.equal(overviewDone, 1);
  await pi.commandOptions.get("chief").handler("", context);
  overview.handleInput(" ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  overview.handleInput(" ");
  assert.equal(overviewDone, 1);
  await pi.commandOptions.get("chief").handler("", context);
  overview.handleInput(" ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  overview.handleInput("\u0003");
  assert.equal(overviewDone, 2);
  overview.handleInput("\u001b[B");
  overview.handleInput("\r");
  await t.waitFor(() => assert.equal(overviewDone, 2, notices.join(" | ")));
});

test("Lead resume repairs stale staff from its durable displaced loadout", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-reload-${randomUUID()}.sock`,
  );
  const entries: unknown[] = [];
  const ordinaryTools = [
    "read",
    "bash",
    "agent_list",
    "agent_delegate",
    "agent_continue",
    "agent_steer",
    "agent_interrupt",
    "agent_reply",
    "agent_complete",
    "agent_close",
    "agent_inspect",
    "agent_transcript",
    "agent_extend",
    "supervisor_message",
    "peer_list",
    "peer_message",
  ];
  const pi = fakeChiefPi({
    activeTools: ordinaryTools,
    entries,
  });
  const context = fakeContext(entries) as any;
  context.mode = "rpc";
  context.ui.notify = () => undefined;
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  assert.deepEqual(pi.pi.getActiveTools(), [
    "staff_list",
    "staff_inspect",
    "staff_transcript",
    "staff_message",
  ]);

  await pi.commandOptions.get("chief").handler("leave", context);
  assert.deepEqual(pi.pi.getActiveTools(), ordinaryTools);
  const role = entries
    .filter((entry: any) => entry.customType === "pi-herdsman-role")
    .at(-1) as any;
  assert.deepEqual(role.data, {
    role: "lead",
    leadTools: ordinaryTools,
    sessionId: context.sessionManager.getSessionId(),
  });

  const reloaded = fakeChiefPi({
    activeTools: [
      "staff_list",
      "staff_inspect",
      "staff_transcript",
      "staff_message",
    ],
    entries: [...entries],
  });
  const reloadedContext = fakeContext(reloaded.entries) as any;
  reloadedContext.mode = "rpc";
  reloadedContext.ui.notify = () => undefined;
  registerExtension!(reloaded.pi as never);
  await reloaded.events.get("session_start")![0](undefined, reloadedContext);
  assert.deepEqual(reloaded.pi.getActiveTools(), ordinaryTools);

  await reloaded.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
});

test("ordinary branch tool state wins over an older lead checkpoint", async () => {
  setLeadEnvironment();
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: {
        role: "lead",
        leadTools: [
          "read",
          "bash",
          "agent_list",
          "agent_delegate",
          "agent_continue",
          "agent_steer",
          "agent_interrupt",
          "agent_reply",
          "agent_complete",
          "agent_close",
          "agent_inspect",
          "agent_transcript",
          "agent_extend",
          "supervisor_message",
          "peer_list",
          "peer_message",
        ],
      },
    },
  ];
  const branchTools = [
    "read",
    "grep",
    "agent_list",
    "agent_delegate",
    "agent_continue",
    "agent_steer",
    "agent_interrupt",
    "agent_reply",
    "agent_complete",
    "agent_close",
    "agent_inspect",
    "agent_transcript",
    "agent_extend",
    "supervisor_message",
    "peer_list",
    "peer_message",
  ];
  const pi = fakeChiefPi({ entries, activeTools: branchTools });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), branchTools);
  await pi.events.get("session_shutdown")?.[0]();
});

async function openChiefOverview(
  populated: boolean,
  options: {
    failSetWidget?: boolean;
    failRender?: boolean;
    failRefresh?: boolean;
    openOverview?: boolean;
  } = {},
) {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-tui-${randomUUID()}.sock`,
  );
  radarDaemon.options.inventory = observedFleet(
    populated ? [observedLead("lead-pane")] : [],
  );
  radarDaemon.options.observeUnavailable = options.failRefresh ?? false;
  const pi = fakeChiefPi({
    activeTools: ["agent", "chief", "read"],
    entries: [],
    // The focus action proves the lead against Herdr's agent list before Radar
    // re-proves it, so the list must still carry the lead's row.
    exec: (_command, args) =>
      populated && isAgentList(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: { agents: [herdrLeadRow] },
            }),
            stderr: "",
            code: 0,
          }
        : undefined,
  });
  const context = fakeContext([]) as any;
  context.hasUI = true;
  let component: any;
  let customCalls = 0;
  let doneCalls = 0;
  let renderRequests = 0;
  const widgetRegistrations: Array<{ key: string; content: unknown }> = [];
  context.ui = {
    setStatus: () => undefined,
    setWidget: (key: string, content: unknown) => {
      if (options.failSetWidget && key === "pi-herdsman-staff")
        throw new Error("widget registration failed");
      widgetRegistrations.push({ key, content });
      if (content !== undefined) assert.equal(typeof content, "function");
      if (typeof content === "function")
        component = content(
          {
            requestRender: () => {
              if (options.failRender) throw new Error("render failed");
              renderRequests++;
            },
          },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
    notify: () => undefined,
    confirm: async () => false,
    select: async () => undefined,
    custom: async (factory: any) => {
      customCalls++;
      component = factory(
        { requestRender: () => renderRequests++ },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        () => doneCalls++,
      );
    },
  };
  registerExtension!(pi.pi as never);
  await pi.events.get("session_start")![0](undefined, context);
  await pi.commandOptions.get("chief").handler("", context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (populated)
    writeLeadCoordinationState(supervisionRuntime(), {
      version: 1,
      instanceId: randomUUID(),
      piSessionId: PARENT_SESSION_ID,
      updatedAt: Date.now(),
    });
  if (options.openOverview !== false)
    await pi.commandOptions.get("chief").handler("", context);
  // The overview draws the last supervision snapshot, which a chief loads in
  // the background, so the harness waits for that first load to land rather than
  // leaving every caller to race it.
  for (
    let tick = 0;
    tick < 200 &&
    component !== undefined &&
    /unavailable/.test(component.render(120).join("\n"));
    tick++
  )
    await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    pi,
    context,
    component,
    get customCalls() {
      return customCalls;
    },
    get doneCalls() {
      return doneCalls;
    },
    get renderRequests() {
      return renderRequests;
    },
    setFailRefresh(value: boolean) {
      radarDaemon.options.observeUnavailable = value;
    },
    widgetRegistrations,
    async cleanup() {
      await pi.events.get("session_shutdown")?.[0]();
      delete process.env.HERDR_SOCKET_PATH;
      delete process.env.HERDR_TAB_ID;
      setLeadEnvironment();
    },
  };
}

/**
 * A Radar control socket the extension can dial for real: one connection per
 * call, one JSON line in and one out. The answer returns `{ result }` or
 * `{ error }` for the caller's request id, or `undefined` to stay silent.
 */
function fakeRadarControlPlane(answer: (request: any) => unknown) {
  const root = mkdtempSync(join(tmpdir(), "radar-control-plane-"));
  const directory = join(root, "socket");
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, "control.sock");
  const requests: any[] = [];
  const server = createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffered.slice(0, end));
      requests.push(request);
      const answerBody = answer(request);
      if (answerBody !== undefined)
        socket.write(`${JSON.stringify({ id: request.id, ...answerBody })}\n`);
    });
    socket.on("error", () => undefined);
  });
  // A test daemon must never be the reason a suite cannot exit: a test that
  // fails before it can hand out this daemon's cleanup must not hold the run
  // open on a listening socket.
  server.unref();
  return {
    path,
    requests,
    /** How many focus operations the daemon was asked to dispatch. */
    focusCount: () =>
      requests.filter((request) => request.method === "mux.focus").length,
    async listen() {
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.removeListener("error", reject);
          resolveListen();
        });
      });
    },
    async close() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * One agent row of a fresh observation, in the shape the daemon reports it: the
 * location it sits in, the session it claims, and the lifecycle the daemon read
 * for it. A row that reports no lifecycle is a child the daemon could not say
 * anything about, which is a different observation from a working one.
 */
const observedAgent = (request: {
  paneId: string;
  tabId: string;
  session: unknown;
  status?: "idle" | "working" | "blocked" | "done";
}) => ({
  location: {
    workspace_id: WORKSPACE,
    tab_id: request.tabId,
    pane_id: request.paneId,
  },
  ...(request.status !== undefined ? { status: request.status } : {}),
  session: request.session,
});

/** The Herdr agent-list row the focus action's identity proof reads for the lead. */
const herdrLeadRow = {
  agent_session: {
    source: "herdr:pi",
    agent: "pi",
    kind: "id",
    value: PARENT_SESSION_ID,
  },
  pane_id: "lead-pane",
  tab_id: "lead-tab",
  workspace_id: WORKSPACE,
};

/** The Radar inventory a fresh observation must place the supervised lead on. */
const observedLead = (paneId: string) =>
  observedAgent({
    paneId,
    tabId: "lead-tab",
    session: { kind: "uuid", value: PARENT_SESSION_ID },
  });

/**
 * The canonical fleet a live daemon answers `mux.observe` with: every pane, tab
 * and workspace an agent row sits in is reported beside it, and a reply that
 * omits any of the four collections is refused outright rather than read as an
 * empty fleet.
 */
const observedFleet = (agents: unknown[]) => {
  const locations = agents
    .map((agent) => (agent as { location?: Record<string, string> }).location)
    .filter((location): location is Record<string, string> => location !== undefined);
  const unique = <T>(values: T[], key: (value: T) => string) => [
    ...new Map(values.map((value) => [key(value), value])).values(),
  ];
  return {
    workspaces: unique(
      locations.map(({ workspace_id }) => ({ workspace_id })),
      (workspace) => workspace.workspace_id,
    ),
    tabs: unique(
      locations.map(({ tab_id, workspace_id }) => ({ tab_id, workspace_id })),
      (tab) => `${tab.workspace_id}\0${tab.tab_id}`,
    ),
    panes: unique(
      locations.map((location) => ({ location })),
      (pane) =>
        `${pane.location.workspace_id}\0${pane.location.tab_id}\0${pane.location.pane_id}`,
    ),
    agents,
  };
};

const radarPing = (
  contracts: string[],
  backend = "herdr",
) => ({
  result: {
    protocol: 2,
    revision: 1,
    backend,
    instance: null,
    contracts,
    tasks: { available: true, error: null },
  },
});

const focusRecord = (request: any) => ({
  result: {
    request: {
      id: request.id,
      method: "mux.focus",
      state: "completed",
      outcome: "completed",
    },
  },
});

/**
 * The panes the daemon has recorded a close for, in the order it closed them. A
 * Radar-managed close is the daemon's own effect, so the daemon's record is what
 * a test observes instead of a fixture's imitation of a mux. A refused close
 * carries no pane and is left out.
 */
const closedPanes = () =>
  [...radarDaemon.closes.values()]
    .filter((close) => close.pane !== undefined)
    .map((close) => close.pane);

/**
 * Serve a fake Radar control plane whose fresh observation reports `inventory`,
 * and point the extension at it. Registry publication shares this socket; it is
 * not what these tests prove.
 */
async function serveFakeRadar(
  inventory: unknown[] | (() => unknown[]),
  socketPath?: string,
) {
  const daemon = fakeRadarControlPlane((request) => {
    if (request.method === "daemon.ping")
      return radarPing(["registry.v1", "mux.observe", "mux.focus"]);
    if (request.method === "mux.observe")
      return {
        result: {
          inventory: observedFleet(
            typeof inventory === "function" ? inventory() : inventory,
          ),
        },
      };
    if (request.method === "mux.focus") return focusRecord(request);
    return {
      error: { code: "refused", message: "registry is not exercised here" },
    };
  });
  await daemon.listen();
  process.env.RADAR_CONTROL_SOCKET = socketPath ?? daemon.path;
  return daemon;
}

/**
 * Drive the live supervised-lead focus action: load the overview from `loaded`,
 * then change what the daemon observes (`changed`) and press Enter, exactly as
 * an operator does. The focus takes a fresh observation of its own, so a change
 * made after the herd loaded is what it has to refuse. Then wait for the action
 * to settle (a notice or a closed overview).
 */
async function focusLeadFromOverview(
  loaded: unknown[],
  changed: { inventory?: unknown[]; socketPath?: string } = {},
) {
  let observed = loaded;
  const daemon = await serveFakeRadar(() => observed);
  const harness = await openChiefOverview(true);
  const notices: string[] = [];
  harness.context.ui.notify = (message: string) => notices.push(message);
  // The overview draws the last supervision snapshot, and a chief refreshes it
  // at the start of a turn, so the herd is loaded the way Pi loads it rather
  // than by waiting on the two-second timer.
  await harness.pi.events.get("before_agent_start")![0](
    { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
    harness.context,
  );
  assert.match(harness.component.render(120).join("\n"), /1 herd/);
  observed = changed.inventory ?? loaded;
  if (changed.socketPath !== undefined)
    process.env.RADAR_CONTROL_SOCKET = changed.socketPath;
  harness.component.handleInput("\r");
  for (let tick = 0; tick < 100; tick++) {
    if (notices.length > 0 || harness.doneCalls > 0) break;
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  }
  return {
    daemon,
    harness,
    notices,
    async cleanup() {
      await harness.cleanup();
      await ensureRadarDaemon();
      await daemon.close();
    },
  };
}

test("supervised lead focus dispatches through the Radar control plane", async () => {
  const focus = await focusLeadFromOverview([observedLead("lead-pane")]);
  try {
    assert.deepEqual(focus.notices, []);
    assert.deepEqual(
      focus.daemon.requests
        .filter((request) => request.method === "mux.focus")
        .map((request) => request.params),
      [
        {
          target: "lead-pane",
          target_kind: "pane",
          requester: "pi-herdsman",
        },
      ],
    );
    const methods = focus.daemon.requests.map((request) => request.method);
    assert.ok(
      methods.includes("mux.observe") &&
        methods.lastIndexOf("mux.observe") < methods.indexOf("mux.focus"),
      "the focus re-proves the lead from a fresh observation",
    );
    assert.deepEqual(
      focus.harness.pi.calls.filter(
        (args) => args[0] === "agent" && args[1] === "focus",
      ),
      [],
    );
    assert.equal(focus.harness.doneCalls, 1);
  } finally {
    await focus.cleanup();
  }
});

test("a changed, moved, or duplicated observed identity focuses nothing", async () => {
  for (const changed of [
    {
      inventory: [
        {
          ...observedLead("lead-pane"),
          session: { kind: "uuid", value: CHILD_SESSION_ID },
        },
      ],
    },
    { inventory: [observedLead("lead-pane"), observedLead("lead-pane")] },
    { inventory: [observedLead("other-pane")] },
  ]) {
    const focus = await focusLeadFromOverview(
      [observedLead("lead-pane")],
      changed,
    );
    try {
      // The lead was proven when the herd loaded; the fresh observation taken
      // at focus time no longer proves it, so the focus refuses before any
      // Radar focus is sent.
      assert.ok(
        focus.daemon.requests.some(
          (request) => request.method === "mux.observe",
        ),
        "the refusal came from the daemon's own observation",
      );
      assert.deepEqual(focus.notices, ["Lead changed; reopen staff."]);
      assert.equal(focus.daemon.focusCount(), 0);
      assert.equal(focus.harness.doneCalls, 0);
      assert.deepEqual(
        focus.harness.pi.calls.filter(
          (args) => args[0] === "agent" && args[1] === "focus",
        ),
        [],
      );
    } finally {
      await focus.cleanup();
    }
  }
});

test("a lost focus reply is read back by operation id and never resent", async () => {
  const daemon = fakeRadarControlPlane((request) => {
    if (request.method === "daemon.ping")
      return radarPing(["registry.v1", "mux.observe", "mux.focus"]);
    if (request.method === "mux.observe")
      return { result: { inventory: observedFleet([observedLead("lead-pane")]) } };
    if (request.method === "mux.focus")
      return {
        error: { code: "internal", message: "the daemon lost the reply" },
      };
    if (request.method === "mux.request.get")
      return { error: { code: "not_found", message: "no record" } };
    return {
      error: { code: "refused", message: "registry is not exercised here" },
    };
  });
  await daemon.listen();
  process.env.RADAR_CONTROL_SOCKET = daemon.path;
  const harness = await openChiefOverview(true);
  const notices: string[] = [];
  harness.context.ui.notify = (message: string) => notices.push(message);
  try {
    // A chief refreshes the herd at the start of a turn, which is when the
    // overview has a snapshot to draw and act on.
    await harness.pi.events.get("before_agent_start")![0](
      { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
      harness.context,
    );
    harness.component.render(120);
    harness.component.handleInput("\r");
    for (let tick = 0; tick < 100 && notices.length === 0; tick++)
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    assert.equal(daemon.focusCount(), 1);
    assert.equal(
      daemon.requests.find((request) => request.method === "mux.request.get")?.params.id,
      daemon.requests.find((request) => request.method === "mux.focus")?.id,
    );
    assert.equal(notices.length, 1);
    assert.match(
      notices[0]!,
      /^Radar did not confirm the focus \(focus [0-9a-f-]{36} is unresolved \(internal: the daemon lost the reply; the daemon holds no record of it\)\); the lead may already be focused\.$/u,
    );
    assert.equal(harness.doneCalls, 0);
    assert.deepEqual(
      harness.pi.calls.filter(
        (args) => args[0] === "agent" && args[1] === "focus",
      ),
      [],
    );
  } finally {
    await harness.cleanup();
    await ensureRadarDaemon();
    await daemon.close();
  }
});

// An unreadable observation is stale, never an empty fleet: an empty fleet
// would read as "Lead changed", so the exact notice is the regression guard.
test("an unavailable Radar observation refuses the focus rather than reading as an empty fleet", async () => {
  const focus = await focusLeadFromOverview([observedLead("lead-pane")], {
    socketPath: join(PI_AGENT_ROOT, `absent-radar-${randomUUID()}`, "control.sock"),
  });
  try {
    assert.equal(focus.daemon.focusCount(), 0);
    assert.deepEqual(focus.notices, [
      "The daemon's fleet observation is unavailable",
    ]);
    assert.deepEqual(
      focus.harness.pi.calls.filter(
        (args) => args[0] === "agent" && args[1] === "focus",
      ),
      [],
    );
    assert.equal(focus.harness.doneCalls, 0);
  } finally {
    await focus.cleanup();
  }
});

test("a daemon without the focus capability refuses and is never sent a focus", async () => {
  const daemon = fakeRadarControlPlane((request) => {
    if (request.method === "daemon.ping")
      return radarPing(["registry.v1", "mux.observe"]);
    if (request.method === "mux.observe")
      return { result: { inventory: observedFleet([observedLead("lead-pane")]) } };
    return { error: { code: "refused", message: "registry is not exercised here" } };
  });
  await daemon.listen();
  process.env.RADAR_CONTROL_SOCKET = daemon.path;
  const harness = await openChiefOverview(true);
  const notices: string[] = [];
  harness.context.ui.notify = (message: string) => notices.push(message);
  try {
    // A chief refreshes the herd at the start of a turn, which is when the
    // overview has a snapshot to draw and act on.
    await harness.pi.events.get("before_agent_start")![0](
      { systemPrompt: "base", systemPromptOptions: { contextFiles: [] } },
      harness.context,
    );
    harness.component.render(120);
    harness.component.handleInput("\r");
    for (let tick = 0; tick < 100 && notices.length === 0; tick++)
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    assert.equal(daemon.focusCount(), 0);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /does not provide `mux\.focus`/u);
  } finally {
    await harness.cleanup();
    await ensureRadarDaemon();
    await daemon.close();
  }
});

test("registered chief widget obeys registration, refresh, and teardown contracts", async () => {
  const originalSetInterval = globalThis.setInterval;
  const callbacks: TimerHandler[] = [];
  globalThis.setInterval = ((callback: TimerHandler) => {
    callbacks.push(callback);
    return { unref: () => undefined } as any;
  }) as typeof setInterval;
  try {
    const harness = await openChiefOverview(false, {
      openOverview: false,
    });
    const registrations = harness.widgetRegistrations.filter(
      ({ key, content }) =>
        key === "pi-herdsman-staff" && content !== undefined,
    );
    assert.equal(registrations.length, 1);
    assert.equal(typeof registrations[0].content, "function");
    assert.equal(typeof harness.component.render, "function");
    assert.equal(typeof harness.component.invalidate, "function");
    const before = harness.renderRequests;
    (callbacks.at(-1) as () => void)();
    // The refresh reads the daemon over its socket before it repaints.
    for (let tick = 0; tick < 100 && harness.renderRequests === before; tick++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(harness.renderRequests > before);
    assert.equal(
      harness.widgetRegistrations.filter(
        ({ key, content }) =>
          key === "pi-herdsman-staff" && content !== undefined,
      ).length,
      1,
    );
    await harness.cleanup();
    const teardown = harness.widgetRegistrations.filter(
      ({ key, content }) =>
        key === "pi-herdsman-staff" && content === undefined,
    );
    assert.ok(teardown.length > 0);
    assert.equal(teardown.at(-1)?.content, undefined);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("Chief overview closes on native Escape and Ctrl+C with no herds", async () => {
  for (const key of ["\u001b", "\u0003"]) {
    const harness = await openChiefOverview(false);
    harness.component.handleInput(key);
    assert.equal(harness.doneCalls, 1);
    await harness.cleanup();
  }
});

test("Chief overview reports unavailable when its first refresh fails", async () => {
  const harness = await openChiefOverview(false, {
    failRefresh: true,
  });
  try {
    const output = harness.component.render(120).join("\n");
    assert.match(output, /Pi Herdsman · unavailable/);
    assert.doesNotMatch(output, /0 herds/);
  } finally {
    await harness.cleanup();
  }
});

test("Chief overview redraws identical herds when freshness changes", async () => {
  const originalSetInterval = globalThis.setInterval;
  const callbacks: TimerHandler[] = [];
  globalThis.setInterval = ((callback: TimerHandler) => {
    callbacks.push(callback);
    return { unref: () => undefined } as any;
  }) as typeof setInterval;
  try {
    const harness = await openChiefOverview(true);
    try {
      assert.match(harness.component.render(120).join("\n"), /1 herd/);
      assert.doesNotMatch(
        harness.component.render(120).join("\n"),
        /stale|unavailable/,
      );

      harness.setFailRefresh(true);
      (callbacks.at(-1) as () => void)();
      // The refresh reads the daemon's fleet before the widget repaints.
      for (
        let tick = 0;
        tick < 100 &&
        !/1 herd · stale/.test(harness.component.render(120).join("\n"));
        tick++
      )
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(harness.component.render(120).join("\n"), /1 herd · stale/);

      harness.setFailRefresh(false);
      (callbacks.at(-1) as () => void)();
      for (
        let tick = 0;
        tick < 100 &&
        /stale|unavailable/.test(harness.component.render(120).join("\n"));
        tick++
      )
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(harness.component.render(120).join("\n"), /1 herd/);
      assert.doesNotMatch(
        harness.component.render(120).join("\n"),
        /stale|unavailable/,
      );
    } finally {
      await harness.cleanup();
    }
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("Chief overview redraws after a background refresh", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeTimers = new Set<object>();
  let intervalCalls = 0;
  let refresh: (() => void) | undefined;
  globalThis.setInterval = ((callback: TimerHandler, _delay?: number) => {
    refresh = callback as () => void;
    intervalCalls++;
    const timer = { unref: () => undefined };
    activeTimers.add(timer);
    return timer as any;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: any) => {
    if (!activeTimers.delete(timer)) originalClearInterval(timer);
  }) as typeof clearInterval;
  try {
    const harness = await openChiefOverview(true);
    assert.equal(intervalCalls, 2);
    assert.equal(
      activeTimers.size,
      1,
      "one managed status refresh timer remains after replacing the old widget",
    );
    const before = harness.renderRequests;
    refresh!();
    // The refresh reads the daemon's fleet before it redraws, so the widget
    // repaints a few round trips after the timer fires.
    for (let tick = 0; tick < 100 && harness.renderRequests === before; tick++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(harness.renderRequests > before);
    await harness.cleanup();
    assert.equal(activeTimers.size, 0);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("persisted chief resume isolates tools and restores its ordinary baseline", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-resume-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: {
        role: "chief",
        leadTools: [
          "read",
          "bash",
          "foreign_tool",
          "agent_list",
          "agent_delegate",
          "agent_continue",
          "agent_steer",
          "agent_interrupt",
          "agent_reply",
          "agent_complete",
          "agent_close",
          "agent_inspect",
          "agent_transcript",
          "agent_extend",
          "supervisor_message",
          "peer_list",
          "peer_message",
        ],
      },
    },
  ];
  const pi = fakeChiefPi({
    entries,
    activeTools: ["read", "bash", "foreign_tool"],
    exec: (_command, args) =>
      isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: { agents: [], snapshot: { agents: [], panes: [] } },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  await pi.events.get("session_start")![0](undefined, context);
  assert.deepEqual(pi.pi.getActiveTools(), [
    "staff_list",
    "staff_inspect",
    "staff_transcript",
    "staff_message",
  ]);
  await pi.commandOptions.get("chief").handler("leave", context);
  assert.deepEqual(pi.pi.getActiveTools(), [
    "read",
    "bash",
    "foreign_tool",
    "agent_list",
    "agent_delegate",
    "agent_continue",
    "agent_steer",
    "agent_interrupt",
    "agent_reply",
    "agent_complete",
    "agent_close",
    "agent_inspect",
    "agent_transcript",
    "agent_extend",
    "supervisor_message",
    "peer_list",
    "peer_message",
  ]);
  await pi.events.get("session_shutdown")?.[0]();
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_TAB_ID;
  delete process.env.HERDR_PANE_ID;
  setLeadEnvironment();
});

test("persisted chief collision is suspended and has no lead authority", async () => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "lead-pane";
  process.env.HERDR_TAB_ID = "lead-tab";
  process.env.HERDR_SOCKET_PATH = join(
    tmpdir(),
    `supervision-${randomUUID()}.sock`,
  );
  const entries = [
    {
      type: "custom",
      customType: "pi-herdsman-role",
      data: {
        role: "chief",
        leadTools: [
          "agent_list",
          "agent_delegate",
          "agent_continue",
          "agent_steer",
          "agent_interrupt",
          "agent_reply",
          "agent_complete",
          "agent_close",
          "agent_inspect",
          "agent_transcript",
          "agent_extend",
          "supervisor_message",
        ],
      },
    },
  ];
  const incumbent = claimChiefLease({
    piSessionId: "incumbent-session",
    paneId: "incumbent-pane",
    tabId: "incumbent-tab",
    workspaceId: "incumbent-workspace",
  });
  try {
    const pi = fakeChiefPi({
      entries,
      activeTools: [
        "agent_list",
        "agent_delegate",
        "agent_continue",
        "agent_steer",
        "agent_interrupt",
        "agent_reply",
        "agent_complete",
        "agent_close",
        "agent_inspect",
        "agent_transcript",
        "agent_extend",
        "supervisor_message",
      ],
    });
    registerExtension!(pi.pi as never);
    const context = fakeContext(entries) as any;
    context.ui.notify = () => undefined;
    await pi.events.get("session_start")![0](undefined, context);
    assert.deepEqual(pi.pi.getActiveTools(), []);
    assert.equal(
      readLeadCoordinationState(
        supervisionRuntime(),
        context.sessionManager.getSessionId(),
      ),
      undefined,
    );
    await pi.events.get("session_shutdown")?.[0]();
  } finally {
    incumbent.release();
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_TAB_ID;
    setLeadEnvironment();
  }
});

test("plain agents opens the native management menu", async () => {
  setLeadEnvironment();
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { snapshot: { agents: [], panes: [] } },
          }),
          stderr: "",
          code: 0,
        };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: { workspace_id: WORKSPACE, agents: [] },
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result: { panes: [] } }),
          stderr: "",
          code: 0,
        };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (prompts.length === 1)
      return options.find((option) => option.startsWith("Layout"));
    return undefined;
  };
  await command.handler("", context);
  assert.equal(prompts[0]?.label, `Pi Herdsman · v${packageMetadata.version}`);
  assert.deepEqual(
    prompts[0]?.options.map((option) => option.replace(/\s+.*/u, "")),
    [
      "Running",
      "Session",
      "Definitions",
      "Layout",
      "Context",
      "Retain",
      "Soft",
      "Message",
      "Clear",
      "Stop",
    ],
  );
  assert.equal(prompts[1]?.label, "Layout");
  assert.deepEqual(prompts[1]?.options, [
    "Lead agents tab",
    "Subtree tabs",
    "Split from caller (current)",
  ]);
  await pi.events.get("session_shutdown")?.[0]();
});

test("agents TUI selectors use stable values and current preselection", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "tui";
  const configPath = join(PI_AGENT_ROOT, "pi-herdsman", "config.json");
  realFs.mkdirSync(join(PI_AGENT_ROOT, "pi-herdsman"), { recursive: true });
  realFs.writeFileSync(configPath, JSON.stringify({ spawnPlacement: "subtree" }));
  const renders: string[][] = [];
  let customCalls = 0;
  context.ui.custom = async (factory: any) =>
    new Promise((resolve) => {
      const component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        resolve,
      );
      renders.push(component.render(200));
      if (customCalls++ === 0) {
        component.handleInput("\u001b[B");
        component.handleInput("\u001b[B");
        component.handleInput("\u001b[B");
        component.handleInput("\r");
      } else if (customCalls === 2) component.handleInput("\r");
      else component.handleInput("\u001b");
    });
  try {
    await pi.commandOptions.get("agents").handler("", context);
    assert.ok(
      renders[0]?.some((line) =>
        line.includes(`Pi Herdsman · v${packageMetadata.version}`),
      ),
    );
    assert.ok(
      renders[1]?.some((line) => /Subtree tabs \(current\)/u.test(line)),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(configPath, { force: true });
  }
});

const selectTuiItem = (component: any, target: string): void => {
  for (let attempts = 0; attempts < 100; attempts++) {
    const selected = component
      .render(200)
      .find((line: string) => line.trimStart().startsWith("→"));
    if (selected?.includes(target)) {
      component.handleInput("\r");
      return;
    }
    component.handleInput("\u001b[B");
  }
  throw new Error(`TUI item was not selected: ${target}`);
};

test("definition pickers preselect configured values and honor cancellation", async () => {
  for (const scenario of [
    {
      field: "Model",
      picker: "Inherit current session",
      property: "model",
      source: "---\nname: preselect-agent\n---\n",
      expected: undefined,
    },
    {
      field: "Model",
      picker: "model",
      property: "model",
      source: "---\nname: preselect-agent\nmodel: provider/model\n---\n",
      expected: "provider/model",
    },
    {
      field: "Model",
      picker: "model",
      filter: " ",
      property: "model",
      source: "---\nname: preselect-agent\nmodel: provider/model\n---\n",
      expected: "provider/model",
    },
    {
      field: "Thinking",
      picker: "Inherit current session",
      property: "thinking",
      source: "---\nname: preselect-agent\n---\n",
      expected: undefined,
    },
    {
      field: "Thinking",
      picker: "high",
      property: "thinking",
      source: "---\nname: preselect-agent\nthinking: high\n---\n",
      expected: "high",
    },
    {
      field: "Model",
      picker: undefined,
      property: "model",
      source: "---\nname: preselect-agent\n---\n",
      expected: undefined,
    },
  ] as const) {
    setLeadEnvironment();
    const definitionPath = join(PI_AGENTS_DIR, "preselect-agent.md");
    realFs.writeFileSync(definitionPath, scenario.source);
    const pi = fakePi();
    registerExtension!(pi.pi as never);
    const context = fakeContext() as any;
    context.hasUI = true;
    context.mode = "tui";
    context.modelRegistry = {
      refresh: async () => undefined,
      getAll: () => [{ provider: "provider", id: "model", reasoning: true }],
      getAvailable: () => [
        { provider: "provider", id: "model", reasoning: true },
      ],
    };
    let customCalls = 0;
    const keybindings = {
      matches: (data: string, key: string) =>
        ({
          "tui.select.up": "\u001b[A",
          "tui.select.down": "\u001b[B",
          "tui.select.confirm": "\r",
          "tui.select.cancel": "\u001b",
        })[key] === data,
    };
    context.ui.custom = async (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          keybindings,
          resolve,
        );
        const call = customCalls++;
        if (call === 0) {
          selectTuiItem(component, "preselect-agent");
        } else if (call === 1) {
          selectTuiItem(component, scenario.field);
        } else if (call === 2 && scenario.picker !== undefined) {
          if ("filter" in scenario && scenario.filter !== undefined)
            for (const character of scenario.filter)
              component.handleInput(character);
          const line = component
            .render(200)
            .find((candidate: string) => candidate.includes(scenario.picker));
          assert.match(line ?? "", /^→/u);
          component.handleInput("\r");
        } else component.handleInput("\u001b");
      });
    try {
      await pi.commandOptions.get("agents").handler("definitions", context);
      assert.equal(customCalls, 5, JSON.stringify(scenario));
      assert.equal(
        discoverAgent("preselect-agent").frontmatter[scenario.property],
        scenario.expected,
      );
    } finally {
      await pi.events.get("session_shutdown")?.[0]();
      realFs.rmSync(definitionPath, { force: true });
    }
  }
});

test("TUI Model picker fuzzy-filters models and cancels in place", async () => {
  setLeadEnvironment();
  const definitionPath = join(PI_AGENTS_DIR, "search-agent.md");
  realFs.writeFileSync(
    definitionPath,
    "---\nname: search-agent\nmodel: alpha/original\n---\n",
  );
  const models = [
    ...Array.from({ length: 15 }, (_, index) => ({
      provider: `provider-${index}`,
      id: `model-${index}`,
      name: `Model ${index}`,
      reasoning: true,
    })),
    {
      provider: "zulu",
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      reasoning: true,
    },
    {
      provider: "alpha",
      id: "original",
      name: "Original",
      reasoning: true,
    },
  ];
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "tui";
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => models,
    getAvailable: () => models,
  };
  context.scopedModels = [{ model: models[models.length - 1] }];
  const keybindings = {
    matches: (data: string, key: string) =>
      ({
        "tui.select.up": "\u001b[A",
        "tui.select.down": "\u001b[B",
        "tui.select.confirm": "\r",
        "tui.select.cancel": "\u001b",
      })[key] === data,
  };
  let customCalls = 0;
  context.ui.custom = async (factory: any) =>
    new Promise((resolve) => {
      const component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        keybindings,
        resolve,
      );
      switch (customCalls++) {
        case 0:
          selectTuiItem(component, "search-agent");
          break;
        case 1:
          selectTuiItem(component, "Model");
          break;
        case 2:
          for (const character of "zulu 46") component.handleInput(character);
          {
            const rendered = component.render(200);
            const selected = rendered.find((line: string) =>
              line.trimStart().startsWith("→"),
            );
            assert.match(selected ?? "", /claude-sonnet-4-6/u);
            assert.ok(
              rendered.some((line: string) => line.includes("zulu 46")),
            );
          }
          component.handleInput("\r");
          break;
        case 3:
          selectTuiItem(component, "Model");
          break;
        case 4:
        case 5:
        case 6:
          component.handleInput("\u001b");
          break;
      }
    });
  try {
    await pi.commandOptions.get("agents").handler("definitions", context);
    assert.equal(customCalls, 7);
    assert.equal(
      discoverAgent("search-agent").frontmatter.model,
      "zulu/claude-sonnet-4-6",
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("message limits use flat config and one rough token formatter", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string) => notices.push(message);
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (prompts.length === 1) return "Message limits";
    if (prompts.length === 2) return options[0];
    if (prompts.length === 3) return options[1];
    return undefined;
  };
  await command.handler("", context);
  assert.equal(prompts[1]?.label, "Message limits");
  assert.match(prompts[1]?.options[0] ?? "", /≈32,768 tokens/);
  assert.match(prompts[1]?.options[1] ?? "", /≈32,768 tokens/);
  assert.ok(prompts.every(({ label }) => label !== "Scope"));
  assert.deepEqual(prompts[2]?.options, [
    "1 KiB · ≈256 tokens",
    "4 KiB · ≈1,024 tokens",
    "16 KiB · ≈4,096 tokens",
    "64 KiB · ≈16,384 tokens",
    "128 KiB · ≈32,768 tokens",
    "Custom…",
    "Reset",
  ]);
  assert.match(notices.at(-1) ?? "", /4 KiB · ≈1,024 tokens/);
  await pi.events.get("session_shutdown")?.[0]();
});

test("main agents menu toggles context retirement", async () => {
  setLeadEnvironment();
  updateConfig("contextRetirement", undefined);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  const menus: string[][] = [];
  const notices: string[] = [];
  context.ui.select = async (_title: string, options: string[]) => {
    menus.push(options);
    return menus.length === 1
      ? options.find((option) => option.includes("Context retirement"))
      : undefined;
  };
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.commandOptions.get("agents").handler("", context);
    assert.match(
      menus[0]?.find((option) => option.includes("Context retirement")) ?? "",
      /Context retirement  off/,
    );
    assert.equal(readConfig().contextRetirement, true);
    assert.deepEqual(notices, ["context retirement: on"]);
    await pi.commandOptions.get("agents").handler("", context);
    assert.match(
      menus.at(-1)?.find((option) => option.includes("Context retirement")) ??
        "",
      /Context retirement  on/,
    );
  } finally {
    updateConfig("contextRetirement", undefined);
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("main agents menu toggles retain workers", async () => {
  setLeadEnvironment();
  // Retention is on by default; start from the opt-out to see the toggle turn it on.
  updateConfig("retainWorkers", false);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  const menus: string[][] = [];
  const notices: string[] = [];
  context.ui.select = async (_title: string, options: string[]) => {
    menus.push(options);
    return menus.length === 1
      ? options.find((option) => option.includes("Retain workers"))
      : undefined;
  };
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await pi.commandOptions.get("agents").handler("", context);
    assert.match(
      menus[0]?.find((option) => option.includes("Retain workers")) ?? "",
      /Retain workers  off/,
    );
    assert.equal(readConfig().retainWorkers, true);
    assert.deepEqual(notices, ["retain workers: on"]);
    await pi.commandOptions.get("agents").handler("", context);
    assert.match(
      menus.at(-1)?.find((option) => option.includes("Retain workers")) ?? "",
      /Retain workers  on/,
    );
    assert.equal(readConfig().retainWorkers, true);
  } finally {
    updateConfig("retainWorkers", undefined);
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("main agents menu sets the soft timeout from presets, off, custom, and reset", async () => {
  setLeadEnvironment();
  updateConfig("softTimeoutMs", undefined);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  const prompts: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  const choices = ["10 min", "Off", "Custom…", "Reset", "Custom…"];
  let choice = 0;
  const inputs: (string | undefined)[] = ["7", "abc"];
  let rootPending = false;
  context.ui.input = async () => inputs.shift();
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (rootPending) {
      rootPending = false;
      return options.find((option) => option.includes("Soft timeout"));
    }
    if (label !== "Soft timeout") return undefined;
    const next = choices[choice++];
    return next
      ? (options.find((option) => option === next) ?? undefined)
      : undefined;
  };
  context.ui.notify = (message: string, kind?: string) =>
    notices.push(kind ? `${kind}: ${message}` : message);
  const rootLabel = (index: number) =>
    prompts[index]?.options.find((option) => option.includes("Soft timeout")) ??
    "";
  const open = () => {
    rootPending = true;
    return pi.commandOptions.get("agents").handler("", context);
  };
  try {
    await open();
    assert.match(rootLabel(0), /Soft timeout  5 min/);
    assert.equal(prompts[1]?.label, "Soft timeout");
    assert.deepEqual(prompts[1]?.options, [
      "2 min",
      "5 min",
      "10 min",
      "Off",
      "Custom…",
      "Reset",
    ]);
    assert.equal(readConfig().softTimeoutMs, 10 * 60_000);
    assert.equal(notices.at(-1), "soft timeout: 10 min");
    assert.match(rootLabel(2), /Soft timeout  10 min/);

    await open();
    assert.equal(readConfig().softTimeoutMs, 0);
    assert.equal(notices.at(-1), "soft timeout: off");
    assert.match(rootLabel(5), /Soft timeout  off/);

    await open();
    assert.equal(readConfig().softTimeoutMs, 7 * 60_000);
    assert.equal(notices.at(-1), "soft timeout: 7 min");

    await open();
    assert.equal(readConfig().softTimeoutMs, 5 * 60_000);
    assert.equal(notices.at(-1), "soft timeout: reset");

    await open();
    assert.equal(readConfig().softTimeoutMs, 5 * 60_000);
    assert.equal(
      notices.at(-1),
      "error: Enter an integer from 0 through 35791 minutes",
    );
  } finally {
    updateConfig("softTimeoutMs", undefined);
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("clear idle closes exactly the directly owned idle workers", async () => {
  setLeadEnvironment();
  updateConfig("retainWorkers", true);
  const labels = [
    "clear-idle-one-agent",
    "clear-idle-two-agent",
    "clear-idle-working-agent",
    "clear-idle-waiting-agent",
    "clear-idle-foreign-agent",
  ];
  const workingLabel = "clear-idle-working-agent";
  const waitingLabel = "clear-idle-waiting-agent";
  const foreignLabel = "clear-idle-foreign-agent";
  // Each worker's own launch gave it a session, so each reports its own.
  const sessions = new Map(
    labels.map((label) => [
      label,
      { id: randomUUID(), file: `/tmp/${label}-session.jsonl` },
    ]),
  );
  radarDaemon.childSession = (_spawn, index) => sessions.get(labels[index]!);
  for (const session of sessions.values())
    writeFileSync(session.file, "{}", "utf8");
  const launches = [];
  for (const label of labels)
    launches.push(
      await radarDaemon.adoptRetainedChild({
        label,
        runId: randomUUID(),
        ownerSessionId:
          label === foreignLabel ? PARENT_SESSION_ID : LEAD_SESSION_ID,
        workspaceId: WORKSPACE,
        mailbox: agentMailboxPath(WORKSPACE, label),
        pane: `${label}-pane`,
      }),
    );
  const provider = { id: "clear-idle-background-provider", version: 1 };
  for (const launch of launches) {
    const mailbox = launch.mailbox;
    const state = readAgentState(mailbox)!;
    const working = state.agentLabel === workingLabel;
    writeAgentState(mailbox, {
      ...state,
      ...(working || state.agentLabel === waitingLabel
        ? { activeRequestId: REQUEST_ID }
        : { completedRequestId: REQUEST_ID }),
      ...(state.agentLabel === waitingLabel
        ? {
            backgroundWorkProvider: provider,
            backgroundWaiting: {
              sessionId: state.piSessionId,
              requestId: REQUEST_ID,
              provider,
              revision: 1,
              taskIds: ["still-running"],
            },
          }
        : {}),
    });
  }
  const idleStates = launches
    .map((launch) => readAgentState(launch.mailbox)!)
    .filter(
      (state) =>
        state.agentLabel !== workingLabel && state.agentLabel !== waitingLabel,
    );
  const entries = [
    ...idleStates.map((state) => ({
      customType: "pi-herdsman-agent-result",
      details: resultEntryDetails(state, REQUEST_ID),
    })),
    ...launches.map((launch) => ({
      type: "custom",
      customType: "pi-herdsman-radar-spawn",
      data: launch,
    })),
  ];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const context = fakeContext(entries) as any;
  context.hasUI = true;
  context.mode = "rpc";
  const menus: string[][] = [];
  const notices: string[] = [];
  context.ui.select = async (_title: string, options: string[]) => {
    menus.push(options);
    return menus.length === 1
      ? options.find((option) => option.includes("Clear idle"))
      : undefined;
  };
  context.ui.confirm = async () => true;
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await startRadarSession(pi, context);
    await pi.commandOptions.get("agents").handler("", context);
    assert.deepEqual([...closedPanes()].sort(), [
      "clear-idle-one-agent-pane",
      "clear-idle-two-agent-pane",
    ]);
    assert.equal(notices.at(-1), "cleared 2 idle workers");
    assert.equal(
      readAgentState(agentMailboxPath(WORKSPACE, workingLabel))
        ?.activeRequestId,
      REQUEST_ID,
    );
    assert.equal(
      readAgentState(agentMailboxPath(WORKSPACE, waitingLabel))
        ?.activeRequestId,
      REQUEST_ID,
      "Clear idle leaves the unresolved background assignment untouched",
    );
    assert.ok(
      readAgentState(agentMailboxPath(WORKSPACE, foreignLabel)),
      "a foreign-owned idle worker is preserved",
    );
  } finally {
    updateConfig("retainWorkers", undefined);
    pi.events.get("session_shutdown")?.[0]();
    for (const label of labels)
      resetAgentMailbox(agentMailboxPath(WORKSPACE, label));
    for (const session of sessions.values())
      realFs.rmSync(session.file, { force: true });
  }
});

test("message limit edits stay in the submenu with the edited field selected", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "tui";
  const renders: string[][] = [];
  let customCalls = 0;
  context.ui.custom = async (factory: any) =>
    new Promise((resolve) => {
      const component = factory(
        { requestRender: () => undefined },
        {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        resolve,
      );
      renders.push(component.render(200));
      switch (customCalls++) {
        case 0:
          for (let i = 0; i < 4; i++) component.handleInput("\u001b[B");
          component.handleInput("\r");
          break;
        case 1:
        case 3:
          component.handleInput("\r");
          break;
        case 2:
          for (let i = 0; i < 3; i++) component.handleInput("\u001b[B");
          component.handleInput("\r");
          break;
        case 4:
        case 5:
        case 6:
          component.handleInput("\u001b");
          break;
      }
    });
  try {
    await pi.commandOptions.get("agents").handler("", context);
    assert.ok(renders[3]?.some((line) => line.includes("Inline attachments")));
    assert.match(
      renders[3]?.find((line) => line.includes("Inline attachments")) ?? "",
      /^→/u,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Running uses compact native options and focuses the freshly verified pane", async () => {
  setLeadEnvironment();
  const label = "running-menu-agent";
  const identity = defaultFixtureIdentity;
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const pi = fakePi();
  const daemon = await serveFakeRadar([
    observedAgent({
      paneId: identity.paneId,
      tabId: identity.tabId,
      status: "working",
      session: { kind: "uuid", value: identity.piSessionId },
    }),
  ]);
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string) => notices.push(message);
  context.ui.select = async (prompt: string, options: string[]) => {
    prompts.push({ label: prompt, options });
    if (prompts.length === 1) {
      assert.equal(options[0], "Running        1 working");
      return options.find((option) => option.startsWith("Running"));
    }
    if (prompts.length === 2) {
      const expected = renderRunningOptions(
        buildStatusRows(
          [
            {
              label,
              definition: "agent",
              state: "working",
              paneId: identity.paneId,
              sessionId: identity.piSessionId,
            },
          ],
          { now: Date.now() },
        ),
      )[0];
      assert.equal(prompts[1]?.label, "Running");
      assert.equal(options[0], expected);
      assert.match(options[0]!, /└─ agent\s+running-menu-agent\s+● working/);
      assert.doesNotMatch(options[0]!, /⠋|gpt|high|0s|Implement/);
      return options[0];
    }
    return undefined;
  };
  try {
    await command.handler("", context);
    assert.deepEqual(
      daemon.requests
        .filter((request) => request.method === "mux.focus")
        .map((request) => request.params),
      [
        {
          target: identity.paneId,
          target_kind: "pane",
          requester: "pi-herdsman",
        },
      ],
      `notices: ${JSON.stringify(notices)}`,
    );
    assert.deepEqual(
      pi.calls.filter((args) => args[0] === "agent" && args[1] === "focus"),
      [],
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    await ensureRadarDaemon();
    await daemon.close();
    resetAgentMailbox(mailbox);
  }
});

test("Running explains how to delegate when no agents are running", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string) => notices.push(message);
  let selection = 0;
  context.ui.select = async (_prompt: string, options: string[]) =>
    selection++ === 0
      ? options.find((option) => option.startsWith("Running"))
      : undefined;

  await command.handler("", context);

  assert.ok(
    notices.some(
      (message) =>
        message.includes("No running agents") &&
        message.includes("Use scout to inspect this repository"),
    ),
  );
});

test("Running excludes lost and unknown durable generations", async () => {
  setLeadEnvironment();
  // The menu reads the daemon's own fleet, so this test needs a reachable one
  // rather than trusting the instance the module loaded.
  await ensureRadarDaemon();
  const lostLabel = "lost-running-menu-agent";
  const unknownLabel = "unknown-running-menu-agent";
  const lostIdentity = {
    paneId: "lost-running-menu-pane",
    tabId: "lost-running-menu-tab",
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/lost-running-menu-agent.jsonl",
  };
  const unknownIdentity = {
    paneId: "unknown-running-menu-pane",
    tabId: "unknown-running-menu-tab",
    piSessionId: "22222222-2222-4222-8222-222222222222",
    piSessionFile: "/tmp/unknown-running-menu-agent.jsonl",
  };
  const mailboxes = [
    agentMailboxPath(WORKSPACE, lostLabel),
    agentMailboxPath(WORKSPACE, unknownLabel),
  ];
  // The lost generation is older than the longest startup the owner would wait
  // for, and the daemon's observation does not report its pane at all; the
  // unknown one is inside that window, on a pane the observation reports with no
  // agent row on it.
  const stale = Date.now() - 3_600_000;
  writeAgentState(mailboxes[0]!, {
    ...managedState(lostLabel, REQUEST_ID, lostIdentity),
    runId: randomUUID(),
    updatedAt: stale,
    lastActivityAt: stale,
  });
  writeAgentState(mailboxes[1]!, {
    ...managedState(unknownLabel, REQUEST_ID, unknownIdentity),
    runId: randomUUID(),
  });
  radarDaemon.observeInventory = () => ({
    workspaces: [{ workspace_id: WORKSPACE }],
    tabs: [{ tab_id: unknownIdentity.tabId, workspace_id: WORKSPACE }],
    panes: [
      {
        location: {
          workspace_id: WORKSPACE,
          tab_id: unknownIdentity.tabId,
          pane_id: unknownIdentity.paneId,
        },
      },
    ],
    agents: [],
  });
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string) => notices.push(message);
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    assert.equal(label, `Pi Herdsman · v${packageMetadata.version}`);
    assert.ok(options.includes("Running        1 unknown · 1 lost"));
    return prompts.length === 1
      ? options.find((option) => option.startsWith("Running"))
      : undefined;
  };
  try {
    await command.handler("", context);
    // The menu reopens after the empty Running list, and the notice is what
    // answers the selection.
    assert.deepEqual(
      prompts.map(({ label }) => label),
      [
        `Pi Herdsman · v${packageMetadata.version}`,
        `Pi Herdsman · v${packageMetadata.version}`,
      ],
    );
    assert.ok(
      notices.some((message) => message.includes("No running agents")),
      `notices: ${JSON.stringify(notices)} prompts: ${JSON.stringify(prompts)}`,
    );
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "focus"),
      false,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    for (const mailbox of mailboxes) resetAgentMailbox(mailbox);
  }
});

test("Running warns when the selected agent is replaced before focus", async () => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const label = "running-menu-replaced-agent";
  const identity = defaultFixtureIdentity;
  const replacementIdentity: FixtureIdentity = {
    paneId: "replacement-pane",
    tabId: "replacement-tab",
    piSessionId: "11111111-1111-4111-8111-111111111111",
    piSessionFile: "/tmp/replacement-agent.jsonl",
  };
  const mailbox = agentMailboxPath(WORKSPACE, label);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  let currentIdentity = identity;
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              ...JSON.parse(
                listResponse(
                  label,
                  "working",
                  currentIdentity.piSessionId,
                  currentIdentity,
                ),
              ),
              snapshot: {
                agents: JSON.parse(
                  listResponse(
                    label,
                    "working",
                    currentIdentity.piSessionId,
                    currentIdentity,
                  ),
                ).agents,
                panes: [
                  {
                    pane_id: currentIdentity.paneId,
                    workspace_id: WORKSPACE,
                    cwd: "/tmp",
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
                      kind: "id",
                      value: currentIdentity.piSessionId,
                    },
                  },
                ],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              panes: [
                {
                  pane_id: currentIdentity.paneId,
                  workspace_id: WORKSPACE,
                  cwd: "/tmp",
                  agent: label,
                  agent_status: "working",
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: { message: string; level?: string }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.notify = (message: string, level?: string) =>
    notices.push({ message, level });
  let selection = 0;
  context.ui.select = async (_prompt: string, options: string[]) => {
    if (selection === 0) {
      selection++;
      return options.find((option) => option.startsWith("Running"));
    }
    if (selection === 1) {
      selection++;
      currentIdentity = replacementIdentity;
      writeAgentState(
        mailbox,
        managedState(label, REQUEST_ID, replacementIdentity),
      );
      return options[0];
    }
    return undefined;
  };
  try {
    await command.handler("", context);
    assert.equal(
      pi.calls.some((args) => args[0] === "agent" && args[1] === "focus"),
      false,
    );
    assert.ok(
      notices.some(
        ({ message, level }) =>
          level === "warning" && message.includes("Agent changed"),
      ),
      `notices: ${JSON.stringify(notices)}`,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
  }
});

test("Running keeps colliding display labels distinct and focuses the selected pane", async () => {
  setLeadEnvironment();
  const states = [
    {
      label: "reviewer:task",
      definition: "reviewer",
      identity: {
        paneId: "reviewer-task-pane",
        tabId: "reviewer-task-tab",
        piSessionId: "22222222-2222-4222-8222-222222222222",
        piSessionFile: "/tmp/reviewer-task-agent.jsonl",
      },
    },
    {
      label: "scout:task",
      definition: "scout",
      identity: {
        paneId: "scout-task-pane",
        tabId: "scout-task-tab",
        piSessionId: "33333333-3333-4333-8333-333333333333",
        piSessionFile: "/tmp/scout-task-agent.jsonl",
      },
    },
  ] as const;
  const agentStates = states.map(({ label, identity }) => ({
    ...managedState(label, REQUEST_ID, identity),
  }));
  const mailboxes = agentStates.map((state, index) => {
    const mailbox = agentMailboxPath(WORKSPACE, state.agentLabel);
    writeAgentState(mailbox, state);
    nativeSessions.set(state.piSessionFile!, {
      id: state.piSessionId!,
      path: state.piSessionFile!,
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: states[index]!.identity.piSessionId,
            definition: states[index]!.definition,
            label: states[index]!.label,
          },
        },
      ],
    });
    return mailbox;
  });
  const pi = fakePi({
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isApiSnapshot(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              action: "list",
              workspace_id: WORKSPACE,
              tab: "",
              tabs: [],
              agents: states.map(({ label, identity }) => ({
                agent_status: "working",
                cwd: "/tmp",
                workspace_id: WORKSPACE,
                pane_id: identity.paneId,
                tab_id: identity.tabId,
                tab_label: "agents",
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "id",
                  value: identity.piSessionId,
                },
                session_id: identity.piSessionId,
                session_path: identity.piSessionFile,
              })),
              available_panes: [],
              agent_definitions: [],
              snapshot: {
                agents: states.map(({ label, identity }) => ({
                  ...JSON.parse(
                    listResponse(
                      label,
                      "working",
                      identity.piSessionId,
                      identity,
                    ),
                  ).agents[0],
                })),
                panes: states.map(({ identity }) => ({
                  pane_id: identity.paneId,
                  workspace_id: WORKSPACE,
                  cwd: "/tmp",
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
                    kind: "id",
                    value: identity.piSessionId,
                  },
                })),
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              panes: states.map(({ label, identity }) => ({
                pane_id: identity.paneId,
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent: label,
                agent_status: "working",
              })),
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const daemon = await serveFakeRadar(
    states.map(({ identity }) =>
      observedAgent({
        paneId: identity.paneId,
        tabId: identity.tabId,
        status: "working",
        session: { kind: "uuid", value: identity.piSessionId },
      }),
    ),
  );
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  let selection = 0;
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (selection++ === 0)
      return options.find((option) => option.startsWith("Running"));
    if (selection === 2) {
      assert.ok(options.some((option) => option.includes("reviewer:task")));
      assert.ok(options.some((option) => option.includes("scout:task")));
      assert.equal(new Set(options).size, 2);
      return options.find((option) => option.includes("scout:task"));
    }
    return undefined;
  };
  try {
    await command.handler("", context);
    assert.deepEqual(
      daemon.requests
        .filter((request) => request.method === "mux.focus")
        .map((request) => request.params),
      [
        {
          target: "scout-task-pane",
          target_kind: "pane",
          requester: "pi-herdsman",
        },
      ],
    );
    assert.deepEqual(
      pi.calls.filter((args) => args[0] === "agent" && args[1] === "focus"),
      [],
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    await ensureRadarDaemon();
    await daemon.close();
    for (const [index, mailbox] of mailboxes.entries()) {
      resetAgentMailbox(mailbox);
      nativeSessions.delete(states[index]!.identity.piSessionFile);
    }
  }
});

test("Definitions edits standalone definitions through the shared override writer", async () => {
  setLeadEnvironment();
  const definitionPath = join(PI_AGENTS_DIR, "docs-reviewer.md");
  const original =
    '---\nname: docs-reviewer\ndescription: Docs review\nmodel: old/model\nthinking: medium\ntools: ["read"]\n---\n\nKeep this body exactly.\n';
  realFs.writeFileSync(definitionPath, original);
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => [{ provider: "new", id: "model" }],
    getAvailable: () => [{ provider: "new", id: "model" }],
  };
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    if (selection++ === 0)
      return options.find((option) => option.includes("docs-reviewer"));
    if (selection === 2)
      return options.find((option) => option.startsWith("Model"));
    if (selection === 3) return "Inherit current session";
    return undefined;
  };
  try {
    await command.handler("definitions", context);
    assert.ok(
      prompts.some(({ options }) =>
        options.some((option) => option.includes("--- Custom ---")),
      ),
    );
    assert.equal(
      realFs.readFileSync(definitionPath, "utf8"),
      original.replace("model: old/model\n", ""),
    );
    assert.ok(
      prompts[0]?.options.some((option) => option.includes("docs-reviewer")),
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions Details snapshots effective append and replace instructions", async () => {
  setLeadEnvironment();
  const definitionPath = join(PI_AGENTS_DIR, "scout.md");
  const customDefinitionPath = join(PI_AGENTS_DIR, "details-scout.md");
  const bodyPath = join(PI_AGENT_ROOT, "scout-details-body.md");
  const baseBody = discoverAgent("scout").body;

  const selectDetails = async (
    selectedName: string,
    beforeDetails?: () => void,
  ) => {
    const pi = fakePi();
    registerExtension!(pi.pi as never);
    const initialEntryCount = pi.entries.length;
    const command = pi.commandOptions.get("agents");
    const context = fakeContext() as any;
    context.hasUI = true;
    context.mode = "tui";
    const notices: string[] = [];
    context.ui.notify = (message: string) => notices.push(message);
    let customCalls = 0;
    context.ui.custom = async (factory: any) => {
      const result = new Promise<unknown>((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          resolve,
        );
        const call = customCalls++;
        if (call >= 2) {
          component.handleInput("\u001b");
          return;
        }
        const target = call === 0 ? selectedName : "Details…";
        if (call === 1) beforeDetails?.();
        selectTuiItem(component, target);
      });
      return result;
    };
    let error: unknown;
    try {
      await command.handler("definitions", context);
    } catch (caught) {
      error = caught;
    } finally {
      await pi.events.get("session_shutdown")?.[0]();
    }
    return {
      entry: [...pi.entries.slice(initialEntryCount)]
        .reverse()
        .find(
          (entry: any) => entry?.customType === "pi-herdsman-agent-definitions",
        ) as
        | {
            customType: string;
            data: {
              definitions: Array<Record<string, unknown>>;
              instructions: string;
            };
          }
        | undefined,
      notices,
      error,
    };
  };

  try {
    realFs.writeFileSync(bodyPath, "file instructions");
    realFs.writeFileSync(
      definitionPath,
      `---\nname: scout\ndescription: before\nbodyMode: append\n---\nAdditional instructions\n@${bodyPath}\n`,
    );
    const appended = discoverAgent("scout");
    assert.equal(
      appended.body,
      `${baseBody}\n\nAdditional instructions\n@${bodyPath}`,
    );
    const appendedResult = await selectDetails("scout", () => {
      realFs.writeFileSync(bodyPath, "mutated after selection");
      realFs.writeFileSync(
        definitionPath,
        `---\nname: scout\ndescription: after\nbodyMode: append\n---\nAdditional instructions\n@${bodyPath}\n`,
      );
    });
    const appendedEntry = appendedResult.entry!;
    assert.equal(
      appendedEntry.data.instructions,
      `${baseBody}\n\nAdditional instructions\nmutated after selection`,
    );
    assert.equal(appendedEntry.data.definitions[0]?.description, "after");

    realFs.writeFileSync(
      definitionPath,
      `---\nname: scout\nbodyMode: replace\n---\nReplacement instructions\n@${bodyPath}\n`,
    );
    const replacedResult = await selectDetails("scout", () => {
      realFs.writeFileSync(bodyPath, "changed file instructions");
    });
    const replacedEntry = replacedResult.entry!;
    assert.equal(
      replacedEntry.data.instructions,
      "Replacement instructions\nchanged file instructions",
    );
    assert.equal(
      appendedEntry.data.instructions,
      `${baseBody}\n\nAdditional instructions\nmutated after selection`,
    );

    realFs.writeFileSync(
      customDefinitionPath,
      `---\nname: details-scout\ndescription: Still available\n---\nStill available\n`,
    );
    const deletedResult = await selectDetails("details-scout", () => {
      realFs.rmSync(customDefinitionPath, { force: true });
    });
    assert.equal(deletedResult.entry, undefined);
    assert.ok(
      deletedResult.notices.some((notice) =>
        notice.includes("Definition details-scout is no longer available."),
      ),
    );

    realFs.writeFileSync(
      customDefinitionPath,
      `---\nname: details-scout\ndescription: Still available\n---\nStill available\n`,
    );
    const invalidResult = await selectDetails("details-scout", () => {
      realFs.writeFileSync(
        customDefinitionPath,
        `---\nname: details-scout\nunknownField: true\n---\nInvalid\n`,
      );
    });
    assert.ok(
      invalidResult.notices.some((notice) =>
        /unknownField|Malformed|invalid/i.test(notice),
      ),
    );
  } finally {
    realFs.rmSync(definitionPath, { force: true });
    realFs.rmSync(customDefinitionPath, { force: true });
    realFs.rmSync(bodyPath, { force: true });
  }
});

test("Definitions cancellation navigates one menu level at a time", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: { label: string; options: string[] }[] = [];
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.modelRegistry = {
    refresh: async () => undefined,
    getAll: () => [{ provider: "provider", id: "model", reasoning: true }],
    getAvailable: () => [
      { provider: "provider", id: "model", reasoning: true },
    ],
  };
  context.ui.select = async (label: string, options: string[]) => {
    prompts.push({ label, options });
    switch (selection++) {
      case 0:
        return options.find((option) => option.includes("implementer"));
      case 1:
        return options.find((option) => option.startsWith("Model"));
      case 2:
        return undefined;
      case 3:
        return options.find((option) => option.startsWith("Thinking"));
      case 4:
        return undefined;
      case 5:
        return undefined;
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    assert.deepEqual(
      prompts.map(({ label }) => label),
      [
        "Definitions",
        "implementer",
        "Model",
        "implementer",
        "Thinking",
        "implementer",
        "Definitions",
      ],
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
  }
});

test("Definitions applies model and thinking overrides independently", async () => {
  for (const scenario of [
    { field: "Model", selected: "new-model", property: "model" },
    { field: "Thinking", selected: "medium", property: "thinking" },
  ] as const) {
    setLeadEnvironment();
    const pi = fakePi();
    registerExtension!(pi.pi as never);
    const command = pi.commandOptions.get("agents");
    const definitionPath = join(PI_AGENTS_DIR, "implementer.md");
    const prompts: { label: string; options: string[] }[] = [];
    let selection = 0;
    const context = fakeContext() as any;
    context.hasUI = true;
    context.mode = "rpc";
    context.modelRegistry = {
      refresh: async () => undefined,
      getAll: () => [
        { provider: "provider", id: "new-model", reasoning: true },
      ],
      getAvailable: () => [
        { provider: "provider", id: "new-model", reasoning: true },
      ],
    };
    context.ui.select = async (label: string, options: string[]) => {
      prompts.push({ label, options });
      switch (selection++) {
        case 0:
          return options.find((option) => option.includes("implementer"));
        case 1:
          return options.find((option) => option.startsWith(scenario.field));
        case 2:
          return scenario.selected;
        case 3:
          assert.equal(
            discoverAgent("implementer").frontmatter[scenario.property],
            scenario.property === "model" ? "provider/new-model" : "medium",
          );
          return options.find((option) => option.startsWith(scenario.field));
        case 4:
          return "Inherit current session";
        default:
          return undefined;
      }
    };
    try {
      await command.handler("definitions", context);
      const content = realFs.readFileSync(definitionPath, "utf8");
      assert.doesNotMatch(content, new RegExp(`^${scenario.property}:`, "m"));
      assert.equal(
        discoverAgent("implementer").frontmatter[scenario.property],
        undefined,
      );
      assert.ok(prompts.some(({ label }) => label === scenario.field));
    } finally {
      await pi.events.get("session_shutdown")?.[0]();
      realFs.rmSync(definitionPath, { force: true });
    }
  }
});

test("Definitions toggles enabled state for bundled definitions", async () => {
  setLeadEnvironment();
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const definitionPath = join(PI_AGENTS_DIR, "implementer.md");
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.select = async (_label: string, options: string[]) => {
    switch (selection++) {
      case 0:
        return options.find((option) => option.includes("implementer"));
      case 1:
        return options.find((option) => option.startsWith("Enabled"));
      case 2:
        assert.equal(discoverAgent("implementer").frontmatter.enabled, false);
        return options.find((option) => option.startsWith("Enabled"));
      case 3:
        assert.equal(discoverAgent("implementer").frontmatter.enabled, true);
        return undefined;
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    assert.match(
      realFs.readFileSync(definitionPath, "utf8"),
      /^enabled: true$/m,
    );
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions refreshes the model registry before post-model thinking choices", async () => {
  setLeadEnvironment();
  const pi = fakePi({ thinkingLevel: "high" });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const definitionPath = join(PI_AGENTS_DIR, "implementer.md");
  const refreshedModel = {
    provider: "refresh-provider",
    id: "refresh-model",
    reasoning: true,
  };
  let registryModels: (typeof refreshedModel)[] = [];
  const registry = {
    refreshes: 0,
    async refresh() {
      this.refreshes++;
      registryModels = [refreshedModel];
    },
    getAll: () => registryModels,
    getAvailable: () => registryModels,
  };
  let selection = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.model = { provider: "current-provider", id: "current-model" };
  context.thinkingLevel = "high";
  context.modelRegistry = registry;
  context.ui.select = async (_label: string, options: string[]) => {
    switch (selection++) {
      case 0:
        assert.ok(
          options.some((option) => option.includes("inherit · current-model")),
        );
        return options.find((option) => option.includes("implementer"));
      case 1:
        return options.find((option) => option.startsWith("Model"));
      case 2:
        return "refresh-model";
      case 3:
        assert.ok(options.includes("Thinking    inherit · high"));
        return options.find((option) => option.startsWith("Thinking"));
      case 4:
        assert.equal(registry.refreshes, 2);
        assert.ok(options.includes("medium"));
        assert.equal(options.includes("xhigh"), false);
        return "medium";
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
    assert.equal(
      discoverAgent("implementer").frontmatter.model,
      "refresh-provider/refresh-model",
    );
    assert.equal(discoverAgent("implementer").frontmatter.thinking, "medium");
    assert.equal(registry.refreshes, 2);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions uses the current model for inherited thinking choices", async () => {
  setLeadEnvironment();
  const pi = fakePi({ thinkingLevel: "medium" });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = fakeContext() as any;
  context.hasUI = true;
  context.model = {
    provider: "current-provider",
    id: "current-model",
    reasoning: true,
  };
  context.thinkingLevel = "medium";
  const registry = {
    refreshes: 0,
    async refresh() {
      this.refreshes++;
    },
    getAll: () => [],
    getAvailable: () => [],
  };
  context.modelRegistry = registry;
  let selection = 0;
  context.ui.select = async (_label: string, options: string[]) => {
    switch (selection++) {
      case 0:
        assert.ok(
          options.some((option) => option.includes("inherit · current-model")),
        );
        return options.find((option) => option.includes("implementer"));
      case 1:
        return "Thinking    inherit · medium";
      case 2:
        assert.equal(registry.refreshes, 1);
        assert.ok(options.includes("medium"));
        assert.equal(options.includes("xhigh"), false);
        return undefined;
      default:
        return undefined;
    }
  };
  try {
    await command.handler("definitions", context);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
  }
});

test("Definitions resolves explicit compact model IDs for thinking choices", async () => {
  for (const scenario of [
    {
      model: "compact-model",
      models: [{ provider: "provider", id: "compact-model", reasoning: false }],
      levels: ["off"],
    },
    {
      model: "ambiguous-model",
      models: [
        { provider: "one", id: "ambiguous-model", reasoning: false },
        { provider: "two", id: "ambiguous-model", reasoning: false },
      ],
      levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    },
  ] as const) {
    setLeadEnvironment();
    const definitionPath = join(PI_AGENTS_DIR, "implementer.md");
    realFs.writeFileSync(
      definitionPath,
      `---\nname: implementer\nmodel: ${scenario.model}\n---\n`,
    );
    const pi = fakePi({ thinkingLevel: "high" });
    registerExtension!(pi.pi as never);
    const command = pi.commandOptions.get("agents");
    const context = fakeContext() as any;
    context.hasUI = true;
    context.mode = "rpc";
    context.model = {
      provider: "current-provider",
      id: "current-model",
      reasoning: true,
    };
    context.thinkingLevel = "high";
    context.modelRegistry = {
      refresh: async () => undefined,
      getAll: () => scenario.models,
      getAvailable: () => scenario.models,
    };
    let selection = 0;
    context.ui.select = async (_label: string, options: string[]) => {
      switch (selection++) {
        case 0:
          assert.ok(options.some((option) => option.includes(scenario.model)));
          return options.find((option) => option.includes("implementer"));
        case 1:
          return "Thinking    inherit · high";
        case 2:
          assert.deepEqual(options, [
            "Inherit current session",
            ...scenario.levels,
          ]);
          return undefined;
        default:
          return undefined;
      }
    };
    try {
      await command.handler("definitions", context);
    } finally {
      pi.events.get("session_shutdown")?.[0]();
      realFs.rmSync(definitionPath, { force: true });
    }
  }
});

test("Definitions aligns Unicode names and models by display width", async () => {
  setLeadEnvironment();
  const definitionPaths = [
    join(PI_AGENTS_DIR, "unicode-reviewer-a.md"),
    join(PI_AGENTS_DIR, "unicode-reviewer-b.md"),
  ];
  realFs.writeFileSync(
    definitionPaths[0],
    "---\nname: 審査\nmodel: provider/模型\nthinking: high\n---\nreview\n",
  );
  realFs.writeFileSync(
    definitionPaths[1],
    "---\nname: 設計確認\nmodel: provider/長い名前\nthinking: high\n---\nreview\n",
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: string[][] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.select = async (_label: string, options: string[]) => {
    prompts.push(options);
    return undefined;
  };
  try {
    await command.handler("definitions", context);
    const options = prompts[0] ?? [];
    const rowA = options.find((option) => option.includes("模型"));
    const rowB = options.find((option) => option.includes("長い名前"));
    assert.ok(rowA);
    assert.ok(rowB);
    assert.notEqual("審査".length, visibleWidth("審査"));
    assert.notEqual("設計確認".length, visibleWidth("設計確認"));
    assert.notEqual("模型".length, visibleWidth("模型"));
    assert.notEqual("長い名前".length, visibleWidth("長い名前"));
    const column = (line: string, token: string) => {
      const index = line.indexOf(token);
      assert.notEqual(index, -1);
      return visibleWidth(line.slice(0, index));
    };
    assert.equal(column(rowA, "模型"), column(rowB, "長い名前"));
    assert.equal(column(rowA, "high"), column(rowB, "high"));
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    for (const definitionPath of definitionPaths)
      realFs.rmSync(definitionPath, { force: true });
  }
});

test("Definitions separators are ignored and reopen the list", async () => {
  setLeadEnvironment();
  const definitionPath = join(PI_AGENTS_DIR, "group-custom.md");
  realFs.writeFileSync(
    definitionPath,
    "---\nname: group:Custom\n---\nCustom instructions\n",
  );
  const pi = fakePi();
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const prompts: string[][] = [];
  let selections = 0;
  const context = fakeContext() as any;
  context.hasUI = true;
  context.mode = "rpc";
  context.ui.select = async (_label: string, options: string[]) => {
    prompts.push(options);
    return selections++ === 0
      ? options.find((option) => option === "--- Custom ---")
      : undefined;
  };
  try {
    await command.handler("definitions", context);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0]![0], "--- Bundled (* overridden) ---");
    assert.ok(prompts[0]?.includes("--- Custom ---"));
    assert.deepEqual(prompts[0], prompts[1]);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    realFs.rmSync(definitionPath, { force: true });
  }
});

test("lead agents stop reports an empty owned inventory safely", async () => {
  setLeadEnvironment();
  const pi = fakePi({
    exec: (command, args) =>
      command === "herdr" && isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: { snapshot: { agents: [], panes: [] } },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "{}", stderr: "", code: 0 },
  });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  context.ui.notify = (message: string) => notices.push(message);
  await command.handler("stop", context);
  await command.handler("stop", context);
  assert.equal(
    pi.sentMessageCalls.filter(
      (call: any) => call.message.customType === "pi-herdsman-stop-summary",
    ).length,
    2,
  );
  assert.equal(
    pi.entries.some(
      (entry: any) => entry.customType === "pi-herdsman-stop-summary",
    ),
    false,
  );
  assert.equal(stopSummary(pi), "No owned agents running.");
});

test("lead agents stop closes a direct subtree agents-first", async () => {
  setLeadEnvironment();
  const parentMailbox = agentMailboxPath(WORKSPACE, "pi-herdsman-parent");
  const childMailbox = agentMailboxPath(WORKSPACE, "pi-herdsman-agents");
  resetAgentMailbox(parentMailbox);
  resetAgentMailbox(childMailbox);
  // The parent's own session is the owner of the child it delegated, and each
  // child reports the session its own launch gave it.
  radarDaemon.childSession = (_spawn, index) =>
    index === 0
      ? { id: PARENT_SESSION_ID, file: "/tmp/pi-herdsman-parent.jsonl" }
      : { id: CHILD_SESSION_ID, file: "/tmp/pi-herdsman-agents.jsonl" };
  const launches = [
    await radarDaemon.adoptRetainedChild({
      label: "pi-herdsman-parent",
      runId: randomUUID(),
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      mailbox: parentMailbox,
      pane: "cascade-parent-pane",
    }),
    await radarDaemon.adoptRetainedChild({
      label: "pi-herdsman-agents",
      runId: randomUUID(),
      ownerSessionId: PARENT_SESSION_ID,
      workspaceId: WORKSPACE,
      mailbox: childMailbox,
      pane: "cascade-child-pane",
    }),
  ];
  const sessions = [
    { id: PARENT_SESSION_ID, file: "/tmp/pi-herdsman-parent.jsonl" },
    { id: CHILD_SESSION_ID, file: "/tmp/pi-herdsman-agents.jsonl" },
  ];
  for (const session of sessions)
    nativeSessions.set(session.file, {
      id: session.id,
      path: session.file,
      entries: [
        {
          type: "custom",
          customType: "pi-herdsman-agent-definition",
          data: {
            sessionId: session.id,
            definition: "agent",
            label: session.id === PARENT_SESSION_ID ? "pi-herdsman-parent" : "pi-herdsman-agents",
          },
        },
      ],
    });
  const entries = launches.map((launch) => ({
    type: "custom",
    customType: "pi-herdsman-radar-spawn",
    data: launch,
  }));
  const pi = fakePi({ entries, persistMessages: true });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const notices: string[] = [];
  const context = { ...fakeContext(entries), hasUI: true } as any;
  context.ui.notify = (message: string) => notices.push(message);
  try {
    await startRadarSession(pi, context);
    await command.handler("stop", context);
    assert.deepEqual(closedPanes(), ["cascade-child-pane", "cascade-parent-pane"]);
    assert.match(stopSummary(pi), /Stopped 2 agents/);
    assert.match(stopSummary(pi), /✓ pi-herdsman-agents/);
    assert.match(stopSummary(pi), /✓ pi-herdsman-parent/);
    assert.equal(pi.sentMessageCalls.length, 1);
    assert.deepEqual(pi.sentMessageCalls[0]?.options, { triggerTurn: false });
    assert.equal(pi.sentMessageCalls[0]?.message.display, true);
    assert.equal(
      (pi.sentMessageCalls[0]?.message as { content: string } | undefined)?.content,
      `[Pi Herdsman] Stop all result:\n${stopSummary(pi)}`,
    );
    assert.ok(
      pi.entries.some(
        (entry: any) =>
          entry.customType === "pi-herdsman-stop-summary" &&
          entry.details.summary === stopSummary(pi),
      ),
    );
    assert.equal(readAgentState(parentMailbox), undefined);
    assert.equal(readAgentState(childMailbox), undefined);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(parentMailbox);
    resetAgentMailbox(childMailbox);
    for (const session of sessions) nativeSessions.delete(session.file);
  }
});

test("lead agents stop reports cleanup failures and preserves accurate discarded-work summary", async () => {
  setLeadEnvironment();
  const failedLabel = "stop-failed-agent";
  const pendingLabel = "stop-pending-agent";
  const completedRequestId = randomUUID();
  const sessions = [
    { id: randomUUID(), file: "/tmp/stop-failed-agent-session.jsonl" },
    { id: randomUUID(), file: "/tmp/stop-pending-agent-session.jsonl" },
  ];
  radarDaemon.childSession = (_spawn, index) => sessions[index];
  const launches = [];
  for (const label of [failedLabel, pendingLabel])
    launches.push(
      await radarDaemon.adoptRetainedChild({
        label,
        runId: randomUUID(),
        ownerSessionId: LEAD_SESSION_ID,
        workspaceId: WORKSPACE,
        mailbox: agentMailboxPath(WORKSPACE, label),
        pane: `${label}-pane`,
      }),
    );
  const mailboxes = launches.map((launch) => launch.mailbox);
  const pending = readAgentState(mailboxes[1]!)!;
  writeAgentState(mailboxes[1]!, {
    ...pending,
    activeRequestId: REQUEST_ID,
    completedRequestId,
  });
  writeResult(mailboxes[1]!, {
    version: 5,
    runId: pending.runId,
    requestId: completedRequestId,
    ownerSessionId: pending.ownerSessionId,
    workspaceId: pending.workspaceId,
    agentLabel: pending.agentLabel,
    paneId: pending.paneId,
    status: "completed",
    text: "durable result",
    completedAt: Date.now(),
  });
  // The backend refuses every close, so both workers are kept and the summary
  // has to report what each of them still holds.
  radarDaemon.options.refuseChildClose = true;
  const entries = launches.map((launch) => ({
    type: "custom",
    customType: "pi-herdsman-radar-spawn",
    data: launch,
  }));
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = { ...fakeContext(entries), hasUI: true } as any;
  try {
    await startRadarSession(pi, context);
    await command.handler("stop", context);
    const summary = stopSummary(pi);
    assert.match(summary, /Stopped 0 of 2 agents/);
    assert.match(summary, /✗ stop-failed-agent/);
    assert.match(summary, /Discarded:/);
    assert.match(summary, /stop-pending-agent: active assignment/);
    assert.match(summary, /stop-pending-agent: pending result/);
    assert.deepEqual(closedPanes(), []);
    assert.ok(readAgentState(mailboxes[1]!));
    assert.ok(readResult(mailboxes[1]!, completedRequestId));
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    mailboxes.forEach((mailbox) => resetAgentMailbox(mailbox));
  }
});

test("lead agents stop continues independent leads after a partial cascade failure", async () => {
  setLeadEnvironment();
  const failedLabel = "stop-partial-failure";
  const okLabel = "stop-independent";
  // One worker this session launched through Radar and one it only holds a
  // mailbox for: the daemon refuses a physical close for the second (this build
  // has no record of the pane it would be closing), so the first must still be
  // stopped.
  // The two workers must not share a durable identity, exactly as two launches
  // never do.
  const okSession = { id: randomUUID(), file: "/tmp/stop-independent-session.jsonl" };
  radarDaemon.childSession = () => okSession;
  const launch = await radarDaemon.adoptRetainedChild({
    label: okLabel,
    runId: randomUUID(),
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    mailbox: agentMailboxPath(WORKSPACE, okLabel),
    pane: "stop-independent-pane",
  });
  const failedMailbox = agentMailboxPath(WORKSPACE, failedLabel);
  resetAgentMailbox(failedMailbox);
  writeAgentState(
    failedMailbox,
    managedState(failedLabel, undefined, recoveryIdentity(failedLabel)),
  );
  const entries = [
    { type: "custom", customType: "pi-herdsman-radar-spawn", data: launch },
  ];
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = { ...fakeContext(entries), hasUI: true } as any;
  try {
    await startRadarSession(pi, context);
    const stopping = command.handler("stop", context);
    // A backend that starts refusing part-way through a cascade is what this
    // summary has to survive, so the refusal is armed once the first close has
    // landed.
    for (let tick = 0; tick < 500 && closedPanes().length === 0; tick++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    radarDaemon.options.refuseChildClose = true;
    await stopping;
    assert.deepEqual(
      closedPanes(),
      ["stop-independent-pane"],
      `summary: ${stopSummary(pi)}`,
    );
    assert.match(stopSummary(pi), /Stopped 1 of 2 agents/);
    assert.match(stopSummary(pi), /✓ stop-independent/);
    assert.match(stopSummary(pi), /✗ stop-partial-failure/);
  } finally {
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(failedMailbox);
    resetAgentMailbox(launch.mailbox);
  }
});

test("lead agents stop scopes its summary to the current lead subtree", async () => {
  setLeadEnvironment();
  const ownedPane = "scoped-owned-pane";
  const foreignPane = "scoped-foreign-pane";
  const launches = [
    await radarDaemon.adoptRetainedChild({
      label: "scoped-owned-agent",
      runId: randomUUID(),
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      mailbox: agentMailboxPath(WORKSPACE, "scoped-owned-agent"),
      pane: ownedPane,
    }),
    await radarDaemon.adoptRetainedChild({
      label: "scoped-foreign-agent",
      runId: randomUUID(),
      ownerSessionId: "foreign-lead-session",
      workspaceId: WORKSPACE,
      mailbox: agentMailboxPath(WORKSPACE, "scoped-foreign-agent"),
      pane: foreignPane,
    }),
  ];
  const entries = launches.map((launch) => ({
    type: "custom",
    customType: "pi-herdsman-radar-spawn",
    data: launch,
  }));
  const pi = fakePi({ entries });
  registerExtension!(pi.pi as never);
  const command = pi.commandOptions.get("agents");
  const context = { ...fakeContext(entries), hasUI: true } as any;
  try {
    await startRadarSession(pi, context);
    await command.handler("stop", context);
    assert.deepEqual(closedPanes(), [ownedPane]);
    assert.match(stopSummary(pi), /Stopped 1 agents/);
    assert.match(stopSummary(pi), /✓ scoped-owned-agent/);
    assert.doesNotMatch(stopSummary(pi), /scoped-foreign-agent/);
  } finally {
    pi.events.get("session_shutdown")?.[0]();
    for (const launch of launches) resetAgentMailbox(launch.mailbox);
  }
});

test("valid managed leaf agents receive identity-only TUI presentation", async () => {
  const mailbox = setAgentEnvironment("leaf-agent");
  let sessionRuntimeInitialized = false;
  let activeToolsCalls = 0;
  const state: ManagedAgentState = {
    ...managedState("leaf-agent"),
    piSessionId: DEFAULT_PI_SESSION_ID,
    piSessionFile: "/tmp/registered-agent.jsonl",
  };
  const pi = fakePi({
    activeTools: () => {
      activeToolsCalls++;
      assert.equal(sessionRuntimeInitialized, true);
      return ["read", "bash", "ask_owner"];
    },
    exec: (command, args) =>
      command === "herdr" && isApiSnapshot(args)
        ? {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                snapshot: {
                  agents: [
                    agentFromState(state),
                    {
                      agent: "pi",
                      workspace_id: WORKSPACE,
                      pane_id: "lead-pane",
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
                        kind: "id",
                        value: LEAD_SESSION_ID,
                      },
                    },
                  ],
                  panes: [
                    {
                      pane_id: state.paneId,
                      workspace_id: WORKSPACE,
                      cwd: state.cwd,
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
                        kind: "id",
                        value: state.piSessionId,
                      },
                    },
                    {
                      pane_id: "lead-pane",
                      workspace_id: WORKSPACE,
                      cwd: "/tmp",
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
                        kind: "id",
                        value: LEAD_SESSION_ID,
                      },
                    },
                  ],
                },
              },
            }),
            stderr: "",
            code: 0,
          }
        : command === "herdr" && isAgentList(args)
          ? {
              stdout: JSON.stringify({
                id: AGENT_ID,
                result: {
                  agents: [
                    agentFromState(state),
                    {
                      agent: "pi",
                      workspace_id: WORKSPACE,
                      pane_id: "lead-pane",
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
                        kind: "id",
                        value: LEAD_SESSION_ID,
                      },
                    },
                  ],
                },
              }),
              stderr: "",
              code: 0,
            }
          : command === "herdr" && isPaneList(args)
            ? {
                stdout: JSON.stringify({
                  id: AGENT_ID,
                  result: {
                    panes: [
                      {
                        pane_id: "lead-pane",
                        workspace_id: WORKSPACE,
                        agent: NON_PI_AGENT,
                      },
                    ],
                  },
                }),
                stderr: "",
                code: 0,
              }
            : { stdout: "{}", stderr: "", code: 0 },
  });
  const context = fakeAgentContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setStatus: () => undefined,
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
    notify: () => undefined,
    select: async () => "tab",
  };
  registerExtension!(pi.pi as never);
  assert.equal(activeToolsCalls, 0);
  sessionRuntimeInitialized = true;
  await pi.events.get("session_start")![0](undefined, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(widget);
  assert.deepEqual(widget!.render(160), [
    "● ? → agent:leaf-agent  [read, bash, ask_owner]",
  ]);
  assert.equal(pi.tools.filter((tool) => tool.name === "ask_owner").length, 1);
  assert.ok(activeToolsCalls > 0);
  for (const listener of pi.events.get("session_shutdown") ?? [])
    await listener();
  resetAgentMailbox(mailbox);
  setLeadEnvironment();
});

test("TUI status widget is registered as a Pi component factory", async (t) => {
  setLeadEnvironment();
  let factory: unknown;
  let renderRequests = 0;
  const pi = fakePi();
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  context.ui = {
    setStatus: () => undefined,
    setWidget: (_key: string, content: unknown) => {
      factory = content;
    },
  };
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
  });
  await pi.events.get("session_start")![0](undefined, context);

  assert.equal(typeof factory, "function");
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = (factory as (tui: unknown, theme: unknown) => unknown)(
    { requestRender: () => renderRequests++ },
    theme,
  );
  assert.ok(component instanceof StatusWidget);
  (component as StatusWidget).setSnapshot({
    agents: [{ label: "agent", definition: "agent", state: "working" }],
    stale: false,
    unavailable: false,
  });
  assert.equal(renderRequests, 1);
  assert.notEqual(factory, component);
  (component as StatusWidget).dispose();
  await pi.events.get("session_shutdown")?.[0]();
});

test("repeated lead starts replace the widget and ignore old refreshes", async (t) => {
  setLeadEnvironment();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeTimers = new Set<ReturnType<typeof setInterval>>();
  const pendingLists: {
    resolve: (value: { stdout: string; stderr: string; code: number }) => void;
  }[] = [];
  const widgets: StatusWidget[] = [];
  // While this is set, a mux inventory read is held so the test can see what the
  // widget shows for a refresh that has not answered yet. Reads after the held
  // ones are released are answered at once: the staleness this proves is the
  // widget's, not how many reads one start happens to perform.
  let holdReads = true;
  const factories: ((tui: any, theme: any) => StatusWidget)[] = [];
  const originalDispose = StatusWidget.prototype.dispose;
  let disposeCalls = 0;
  let registrations = 0;
  StatusWidget.prototype.dispose = function () {
    disposeCalls++;
    originalDispose.call(this);
  };
  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    if (delay === 2_000) {
      const timer = originalSetInterval(callback as () => void, delay);
      timer.unref?.();
      activeTimers.add(timer);
      return timer;
    }
    const timer = originalSetInterval(callback as () => void, delay);
    timer.unref?.();
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer) => {
    activeTimers.delete(timer);
    originalClearInterval(timer);
  }) as typeof clearInterval;
  try {
    const pi = fakePi({
      exec: (command, args) => {
        if (command === "herdr" && isApiSnapshot(args)) {
          if (!holdReads)
            return {
              stdout: JSON.stringify({
                id: 1,
                result: { snapshot: { agents: [], panes: [] } },
              }),
              stderr: "",
              code: 0,
            };
          return new Promise((resolve) =>
            pendingLists.push({ resolve }),
          ) as any;
        }
        if (command === "herdr" && isPaneList(args))
          return {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                panes: [
                  {
                    pane_id: "registered-pane",
                    workspace_id: WORKSPACE,
                    agent: "agent",
                    agent_status: "idle",
                  },
                ],
              },
            }),
            stderr: "",
            code: 0,
          };
        return { stdout: "{}", stderr: "", code: 0 };
      },
    });
    const makeContext = () => {
      const context = fakeContext() as any;
      context.mode = "tui";
      context.hasUI = true;
      const notices: string[] = [];
      context.ui = {
        notify: (message: string) => notices.push(message),
        setStatus: () => undefined,
        setWidget: (_key: string, content: unknown) => {
          registrations++;
          if (typeof content === "function")
            (factories.push(content as (tui: any, theme: any) => StatusWidget),
              widgets.push(
                (content as (tui: any, theme: any) => StatusWidget)(
                  { requestRender: () => undefined },
                  {
                    fg: (_color: string, text: string) => text,
                    bold: (text: string) => text,
                  },
                ),
              ));
        },
      };
      return context;
    };
    registerExtension!(pi.pi as never);
    t.after(async () => {
      await pi.events.get("session_shutdown")?.[0]();
    });
    const start = pi.events.get("session_start")![0];
    const registrationsBeforeStart = registrations;
    const firstStart = start(undefined, makeContext());
    await Promise.resolve();
    const secondStart = start(undefined, makeContext());
    await Promise.resolve();

    assert.equal(widgets.length, 2);
    assert.equal(
      registrations - registrationsBeforeStart,
      3,
      "two registrations and one old-widget removal",
    );
    assert.equal(disposeCalls, 1, "the old widget is disposed on replacement");
    const staleWidget = factories[0](
      { requestRender: () => undefined },
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
    );
    assert.ok(staleWidget);
    assert.equal(
      disposeCalls,
      2,
      "a stale factory widget is disposed immediately",
    );
    assert.equal(
      activeTimers.size,
      1,
      "only the current widget's status refresh timer survives replacement",
    );
    for (const pending of pendingLists.splice(0, 2))
      pending.resolve({
        stdout: JSON.stringify({
          id: 1,
          result: {
            snapshot: { agents: [], panes: [] },
          },
        }),
        stderr: "",
        code: 0,
      });
    await Promise.resolve();
    await Promise.resolve();
    assert.match(widgets[1].render(120)[0], /unavailable/);
    holdReads = false;
    for (const pending of pendingLists.splice(0))
      pending.resolve({
        stdout: JSON.stringify({
          id: 1,
          result: {
            snapshot: { agents: [], panes: [] },
          },
        }),
        stderr: "",
        code: 0,
      });
    await Promise.all([firstStart, secondStart]);
    for (let index = 0; index < 5; index++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.doesNotMatch(widgets[1].render(120)[0], /unavailable/);
    await pi.events.get("session_shutdown")?.[0]();
    assert.equal(activeTimers.size, 0);
    assert.equal(disposeCalls, 3, "the current widget is disposed on shutdown");
    assert.equal(widgets[0].render(120)[0], "● herd  unavailable");
  } finally {
    StatusWidget.prototype.dispose = originalDispose;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("TUI status refresh consumes the daemon's fleet observation", async (t) => {
  setLeadEnvironment();
  const label = "sleep-smoke-a";
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(tmpdir(), `pi-herdsman-${label}-${randomUUID()}.jsonl`),
  };
  realFs.writeFileSync(
    identity.piSessionFile,
    JSON.stringify({
      type: "session",
      id: identity.piSessionId,
    }),
    "utf8",
  );
  t.after(() => realFs.rmSync(identity.piSessionFile, { force: true }));
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label, REQUEST_ID, identity));
  const definitionReadsBeforeStatus = support.agentDefinitionReadCount;
  // The status refresh reads the daemon's own fleet, which is the one mux read
  // the ordinary path makes.
  let fleetReads = 0;
  const fleet = radarDaemon.observeInventory!;
  radarDaemon.observeInventory = () => {
    fleetReads++;
    return fleet();
  };
  let refreshTimer: TimerHandler | undefined;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: TimerHandler) => {
    refreshTimer = callback;
    return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const pi = fakePi({ activeTools: ["read", "bash", "ask_owner"] });
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setStatus: () => undefined,
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = (content as any)(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
  };
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
  });
  await pi.events.get("session_start")![0](undefined, context);
  await Promise.resolve();
  await Promise.resolve();
  (refreshTimer as () => void)();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  globalThis.setInterval = originalSetInterval;

  assert.ok(widget);
  assert.ok(
    fleetReads > 0,
    "the status refresh reads the daemon's own fleet observation",
  );
  const rendered = widget.render(160).join("\n");
  assert.match(rendered, /1 working/);
  assert.match(rendered, /sleep-smoke-a/);
  globalThis.setInterval = originalSetInterval;
  assert.doesNotMatch(rendered, /\[read, bash, ask_owner\]/);
  assert.ok(
    support.agentDefinitionReadCount > definitionReadsBeforeStatus,
    "session-start roster should discover agent definitions once",
  );
  const listed = await agentTool(pi, "list").execute(
    "id",
    {},
    undefined,
    undefined,
    context,
  );
  assert.equal(listed.details.ok, true, JSON.stringify(listed.details));
  assert.ok(
    support.agentDefinitionReadCount > definitionReadsBeforeStatus,
    "agent list should continue to discover agent definitions",
  );
  await pi.events.get("session_shutdown")?.[0]();
});

test("zero-runtime reconciliation requests one status refresh", async (t) => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const label = "fresh-widget-agent";
  const identity = {
    ...recoveryIdentity(label),
    piSessionFile: join(tmpdir(), `pi-herdsman-${label}-${randomUUID()}.jsonl`),
  };
  realFs.writeFileSync(identity.piSessionFile, "{}", "utf8");
  t.after(() => realFs.rmSync(identity.piSessionFile, { force: true }));
  const mailbox = agentMailboxPath(WORKSPACE, label);
  resetAgentMailbox(mailbox);
  writeAgentState(mailbox, managedState(label, undefined, identity));

  const pi = fakePi();
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setStatus: () => undefined,
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
  };

  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
  });
  const readArrived = Promise.withResolvers<void>();
  radarDaemon.observeInventory = () => {
    readArrived.resolve();
    return undefined as never;
  };
  t.after(() => {
    radarDaemon.observeInventory = undefined;
  });
  const held = radarDaemon.holdNextObserve();
  const starting = pi.events.get("session_start")![0](undefined, context);
  await t.waitFor(() => assert.ok(widget, "the widget was not registered"));
  await readArrived.promise;
  assert.equal(
    held.replyWritten(),
    false,
    "the status reply was written while its read was held",
  );
  assert.doesNotMatch(
    widget!.render(160).join("\n"),
    /fresh-widget-agent/,
    "the widget reconciled before the status read was released",
  );
  held.release();
  await t.waitFor(() =>
    assert.equal(held.replyWritten(), true, "the held reply was never written"),
  );
  await starting;
  await t.waitFor(() =>
    assert.match(widget!.render(160).join("\n"), /fresh-widget-agent/),
  );
  resetAgentMailbox(mailbox);
});

test("fresh assignment refreshes the widget after validation", async (t) => {
  setLeadEnvironment();
  const label = "fresh-start-widget-agent";
  const mailbox = agentMailboxPath(WORKSPACE, label);
  const requestedCwd = PI_AGENT_ROOT;
  const agentsDir = PI_AGENTS_DIR;
  const definitionPath = `${agentsDir}/agent.md`;
  const hadAgentsDir = realFs.existsSync(agentsDir);
  const hadDefinition = realFs.existsSync(definitionPath);
  const previousDefinition = hadDefinition
    ? realFs.readFileSync(definitionPath, "utf8")
    : undefined;
  realFs.mkdirSync(agentsDir, { recursive: true });
  realFs.writeFileSync(
    definitionPath,
    "---\nname: agent\ninheritProjectContext: true\ninheritGlobalContext: false\n---\nagent instructions\n",
  );
  projectContextCwds.length = 0;
  resetAgentMailbox(mailbox);
  const startupAck = testGate<void>();
  const initialHandoff = testGate<void>();
  let childStateReady = false;
  let releaseInitialHandoff: (() => void) | undefined;
  let callsAtHandoff = 0;
  let pi!: ReturnType<typeof fakePi>;
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  // The child's own startup acknowledgment is this launch's readiness, and the
  // fixture holds it: the daemon has started the child and written its state, so
  // the launch is bound, but nothing in this session may treat it as ready or
  // hand it an assignment until the acknowledgment it authored arrives.
  radarDaemon.onChildState = () => {
    childStateReady = true;
    return startupAck.promise;
  };
  pi = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && args[0] === "worktree" && args[1] === "list")
        return nonGitWorkspaceResponse();
      return startup.exec(command, args, options);
    },
  });
  // The session's own entries are what a launch's durable record is read from,
  // so the context has to share the log the extension appends to.
  const context = fakeContext(pi.entries) as any;
  context.cwd = requestedCwd;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  const notices: string[] = [];
  context.ui = {
    notify: (message: string) => notices.push(message),
    setStatus: () => undefined,
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
  };
  try {
    registerExtension!(pi.pi as never);
    await startRadarSession(pi, context);
    const starting = agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        label,
        task: DELEGATION_BRIEF_EXAMPLES.common,
      },
      undefined,
      undefined,
      context,
    );
    let delegateOutcome: unknown;
    void starting.then(
      (value: unknown) => {
        delegateOutcome = value;
      },
      (error: unknown) => {
        delegateOutcome = String(error);
      },
    );
    await t.waitFor(
      () =>
        assert.ok(
          childStateReady,
          `launch did not reach the child's own state; outcome: ${JSON.stringify(delegateOutcome)}; notices: ${JSON.stringify(notices)}; spawns: ${radarDaemon.spawns.length}`,
        ),
      { timeout: 3_000 },
    );
    // Started and bound, but unacknowledged: the assignment is not validated, so
    // the widget shows the launch still starting rather than a working worker.
    assert.match(widget!.render(160).join("\n"), /starting/);
    assert.doesNotMatch(widget!.render(160).join("\n"), /1 working/);
    const callsAtReady = pi.calls.length;
    startupAck.resolve();
    await t.waitFor(() =>
      assert.ok(
        releaseInitialHandoff,
        `assignment did not reach the child's handoff; notices: ${JSON.stringify(notices)}; Herdr calls: ${JSON.stringify(pi.calls)}`,
      ),
    );
    // The refresh this window contains is this session's own read of the
    // validated runtime, and a Radar child's provenance is the launch record it
    // already holds: proving it must not look the child up in the mux, which is
    // what a child that never registered with the mux could not answer.
    assert.ok(
      !pi.calls
        .slice(callsAtReady, callsAtHandoff)
        .some((args) => JSON.stringify(args).includes(label)),
      `the validated runtime refresh must not look the child up in the mux; Herdr calls: ${JSON.stringify(
        pi.calls.slice(callsAtReady, callsAtHandoff),
      )}`,
    );
    const pendingList = await agentTool(pi, "list").execute(
      "id",
      {},
      undefined,
      undefined,
      context,
    );
    assert.equal(pendingList.details.agents[0].state, "settling");
    releaseInitialHandoff!();
    const result = await starting;
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(pi.sentMessageCalls.length, 1);
    assert.deepEqual(
      {
        discoveryCwds: projectContextCwds,
        splitForMismatchedCwd: pi.calls.some(
          (args) => args[0] === "pane" && args[1] === "split",
        ),
      },
      { discoveryCwds: [requestedCwd], splitForMismatchedCwd: false },
    );
    await t.waitFor(() =>
      assert.match(widget!.render(160).join("\n"), /1 working/),
    );
    const rendered = widget!.render(160).join("\n");
    assert.match(rendered, /1 working/);
    assert.match(rendered, /fresh-start-widget-agent/);

    // A second fresh assignment for the same label launches its own child. The
    // first child is retired through the lead's close first: its consumer stops
    // with its pane, so only the new child answers the reset mailbox.
    const closedFirst = await agentTool(pi, "close").execute(
      "id",
      { agent: label },
      undefined,
      undefined,
      context,
    );
    assert.equal(closedFirst.details.ok, true, JSON.stringify(closedFirst.details));
    resetAgentMailbox(mailbox);
    const relaunched = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        label,
        task: DELEGATION_BRIEF_EXAMPLES.common,
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(relaunched.details.ok, true, JSON.stringify(relaunched.details));
    assert.equal(radarDaemon.spawns.length, 2);
    assert.equal(pi.sentMessageCalls.length, 1);
    await t.waitFor(() =>
      assert.match(
        widget!.render(160).join("\n"),
        /fresh-start-widget-agent[^\n]*working/,
      ),
    );

    // A fresh assignment whose child never acknowledges readiness fails, and the
    // launch must stay visible without being presented as a worker: only the
    // acknowledged assignment that reached validation counts as working.
    const stalledLabel = "fresh-start-widget-stalled";
    radarDaemon.options.acknowledge = false;
    process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS = "300";
    const stalled = await agentTool(pi, "delegate").execute(
      "id",
      {
        definition: "agent",
        label: stalledLabel,
        task: DELEGATION_BRIEF_EXAMPLES.common,
      },
      undefined,
      undefined,
      context,
    );
    assert.equal(stalled.details.ok, false, JSON.stringify(stalled.details));
    assert.equal(radarDaemon.spawns.length, 3);
    await t.waitFor(() =>
      assert.ok(
        widget!
          .render(160)
          .join("\n")
          .split("\n")
          .some((line) => line.includes(stalledLabel)),
        "the unacknowledged launch must still be visible to the operator",
      ),
    );
    const stalledRow = widget!
      .render(160)
      .join("\n")
      .split("\n")
      .find((line) => line.includes(stalledLabel));
    assert.doesNotMatch(stalledRow!, /working/);
    assert.match(widget!.render(160).join("\n"), /1 working/);
  } finally {
    delete process.env.PI_HERDSMAN_RADAR_LAUNCH_TIMEOUT_MS;
    radarDaemon.options.acknowledge = true;
    radarDaemon.onChildState = undefined;
    await pi.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    if (hadDefinition)
      realFs.writeFileSync(definitionPath, previousDefinition!);
    else if (!hadAgentsDir) {
      realFs.unlinkSync(definitionPath);
      realFs.rmdirSync(agentsDir);
    } else realFs.unlinkSync(definitionPath);
  }
});
test("lead status refreshes keep one in-flight refresh and one trailing rerun", async (t) => {
  setLeadEnvironment();
  await ensureRadarDaemon();
  const originalSetInterval = globalThis.setInterval;
  let refreshTimer: TimerHandler | undefined;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    if (delay === 2000) refreshTimer = callback;
    return { unref: () => undefined } as any;
  }) as typeof setInterval;
  t.after(() => {
    globalThis.setInterval = originalSetInterval;
  });

  let snapshots = 0;
  radarDaemon.observeInventory = () => {
    snapshots++;
    return observedFleet([]);
  };
  const pi = fakePi({ activeTools: [] });
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setStatus: () => undefined,
    setWidget: (_key: string, content: unknown) => {
      if (typeof content === "function")
        widget = (content as any)(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
    notify: () => undefined,
    select: async () => "tab",
  };
  registerExtension!(pi.pi as never);
  t.after(async () => {
    await pi.events.get("session_shutdown")?.[0]();
  });
  await pi.events.get("session_start")![0](undefined, context);
  for (let index = 0; index < 30; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(refreshTimer, "lead status timer registered");
  assert.ok(widget);
  const base = snapshots;

  const held = radarDaemon.holdNextObserve();
  (refreshTimer as () => void)();
  await t.waitFor(() =>
    assert.equal(snapshots - base, 1, "the status refresh did not start"),
  );
  (refreshTimer as () => void)();
  (refreshTimer as () => void)();
  (refreshTimer as () => void)();
  assert.equal(
    snapshots - base,
    1,
    "a second status refresh overlapped the in-flight one",
  );

  held.release();
  await t.waitFor(() =>
    assert.equal(
      snapshots - base,
      2,
      "the trailing status rerun did not run exactly once",
    ),
  );
  for (let index = 0; index < 10; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(snapshots - base, 2, "the status refresh queue kept growing");
  assert.match(widget!.render(160)[0], /herd/);
});

// Consumer wiring for the footer status entries: the real session and refresh
// paths publish through ctx.ui.setStatus, and the background count is read
// through the documented pi-bash-processes session query. Only the status
// refresh timers are captured, so each test drives a refresh explicitly and
// waits for its asynchronous publish.
const STATUS_ENTRY = "pi-herdsman";
const WORK_ENTRY = "pi-herdsman-waiting";
const SESSION_OUTSTANDING = "pi-bash-processes:v1:session-outstanding";
const GLYPH_WAITING = "\u{F051F}";
const GLYPH_BLOCKED = "\u{F02D7}";
const GLYPH_TERMINAL = "\u{F018D}";
const GLYPH_IDLE = "\u{F04B2}";
const GLYPH_ROBOT = "\u{F06A9}";

function footerUi() {
  const footer = new Map<string, string | undefined>();
  return {
    footer,
    ui: {
      setStatus: (key: string, text: string | undefined) =>
        footer.set(key, text),
      notify: () => undefined,
      setWidget: (_key: string, content: unknown) => {
        if (typeof content === "function")
          (content as (tui: unknown, theme: unknown) => unknown)(
            { requestRender: () => undefined },
            {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            },
          );
      },
    },
  };
}

async function shutDown(pi: ReturnType<typeof fakePi>): Promise<void> {
  for (const handler of pi.events.get("session_shutdown") ?? [])
    await handler(undefined, undefined as never);
}

/** Captures the status refresh timers a start creates, so a test drives them. */
async function captureRefreshes(start: () => Promise<unknown>): Promise<() => void> {
  const refreshes: (() => void)[] = [];
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: () => void) => {
    refreshes.push(callback);
    return { unref: () => undefined } as unknown as ReturnType<
      typeof setInterval
    >;
  }) as typeof setInterval;
  try {
    await start();
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
  return () => {
    for (const refresh of refreshes) refresh();
  };
}

async function startSession(
  pi: ReturnType<typeof fakePi>,
  context: any,
): Promise<() => void> {
  registerExtension!(pi.pi as never);
  return captureRefreshes(async () => {
    for (const handler of pi.events.get("session_start") ?? [])
      await handler(undefined, context);
  });
}

test("a lead's footer keeps local facts through an unavailable fleet and clears on shutdown", async (t) => {
  setLeadEnvironment();
  const pi = fakePi({ activeTools: ["read", "bash", "ask_owner"] });
  const { footer, ui } = footerUi();
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  context.ui = ui;
  let backgroundTasks = 2;
  pi.pi.events.on(SESSION_OUTSTANDING, (query: any) =>
    query.respond(backgroundTasks),
  );
  t.after(() => shutDown(pi));
  const refresh = await startSession(pi, context);
  refresh();
  await t.waitFor(() => {
    assert.equal(footer.get(STATUS_ENTRY), GLYPH_WAITING);
    assert.equal(footer.get(WORK_ENTRY), `${GLYPH_TERMINAL} 2`);
  });

  radarDaemon.observeInventory = () => undefined as never;
  t.after(() => {
    radarDaemon.observeInventory = undefined;
  });
  pi.pi.events.emit("rpiv:ask-user:blocked", { active: true });
  refresh();
  await t.waitFor(() => assert.equal(footer.get(STATUS_ENTRY), GLYPH_BLOCKED));
  assert.equal(
    footer.get(WORK_ENTRY),
    `${GLYPH_TERMINAL} 2`,
    "unknown children are omitted, not shown as zero",
  );

  backgroundTasks = 0;
  pi.pi.events.emit("rpiv:ask-user:blocked", { active: false });
  refresh();
  await t.waitFor(() => {
    assert.equal(footer.get(STATUS_ENTRY), GLYPH_IDLE);
    assert.equal(footer.get(WORK_ENTRY), undefined);
  });

  await shutDown(pi);
  assert.equal(footer.get(STATUS_ENTRY), undefined);
  assert.equal(footer.get(WORK_ENTRY), undefined);
});

test("a managed leaf publishes its footer entries and an open permission prompt blocks it", async (t) => {
  setAgentEnvironment("leaf-agent");
  const pi = fakePi({ activeTools: ["read", "bash", "ask_owner"] });
  const { footer, ui } = footerUi();
  const context = fakeContext() as any;
  context.mode = "tui";
  context.hasUI = true;
  context.ui = ui;
  pi.pi.events.on(SESSION_OUTSTANDING, (query: any) => query.respond(1));
  t.after(() => shutDown(pi));
  const refresh = await startSession(pi, context);
  refresh();
  await t.waitFor(() =>
    assert.equal(footer.get(WORK_ENTRY), `${GLYPH_TERMINAL} 1`),
  );
  assert.doesNotMatch(footer.get(WORK_ENTRY) ?? "", new RegExp(GLYPH_ROBOT));

  pi.pi.events.emit("permissions:ui_prompt", { requestId: "req-a" });
  refresh();
  await t.waitFor(() => assert.equal(footer.get(STATUS_ENTRY), GLYPH_BLOCKED));
  pi.pi.events.emit("permissions:decision", { requestId: "req-a" });
  refresh();
  await t.waitFor(() => assert.equal(footer.get(STATUS_ENTRY), GLYPH_WAITING));
});

test("an active Chief publishes its own footer facts with no owned subagents", async (t) => {
  setLeadEnvironment();
  process.env.HERDR_PANE_ID = "chief-pane";
  process.env.HERDR_TAB_ID = "chief-tab";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  process.env.HERDR_SOCKET_PATH = join(tmpdir(), `footer-${randomUUID()}.sock`);
  const pi = fakeChiefPi({ activeTools: ["read"], autoActivateRegisteredTools: true });
  const { footer, ui } = footerUi();
  const context = fakeContext([]) as any;
  context.hasUI = true;
  context.mode = "tui";
  context.ui = ui;
  pi.pi.events.on(SESSION_OUTSTANDING, (query: any) => query.respond(2));
  t.after(() => shutDown(pi));
  const refresh = await captureRefreshes(async () => {
    await startSession(pi, context);
    await pi.commandOptions.get("chief").handler("", context);
  });
  refresh();
  await t.waitFor(() => {
    assert.equal(footer.get(STATUS_ENTRY), GLYPH_WAITING);
    assert.equal(footer.get(WORK_ENTRY), `${GLYPH_TERMINAL} 2`);
  });
  assert.doesNotMatch(footer.get(WORK_ENTRY) ?? "", new RegExp(GLYPH_ROBOT));

  await shutDown(pi);
  assert.equal(footer.get(STATUS_ENTRY), undefined);
  assert.equal(footer.get(WORK_ENTRY), undefined);
});
